import type { Edge, Func, Graph } from './types'

/** How deep the impact list goes. */
export const MAX_DEPTH = 6

/** An edge that passes an environment variable from one function to another. */
export const isEnv = (e: Edge) => e.k === 'env'

/** Lookups over one graph: callers, callees and names. */
/** The rules of codemap/rules.py, as the explanations name them. */
const RULE_NAME: Record<string, string> = {
  fnptr_assign: '函式指標賦值', fnptr_pass: '函式當作參數或表格內容', indirect: '經由函式指標呼叫', ctor: 'constructor / destructor', env: '環境變數',
}

export class Index {
  readonly funcs: Record<string, Func>
  readonly out = new Map<string, Edge[]>()
  readonly inn = new Map<string, Edge[]>()
  private files: Map<string, string[]> | null = null
  readonly g: Graph

  constructor(g: Graph) {
    this.g = g
    this.funcs = g.funcs
    for (const e of g.edges) {
      push(this.out, e.s, e)
      push(this.inn, e.d, e)
    }
  }

  nameOf(id: string, e?: Partial<Edge> | null): string {
    const bare = this.bareName(id, e)
    return !this.funcs[id] && e?.saved_from ? '原本的 ' + bare : bare
  }

  /** The name alone, without 原本的 before a replaced function. */
  bareName(id: string, e?: Partial<Edge> | null): string {
    const f = this.funcs[id]
    if (f) return f.name
    if (e?.saved_from) return e.saved_from.split(/->|\./).pop()!
    if (e?.k === 'constructor') return '程式載入時'   // run by the loader, not called by a function
    if (e?.k === 'destructor') return '程式結束時'
    if (e?.k === 'fnptr_table' && id === e.s) return `表格 ${e.slot}`   // a file-scope table, not a function
    return e?.dn || id
  }

  /** Calls only (an environment variable is listed in search instead), one per other end and line. */
  private calls(list: Edge[] | undefined, other: (e: Edge) => string, keep: (e: Edge) => boolean): Edge[] {
    const seen = new Set<string>()
    return (list ?? []).filter((e) => {
      const k = other(e) + '@' + e.l
      if (isEnv(e) || !keep(e) || seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  /** What a function calls, in line order; external functions only when asked. */
  callees(id: string, showExt: boolean): Edge[] {
    return this.calls(this.out.get(id), (e) => e.d, (e) => !!this.funcs[e.d] || showExt || e.src === 'rule')
      .sort((a, b) => a.l - b.l)
  }

  /** Who calls a function, one row per call site, by file and line. */
  callers(id: string): Edge[] {
    return this.calls(this.inn.get(id), (e) => e.s, (e) => !!this.funcs[e.s] || e.src === 'rule')
      .sort((a, b) => a.f.localeCompare(b.f) || a.l - b.l)
  }

  /** How many different functions call this one. */
  callerCount(id: string): number {
    return new Set(this.callers(id).filter((e) => this.funcs[e.s]).map((e) => e.s)).size
  }

  /** How many different functions in the repo this one calls. */
  calleeCount(id: string): number {
    return new Set(this.callees(id, false).filter((e) => this.funcs[e.d]).map((e) => e.d)).size
  }

  /** Each file's functions in line order. */
  byFile(): Map<string, string[]> {
    if (!this.files) {
      this.files = new Map()
      for (const [id, f] of Object.entries(this.funcs)) push(this.files, f.file, id)
      for (const ids of this.files.values()) ids.sort((a, b) => this.funcs[a].line - this.funcs[b].line)
    }
    return this.files
  }

  /** How an edge was found, in plain words: the tag, and the explanation behind its question mark. */
  explain(e: Edge): { label: string; title: string; text: string } {
    const id = e.d, to = '`' + this.bareName(id, e) + '`'
    if (e.src === 'compiler') {
      if (!this.funcs[id]) {
        return { label: '外部', title: '外部函式', text: `不在此 repo 中${e.ext ? `，宣告於 \`${e.ext}\`` : ''}。` }
      }
      return { label: '編譯器確認', title: '編譯器確認', text: '重新編譯時記錄到的呼叫，存在於目前的 build。' }
    }
    const tail = `由規則「${RULE_NAME[e.rule ?? ''] ?? e.rule}」推得，編譯器無法確認。`
    let text: string
    if (e.k === 'fnptr_pass') text = `${this.bareName(e.s)} 把 ${to} 當作參數傳給 \`${e.slot}()\`，可能由它呼叫。${tail}`
    else if (e.k === 'fnptr_table') text = `${to} 列在表格 \`${e.slot}\` 裡，可能經由這張表被呼叫。${tail}`
    else if (e.k === 'fnptr_assign') text = `${to} 存入 \`${e.slot ?? '函式指標'}\`，可能經由此指標被呼叫。${tail}`
    else if (e.k === 'indirect_saved') text = `經由 \`${e.via}\` 呼叫替換前的 \`${e.saved_from}\`。${tail}`
    else if (e.k === 'indirect_candidate') text = `經由 \`${e.via ?? '函式指標'}\` 呼叫 ${to}。${tail}`
    else if (e.k === 'constructor' || e.k === 'destructor') text = e.k === 'constructor'
      ? '標記為 `constructor`：dynamic loader 載入程式或程式庫時，在 main 之前自動執行。以 LD_PRELOAD 載入的程式庫常用它做初始化。'
      : '標記為 `destructor`：程式結束或程式庫卸載時自動執行。'
    else text = `由規則「${e.rule}」推得，編譯器無法確認。`
    return { label: '推測（規則）', title: '推測（規則）', text }
  }

  /** The function a file:line falls in, for links in notes such as `ops.c:175`. */
  at(ref: string): { id: string; edge: { f: string; l: number } } | null {
    const m = /^(.*?):(\d+)/.exec(ref)
    if (!m) return null
    const ln = Number(m[2])
    // an exact path, or a suffix only one file has (the check calls a suffix wrong but suggests that file as the fix)
    const files = this.byFile()
    const hits = files.has(m[1]) ? [m[1]] : [...files.keys()].filter((f) => f.endsWith('/' + m[1]))
    if (hits.length !== 1) return null
    let best: string | null = null
    for (const id of files.get(hits[0])!) {
      const f = this.funcs[id]
      if (f.line <= ln && f.end >= ln) best = id         // in line order, so the innermost start wins
    }
    return best ? { id: best, edge: { f: this.funcs[best].file, l: ln } } : null
  }

  /** A sensible first function to show: the one that calls the most functions, outside shared components. */
  firstFunc(): string | null {
    const shared = new Set(this.g.comps.filter((c) => c.shared).map((c) => c.id))
    let best: string | null = null, n = -1
    for (const [id, f] of Object.entries(this.funcs)) {
      if (shared.has(f.comp)) continue
      const k = this.callees(id, false).length
      if (k > n) { best = id; n = k }
    }
    return best
  }
}

/** Add v to the list at m[k]. */
export function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}
