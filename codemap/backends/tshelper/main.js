'use strict';
// codemap TypeScript/JavaScript helper: the TypeScript compiler API resolves the calls.
//
// Input (stdin, JSON): {root, files, tests, configs, ts}
//   files    the repository's TS/JS files, paths from the root, .d.ts included (types only, never nodes)
//   tests    the files that are test code: their values, subclasses and implementations are left out
//            of what production call sites resolve to
//   configs  tsconfig*.json / jsconfig.json files, paths from the root
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
const repo = new Set(input.files);
const tests = new Set(input.tests || []);
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
const ifaceUsed = new Map();    // interface member id -> {decl, name, ext}: the targets of exact interface calls

function count(k, n = 1) { counts[k] = (counts[k] || 0) + n; }
function miss(why) { unresolved[why] = (unresolved[why] || 0) + 1; count('unresolved'); }

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

const configs = (input.configs || []).map(loadConfig).filter(Boolean);
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

const groups = new Map();
for (const f of input.files) {
  if (isDts(f)) continue;
  const c = groupOf(f);
  const key = c ? c.rel : '';
  if (!groups.has(key)) groups.set(key, { config: c, owned: [] });
  groups.get(key).owned.push(f);
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

  // a value given a name: const f = () => ..., const C = class {...}, const api = {...}
  function bound(decl, init, qual, owner, kind) {
    const v = skipOuter(init);
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
  return id;
}

// ---------------------------------------------------------------------------
// one program

function analyze(group) {
  const c = group.config;
  const options = Object.assign({}, c ? c.options : DEFAULTS, { noEmit: true });
  if (group.owned.some(isJs)) { options.allowJs = true; options.checkJs = false; }
  delete options.outDir; delete options.composite; delete options.incremental; delete options.tsBuildInfoFile;
  const rootNames = new Set(group.owned.map((f) => path.join(root, f)));
  if (c) for (const f of c.names) rootNames.add(path.join(root, f));
  else for (const f of input.files) if (isDts(f)) rootNames.add(path.join(root, f));
  const program = ts.createProgram({ rootNames: [...rootNames], options });
  const checker = program.getTypeChecker();
  const owned = group.owned.map((f) => program.getSourceFile(path.join(root, f))).filter(Boolean);
  const isTestFile = (n) => tests.has(rel(n.getSourceFile().fileName));

  // the values given to each variable, field and parameter, from every file of the program
  const assigns = new Map();
  const put = (sym, e) => { if (sym) { if (!assigns.has(sym)) assigns.set(sym, []); assigns.get(sym).push(e); } };
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
      // useCallback(fn, deps): fn
      const s = symOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      const d = s && (s.declarations || [])[0];
      if (d && !inRepo(d.getSourceFile()) && s.name === 'useCallback' && e.arguments.length) return fnValues(e.arguments[0], prod, depth + 1, seen);
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
    const s = symOf(target);
    if (!s) return { ts: [], partial: true };
    const decls = s.declarations || [];
    const named = decls.map((d) => (fnLike(d) || ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d) || ts.isBinaryExpression(d.parent)) && idOf(d)).filter(Boolean);
    if (named.length) {
      const how = ts.isPropertyAccessExpression(e) && decls.some((d) => ts.isMethodDeclaration(d) || ts.isPropertyDeclaration(d)) ? 'methodvalue' : 'funcvalue';
      return { ts: [...new Set(named)].map((id) => ({ id, how })), partial: false };
    }
    if (seen.has(s)) return { ts: [], partial: false };
    seen.add(s);
    let vals = (assigns.get(s) || []).filter((v) => !(prod && isTestFile(v)));
    // function Editor({onSave}): what callers give the onSave property
    for (const be of decls.filter((x) => ts.isBindingElement(x) && ts.isObjectBindingPattern(x.parent))) {
      const p = checker.getPropertyOfType(checker.getTypeAtLocation(be.parent), (be.propertyName || be.name).getText());
      if (p) vals = vals.concat((assigns.get(p) || []).filter((v) => !(prod && isTestFile(v))));
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
    const vals = (assigns.get(s) || []).filter((v) => !(prod && isTestFile(v)));
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
      if (outside(k)) return { id: ext(extName(k)) };
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
        if (record) placeholders.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
        return spec + (orig && orig !== 'default' ? '.' + orig : '');
      }
      if (!checker.getImmediateAliasedSymbol) return null;
      s = checker.getImmediateAliasedSymbol(s);           // a file of the repository: what it re-exports
    }
    return null;
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
      return p ? { ts: [{ id: ext(p, true) }], res: 'exact' } : null;
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
      return null;
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
      return p ? { ts: [{ id: ext(p + '.' + name, true) }], res: 'exact' } : null;
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
      if (t.how && t.partial) e.infer.partial = true;
      edges.push(e);
      count(res);
    }
    return true;
  }

  for (const sf of owned) {
    const d = define(sf);
    if (!d.rel) continue;
    Object.assign(nodes, d.nodes);
    const module = `${d.rel}:<module>`;
    const prod = !tests.has(d.rel);
    const callees = new Set();
    try {
      const diags = program.getSemanticDiagnostics(sf).concat(program.getSyntacticDiagnostics(sf)).filter((x) => x.category === ts.DiagnosticCategory.Error);
      if (diags.length) {
        broken.add(d.rel);
        for (const x of diags.slice(0, 50)) {
          const lc = x.start !== undefined ? sf.getLineAndCharacterOfPosition(x.start) : { line: 0 };
          errors.push(`${d.rel}:${lc.line + 1}: TS${x.code} ${ts.flattenDiagnosticMessageText(x.messageText, ' ')}`);
        }
      }
    } catch (e) { broken.add(d.rel); }

    const call = (owner, site, callee, kind) => {
      const r = resolve(callee, prod);
      if (!r || !emit(owner, site, kind, r)) miss(kind === 'jsx' ? 'jsx' : ts.isPropertyAccessExpression(skipOuter(callee)) ? 'member' : 'value');
    };

    (function walk(n, owner) {
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
          if (p) emit(owner, n, 'call', { ts: [{ id: ext(p, true), how: 'new' }], res: 'exact' });
        } else miss('new');
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
          if (!r || !emit(owner, n, 'call', r)) miss('jsx');
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
for (const [, g] of groups) {
  try {
    files += analyze(g).owned;
  } catch (e) {
    errors.push(`${g.config ? g.config.rel : '(default options)'}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e}`);
  }
}

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
    files, languages: langs, nodes: Object.values(nodes).filter((n) => n.defined).length, edges: edges.length,
    programs: groups.size, typescript: ts.version, resolution: counts, unresolved_top: top, errors,
    placeholders: [...placeholders].sort(), incomplete_files: broken.size,
  },
}));
