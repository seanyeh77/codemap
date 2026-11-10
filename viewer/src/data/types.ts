// Shapes returned by `codemap serve` (/api/*) and stored in .codemap snapshots.
// Keep in sync with codemap/view.py.

export interface Func {
  name: string
  file: string
  line: number
  end: number
  comp: string
  /** It has the name of this external library's function and replaces it (LD_PRELOAD): entered from outside the repo. */
  api?: string
  /** First line of the comment and attributes right above the definition, when there are any. */
  top?: number
  /** Atomic operations in its body, e.g. 'fetch_add acq_rel'. */
  atomics?: string[]
  /** Snapshot only: the function's source lines, starting at line. */
  src?: string[]
  /** Not C: python, java, go, typescript, javascript, html, css */
  lang?: string
  /** Not a plain function: method, class, module (code at the top of a file), page, stylesheet */
  kind?: string
  /** A framework calls it by itself: a route handler, a test, an event handler */
  entry?: { framework: string; kind: string; text: string }
  decorators?: string[]
  /** defined in a test file */
  scope?: 'test'
  /** Go: its package did not type-check fully; calls inside may be missing */
  types_incomplete?: boolean
}

/** How an edge is known: the first three are calls written in the code, the last two are inferred. */
export type EdgeSource = 'compiler' | 'static' | 'syntax' | 'rule' | 'framework'
export const inferred = (e: { src: EdgeSource }) => e.src === 'rule' || e.src === 'framework'
/** Not certain: inferred by a rule or framework, or one of several possible targets, or matched on a name alone. */
export const uncertain = (e: Edge) => inferred(e) || e.resolution === 'ambiguous' || e.by === 'name'
/** A call written in the code, whichever backend read it. */
export const written = (e: { src: EdgeSource }) => !inferred(e)

export interface Edge {
  s: string
  d: string
  f: string
  l: number
  /** call, fnptr_assign, fnptr_pass, fnptr_table, indirect_saved, indirect_candidate, constructor, destructor, env */
  k: string
  src: EdgeSource
  rule?: string
  /** syntax: the receiver's type is unknown, matched on a method name defined once in the repo */
  by?: 'name'
  /** static: exact (the name decides it), inferred (a type did), ambiguous (one of several targets) */
  resolution?: 'exact' | 'inferred' | 'ambiguous'
  /** static: how the receiver's type was found, and the type */
  infer?: { how: string; type: string | null; partial?: boolean }
  /** the target is in a package codemap could not read: known by name only */
  ph?: boolean
  /** Go: a call run as a goroutine (go) or when the function returns (defer) */
  mode?: 'go' | 'defer'
  via?: string
  slot?: string
  /** table_install: the table the function is listed in */
  table?: string
  saved_from?: string
  name?: string
  read_at?: string
  /** Name of the target when it is not a function of the repository. */
  dn?: string
  /** Header that declares an external target. */
  ext?: string
  /** The source line at f:l, the evidence for this edge. */
  t?: string
}

export interface Comp {
  id: string
  files: number
  funcs: number
  shared: boolean
  layer: number | null
  callers: number
  /** What it is for: the top comment of its main file, and where that comment is. */
  doc?: Doc
  /** python: a group of Python tools, not C code (no functions are indexed) */
  lang?: 'python'
  /** python: its scripts, and the first line of each one's docstring */
  scripts?: string[]
  docs?: Record<string, string>
}

export interface Doc {
  text: string
  file: string
  line: number
  /** written for the component in .codemap/rules.json (describe), not taken from a file's comment */
  own?: boolean
}

export interface Link {
  a: string
  b: string
  n: number
  /** runs: a Python tool starts a program built from b; reads: it parses a header of b */
  kind: 'call' | 'env' | 'interpose' | 'channel' | 'runs' | 'reads'
  api?: string
  /** channel: the shared component the data goes through, and the name given in rules.json. */
  via?: string
  label?: string
  names?: string[]
  /** interpose: each hooked call, by caller and line. */
  sites?: { s: string; f: string; l: number; name: string }[]
}

export interface CheckItem {
  at: string
  line: number
  text: string
  status: 'done' | 'fail' | 'review'
  /** What a match rests on: calls the compiler confirmed, names seen on the referenced lines, or only that the lines exist. */
  basis?: 'calls' | 'syntax' | 'names' | 'exists' | null
  why: string
  /** the same explanation as templates and values, to show in the reader's language */
  msgs?: { t: string; v: Record<string, string | number | string[] | null> }[]
  /** A corrected line when a reference is wrong; both keep their backticks. */
  fix?: { before: string; after: string } | null
}

export interface CheckFile {
  file: string
  refs: number
  claims: number
  items: CheckItem[]
}

export interface Stats {
  units: number | null
  failed: number | null
  funcs: number
  /** compiler-confirmed calls */
  edges: number | null
  /** calls tree-sitter matched by name */
  syntax?: number
  /** calls the Python analyzer resolved */
  static?: number
  /** the analyzers' results per backend (python, go): exact, inferred, ambiguous, unresolved, builtin */
  resolution?: Record<string, Record<string, number>>
  /** files read per language */
  languages?: Record<string, number>
  /** framework adapters that ran */
  frameworks?: string[]
  /** functions defined in test files */
  tests?: number
  /** the compiler that read each backend's files: version and where it came from */
  compilers?: Record<string, { version: string; source?: string }>
  /** per backend: type-checker messages, packages read as placeholders, packages with incomplete types */
  limits?: Record<string, { messages: number; placeholders: string[]; incomplete: number }>
}

export interface Graph {
  format: 'codemap-snapshot'
  version: number
  repo: string
  root: string
  host: string
  commit: string | null
  dirty: string[]
  generated: number
  stats: Stats
  comps: Comp[]
  links: Link[]
  funcs: Record<string, Func>
  edges: Edge[]
  /** File-scope variables used by two or more functions: [function id, first line that uses it]. Older graphs lack it. */
  /** Each file's top comment (or its header's). Older graphs lack it. */
  files?: Record<string, Doc>
  /** Every environment variable the rules found: where it is set and where it is read. */
  env?: Record<string, { set: string[]; get: string[] }>
  /** Files the server may show whole: sources, headers, Makefiles, linker maps. */
  readable?: string[]
  /** Macros and file-scope variables, to search by name. */
  symbols?: { name: string; kind: 'macro' | 'var'; file: string; line: number; text: string }[]
  state?: { name: string; file: string; line: number; static: boolean; users: [string, number][] }[]
  /** Stages of a long function's calls, from .codemap/rules.json: function name -> [{name, from}]. */
  /** How the C code reads each variable: flag, number, text or presence; its value when unset; where it is stored.
   *  purpose and default with own: written in .codemap/rules.json (env). */
  env_info?: Record<string, { comments?: { text: string; at: string; defines: boolean }[]; kind?: 'flag' | 'number' | 'text' | 'presence'; default?: string | null; into?: string | null; via?: string; at?: string; purpose?: string; own?: boolean }>
  phases?: Record<string, { name: string | Record<string, string>; from: string }[]>
  /** What the Makefile builds and installs, read from `make -n`. Null when there is no Makefile. */
  build?: BuildInfo | null
  /** Calls that create or write a file. */
  writes?: FileWrite[]
  docs?: DocSummary[]
  /** Facts worth a look: calls that end the process, fixed-size global arrays, getenv results used unchecked. */
  worth?: {
    stops: { fid: string; f: string; l: number; name: string }[]
    arrays: { name: string; file: string; line: number; size: string; text: string; value?: string }[]
    env: { fid: string; f: string; l: number; use: number; name: string | null }[]
    /** variables set only when not set already */
    env_if_unset?: { name: string; fid: string; f: string; l: number; check: number; says?: boolean }[]
    /** fixed error codes handed back: return ENOSYS, errno = EAGAIN */
    errors?: { code: string; fid: string; f: string; l: number; how: 'return' | 'errno' }[]
    /** file-scope variables changed with a plain store, not an atomic operation */
    plain_writes?: { name: string; file: string; line: number; static: boolean; writes: { fid: string; f: string; l: number; text: string }[] }[]
    /** a count reaching a MAX constant: returns without a word (silent), or prints first (said) */
    limits?: { silent: Limit[]; said: Limit[] }
    /** counters of what is given up (rd->lost += n): the calls that lead there and the prints that report it */
    loss?: { fid: string; f: string; l: number; var: string; text: string; via: { fid: string; f: string; l: number }[]; said: { fid: string; f: string; l: number }[] }[]
    /** what stays after the process ends unless removed (shm_open with O_CREAT), who removes it, and calls that end the program in the components that make it */
    leftovers?: { fid: string; f: string; l: number; call: string; remove: string; removed: { fid: string; f: string; l: number; via: string[] }[]; stops: { fid: string; f: string; l: number; name: string }[] }[]
  }
  /** Calls inside #if/#ifdef blocks the compiler did not record, by the function called. */
  uncompiled?: Record<string, { f: string; l: number; cond: string; by: string }[]>
  /** Function definitions inside #if/#ifdef blocks the build leaves out. */
  uncompiled_funcs?: { name: string; f: string; line: number; end: number; cond: string }[]
  /** In a snapshot only; live, the Check page asks the server. */
  checks?: CheckFile[]
  config: { cc: string | null; scope: string[] | null }
}

export interface Limit { fid: string; f: string; l: number; cond: string; limit: string }

export interface Capabilities {
  rebuild: boolean
  macro: boolean
  /** /api/grep: search the text of the source files */
  grep?: boolean
}

/** A line of source text that contains the search words. */
export interface GrepHit { file: string; line: number; text: string }

export interface Meta {
  host: string
  root: string
  capabilities: Capabilities
  indexed: number
  repo: string
  commit: string | null
  dirty: string[]
}

/** The selected function, and the edge it was reached through (a call site or a rule's evidence line). */
export interface Sel { id: string; edge: Pick<Edge, 'f' | 'l'> & Partial<Edge> | null; key: string | null }

export interface SourceLines {
  file: string
  start: number
  lines: string[]
}

export interface BuildProduct {
  name: string
  path: string
  /** exec: executable, shared / static: library, generated: a file made by a command (sed, a script) */
  kind: 'exec' | 'shared' | 'static' | 'generated'
  /** the make goal that builds it: the default goal first */
  goal: string
  comps: string[]
  files: string[]
  libs: string[]
  /** version scripts that decide what a library exports */
  exports: string[]
  /** other products and libraries linked in */
  uses: string[]
}

export interface BuildInfo {
  goal: string
  built: BuildProduct[]
  install: { what: string[]; to: string; link?: boolean }[]
}

/** A project document: its first heading and first sentence, and how many source files name it. */
export interface DocSummary {
  file: string
  title: string
  text: string
  cited: number
}

export interface FileWrite {
  fid: string
  f: string
  l: number
  call: string
  /** the file name, when the code writes it out */
  name?: string
  /** the name is only known when the program runs */
  runtime?: boolean
  /** the format the name is built from */
  format?: string
  /** the function's parameter the name comes in */
  param?: string
  /** the expression that holds the name */
  expr?: string
}
