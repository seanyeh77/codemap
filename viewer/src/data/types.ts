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
}

export interface Doc {
  text: string
  file: string
  line: number
}

export interface Link {
  a: string
  b: string
  n: number
  kind: 'call' | 'env' | 'interpose' | 'channel'
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
  state?: { name: string; file: string; line: number; static: boolean; users: [string, number][] }[]
  /** In a snapshot only; live, the Check page asks the server. */
  checks?: CheckFile[]
  config: { cc: string | null; scope: string[] | null }
}

export interface Capabilities {
  rebuild: boolean
  macro: boolean
}

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
