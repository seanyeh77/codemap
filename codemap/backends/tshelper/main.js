'use strict';
// codemap TypeScript/JavaScript helper: the TypeScript compiler API resolves the calls.
//
// Input (stdin, JSON): {root, files, tests, configs, packages, ts}
//   files    the repository's TS/JS files, paths from the root, .d.ts included (types only, never nodes)
//   tests    the files that are test code: their values, subclasses and implementations are left out
//            of what production call sites resolve to
//   configs  tsconfig*.json / jsconfig.json files, paths from the root
//   packages the repository's package.json files: an import of a workspace package
//            (@scope/core in a monorepo) goes to its source, not to a build or to nothing
//   ts       the path of the typescript package to load (5.x or 6.x)
// Output (stdout, JSON): {"nodes": {...}, "edges": [...], "stats": {...}}, the shapes of codemap.schema.
//
// Files are grouped by the tsconfig that lists them (or the nearest one above them, or default options
// with allowJs), and each group is one ts.Program. Node ids are "file:Qualified.name" like the
// tree-sitter backend; a function with no name of its own is "outer.fnN" (N counts in source order).
// Declarations outside the repository (lib.*.d.ts, node_modules, the repository's .d.ts files) are
// "ext:" nodes named by their qualified name; node_modules is read for types, never for nodes.

const fs = require('fs');
const path = require('path');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const ts = require(input.ts);
const root = path.resolve(input.root);
// what a program read, for the program cache: set while one program is created and analyzed
let rec = null;
// sets whose answers a program depends on: each question is recorded with its answer
const watched = (set, kind) => ({
  has: (k) => { const v = set.has(k); if (rec) rec.member[kind + '\0' + k] = v; return v; },
  [Symbol.iterator]: () => set[Symbol.iterator](),
});
const repoSet = new Set(input.files);
const testSet = new Set(input.tests || []);
const repo = watched(repoSet, 'repo');
const tests = watched(testSet, 'test');
const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
const isDts = (f) => /\.d\.[cm]?ts$/.test(f) || /\.d\.[^/.]+\.ts$/.test(f);
const isJs = (f) => /\.[cm]?jsx?$/.test(f);
const fnLike = (n) => n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
  || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n));
const valueFn = (n) => n && (ts.isFunctionExpression(n) || ts.isArrowFunction(n));
const skipOuter = (e) => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)))) e = e.expression;
  return e;
};

const nodes = {};
const edges = [];
const counts = {};
const unresolved = {};
const errors = [];
const placeholders = new Set();
const broken = new Set();
const seenEdge = new Set();
let decorating = 0;
let lastMissing = false;         // the last placeholder() named a package that could not be found
// ms per phase, for CODEMAP_TS_DEBUG: reading the configs, building the programs (parsing and module
// resolution), type checking the owned files, and extracting nodes and edges (values, then calls)
const phase = { config: 0, program: 0, check: 0, extract: 0 };
// CODEMAP_TS_PROFILE=1: per program, which files it loaded and what parsing them cost; per file, how
// many programs loaded it
const PROFILE = !!process.env.CODEMAP_TS_PROFILE;
const profile = [];
const loadedBy = new Map();         // file name -> programs that loaded it
const ifaceUsed = new Map();    // interface member id -> {decl, name, ext}: the targets of exact interface calls

function count(k, n = 1) { counts[k] = (counts[k] || 0) + n; }
const samples = {};
function miss(why, at) {
  unresolved[why] = (unresolved[why] || 0) + 1;
  count('unresolved');
  // CODEMAP_TS_DEBUG=1: where calls stay unresolved, for checking the analyzer on a real project
  if (process.env.CODEMAP_TS_DEBUG && at) {
    const sf = at.getSourceFile();
    (samples[why] = samples[why] || []).push(`${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1} ${at.getText(sf).slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}

// ---------------------------------------------------------------------------
// programs

function loadConfig(r) {
  const abs = path.join(root, r);
  const host = Object.assign({}, ts.sys, { onUnRecoverableConfigFileDiagnostic: () => {} });
  let pc;
  try { pc = ts.getParsedCommandLineOfConfigFile(abs, {}, host); } catch (e) { return null; }
  if (!pc) return null;
  return { rel: r, dir: path.posix.dirname(r), options: pc.options, names: pc.fileNames.map(rel), errors: pc.errors.length };
}

const tc = Date.now();
const configs = (input.configs || []).map(loadConfig).filter(Boolean);
phase.config += Date.now() - tc;
const under = (dir, f) => dir === '.' || f.startsWith(dir + '/');

function groupOf(f) {
  let best = null;
  for (const c of configs) if (c.names.includes(f) && (!best || c.dir.length > best.dir.length)) best = c;
  if (best) return best;
  for (const c of configs) {
    if (under(c.dir, f) && path.posix.basename(c.rel).match(/^(tsconfig|jsconfig)\.json$/) && (!best || c.dir.length > best.dir.length)) best = c;
  }
  return best;
}

// configs that differ only in what they emit (outDir, rootDir, declaration, composite, ...) resolve
// the same way: one program reads all of them, so a monorepo's packages are type-checked once and
// values flow between them
const EMIT_ONLY = new Set(['configFilePath', 'outDir', 'rootDir', 'declaration', 'declarationDir', 'declarationMap',
  'emitDeclarationOnly', 'composite', 'incremental', 'tsBuildInfoFile', 'noEmit', 'sourceMap', 'inlineSourceMap',
  'inlineSources', 'outFile', 'removeComments', 'noEmitOnError', 'importHelpers', 'build', 'pathsBasePath']);
function optionsKey(c) {
  if (!c) return '';
  const o = {};
  for (const k of Object.keys(c.options).sort()) if (!EMIT_ONLY.has(k)) o[k] = c.options[k];
  // paths are resolved against the config that wrote them
  if (c.options.paths) o.__paths = path.resolve(c.options.pathsBasePath || c.options.baseUrl || path.join(root, c.dir));
  return JSON.stringify(o);
}

const groups = new Map();
for (const f of input.files) {
  if (isDts(f)) continue;
  const c = groupOf(f);
  const key = optionsKey(c);
  if (!groups.has(key)) groups.set(key, { config: c, configs: [], owned: [] });
  const g = groups.get(key);
  if (c && !g.configs.includes(c)) g.configs.push(c);
  g.owned.push(f);
}

const DEFAULTS = {
  allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler || ts.ModuleResolutionKind.NodeJs, esModuleInterop: true,
  allowSyntheticDefaultImports: true, resolveJsonModule: true, skipLibCheck: true,
};

// ---------------------------------------------------------------------------
// definitions: the same walk for every file, so ids agree between programs

const defCache = new WeakMap();

function inRepo(sf) {
  const r = rel(sf.fileName);
  return repo.has(r) && !r.split('/').includes('node_modules') ? r : null;
}

function memberName(n, sf) {
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  if (!n.name) return null;
  if (ts.isIdentifier(n.name) || ts.isPrivateIdentifier(n.name) || ts.isStringLiteral(n.name) || ts.isNumericLiteral(n.name)) return n.name.text;
  return n.name.getText(sf);
}

function define(sf) {
  if (defCache.has(sf)) return defCache.get(sf);
  const r = inRepo(sf);
  const out = { map: new Map(), anon: new Set(), rel: r, nodes: {} };
  defCache.set(sf, out);
  if (!r || isDts(r)) return out;
  const lang = isJs(r) ? 'javascript' : 'typescript';
  const counters = {};
  const pos = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const endOf = (n) => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;

  function add(decl, qual, kind, fn, extra) {
    const id = `${r}:${qual.join('.')}`;
    const old = out.nodes[id];
    // overloads and merged declarations are one definition: the one with a body gives the lines
    if (!old || (fn && fn.body && !old._body)) {
      const n = Object.assign(old || {}, { name: qual.join('.'), file: r, line: pos(decl), end: endOf(decl), defined: true, lang, kind }, extra || {});
      if (fn && fn.parameters) {
        n.params = fn.parameters.map((p) => p.name.getText(sf));
        n.param_text = '(' + fn.parameters.map((p) => p.getText(sf)).join(', ') + ')';
      }
      if (fn && fn.body) n._body = true;
      out.nodes[id] = n;
    }
    out.map.set(decl, id);
    if (fn) out.map.set(fn, id);
    return id;
  }

  // named after the nearest named definition, as Go names closures (Serve.func1): an IIFE around a
  // whole script does not rename what it holds
  function anonName(scope) {
    const base = scope.length ? scope.join('.') : '<module>';
    counters[base] = (counters[base] || 0) + 1;
    return scope.length ? scope.concat(['fn' + counters[base]]) : ['<module>', 'fn' + counters[base]];
  }

  function body(fn, scope, id) {
    ts.forEachChild(fn, (c) => visit(c, scope, id));
  }

  function klass(n, qual, owner) {
    const bases = [];
    for (const h of n.heritageClauses || []) for (const t of h.types) bases.push(t.expression.getText(sf));
    const id = add(n, qual, 'class', null, bases.length ? { bases } : null);
    for (const m of n.members) {
      const nm = memberName(m, sf);
      if (fnLike(m) && nm) {
        const mid = add(m, qual.concat([nm]), 'method', m, { class: id });
        body(m, qual.concat([nm]), mid);
      } else if (ts.isPropertyDeclaration(m) && nm && valueFn(skipOuter(m.initializer))) {
        const init = skipOuter(m.initializer);
        const mid = add(m, qual.concat([nm]), 'method', init, { class: id });
        body(init, qual.concat([nm]), mid);
      } else {
        // field initializers and static blocks run when the class is made: the class is their owner
        ts.forEachChild(m, (c) => visit(c, qual, id));
      }
    }
    return id;
  }

  function iface(n, qual) {
    const id = add(n, qual, 'class', null);
    const members = ts.isInterfaceDeclaration(n) ? n.members : n.type.members;
    for (const m of members) {
      const nm = memberName(m, sf);
      if (!nm) continue;
      if (ts.isMethodSignature(m) || (ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type))) {
        add(m, qual.concat([nm]), 'method', ts.isMethodSignature(m) ? m : m.type, { class: id });
      }
    }
  }

  // an object literal bound to a name: its functions are named after it (api.get)
  function object(o, qual, owner) {
    for (const p of o.properties) {
      const nm = memberName(p, sf);
      if (fnLike(p) && nm) {
        const id = add(p, qual.concat([nm]), 'function', p);
        body(p, qual.concat([nm]), id);
      } else if (ts.isPropertyAssignment(p) && nm) {
        const init = skipOuter(p.initializer);
        if (valueFn(init)) {
          const id = add(p, qual.concat([nm]), 'function', init);
          body(init, qual.concat([nm]), id);
        } else if (ts.isObjectLiteralExpression(init)) {
          object(init, qual.concat([nm]), owner);
        } else {
          visit(p.initializer, qual, owner);
        }
      } else {
        visit(p, qual, owner);
      }
    }
  }

  // a value given a name: const f = () => ..., const C = class {...}, const api = {...}; React's
  // wrappers keep the name of what they wrap: const Card = forwardRef((p, ref) => ...), memo(...),
  // const save = useCallback(() => ..., [])
  function bound(decl, init, qual, owner, kind) {
    let v = skipOuter(init);
    if (v && ts.isCallExpression(v) && v.arguments.length && valueFn(skipOuter(v.arguments[0]))
        && /^(React\.)?(forwardRef|memo|useCallback)$/.test(v.expression.getText(sf))) {
      v = skipOuter(v.arguments[0]);
    }
    if (valueFn(v)) {
      const id = add(decl, qual, kind, v);
      body(v, qual, id);
      return true;
    }
    if (ts.isClassExpression(v)) {
      out.map.set(decl, klass(v, qual, owner));
      return true;
    }
    if (ts.isObjectLiteralExpression(v)) {
      object(v, qual, owner);
      return true;
    }
    return false;
  }

  function visit(n, scope, owner) {
    if (ts.isFunctionDeclaration(n)) {
      const q = scope.concat([n.name ? n.name.text : 'default']);
      const id = add(n, q, 'function', n);
      if (n.body) body(n, q, id);
      return;
    }
    if (ts.isClassDeclaration(n) || (ts.isClassExpression(n) && n.name)) {
      klass(n, scope.concat([n.name ? n.name.text : 'default']), owner);
      return;
    }
    if (ts.isClassExpression(n)) {
      klass(n, anonName(scope).map((x, i, a) => (i === a.length - 1 ? x.replace(/^fn(\d+)$/, 'class$1') : x)), owner);
      return;
    }
    if (ts.isInterfaceDeclaration(n) || (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type))) {
      iface(n, scope.concat([n.name.text]));
      return;
    }
    if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) {
      let b = n.body;
      const q = scope.concat([n.name.text]);
      while (b && ts.isModuleDeclaration(b)) { q.push(b.name.text); b = b.body; }
      if (b) ts.forEachChild(b, (c) => visit(c, q, owner));
      return;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (bound(n, n.initializer, scope.concat([n.name.text]), owner, 'function')) return;
    }
    if (ts.isExportAssignment(n)) {
      if (bound(n, n.expression, scope.concat(['default']), owner, 'function')) return;
    }
    // exports.f = function () {}, module.exports.f = ..., Foo.prototype.bar = function () {}
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
      const l = n.left.getText(sf);
      let q = null;
      let kind = 'function';
      let m;
      if ((m = l.match(/^(?:module\.)?exports\.([\w$]+)$/))) q = [m[1]];
      else if ((m = l.match(/^([\w$]+)\.prototype\.([\w$]+)$/))) { q = [m[1], m[2]]; kind = 'method'; }
      if (q && valueFn(skipOuter(n.right))) {
        const id = add(n, scope.concat(q), kind, skipOuter(n.right));
        out.map.set(n.left, id);
        body(skipOuter(n.right), scope.concat(q), id);
        return;
      }
    }
    if (ts.isObjectLiteralExpression(n)) {
      // an object nobody named (returned, passed): its methods keep their own names, under the
      // definition around them (tipFor returns {show() {}, hide() {}}: tipFor.show, tipFor.hide)
      object(n, scope, owner);
      return;
    }
    if (fnLike(n)) {
      // a function with no name of its own: a callback, a closure, a method of an object nobody named
      const q = anonName(scope);
      const id = add(n, q, 'function', n);
      out.anon.add(n);
      body(n, scope, id);
      return;
    }
    ts.forEachChild(n, (c) => visit(c, scope, owner));
  }

  ts.forEachChild(sf, (c) => visit(c, [], null));
  for (const n of Object.values(out.nodes)) delete n._body;
  return out;
}

function idOf(decl) {
  if (!decl) return null;
  const d = define(decl.getSourceFile());
  if (d.map.has(decl)) return d.map.get(decl);
  if (decl.parent && ts.isBinaryExpression(decl.parent) && d.map.has(decl.parent)) return d.map.get(decl.parent);
  // a property or variable whose value is a function with no name of its own: that function
  const init = (ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl) || ts.isVariableDeclaration(decl)) && skipOuter(decl.initializer);
  if (init && valueFn(init) && d.map.has(init)) return d.map.get(init);
  return null;
}

// declared outside the repository's own code: lib.*.d.ts, node_modules, a .d.ts of the repository
function outside(decl) {
  const sf = decl.getSourceFile();
  return !inRepo(sf) || isDts(rel(sf.fileName));
}

// the node a declaration is: a repository definition, an outside one, or nothing (a repository variable)
function target(decl) {
  return idOf(decl) || (outside(decl) ? ext(extName(decl)) : null);
}

// ---------------------------------------------------------------------------
// outside declarations

function pkgOf(file) {
  const i = file.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const parts = file.slice(i + 14).split('/');
  let p = parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
  if (p.startsWith('@types/')) p = p.slice(7).replace(/^(.+)__(.+)$/, '@$1/$2');
  return p;
}

function extName(decl) {
  const parts = [];
  let modName = null;
  let global = false;
  for (let x = decl; x && !ts.isSourceFile(x); x = x.parent) {
    if (ts.isModuleDeclaration(x) && ts.isStringLiteral(x.name)) { modName = x.name.text; break; }
    if (ts.isModuleDeclaration(x) && x.flags & ts.NodeFlags.GlobalAugmentation) { global = true; break; }   // declare global {}
    const nm = x.name && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name) || ts.isPrivateIdentifier(x.name)) ? x.name.text : null;
    if (!nm) continue;
    if (x === decl || ts.isClassLike(x) || ts.isInterfaceDeclaration(x) || ts.isModuleDeclaration(x) || ts.isTypeAliasDeclaration(x)) parts.unshift(nm);
  }
  const sf = decl.getSourceFile();
  let prefix = modName;
  if (!prefix && !global) {
    const pkg = pkgOf(sf.fileName);
    if (pkg && ts.isExternalModule(sf)) prefix = pkg;
    else if (!pkg && inRepo(sf) && ts.isExternalModule(sf)) prefix = rel(sf.fileName).replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, '');
  }
  if (prefix) {
    const base = prefix.split('/').pop().toLowerCase();
    if (parts.length > 1 && parts[0].toLowerCase() === base) parts.shift();   // @types/react: namespace React
    parts.unshift(prefix);
  }
  return parts.join('.');
}

function ext(name, ph) {
  const id = 'ext:' + name;
  if (!nodes[id]) nodes[id] = { name, file: '', line: null, defined: false };
  if (ph) nodes[id].placeholder = true;
  if (rec) rec.touched.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// workspace packages: in a monorepo an import of a sibling package is the repository's own source,
// whether or not node_modules links it, and whatever its package.json says the build is

const workspace = new Map();      // package name -> {dir, exports}
for (const p of input.packages || []) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
    if (j.name && !workspace.has(j.name)) workspace.set(j.name, { dir: path.join(root, path.posix.dirname(p)), json: j });
  } catch (e) { /* not JSON */ }
}
const SOURCE = /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/;
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };
const exists = (f) => { const v = isFile(f); if (rec) rec.probe['isFile\0' + f] = v; return v; };

// the first condition of an exports entry that names a source file (not a .d.ts, not a build)
function sourceIn(entry, dir) {
  if (typeof entry === 'string') {
    const f = path.join(dir, entry);
    return SOURCE.test(entry) && !isDts(entry) && repo.has(rel(f)) ? f : null;
  }
  if (entry && typeof entry === 'object') for (const v of Object.values(entry)) { const f = sourceIn(v, dir); if (f) return f; }
  return null;
}

// the source a workspace package's import goes to; each lookup is one of a program's recorded questions,
// so a change to a package a program never imports does not rebuild it
function workspaceSource(name) {
  const r = findWorkspaceSource(name);
  if (rec) rec.probe['workspace\0' + name] = r;
  return r;
}

function findWorkspaceSource(name) {
  let pkg = null;
  let sub = '';
  for (const [n, w] of workspace) if ((name === n || name.startsWith(n + '/')) && (!pkg || n.length > pkg[0].length)) { pkg = [n, w]; sub = name.slice(n.length); }
  if (!pkg) return null;
  const { dir, json } = pkg[1];
  const key = '.' + sub;
  const ex = json.exports && typeof json.exports === 'object' && !Array.isArray(json.exports) && Object.keys(json.exports).some((k) => k.startsWith('.'))
    ? json.exports[key] : sub ? null : json.exports;
  const found = sourceIn(ex, dir) || (!sub && (sourceIn(json.source, dir) || sourceIn(json.types, dir) || sourceIn(json.main, dir)));
  if (found) return found;
  const tail = sub ? sub.slice(1) : 'index';
  for (const base of ['src/' + tail, tail]) {
    for (const ext of ['.ts', '.tsx', '.mts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const f = path.join(dir, base + ext);
      if (repo.has(rel(f)) && exists(f)) return f;
    }
  }
  return null;
}

const EXT_OF = { '.ts': ts.Extension.Ts, '.tsx': ts.Extension.Tsx, '.mts': ts.Extension.Mts, '.cts': ts.Extension.Cts,
  '.js': ts.Extension.Js, '.jsx': ts.Extension.Jsx, '.mjs': ts.Extension.Mjs, '.cjs': ts.Extension.Cjs };

// where a file comes from, for the profile
function category(fileName) {
  if (fileName.includes('/node_modules/typescript/lib/')) return 'lib';
  if (fileName.includes('/node_modules/')) return 'node_modules';
  const r = rel(fileName);
  if (r.startsWith('..')) return 'outside';
  return isDts(r) ? 'repo_dts' : 'repo';
}

function hostFor(options, prof) {
  const host = ts.createCompilerHost(options, true);
  if (CACHE) {
    // every question the compiler asks the file system, with its answer: the program is the same as
    // long as every answer is
    const ask = (name, fn) => {
      const orig = host[name] && host[name].bind(host);
      if (!orig) return;
      host[name] = (...a) => { const v = orig(...a); if (rec) rec.probe[name + '\0' + a[0]] = fn ? fn(v) : v; return v; };
    };
    ask('fileExists'); ask('directoryExists'); ask('realpath'); ask('getDirectories', (v) => JSON.stringify(v));
    ask('readFile', (v) => (v === undefined ? null : digest(v)));
    const get = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, ...rest) => {
      const sf = get(fileName, ...rest);
      if (rec) rec.probe['readFile\0' + fileName] = sf ? digest(sf.text) : null;
      return sf;
    };
  }
  if (prof) {
    const get = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, ...rest) => {
      const t0 = process.hrtime.bigint();
      const sf = get(fileName, ...rest);
      const k = category(fileName);
      const c = prof.files[k] = prof.files[k] || { files: 0, kb: 0, parse_ms: 0 };
      c.files++;
      c.parse_ms += Number(process.hrtime.bigint() - t0) / 1e6;
      if (sf) c.kb += sf.text.length / 1024;
      loadedBy.set(fileName, (loadedBy.get(fileName) || 0) + 1);
      return sf;
    };
  }
  if (!workspace.size) return host;
  // the compiler's own resolution keeps a cache per program; a host that resolves for it must too
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, options);
  host.resolveModuleNames = (names, containing, reused, redirected, opts) => names.map((n) => {
    const r = ts.resolveModuleName(n, containing, opts || options, host, cache, redirected).resolvedModule;
    // resolved to the repository's own source: keep it; otherwise a workspace package's source wins
    if (r && !r.isExternalLibraryImport && !isDts(r.resolvedFileName)) return r;
    if (n.startsWith('.') || path.isAbsolute(n)) return r;
    const f = workspaceSource(n);
    return f ? { resolvedFileName: f, extension: EXT_OF[path.extname(f)], isExternalLibraryImport: false } : r;
  });
  return host;
}

// ---------------------------------------------------------------------------
// the program cache: a program's nodes, edges and counts, kept with every question its creation and
// analysis asked (files read and their content, files and directories looked for, which files are the
// repository's and which are tests). A later run replays it when every answer is still the same, and
// creates and checks the program otherwise. The graph is the same either way.

const CACHE = input.cache ? path.resolve(input.cache) : null;
const crypto = require('crypto');
const digest = (text) => crypto.createHash('sha1').update(text).digest('hex');
// the layout of an entry; an entry of another format is not read, whatever codemap wrote it
const FORMAT = 1;
const KEEP_DAYS = 14;                 // an entry no run has used for this long is removed
const MAX_MB = Number(process.env.CODEMAP_TS_CACHE_MB || 2048);   // beyond this, the least recently used go
// replayed: answers unchanged; rebuilt, and why: no entry, content, lookup, files (repository or test
// membership), corrupt (unreadable or malformed: removed, the program analyzed in full), format
const cacheStats = { replayed: 0, rebuilt: 0, why: {}, entries: 0, mb: 0, removed: 0 };
const fresh = new Set();          // the entries this run read or wrote
const why = (k) => { cacheStats.why[k] = (cacheStats.why[k] || 0) + 1; };
// the helper's code, codemap's version, TypeScript and Node: a change to any makes every entry stale
const HELPER = CACHE ? digest([fs.readFileSync(__filename, 'utf8'), input.codemap || '', ts.version, process.version,
  !!process.env.CODEMAP_TS_DEBUG, FORMAT].join('\0')) : null;

// an entry's file: <program>-<key>.json, the program named by its configs, so an entry that a newer
// one replaces is found and removed
function programKey(group) {
  const c = group.config;
  const program = digest(JSON.stringify(c ? group.configs.map((k) => k.rel).sort() : ['(default options)'])).slice(0, 12);
  const key = digest(JSON.stringify([HELPER, c ? group.configs.map((k) => [k.rel, k.options, k.names]) : DEFAULTS,
    [...group.owned].sort(), group.owned.some(isJs), c ? null : input.files.filter(isDts)]));
  return { program, key, file: path.join(CACHE, `${program}-${key}.json`) };
}

// the answers now, asked again; one file's content is read once per run
const answers = new Map();
function answer(q) {
  if (answers.has(q)) return answers.get(q);
  const [kind, arg] = q.split('\0');
  let v;
  try {
    if (kind === 'readFile') v = fs.existsSync(arg) && fs.statSync(arg).isFile() ? digest(ts.sys.readFile(arg)) : null;
    else if (kind === 'fileExists') v = ts.sys.fileExists(arg);
    else if (kind === 'directoryExists') v = ts.sys.directoryExists(arg);
    else if (kind === 'realpath') v = ts.sys.realpath ? ts.sys.realpath(arg) : arg;
    else if (kind === 'getDirectories') v = JSON.stringify(ts.sys.getDirectories(arg));
    else if (kind === 'isFile') v = isFile(arg);
    else if (kind === 'workspace') v = findWorkspaceSource(arg);
    else v = { unknown: kind };            // a question this helper does not ask: never the same answer
  } catch (e) { v = { failed: true }; }
  answers.set(q, v);
  return v;
}

const checksum = (probe, member, delta) => digest(JSON.stringify([probe, member, delta]));

// an entry this helper can replay whole: checked before anything is replayed, so a damaged entry
// never leaves half its results behind
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const strs = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
function wellFormed(entry) {
  if (!isObj(entry) || entry.format !== FORMAT || entry.sum !== checksum(entry.probe, entry.member, entry.delta) || !isObj(entry.probe) || !isObj(entry.member) || !isObj(entry.delta)) return false;
  const d = entry.delta;
  return Number.isInteger(d.owned) && isObj(d.nodes) && Object.values(d.nodes).every((n) => isObj(n) && typeof n.name === 'string')
    && Array.isArray(d.edges) && d.edges.every((e) => isObj(e) && typeof e.src === 'string' && typeof e.dst === 'string'
      && Number.isInteger(e.line) && Number.isInteger(e.col) && typeof e.kind === 'string')
    && [d.counts, d.unresolved].every((c) => isObj(c) && Object.values(c).every(Number.isInteger))
    && isObj(d.samples) && Object.values(d.samples).every(strs) && strs(d.errors) && strs(d.placeholders) && strs(d.broken)
    && Object.values(entry.member).every((v) => typeof v === 'boolean');
}

function cached(k) {
  let text;
  try { text = fs.readFileSync(k.file, 'utf8'); } catch (e) { why('no entry'); return null; }
  let entry;
  try { entry = JSON.parse(text); } catch (e) { entry = null; }
  if (!wellFormed(entry)) {
    why(entry && entry.format !== FORMAT ? 'format' : 'corrupt');
    try { fs.unlinkSync(k.file); } catch (e) { /* gone */ }
    return null;
  }
  for (const [q, v] of Object.entries(entry.member)) {
    const [kind, f] = q.split('\0');
    if ((kind === 'repo' ? repoSet : kind === 'test' ? testSet : null)?.has(f) !== v) { why('files'); return null; }
  }
  for (const [q, v] of Object.entries(entry.probe)) {
    if (answer(q) !== v) { why(q.startsWith('readFile') ? 'content' : q.startsWith('workspace') ? 'workspace package' : 'lookup'); return null; }
  }
  const now = new Date();
  try { fs.utimesSync(k.file, now, now); } catch (e) { /* read-only: still usable */ }   // used: kept longer
  return entry;
}

// written whole or not at all: a temporary file renamed over the entry, so a crash or another run at
// the same time never leaves a half-written entry behind
function save(k, r, d) {
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    const ignore = path.join(CACHE, '.gitignore');          // local to this checkout, never committed
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const tmp = `${k.file}.${process.pid}.tmp`;
    // the checksum covers everything read back: the questions and answers that decide whether the
    // entry is used, and the results replayed; a changed or missing byte that still parses is caught
    fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, sum: checksum(r.probe, r.member, d), probe: r.probe, member: r.member, delta: d }));
    fs.renameSync(tmp, k.file);
    // the entries this one replaces: the same program before a change
    for (const f of fs.readdirSync(CACHE)) {
      if (f.startsWith(k.program + '-') && f.endsWith('.json') && path.join(CACHE, f) !== k.file) { fs.unlinkSync(path.join(CACHE, f)); cacheStats.removed++; }
    }
  } catch (e) { why('not saved'); }            // a full disk or a read-only checkout: the next run analyzes again
}

// entries no run has used for KEEP_DAYS, temporary files a stopped run left, and, beyond MAX_MB, the
// least recently used; the size is reported
function prune() {
  let list;
  try { list = fs.readdirSync(CACHE); } catch (e) { return; }
  const now = Date.now();
  const kept = [];
  for (const f of list) {
    const p = path.join(CACHE, f);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    const age = now - st.mtimeMs;
    // an entry this format does not name so (an earlier codemap's): never read, so removed
    const foreign = f.endsWith('.json') && !/^[0-9a-f]{12}-[0-9a-f]{40}\.json$/.test(f);
    if ((f.endsWith('.tmp') && age > 3600e3) || foreign || (f.endsWith('.json') && age > KEEP_DAYS * 86400e3 && !fresh.has(p))) {
      try { fs.unlinkSync(p); cacheStats.removed++; } catch (e) { /* gone */ }
    } else if (f.endsWith('.json')) kept.push([p, st.size, st.mtimeMs]);
  }
  kept.sort((a, b) => b[2] - a[2]);
  let total = 0;
  for (const [p, size] of kept) {
    if (total + size > MAX_MB * 1048576 && !fresh.has(p)) { try { fs.unlinkSync(p); cacheStats.removed++; } catch (e) { /* gone */ } continue; }
    total += size;
    cacheStats.entries++;
  }
  cacheStats.mb = Math.round(total / 1048576 * 10) / 10;
}

// one line per run in log.jsonl (the last 1,000 runs): how often the cache is hit in real use, how big
// it gets, and why programs are rebuilt
function logRun(ms) {
  try {
    const f = path.join(CACHE, 'log.jsonl');
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch (e) { /* first run */ }
    lines.push(JSON.stringify({ at: new Date().toISOString(), ms, programs: groups.size, ...cacheStats }));
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-1000).join('\n') + '\n');
    fs.renameSync(tmp, f);
  } catch (e) { /* a read-only checkout: no log */ }
}

// what one program adds to the run's results
let before = null;
function snapshot() {
  before = { edges: edges.length, counts: Object.assign({}, counts), unresolved: Object.assign({}, unresolved),
    samples: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.length])), errors: errors.length,
    placeholders: new Set(placeholders), broken: new Set(broken), files };
}
function delta() {
  const sub = (a, b) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v - (b[k] || 0)]).filter(([, v]) => v));
  return {
    owned: files - before.files,
    nodes: Object.fromEntries([...rec.touched].map((id) => [id, nodes[id]])),
    edges: edges.slice(before.edges),
    counts: sub(counts, before.counts),
    unresolved: sub(unresolved, before.unresolved),
    samples: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.slice(before.samples[k] || 0)]).filter(([, v]) => v.length)),
    errors: errors.slice(before.errors),
    placeholders: [...placeholders].filter((p) => !before.placeholders.has(p)),
    broken: [...broken].filter((b) => !before.broken.has(b)),
  };
}
function replay(d) {
  for (const [id, n] of Object.entries(d.nodes)) {
    if (!nodes[id]) nodes[id] = Object.assign({}, n);
    else if (n.placeholder) nodes[id].placeholder = true;
  }
  for (const e of d.edges) {
    edges.push(e);
    seenEdge.add(e.kind === 'implements' ? ['impl', e.src, e.dst].join('\0') : [e.src, e.dst, e.line - 1, e.col - 1, e.kind].join('\0'));
  }
  for (const [k, v] of Object.entries(d.counts)) counts[k] = (counts[k] || 0) + v;
  for (const [k, v] of Object.entries(d.unresolved)) unresolved[k] = (unresolved[k] || 0) + v;
  for (const [k, v] of Object.entries(d.samples)) (samples[k] = samples[k] || []).push(...v);
  errors.push(...d.errors);
  for (const p of d.placeholders) placeholders.add(p);
  for (const b of d.broken) broken.add(b);
}

// ---------------------------------------------------------------------------
// one program

function analyze(group) {
  const c = group.config;
  const options = Object.assign({}, c ? c.options : DEFAULTS, { noEmit: true });
  if (group.owned.some(isJs)) { options.allowJs = true; options.checkJs = false; }
  // what a config emits does not change what the code means; rootDir of one merged config would
  // flag every other config's files
  for (const k of EMIT_ONLY) if (k !== 'configFilePath' && k !== 'noEmit' && k !== 'pathsBasePath') delete options[k];
  const rootNames = new Set(group.owned.map((f) => path.join(root, f)));
  if (c) for (const k of group.configs) for (const f of k.names) rootNames.add(path.join(root, f));
  else for (const f of input.files) if (isDts(f)) rootNames.add(path.join(root, f));
  const prof = PROFILE ? { configs: group.configs.map((k) => k.rel), roots: rootNames.size, files: {} } : null;
  let tp = Date.now();
  const program = ts.createProgram({ rootNames: [...rootNames], options, host: hostFor(options, prof) });
  const checker = program.getTypeChecker();
  const owned = group.owned.map((f) => program.getSourceFile(path.join(root, f))).filter(Boolean);
  const isTestFile = (n) => tests.has(rel(n.getSourceFile().fileName));
  const programMs = Date.now() - tp;
  phase.program += programMs;

  // type checking: the owned files' diagnostics check them, and the declarations they use; what is
  // extracted afterwards reads the checker's caches
  tp = Date.now();
  for (const sf of owned) {
    const r = inRepo(sf);
    if (!r || isDts(r)) continue;
    try {
      const diags = program.getSemanticDiagnostics(sf).concat(program.getSyntacticDiagnostics(sf)).filter((x) => x.category === ts.DiagnosticCategory.Error);
      if (diags.length) {
        broken.add(r);
        for (const x of diags.slice(0, 50)) {
          const lc = x.start !== undefined ? sf.getLineAndCharacterOfPosition(x.start) : { line: 0 };
          errors.push(`${r}:${lc.line + 1}: TS${x.code} ${ts.flattenDiagnosticMessageText(x.messageText, ' ')}`);
        }
      }
    } catch (e) { broken.add(r); }
  }
  const checkMs = Date.now() - tp;
  phase.check += checkMs;

  // the values given to each variable, field and parameter, from every file of the program
  tp = Date.now();
  const assigns = new Map();
  // one key per declared variable or property: the same prop seen through a union, an intersection or
  // a mapped type (React's JSX props) is a different symbol object, with the same root declaration
  const keyOf = (sym) => {
    const r = checker.getRootSymbols(sym)[0] || sym;
    return (r.declarations && r.declarations[0]) || r;
  };
  const put = (sym, e) => { if (sym) { const k = keyOf(sym); if (!assigns.has(k)) assigns.set(k, []); assigns.get(k).push(e); } };
  const valuesOf = (sym) => assigns.get(keyOf(sym)) || [];
  const symOf = (n) => { const s = n && checker.getSymbolAtLocation(n); return s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s; };
  // subclasses: class declaration -> classes that extend it
  const subs = new Map();
  const classes = [];
  for (const sf of owned) {
    (function walk(n) {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) put(symOf(n.name), n.initializer);
      else if (ts.isPropertyDeclaration(n) && n.initializer) put(symOf(n.name), n.initializer);
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const l = skipOuter(n.left);
        put(symOf(ts.isPropertyAccessExpression(l) ? l.name : l), n.right);
      } else if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
        // {onSave: save} given to a parameter or variable of a declared type: the property of that type
        const t = checker.getContextualType(n.parent);
        const p = t && memberName(n, sf) && checker.getPropertyOfType(t, memberName(n, sf));
        if (p) put(p, n.initializer);
      } else if (ts.isJsxAttribute(n) && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
        // <Editor onSave={save} />: the onSave property of Editor's props
        const t = checker.getContextualType(n.parent);
        const p = t && checker.getPropertyOfType(t, n.name.getText(sf));
        if (p) put(p, n.initializer.expression);
      } else if (ts.isClassLike(n)) {
        classes.push(n);
        const ext = (n.heritageClauses || []).find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
        const b = ext && symOf(ext.types[0].expression);
        const bd = b && (b.declarations || []).find(ts.isClassLike);
        if (bd) { if (!subs.has(bd)) subs.set(bd, []); subs.get(bd).push(n); }
      }
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments && n.arguments.length) {
        // run(() => ...), new Button(save): the parameters of the repository's function get the arguments
        const sig = checker.getResolvedSignature(n);
        const decl = sig && sig.declaration;
        if (decl && decl.parameters && !outside(decl)) {
          n.arguments.forEach((a, i) => {
            const p = decl.parameters[Math.min(i, decl.parameters.length - 1)];
            if (p && ts.isIdentifier(p.name) && (i < decl.parameters.length || p.dotDotDotToken)) put(symOf(p.name), a);
          });
        }
      }
      ts.forEachChild(n, walk);
    })(sf);
  }

  let extractMs = Date.now() - tp;
  function classDeclOf(t) {
    const s = t && (t.getSymbol() || (t.aliasSymbol));
    return s && (s.declarations || []).find(ts.isClassLike);
  }

  function ownMember(cls, name) {
    for (const m of cls.members) {
      if (memberName(m, cls.getSourceFile()) !== name) continue;
      if (fnLike(m) && m.body) return m;
      if (ts.isPropertyDeclaration(m) && valueFn(skipOuter(m.initializer))) return m;
    }
    return null;
  }

  // methods of the classes below cls that override name (production code only, for production call sites)
  function overrides(cls, name, prod, seen = new Set()) {
    const out = [];
    for (const s of subs.get(cls) || []) {
      if (seen.has(s) || (prod && isTestFile(s))) continue;
      seen.add(s);
      const m = ownMember(s, name);
      if (m && idOf(m)) out.push({ id: idOf(m), how: 'override', type: s.name ? s.name.text : null });
      out.push(...overrides(s, name, prod, seen));
    }
    return out;
  }

  // the classes of the repository that implement an interface: implements clauses (through bases and
  // interfaces that extend it), or, for one of the repository's own, its shape
  function implementers(ifaceType, name, prod, explicitOnly) {
    const out = [];
    const isym = ifaceType.getSymbol() || ifaceType.aliasSymbol;
    for (const k of classes) {
      if (prod && isTestFile(k)) continue;
      if (explicitOnly && !(k.heritageClauses || []).length) continue;
      if (!inRepo(k.getSourceFile())) continue;
      const kt = checker.getTypeAtLocation(k.name || k);
      const prop = checker.getPropertyOfType(kt, name);
      if (!prop) continue;
      let yes = declares(k, isym);
      if (!yes && !explicitOnly && checker.isTypeAssignableTo) yes = checker.isTypeAssignableTo(kt, ifaceType);
      if (!yes) continue;
      const d = (prop.declarations || []).find((x) => idOf(x));
      if (d) out.push({ id: idOf(d), how: 'interface', type: k.name ? k.name.text : null, cls: k });
    }
    return out;
  }

  function declares(k, isym, seen = new Set()) {
    if (!isym || seen.has(k)) return false;
    seen.add(k);
    for (const h of k.heritageClauses || []) {
      for (const t of h.types) {
        const s = symOf(t.expression);
        if (!s) continue;
        if (s === isym) return true;
        for (const d of s.declarations || []) if ((ts.isClassLike(d) || ts.isInterfaceDeclaration(d)) && declares(d, isym, seen)) return true;
      }
    }
    return false;
  }

  // what a value can be when it is called: functions, closures, methods handed on
  function fnValues(e, prod, depth = 0, seen = new Set()) {
    e = skipOuter(e);
    if (!e || depth > 4) return { ts: [], partial: true };
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return { ts: [], partial: false };
    if (valueFn(e)) {
      const id = idOf(e);
      return id ? { ts: [{ id, how: 'closure' }], partial: false } : { ts: [], partial: true };
    }
    if (ts.isConditionalExpression(e)) return join([fnValues(e.whenTrue, prod, depth + 1, seen), fnValues(e.whenFalse, prod, depth + 1, seen)]);
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
      const r = fnValues(e.right, prod, depth + 1, seen);
      return e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? r : join([fnValues(e.left, prod, depth + 1, seen), r]);
    }
    if (ts.isCallExpression(e)) {
      const callee = skipOuter(e.expression);
      // f.bind(x): f
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') return fnValues(callee.expression, prod, depth + 1, seen);
      // React's wrappers give back the function they wrap: useCallback(fn, deps), forwardRef(fn), memo(fn)
      if (e.arguments.length && fromReact(callee, ['useCallback', 'forwardRef', 'memo'])) return fnValues(e.arguments[0], prod, depth + 1, seen);
      // a function that returns a function: what it returns
      const sig = checker.getResolvedSignature(e);
      const decl = sig && sig.declaration;
      if (decl && fnLike(decl) && decl.body && inRepo(decl.getSourceFile()) && !seen.has(decl)) {
        seen.add(decl);
        const rets = [];
        if (!ts.isBlock(decl.body)) rets.push(decl.body);
        else (function walk(n) { if (ts.isReturnStatement(n) && n.expression) rets.push(n.expression); if (!fnLike(n)) ts.forEachChild(n, walk); })(decl.body);
        if (rets.length) return join(rets.map((r) => fnValues(r, prod, depth + 1, seen)), 'returned');
      }
      return { ts: [], partial: true };
    }
    const target = ts.isPropertyAccessExpression(e) ? e.name : e;
    if (!ts.isIdentifier(target) && !ts.isPrivateIdentifier(target)) return { ts: [], partial: true };
    const raw = checker.getSymbolAtLocation(target);
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && unknownAlias(checker.getSymbolAtLocation(e.expression))) {
      const p = placeholder(checker.getSymbolAtLocation(e.expression));     // Primitive.Root of a missing package
      return p ? { ts: [{ id: ext(p + '.' + e.name.text, lastMissing), how: 'funcvalue' }], partial: false } : { ts: [], partial: true };
    }
    if (unknownAlias(raw)) {                     // a package that is not installed: known by its import
      const p = placeholder(raw);
      return p ? { ts: [{ id: ext(p, lastMissing), how: 'funcvalue' }], partial: false } : { ts: [], partial: true };
    }
    const s = symOf(target);
    if (!s) return { ts: [], partial: true };
    const decls = s.declarations || [];
    if (decls.length && decls.every(outside)) {      // a library's function or value (const Check: LucideIcon)
      return { ts: [{ id: ext(placeholder(raw, false) || extName(decls[0])), how: 'funcvalue' }], partial: false };
    }
    const named = decls.map((d) => (fnLike(d) || ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d) || ts.isBinaryExpression(d.parent)) && idOf(d)).filter(Boolean);
    if (named.length) {
      const how = ts.isPropertyAccessExpression(e) && decls.some((d) => ts.isMethodDeclaration(d) || ts.isPropertyDeclaration(d)) ? 'methodvalue' : 'funcvalue';
      return { ts: [...new Set(named)].map((id) => ({ id, how })), partial: false };
    }
    if (seen.has(s)) return { ts: [], partial: false };
    seen.add(s);
    let vals = valuesOf(s).filter((v) => !(prod && isTestFile(v)));
    // {check: Check}: an object's property is what it was written as
    for (const d of decls) if (ts.isPropertyAssignment(d) && !outside(d)) vals = vals.concat([d.initializer]);
    // function Editor({onSave}): what callers give the onSave property
    for (const be of decls.filter((x) => ts.isBindingElement(x) && ts.isObjectBindingPattern(x.parent))) {
      const p = checker.getPropertyOfType(checker.getTypeAtLocation(be.parent), (be.propertyName || be.name).getText());
      if (p) vals = vals.concat(valuesOf(p).filter((v) => !(prod && isTestFile(v))));
    }
    const isParam = decls.some((d) => ts.isParameter(d) || ts.isBindingElement(d));
    if (!vals.length) return { ts: [], partial: true };
    const r = join(vals.map((v) => fnValues(v, prod, depth + 1, seen)));
    if (isParam) r.partial = true;            // a caller may pass anything
    return r;
  }

  function join(rs, how) {
    const out = { ts: [], partial: false };
    for (const r of rs) {
      out.ts.push(...r.ts.map((t) => (how && t.how === 'closure' ? Object.assign({}, t, { how }) : t)));
      out.partial = out.partial || r.partial;
    }
    return out;
  }

  // the classes and object literals a receiver was given, when all of them are known
  function concrete(e, prod) {
    e = skipOuter(e);
    const target = ts.isPropertyAccessExpression(e) ? e.name : e;
    if (!ts.isIdentifier(target) && !ts.isPrivateIdentifier(target)) return null;
    const s = symOf(target);
    if (!s || (s.declarations || []).some((d) => ts.isParameter(d) || ts.isBindingElement(d))) return null;
    const vals = valuesOf(s).filter((v) => !(prod && isTestFile(v)));
    if (!vals.length) return null;
    const out = [];
    for (let v of vals) {
      v = skipOuter(v);
      if (v.kind === ts.SyntaxKind.NullKeyword) continue;
      if (ts.isNewExpression(v)) {
        const k = (symOf(v.expression)?.declarations || []).find(ts.isClassLike);
        if (!k || !inRepo(k.getSourceFile())) return null;
        out.push({ type: checker.getTypeAtLocation(v), how: 'constructor', name: k.name ? k.name.text : null });
      } else if (ts.isObjectLiteralExpression(v)) {
        out.push({ type: checker.getTypeAtLocation(v), how: 'assign', name: null });
      } else return null;
    }
    return out.length ? out : null;
  }

  // new C(): C's constructor, an inherited one, or the class itself when none is written
  function ctorTarget(cls) {
    for (let k = cls; k; ) {
      // a repository class whose constructor is inherited from a library: the class itself
      if (outside(k)) return { id: k === cls ? ext(extName(k)) : idOf(cls) };
      const ctor = k.members.find((m) => ts.isConstructorDeclaration(m) && m.body);
      if (ctor) return { id: idOf(ctor) };
      const e = (k.heritageClauses || []).find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
      const b = e && symOf(e.types[0].expression);
      const bd = b && (b.declarations || []).find(ts.isClassLike);
      if (!bd) return { id: idOf(cls) };
      k = bd;
    }
    return null;
  }

  // a name from a module that could not be found: known by its import only
  // the package a name is imported from, following re-exports of the repository
  // (export { expect } from '@playwright/test'): "spec.name", or null for none
  function placeholder(s, record = true) {
    lastMissing = false;
    for (let i = 0; s && i < 8; i++) {
      const d = (s.declarations || [])[0];
      if (!d) return null;
      let imp = d;
      while (imp && !ts.isImportDeclaration(imp) && !ts.isImportEqualsDeclaration(imp) && !ts.isExportDeclaration(imp)) imp = imp.parent;
      if (!imp) return null;
      const spec = ts.isImportEqualsDeclaration(imp)
        ? imp.moduleReference && imp.moduleReference.expression && imp.moduleReference.expression.text
        : imp.moduleSpecifier && imp.moduleSpecifier.text;
      if (spec && !spec.startsWith('.')) {
        const orig = ts.isImportSpecifier(d) || ts.isExportSpecifier(d) ? (d.propertyName || d.name).text : null;
        // a package that could not be found; a name a found package does not export is not one
        const missing = !ts.isExportDeclaration(imp) && !checker.getSymbolAtLocation(ts.isImportEqualsDeclaration(imp) ? imp.moduleReference.expression : imp.moduleSpecifier);
        lastMissing = missing;
        if (record && missing) placeholders.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
        return spec + (orig && orig !== 'default' ? '.' + orig : '');
      }
      if (!checker.getImmediateAliasedSymbol) return null;
      s = checker.getImmediateAliasedSymbol(s);           // a file of the repository: what it re-exports
    }
    return null;
  }

  // a function a library handed back: const [x, setX] = useState(), const { mutate } = useMutation(...).
  // The function is the library's; named by its declared type (react.Dispatch) when it has one, by the
  // library function that returned it otherwise. Only with types: without them nothing is known.
  function fromLibrary(decl, nameNode) {
    let v = decl;
    while (v && ts.isBindingElement(v)) v = v.parent.parent;           // pattern -> its declaration
    if (!v || !ts.isVariableDeclaration(v) || !v.initializer) return null;
    let init = skipOuter(v.initializer);
    if (ts.isAwaitExpression(init)) init = skipOuter(init.expression);
    if (!ts.isCallExpression(init)) return null;
    const callee = skipOuter(init.expression);
    const cs = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    const real = cs && cs.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(cs) : cs;
    const cd = real && (real.declarations || [])[0];
    if (!cd || !outside(cd)) return null;
    const t = checker.getTypeAtLocation(nameNode);
    if (!t.getCallSignatures().length) return null;
    const alias = t.aliasSymbol && (t.aliasSymbol.declarations || [])[0];
    if (alias && outside(alias)) return ext(extName(alias));
    const sig = t.getCallSignatures()[0].declaration;
    if (sig && outside(sig) && !ts.isFunctionTypeNode(sig)) return ext(extName(sig));
    return ext((placeholder(cs, false) || extName(cd)) + '()');
  }

  // a call of one of React's functions, by its types or, when React is not installed, by its import
  function fromReact(callee, names) {
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    if (!ts.isIdentifier(nameNode) || !names.includes(nameNode.text)) return false;
    const raw = checker.getSymbolAtLocation(nameNode);
    const s = raw && raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
    const d = s && (s.declarations || [])[0];
    if (d && outside(d)) return pkgOf(d.getSourceFile().fileName) === 'react';
    const imp = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      ? placeholder(checker.getSymbolAtLocation(callee.expression), false) : placeholder(raw, false);
    return imp === 'react' || imp === 'react.' + nameNode.text;
  }

  function unknownAlias(s) {
    if (!s || !(s.flags & ts.SymbolFlags.Alias)) return false;
    const a = checker.getAliasedSymbol(s);
    return !a || !a.declarations || a.declarations.length === 0;
  }

  // repository classes that say they implement an outside interface, per interface symbol
  const explicitCache = new Map();
  function explicitlyImplemented(t, name) {
    const s = t.getSymbol() || t.aliasSymbol;
    if (!s) return false;
    if (!explicitCache.has(s)) explicitCache.set(s, implementers(t, name, false, true).length > 0 || classes.some((k) => (k.heritageClauses || []).length && declares(k, s)));
    return explicitCache.get(s);
  }

  // the targets of a name used as a function: {ts, res} or null
  function byName(nameNode, prod, whole) {
    let s = checker.getSymbolAtLocation(nameNode);
    if (!s) return null;
    if (unknownAlias(s)) {
      const p = placeholder(s);
      return p ? { ts: [{ id: ext(p, lastMissing) }], res: 'exact' } : null;
    }
    // a name imported from a package: named by the import, as when the package is not installed
    const imported = s.flags & ts.SymbolFlags.Alias ? placeholder(s, false) : null;
    if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    const decls = s.declarations || [];
    if (imported && decls.length && decls.every(outside)) return { ts: [{ id: ext(imported) }], res: 'exact' };
    // a function, method or named function value: the name decides
    // declarations merged from several outside files (fetch in lib.dom and @types/node) are one name
    const fnDecls = decls.filter((d) => fnLike(d) || idOf(d));
    const ids = fnDecls.length && fnDecls.every(outside) ? [ext(extName(fnDecls[0]))]
      : [...new Set(fnDecls.map(target).filter(Boolean))];
    if (ids.length) return { ts: ids.map((id) => ({ id })), res: 'exact' };
    // a variable, field or parameter that holds a function
    const vars = decls.filter((d) => ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d) || ts.isPropertyDeclaration(d)
      || ts.isPropertySignature(d) || ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d));
    if (vars.length && vars.every(outside)) return { ts: [{ id: ext(extName(vars[0])) }], res: 'exact' };
    if (vars.length) {
      const v = fnValues(whole || nameNode, prod);
      if (v.ts.length) return { ts: v.ts.map((t) => Object.assign({ partial: v.partial }, t)), res: 'inferred' };
      const lib = fromLibrary(vars[0], nameNode);
      return lib ? { ts: [{ id: lib, how: 'returned' }], res: 'inferred' } : null;
    }
    // an outside class or enum member called as a function: named
    if (decls.length && outside(decls[0])) return { ts: [{ id: ext(extName(decls[0])) }], res: 'exact' };
    return null;
  }

  // obj.name(...): the receiver decides
  function byMember(obj, name, nameNode, whole, prod) {
    obj = skipOuter(obj);
    if (obj.kind === ts.SyntaxKind.SuperKeyword) {
      const s = checker.getSymbolAtLocation(nameNode);
      const d = s && (s.declarations || [])[0];
      const id = d && target(d);
      return id ? { ts: [{ id, how: 'super' }], res: 'exact' } : null;
    }
    // a module, namespace, class (static), enum or named object: the name decides
    const objName = ts.isPropertyAccessExpression(obj) ? obj.name : obj;
    const os = ts.isIdentifier(objName) ? checker.getSymbolAtLocation(objName) : null;
    if (unknownAlias(os)) {
      const p = placeholder(os);
      return p ? { ts: [{ id: ext(p + '.' + name, lastMissing) }], res: 'exact' } : null;
    }
    const real = os && os.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(os) : os;
    if (real) {
      const isConstObject = (real.declarations || []).some((d) => ts.isVariableDeclaration(d) && d.initializer
        && ts.isObjectLiteralExpression(skipOuter(d.initializer)) && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const);
      if (real.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.Enum | ts.SymbolFlags.Class) || isConstObject) {
        const imported = os !== real && ts.isIdentifier(obj) ? placeholder(os, false) : null;
        const m = imported && checker.getSymbolAtLocation(nameNode);
        if (m && (m.declarations || []).length && m.declarations.every(outside)) return { ts: [{ id: ext(imported + '.' + name) }], res: 'exact' };
        const r = byName(nameNode, prod, whole);
        if (r) return r;
      }
    }
    const recv = checker.getTypeAtLocation(obj);
    const parts = recv.isUnion() ? recv.types : [recv];
    const self = obj.kind === ts.SyntaxKind.ThisKeyword;
    let out = [];
    let partial = false;
    let res = 'exact';
    let narrow = false;
    for (const t of parts) {
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) { partial = true; continue; }
      if (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Void)) continue;
      const prop = checker.getPropertyOfType(checker.getApparentType(t), name);
      const decls = (prop && prop.declarations) || [];
      if (!decls.length) { partial = true; continue; }
      const d = decls.find((x) => idOf(x)) || decls[0];
      const owner = d.parent;
      const ts0 = t.aliasSymbol || t.getSymbol();
      const tname = ts0 ? checker.symbolToString(ts0) : null;
      if (!idOf(d) && !outside(d)) {
        // a field or property that holds a function: what was stored in it
        const v = fnValues(whole, prod);
        if (v.ts.length) {
          out.push(...v.ts.map((x) => Object.assign({}, x, { type: tname, how: x.how === 'closure' ? 'field' : x.how })));
          res = 'inferred';
          partial = partial || v.partial;
        } else partial = true;
        continue;
      }
      if (owner && ts.isClassLike(owner)) {
        const id = target(d);
        const cls = classDeclOf(t) || owner;
        const over = idOf(d) ? overrides(cls, name, prod) : [];
        const abstract = fnLike(d) && !d.body;
        if (!(abstract && over.length)) out.push({ id, how: self ? 'this' : 'type', type: tname });
        if (over.length) { out.push(...over); res = abstract && over.length === 1 ? 'inferred' : 'ambiguous'; narrow = true; }
        continue;
      }
      if (owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner))) {
        const extIface = outside(d);
        // an outside interface no class of the repository says it implements (Array, Console,
        // a library's types): the method of that type, as for a class
        if (extIface && !explicitlyImplemented(t, name)) { out.push({ id: target(d), how: 'type', type: tname }); continue; }
        const impl = extIface ? [] : implementers(t, name, prod, false);
        narrow = true;
        if (impl.length) {
          out.push(...impl.map(({ id, how, type }) => ({ id, how, type })));
          res = impl.length === 1 && res !== 'ambiguous' ? 'inferred' : 'ambiguous';
        } else {
          // nothing in the production code implements it, or it is an outside interface the
          // repository implements: the interface method itself, certain as the method called,
          // not as the code that runs
          const id = target(d);
          if (id) { ifaceUsed.set(id, { type: t, name, ext: extIface, tname }); out.push({ id, how: 'interface', type: tname }); }
        }
        continue;
      }
      // an object literal's member, a declared function, ...
      const id = target(d);
      if (id) out.push({ id, how: self ? 'this' : 'type', type: tname });
      else partial = true;
    }
    // the values the receiver was given decide it when its type leaves several targets
    if (narrow) {
      const got = concrete(obj, prod);
      if (got) {
        const narrowed = [];
        for (const g of got) {
          const p = checker.getPropertyOfType(g.type, name);
          const d = p && (p.declarations || []).find((x) => idOf(x));
          if (!d) { narrowed.length = 0; break; }
          narrowed.push({ id: idOf(d), how: g.how, type: g.name });
        }
        if (narrowed.length) return { ts: narrowed, res: 'inferred' };
      }
    }
    if (!out.length) return null;
    return { ts: out.map((x) => Object.assign({ partial }, x)), res };
  }

  function resolve(callee, prod) {
    callee = skipOuter(callee);
    if (valueFn(callee)) return { ts: [{ id: idOf(callee), how: 'closure' }], res: 'exact' };
    if (ts.isIdentifier(callee)) return byName(callee, prod);
    if (ts.isPropertyAccessExpression(callee)) return byMember(callee.expression, callee.name.text, callee.name, callee, prod);
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
      return byMember(callee.expression, callee.argumentExpression.text, callee.argumentExpression, callee, prod);
    }
    // f()(), table[k](): what the expression can hold
    const v = fnValues(callee, prod);
    if (v.ts.length) return { ts: v.ts.map((t) => Object.assign({ partial: v.partial }, t)), res: 'inferred' };
    return null;
  }

  function emit(owner, at, kind, r) {
    const sf = at.getSourceFile();
    const lc = sf.getLineAndCharacterOfPosition(at.getStart(sf));
    const file = rel(sf.fileName);
    let tsx = [];
    const seen = new Set();
    for (const t of r.ts) if (t.id && !seen.has(t.id) && t.id !== owner) { seen.add(t.id); tsx.push(t); }
    if (!tsx.length) return false;
    let res = r.res;
    if (res !== 'exact' && (tsx.length > 1 || tsx[0].partial)) res = 'ambiguous';
    if (res === 'exact' && tsx.length > 1) res = 'ambiguous';
    for (const t of tsx) {
      const key = [owner, t.id, lc.line, lc.character, kind].join('\0');
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      const e = { src: owner, dst: t.id, file, line: lc.line + 1, col: lc.character + 1, kind, source: 'static', resolution: res };
      if (t.how) e.infer = { how: t.how, type: t.type || null };
      else if (decorating && kind === 'call') e.infer = { how: 'decorator', type: null };
      if (t.how && t.partial) e.infer.partial = true;
      edges.push(e);
      count(res);
    }
    return true;
  }

  tp = Date.now();
  for (const sf of owned) {
    const d = define(sf);
    if (!d.rel) continue;
    Object.assign(nodes, d.nodes);
    if (rec) for (const id of Object.keys(d.nodes)) rec.touched.add(id);
    const module = `${d.rel}:<module>`;
    const prod = !tests.has(d.rel);
    const callees = new Set();

    const call = (owner, site, callee, kind) => {
      const r = resolve(callee, prod);
      if (!r || !emit(owner, site, kind, r)) miss(kind === 'jsx' ? 'jsx' : ts.isPropertyAccessExpression(skipOuter(callee)) ? 'member' : 'value', callee);
    };

    (function walk(n, owner) {
      // a decorator runs once, when its class is defined, not when the method it marks is called
      if (ts.isDecorator(n)) {
        let k = n.parent;
        while (k && !ts.isClassLike(k)) k = k.parent;
        decorating++;
        walk(n.expression, k && d.map.get(k) || owner);
        decorating--;
        return;
      }
      if (d.map.has(n) && (fnLike(n) || ts.isClassLike(n))) {
        const id = d.map.get(n);
        if (d.anon.has(n) && !callees.has(n)) emit(owner, n, 'ref', { ts: [{ id, how: 'closure' }], res: 'exact' });
        owner = id;
      }
      if (ts.isCallExpression(n)) {
        const callee = skipOuter(n.expression);
        callees.add(callee);
        if (callee.kind === ts.SyntaxKind.SuperKeyword) {
          let k = n.parent;
          while (k && !ts.isClassLike(k)) k = k.parent;
          const e = k && (k.heritageClauses || []).find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
          const bd = e && (symOf(e.types[0].expression)?.declarations || []).find(ts.isClassLike);
          const t = bd && ctorTarget(bd);
          if (t && t.id) emit(owner, n, 'call', { ts: [{ id: t.id, how: 'super' }], res: 'exact' });
        } else if (callee.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(callee) && callee.text === 'require' && !checker.getSymbolAtLocation(callee))) {
          call(owner, n, callee, 'call');
        }
      } else if (ts.isNewExpression(n)) {
        const s = symOf(n.expression);
        const k = s && (s.declarations || []).find(ts.isClassLike);
        const imported = ts.isIdentifier(n.expression) && k && outside(k) ? placeholder(checker.getSymbolAtLocation(n.expression), false) : null;
        const t = imported ? { id: ext(imported) } : k ? ctorTarget(k) : s && s.declarations && s.declarations.length && outside(s.declarations[0]) ? { id: ext(extName(s.declarations[0])) } : null;
        if (t && t.id) emit(owner, n, 'call', { ts: [{ id: t.id, how: 'new' }], res: 'exact' });
        else if (s && unknownAlias(checker.getSymbolAtLocation(n.expression) || s)) {
          const p = placeholder(checker.getSymbolAtLocation(n.expression));
          if (p) emit(owner, n, 'call', { ts: [{ id: ext(p, lastMissing), how: 'new' }], res: 'exact' });
        } else miss('new', n.expression);
        callees.add(skipOuter(n.expression));
      } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = n.tagName;
        if (!(ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) && tag.kind !== ts.SyntaxKind.ThisKeyword) {
          callees.add(tag);
          const s = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(tag) ? tag.name : tag);
          const real = s && s.flags & ts.SymbolFlags.Alias && !unknownAlias(s) ? checker.getAliasedSymbol(s) : s;
          const k = real && (real.declarations || []).find(ts.isClassLike);
          let r = null;
          if (k) {
            const render = ownMember(k, 'render');
            r = { ts: [{ id: render ? idOf(render) : idOf(k) || ext(extName(k)), how: 'jsx' }], res: 'exact' };
          } else {
            r = resolve(tag, prod);
            if (r) r.ts = r.ts.map((t) => Object.assign({}, t, { how: t.how || 'jsx' }));
          }
          if (!r || !emit(owner, n, 'call', r)) miss('jsx', tag);
        }
      } else if (ts.isTaggedTemplateExpression(n)) {
        callees.add(skipOuter(n.tag));
        const r = resolve(n.tag, prod);
        if (r) emit(owner, n, 'call', r);
      } else if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && !callees.has(n) && valuePosition(n)) {
        // a function handed on as a value: registered, stored, passed as a callback
        const s = symOf(ts.isPropertyAccessExpression(n) ? n.name : n);
        const decl = s && (s.declarations || []).find((x) => idOf(x) && (fnLike(x) || ts.isVariableDeclaration(x) || ts.isPropertyDeclaration(x) || ts.isPropertyAssignment(x)) && isFunctionNode(x));
        if (decl) emit(owner, n, 'ref', { ts: [{ id: idOf(decl), how: ts.isPropertyAccessExpression(n) ? 'methodvalue' : 'funcvalue' }], res: 'exact' });
        if (ts.isPropertyAccessExpression(n)) { walk(n.expression, owner); return; }
      } else if (ts.isShorthandPropertyAssignment(n)) {
        const s = checker.getShorthandAssignmentValueSymbol(n);
        const real = s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
        const decl = real && (real.declarations || []).find((x) => idOf(x) && isFunctionNode(x));
        if (decl) emit(owner, n, 'ref', { ts: [{ id: idOf(decl), how: 'funcvalue' }], res: 'exact' });
        return;
      }
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
      if (ts.isPropertyAccessExpression(n)) { walk(n.expression, owner); return; }   // its name is not a value of its own
      ts.forEachChild(n, (c) => walk(c, owner));
    })(sf, module);
  }

  extractMs += Date.now() - tp;
  phase.extract += extractMs;
  if (prof) {
    for (const c of Object.values(prof.files)) { c.kb = Math.round(c.kb); c.parse_ms = Math.round(c.parse_ms); }
    if (global.gc) global.gc();
    Object.assign(prof, { program_ms: programMs, check_ms: checkMs, extract_ms: extractMs,
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576), owned: owned.length });
    profile.push(prof);
  }

  function isFunctionNode(decl) {
    const id = idOf(decl);
    const n = id && nodes[id] || (id && define(decl.getSourceFile()).nodes[id]);
    return n && (n.kind === 'function' || n.kind === 'method');
  }

  // repository classes linked to the interface methods calls go to: implements relations, not calls
  for (const [id, u] of ifaceUsed) {
    for (const im of implementers(u.type, u.name, false, u.ext)) {
      const n = nodes[im.id] || define(im.cls.getSourceFile()).nodes[im.id];
      if (!n) continue;
      const key = ['impl', im.id, id].join('\0');
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ src: im.id, dst: id, file: n.file, line: n.line, col: 1, kind: 'implements', source: 'static', resolution: 'exact', infer: { how: 'implements', type: u.tname || null } });
      count('implements');
    }
  }
  ifaceUsed.clear();
  return { program, owned: owned.length };
}

function valuePosition(n) {
  const p = n.parent;
  if (!p) return false;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) return (p.arguments || []).includes(n);
  if (ts.isJsxExpression(p)) return true;
  if (ts.isVariableDeclaration(p)) return p.initializer === n;
  if (ts.isPropertyAssignment(p)) return p.initializer === n;
  if (ts.isPropertyDeclaration(p)) return p.initializer === n;
  if (ts.isReturnStatement(p) || ts.isArrayLiteralExpression(p)) return true;
  if (ts.isBinaryExpression(p)) return p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  if (ts.isConditionalExpression(p)) return p.whenTrue === n || p.whenFalse === n;
  if (ts.isArrowFunction(p)) return p.body === n;
  return false;
}

let files = 0;
const started = Date.now();
const slow = [];
for (const [, g] of groups) {
  const t0 = Date.now();
  const name = g.configs.map((c) => c.rel).join(' + ') || '(default options)';
  try {
    const key = CACHE ? programKey(g) : null;
    const hit = key && cached(key);
    if (hit) {
      replay(hit.delta);
      files += hit.delta.owned;
      cacheStats.replayed++;
      fresh.add(key.file);
    } else {
      if (key) { rec = { probe: {}, member: {}, touched: new Set() }; snapshot(); }
      files += analyze(g).owned;
      if (key) { save(key, rec, delta()); rec = null; cacheStats.rebuilt++; fresh.add(key.file); }
    }
    slow.push([name + (hit ? ' (cached)' : ''), Date.now() - t0]);
  } catch (e) {
    rec = null;
    errors.push(`${g.config ? g.config.rel : '(default options)'}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e}`);
  }
}
if (CACHE) { prune(); logRun(Date.now() - started); }

for (const n of Object.values(nodes)) if (n.defined && broken.has(n.file)) n.types_incomplete = true;
for (const e of edges) {
  if (e.src.endsWith(':<module>') && !nodes[e.src]) {
    const f = e.src.slice(0, -9);
    let end = 1;
    try { end = fs.readFileSync(path.join(root, f), 'utf8').split('\n').length; } catch (x) { /* gone */ }
    nodes[e.src] = { name: path.posix.basename(f), file: f, line: 1, end, defined: true, lang: isJs(f) ? 'javascript' : 'typescript', kind: 'module' };
  }
}
const langs = {};
for (const f of input.files) if (!isDts(f)) { const l = isJs(f) ? 'javascript' : 'typescript'; langs[l] = (langs[l] || 0) + 1; }
const top = Object.entries(unresolved).sort((a, b) => b[1] - a[1]).slice(0, 20);
process.stdout.write(JSON.stringify({
  nodes, edges,
  stats: {
    files, languages: langs, ...(CACHE ? { cache: cacheStats } : {}), nodes: Object.values(nodes).filter((n) => n.defined).length, edges: edges.length,
    programs: groups.size, typescript: ts.version, ms: Date.now() - started,
    max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024), slowest_programs: slow.sort((a, b) => b[1] - a[1]).slice(0, 5), resolution: counts, unresolved_top: top, errors,
    placeholders: [...placeholders].sort(), incomplete_files: broken.size,
    ...(PROFILE ? { profile, loaded: (() => {
      // per category: different files, and loads of them over all programs
      const o = {};
      for (const [f, n] of loadedBy) { const k = category(f); const c = o[k] = o[k] || { files: 0, loads: 0 }; c.files++; c.loads += n; }
      return o;
    })() } : {}),
    ...(process.env.CODEMAP_TS_DEBUG ? { unresolved_samples: samples, phase,
      groups: [...groups.values()].map((g) => [g.configs.map((c) => c.rel), g.owned.length, g.owned.slice(0, 3)]) } : {}),
  },
}));
