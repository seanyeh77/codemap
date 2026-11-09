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
}

export interface Edge {
  s: string
  d: string
  f: string
  l: number
  /** call, fnptr_assign, fnptr_pass, fnptr_table, indirect_saved, indirect_candidate, constructor, destructor, env */
  k: string
  src: 'compiler' | 'rule'
  rule?: string
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
  edges: number | null
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
  phases?: Record<string, { name: string; from: string }[]>
  /** What the Makefile builds and installs, read from `make -n`. Null when there is no Makefile. */
  build?: BuildInfo | null
  /** Calls that create or write a file. */
  writes?: FileWrite[]
  /** Facts worth a look: calls that end the process, fixed-size global arrays, getenv results used unchecked. */
  worth?: {
    stops: { fid: string; f: string; l: number; name: string }[]
    arrays: { name: string; file: string; line: number; size: string; text: string; value?: string }[]
    env: { fid: string; f: string; l: number; use: number; name: string | null }[]
    /** variables set only when not set already */
    env_if_unset?: { name: string; fid: string; f: string; l: number; check: number }[]
    /** fixed error codes handed back: return ENOSYS, errno = EAGAIN */
    errors?: { code: string; fid: string; f: string; l: number; how: 'return' | 'errno' }[]
    /** file-scope variables changed with a plain store, not an atomic operation */
    plain_writes?: { name: string; file: string; line: number; static: boolean; writes: { fid: string; f: string; l: number; text: string }[] }[]
  }
  /** In a snapshot only; live, the Check page asks the server. */
  checks?: CheckFile[]
  config: { cc: string | null; scope: string[] | null }
}

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
