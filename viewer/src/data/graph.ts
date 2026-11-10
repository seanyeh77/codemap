import type { Edge, Func, Graph } from './types'
import { list, t } from '../i18n'

/** How deep the impact list goes. */
export const MAX_DEPTH = 6

/** An edge that passes an environment variable from one function to another. */
export const isEnv = (e: Edge) => e.k === 'env'

/** Lookups over one graph: callers, callees and names. */
/** The rules of codemap/rules.py, as the explanations name them. */
const RULE_NAME: Record<string, string> = {
  fnptr_assign: '函式指標賦值', table_install: '從表格取出函式指標再寫入', param_call: '經由參數呼叫傳入的函式', fnptr_pass: '函式當作參數或表格內容', indirect: '經由函式指標呼叫', ctor: 'constructor / destructor', env: '環境變數',
}
const ruleName = (r?: string) => (RULE_NAME[r ?? ''] ? t(RULE_NAME[r ?? '']) : r ?? '')
/** The same rules in a word or two, for the tag on a line of the flow tree: 「推測（規則：指標賦值）」. */
const RULE_TAG: Record<string, string> = {
  fnptr_assign: '指標賦值', table_install: '表格安裝', param_call: '參數呼叫', fnptr_pass: '當作參數', indirect: '指標呼叫', ctor: 'constructor', env: '環境變數',
}
const ruleTag = (r?: string) => (r ? t('推測（規則：{v1}）', { v1: RULE_TAG[r] ? t(RULE_TAG[r]) : r }) : t('推測（規則）'))

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
    return !this.funcs[id] && e?.saved_from ? t('原本的 {name}', { name: bare }) : bare
  }

  /** The name alone, without 原本的 before a replaced function. */
  bareName(id: string, e?: Partial<Edge> | null): string {
    const f = this.funcs[id]
    if (f) return f.name
    if (e?.saved_from) return e.saved_from.split(/->|\./).pop()!
    if (e?.k === 'constructor') return t('程式載入時')   // run by the loader, not called by a function
    if (e?.k === 'destructor') return t('程式結束時')
    if (e?.k === 'fnptr_table' && id === e.s) return t('表格 {name}', { name: e.slot ?? '' })   // a file-scope table, not a function
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

  /** Who calls a function, split the same way on every page: functions the compiler saw, functions a
   *  rule inferred, inferred sources that are not functions (a table, the loader), and the loader. */
  callerInfo(id: string): { sure: number; guessed: number; others: string[]; load: 'constructor' | 'destructor' | null; names: string[]; main: boolean } {
    const sure = new Set<string>(), guessed = new Set<string>(), others = new Set<string>()
    let load: 'constructor' | 'destructor' | null = null
    for (const e of this.callers(id)) {
      if (e.k === 'constructor' || e.k === 'destructor') load = e.k
      else if (!this.funcs[e.s]) others.add(this.nameOf(e.s, e))
      else (e.src === 'rule' ? guessed : sure).add(e.s)
    }
    for (const s of guessed) if (sure.has(s)) guessed.delete(s)
    // the names, compiler-seen first; main of a program is called by the C runtime, never by the repo
    const names = [...sure, ...guessed].map((s) => this.funcs[s].name)
    return { sure: sure.size, guessed: guessed.size, others: [...others], load, names, main: this.funcs[id]?.name === 'main' && !names.length }
  }

  /** The caller count as one short phrase: 「2 個 caller，其中 1 個是推測」. */
  callerText(id: string): string {
    const c = this.callerInfo(id)
    const n = c.sure + c.guessed
    // nothing in the repo calls it, but a program outside does: say that rather than 「0 caller」
    if (!n && !c.others.length && !c.load && this.funcs[id]?.api) return t('外部進入點：被追蹤的程式呼叫 {v1} 的同名函式時執行', { v1: this.funcs[id].api })
    if (!n && c.main) return t('0 個 caller：程式的起點，由 C 執行環境在程式啟動時呼叫')
    const parts = [t('{n} 個 caller', { n }) + (c.guessed ? (c.guessed === n ? t('（推測）') : t('，其中 {n} 個是推測', { n: c.guessed })) : '')
      + (n ? t('：{v1}', { v1: list(c.names.slice(0, 3)) + (n > 3 ? t(' 等') : '') }) : '')]
    if (c.others.length) parts.push(t('另有推測的來源：{names}', { names: list(c.others.slice(0, 2)) }))
    if (c.load) parts.push(c.load === 'constructor' ? t('程式載入時自動執行') : t('程式結束時自動執行'))
    const left = this.g.uncompiled?.[id]?.length
    if (left) parts.push(t('另有 {v1} 處在條件編譯裡，這次的 build 沒有編進去', { v1: left }))
    return parts.join(t('；'))
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
        return { label: t('外部'), title: t('外部函式'), text: e.ext ? t('不在此 repo 中，宣告於 `{file}`。', { file: e.ext }) : t('不在此 repo 中。') }
      }
      return { label: t('編譯器確認'), title: t('編譯器確認'), text: t('重新編譯時記錄到的呼叫，存在於目前的 build。') }
    }
    const tail = t('由規則「{rule}」推得，編譯器無法確認。', { rule: ruleName(e.rule) })
    let text: string
    const from = this.bareName(e.s), slot = e.slot ?? t('函式指標'), via = e.via ?? t('函式指標')
    if (e.k === 'fnptr_pass') text = t('{from} 把 {to} 當作參數傳給 `{slot}()`，可能由它呼叫。', { from, to, slot }) + tail
    else if (e.k === 'fnptr_table') text = t('{to} 列在表格 `{slot}` 裡，可能經由這張表被呼叫。', { to, slot }) + tail
    else if (e.rule === 'param_call') text = t('{from} 經由參數 `{via}` 呼叫傳進來的函式；有呼叫者傳入的是 {to}。', { from, via, to }) + tail
    else if (e.rule === 'table_install') text = t('{to} 列在表格 `{table}` 裡；{from} 把 `{via}` 寫入 `{slot}`，所以這裡可能裝上 {to}。', { to, table: e.table ?? '', from, via, slot }) + tail
    else if (e.k === 'fnptr_assign') text = t('{to} 存入 `{slot}`，可能經由此指標被呼叫。', { to, slot }) + tail
    else if (e.k === 'indirect_saved') text = t('經由 `{via}` 呼叫替換前的 `{name}`。', { via, name: e.saved_from ?? '' }) + tail
    else if (e.k === 'indirect_candidate') text = t('經由 `{via}` 呼叫 {to}。', { via, to }) + tail
    else if (e.k === 'constructor' || e.k === 'destructor') text = e.k === 'constructor'
      ? t('標記為 `constructor`：dynamic loader 載入程式或程式庫時，在 main 之前自動執行。以 LD_PRELOAD 載入的程式庫常用它做初始化。')
      : t('標記為 `destructor`：程式結束或程式庫卸載時自動執行。')
    else text = t('由規則「{rule}」推得，編譯器無法確認。', { rule: e.rule ?? '' })
    return { label: ruleTag(e.rule), title: t('推測（規則）'), text }
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
