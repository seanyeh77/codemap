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
  /** an ambiguous call's column: tells the candidates of one call from those of another on its line */
  c?: number
  /** an ambiguous call whose candidates are all outside methods of one name (String.toString,
   *  Number.toString): shown as one group of outside candidates, each edge kept */
  eg?: boolean
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
  /** no comment speaks for the whole component: each file's first comment, so files of different roles are told apart */
  file_docs?: { file: string; text: string; line: number }[]
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
  /** the analyzers that read the code: gcc, python, go, typescript, syntax-* */
  backends?: string[]
  /** per backend: the call texts that most often had no target, with their counts */
  /** per backend: the calls most often left unresolved, how many, and up to five places each */
  unresolved?: Record<string, [string, number, [string, number][]?][]>
  /** framework adapters that ran */
  frameworks?: string[]
  /** functions defined in test files */
  tests?: number
  /** ambiguous edges and call sites per backend: candidates in the repository, or only outside methods of one name */
  ambiguity?: Record<string, { repo_edges: number; repo_sites: number; external_edges: number; external_sites: number }>
  /** the compiler that read each backend's files: version and where it came from */
  compilers?: Record<string, { version: string; source?: string
    /** the program cache of this run: programs replayed and rebuilt (with why), entries kept, their size, entries removed */
    cache?: { replayed: number; rebuilt: number; why: Record<string, number>; entries: number; mb: number; removed: number } }>
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
  /** .codemap/rules.json "roles": a path or folder -> whether the project lets people change it. */
  roles?: Record<string, 'editable' | 'protected'>
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
  /** argparse programs: how to start each, its commands (python3 harness/lab3.py status --json) and the
   *  functions each command runs. Older graphs lack it. */
  cli?: CliProgram[]
  /** Python: functions started in the background (hub.spawn, threading.Thread, asyncio.create_task) */
  spawns?: { fid: string; f: string; l: number; call: string; target: string }[]
  /** test functions taken out of the graph while the tests setting is off (filled in by the viewer) */
  /** per function, how many test functions call it while the tests setting is off (filled in by the viewer) */
  hidden_callers?: Record<string, number>
  hidden_tests?: { id: string; name: string; file: string; line: number; comp: string }[]
  /** Python: files the code opens to read (open() without a writing mode, read_text, read_bytes) */
  reads?: FileWrite[]
  /** commands a Python program runs: the command line as written, and for a wrapper (_run(namespace, argv)) each call that fills it in */
  commands?: { fid: string; f: string; l: number; call: string; cmd: string; timeout?: string; shell?: string; via?: { fid: string; f: string; l: number; cmd: string }[] }[]
  docs?: DocSummary[]
  /** Facts worth a look: calls that end the process, fixed-size global arrays, getenv results used unchecked. */
  worth?: {
    stops: { fid: string; f: string; l: number; name: string }[]
    arrays: { name: string; file: string; line: number; size: string; text: string; value?: string }[]
    env: { fid: string; f: string; l: number; use: number; name: string | null }[]
    /** variables set only when not set already */
    env_if_unset?: { name: string; fid: string; f: string; l: number; check: number; says?: boolean; how?: 'setdefault' }[]
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
    /** Python: except Exception (or bare) whose handler does not raise again */
    broad?: { fid: string; f: string; l: number; what: string; then: string }[]
    /** the languages each check reads (writes, stops, arrays, ...): c, python, go, typescript */
    covers?: Record<string, string[]>
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
  /** source files changed on disk after the index was built */
  changed?: string[]
  repo: string
  commit: string | null
  dirty: string[]
}

/** The selected function, and the edge it was reached through (a call site or a rule's evidence line). */
// reveal: a file:line was clicked for this selection (a new number each click); the panel scrolls that line into view
export interface CliArg { name: string; opt: boolean; choices?: string[]; choices_from?: string; choices_at?: number; handled?: Record<string, [string, number]>; default?: string; help?: string; action?: string; nargs?: string; metavar?: string; required?: boolean }
export interface CliCommand { name: string; l: number; help?: string; args?: CliArg[]; run: string[]; at?: [number, number] }
export interface CliProgram { f: string; l: number; prog: string; help?: string; dispatch?: string; main?: string; args?: CliArg[]; cmds: CliCommand[] }

export interface Sel { id: string; edge: Pick<Edge, 'f' | 'l'> & Partial<Edge> | null; key: string | null; reveal?: number }

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
  /** a name that comes in as a parameter: what each caller passes */
  via?: { fid: string; f: string; l: number; name: string }[]
}
