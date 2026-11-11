import { inferred, uncertain, type Edge, type Func, type Graph } from './types'
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

  /** method -> the outside interface methods it implements (error.Error): relations, not calls */
  impls = new Map<string, Edge[]>()
  /** interface method -> the repository's methods that implement it */
  implementers = new Map<string, Edge[]>()

  constructor(g: Graph) {
    this.g = g
    this.funcs = g.funcs
    for (const e of g.edges) {
      if (e.k === 'implements') {
        push(this.impls, e.s, e)
        push(this.implementers, e.d, e)
        continue
      }
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
    // dn names the target; an outside source (a framework event) has only its id: ext:os-ken event …
    return (e?.dn && (!e.d || id === e.d) ? e.dn : null) || id.replace(/^ext:/, '')
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
    return this.calls(this.out.get(id), (e) => e.d, (e) => !!this.funcs[e.d] || showExt || inferred(e))
      .sort((a, b) => a.l - b.l)
  }

  /** Who calls a function, one row per call site, by file and line. */
  callers(id: string): Edge[] {
    return this.calls(this.inn.get(id), (e) => e.s, (e) => !!this.funcs[e.s] || inferred(e))
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
      else (uncertain(e) ? guessed : sure).add(e.s)
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
    const ent = this.funcs[id]?.entry
    if (!n && ent) return t('0 個 caller：由 {v1} 呼叫（{v2}）', { v1: ent.framework, v2: entryText(ent) })
    const parts = [t('{n} 個 caller', { n }) + (c.guessed ? (c.guessed === n ? t('（推測）') : t('，其中 {n} 個是推測', { n: c.guessed })) : '')
      + (n ? t('：{v1}', { v1: list(c.names.slice(0, 3)) + (n > 3 ? t(' 等') : '') }) : '')]
    if (c.others.length) parts.push(t('另有推測的來源：{names}', { names: list(c.others.slice(0, 2)) }))
    if (c.load) parts.push(c.load === 'constructor' ? t('程式載入時自動執行') : t('程式結束時自動執行'))
    const left = this.g.uncompiled?.[id]?.length
    if (left) parts.push(t('另有 {v1} 處在條件編譯中，本次 build 未編入', { v1: left }))
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
    if (e.src === 'static') return this.staticEdge(e, to)
    if (e.src === 'syntax') {
      if (!this.funcs[id]) return { label: t('外部'), title: t('外部函式'), text: t('不在此 repo 中：{v1}。', { v1: '`' + (e.dn ?? id) + '`' }) }
      // tree-sitter read the call; a name, not a type checker, decided which definition it is
      if (e.by === 'name') return { label: t('依名稱推測'), title: t('依名稱推測'),
        text: t('這一行呼叫型別未知物件的 `{v1}()`。repo 中只有 {v2} 使用此名稱，因此連到它，實際可能是其他類別的同名方法。', { v1: this.funcs[id].name.split('.').pop() ?? '', v2: to }) }
      return { label: t('語法解析'), title: t('語法解析'),
        text: t('tree-sitter 依名稱將這一行的呼叫對應到 {v1} 的定義（同一檔案、import 或 self 的類別）。未經編譯器或型別檢查確認。', { v1: to }) }
    }
    if (e.src === 'framework') return this.frameworkEdge(e, to)
    const tail = t('由規則「{rule}」推得，編譯器無法確認。', { rule: ruleName(e.rule) })
    let text: string
    const from = this.bareName(e.s), slot = e.slot ?? t('函式指標'), via = e.via ?? t('函式指標')
    if (e.k === 'fnptr_pass') text = t('{from} 將 {to} 作為參數傳給 `{slot}()`，可能由它呼叫。', { from, to, slot }) + tail
    else if (e.k === 'fnptr_table') text = t('{to} 列於表格 `{slot}`，可能經由此表被呼叫。', { to, slot }) + tail
    else if (e.rule === 'param_call') text = t('{from} 經由參數 `{via}` 呼叫傳入的函式，其中一個呼叫者傳入 {to}。', { from, via, to }) + tail
    else if (e.rule === 'table_install') text = t('{to} 列於表格 `{table}`。{from} 將 `{via}` 寫入 `{slot}`，因此此處可能裝入 {to}。', { to, table: e.table ?? '', from, via, slot }) + tail
    else if (e.k === 'fnptr_assign') text = t('{to} 存入 `{slot}`，可能經由此指標被呼叫。', { to, slot }) + tail
    else if (e.k === 'indirect_saved') text = t('經由 `{via}` 呼叫替換前的 `{name}`。', { via, name: e.saved_from ?? '' }) + tail
    else if (e.k === 'indirect_candidate') text = t('經由 `{via}` 呼叫 {to}。', { via, to }) + tail
    else if (e.k === 'constructor' || e.k === 'destructor') text = e.k === 'constructor'
      ? t('標記為 `constructor`：dynamic loader 載入程式或程式庫時，在 main 之前自動執行。以 LD_PRELOAD 載入的程式庫常用它做初始化。')
      : t('標記為 `destructor`：程式結束或程式庫卸載時自動執行。')
    else text = t('由規則「{rule}」推得，編譯器無法確認。', { rule: e.rule ?? '' })
    return { label: ruleTag(e.rule), title: t('推測（規則）'), text }
  }

  /** A call the Python analyzer resolved: through names (exact), a type (inferred), or one of several targets. */
  staticEdge(e: Edge, to: string): { label: string; title: string; text: string } {
    if (!this.funcs[e.d] && e.eg) return { label: t('外部候選'), title: t('外部候選'),
      text: t('接收者的型別有多種可能（例如聯集），各自都有 repo 外的同名方法 {v1}。這些是同一個呼叫的外部候選，不是 repo 內的不同實作，每個候選各保留一條邊。', { v1: to }) }
    if (!this.funcs[e.d]) {
      const what = e.infer?.how === 'interface' ? t('呼叫的是 interface 方法 {v1}。實作在執行時才決定，repo 外也可能有實作，因此不連到任何一個。', { v1: '`' + (e.dn ?? e.d) + '`' })
        : t('不在此 repo 中：{v1}。', { v1: '`' + (e.dn ?? e.d) + '`' })
      return { label: e.infer?.how === 'interface' ? t('interface 方法') : t('外部'), title: t('外部函式'),
        text: what + (e.ph ? t('此套件未載入（不在 module 快取或需要下載），只知道名稱。') : '') }
    }
    const ty = e.infer?.type ? '`' + e.infer.type + '`' : t('這個類別')
    const how = e.infer?.how
    // element:<how>: the object came out of a container, and the container's elements are known from <how>
    const FROM: Record<string, string> = { annotation: '型別註記', append: 'append() 放進去的值', extend: 'extend() 放進去的值', setitem: '[鍵] = 值 的指定',
      literal: '容器字面值裡寫的值', comprehension: '推導式產生的值', return: '函式的回傳值' }
    const elem = how?.startsWith('element:') ? how.slice(8) : null
    const because = elem ? (this.funcs[e.d]?.kind === 'method' || e.infer?.type
      ? t('物件為從容器取出的元素。容器的元素型別來自{v1}，為 {v2}，因此方法是 {v3}。', { v1: t(FROM[elem] ?? elem), v2: ty, v3: to })
      : t('呼叫的是從容器取出的函式。容器中的值來自{v1}，其中有 {v2}。', { v1: t(FROM[elem] ?? elem), v2: to }))
      : how === 'self' ? t('`self` 是 {v1} 的物件，方法依繼承順序找到 {v2}。', { v1: ty, v2: to })
      : how === 'cls' ? t('`cls` 是 {v1}，方法依繼承順序找到 {v2}。', { v1: ty, v2: to })
        : how === 'super' ? t('`super()` 從 {v1} 的父類別找到 {v2}。', { v1: ty, v2: to })
          : how === 'constructor' ? t('物件由 {v1}() 建立，因此方法是 {v2}。', { v1: ty, v2: to })
            : how === 'annotation' ? t('型別註記寫明物件是 {v1}，因此方法是 {v2}。', { v1: ty, v2: to })
              : how === 'return' ? t('物件為另一個函式的回傳值，該函式回傳 {v1}，因此方法是 {v2}。', { v1: ty, v2: to })
                : how === 'assign' ? t('物件經由賦值傳入，來源為 {v1}，因此方法是 {v2}。', { v1: ty, v2: to })
                  : how === 'attribute' ? t('此為 self 的屬性，在類別中設為 {v1}，因此方法是 {v2}。', { v1: ty, v2: to })
                    : how === 'override' ? t('子類別覆寫此方法，`self` 也可能是子類別的物件。')
                      : how === 'interface' ? t('經由 interface 呼叫。{v1} 實作此 interface（由型別檢查器確認，非僅比對方法名稱），因此可能是 {v2}。', { v1: ty, v2: to })
                      : how === 'this' ? t('`this` 是 {v1} 的物件，方法依繼承找到 {v2}。', { v1: ty, v2: to })
                      : how === 'type' ? t('TypeScript 編譯器確定接收者型別為 {v1}，且分析範圍內沒有子類別覆寫此方法，因此是 {v2}。範圍外的程式碼仍可能繼承並覆寫它。', { v1: ty, v2: to })
                      : how === 'new' ? t('`new` 建立物件時執行 {v1}。', { v1: to })
                      : how === 'jsx' ? t('JSX 元素會呼叫元件 {v1}。', { v1: to })
                      : how === 'returned' ? t('呼叫的是另一個函式回傳的函式 {v1}。', { v1: to })
                      : how === 'decorator' ? t('裝飾器（decorator）{v1} 在類別定義時執行，而非在所標記的方法被呼叫時。', { v1: to })
                        : how === 'embedding' ? t('{v1} 內嵌（embed）其他型別，方法是由內嵌型別提升的 {v2}。', { v1: ty, v2: to })
                          : how === 'closure' ? t('呼叫的是存在變數或欄位中的 func literal（closure）{v1}。', { v1: to })
                            : how === 'field' ? t('呼叫的是 struct 欄位中的函式，程式在他處將 {v1} 存入此欄位。', { v1: to })
                              : how === 'funcvalue' ? (e.k === 'ref' ? t('{v1} 在此作為值傳出（例如註冊為 handler），之後由接收方呼叫。', { v1: to }) : t('呼叫的是存著 {v1} 的變數。', { v1: to }))
                                : how === 'methodvalue' ? t('{v1} 以 method value 形式傳出或儲存，之後才呼叫。', { v1: to })
                                  : how === 'methodexpr' ? t('以 method expression 呼叫 {v1}，receiver 作為第一個參數傳入。', { v1: to })
                      : t('名稱經由 import 或同一個模組，確定指向 {v1}。', { v1: to })
    // Go: when the call runs, before which of its targets it reaches
    const when = e.mode === 'go' ? t('以 goroutine 執行（go），呼叫方不等待其結束。') : e.mode === 'defer' ? t('延到所在的函式結束時才執行（defer）。') : ''
    if (e.k === 'ref' && e.resolution === 'exact') return { label: t('當作函式值'), title: t('當作函式值'), text: because }
    // the repository's interface method, nothing in production implements it: the method is certain, the code that runs is not
    if (e.resolution === 'exact' && how === 'interface') return { label: t('interface 方法'), title: t('interface 方法'),
      text: t('呼叫的是 interface 方法 {v1}，實際執行的實作到執行時才決定。正式程式碼中沒有此 interface 的實作。', { v1: to }) }
    if (e.resolution === 'exact' && how === 'jsx') return { label: 'JSX', title: 'JSX', text: because }
    if (e.resolution === 'exact' && e.mode) return { label: e.mode, title: e.mode, text: when + because }
    if (e.resolution === 'exact' && how === 'embedding') return { label: t('內嵌提升'), title: t('內嵌提升'), text: because }
    if (e.resolution === 'ambiguous' && e.eg) return { label: t('外部候選'), title: t('外部候選'),
      text: t('接收者的型別有多種可能（例如聯集），各自都有 repo 外的同名方法 {v1}。這些是同一個呼叫的外部候選，不是 repo 內的不同實作，每個候選各保留一條邊。', { v1: to }) + when }
    if (e.resolution === 'ambiguous') return { label: t('可能目標之一'), title: t('可能目標之一'),
      text: (e.infer?.partial ? t('容器中還有型別不明的值，實際目標可能不只列出的這些。{v1} 是其中之一。', { v1: to })
        : t('此呼叫有多個可能目標（聯集型別或子類別覆寫），全部列出，{v1} 是其中之一。', { v1: to })) + because + when }
    if (e.resolution === 'inferred') return { label: t('型別推論'), title: t('型別推論'), text: because + when + t('型別由 codemap 從程式碼推得，未經執行確認。') }
    return { label: t('符號解析'), title: t('符號解析'), text: because }
  }

  /** An edge a framework adapter added: the framework makes this call, the code does not. */
  frameworkEdge(e: Edge, to: string): { label: string; title: string; text: string } {
    const fw = (e.rule ?? '').split('.')[0], from = '`' + this.bareName(e.s, e) + '`'
    const label = e.k === 'inject' ? t('{v1} 注入', { v1: fw }) : t('{v1} 回呼', { v1: fw })
    let text: string
    if (e.rule === 'pytest.fixture') text = t('{v1} 的參數與 fixture {v2} 同名：pytest 先執行 {v2}，再將結果傳入 {v1}。', { v1: from, v2: to })
    else if (e.rule?.endsWith('.depends')) text = t('{v1} 宣告 Depends({v2})：{v3} 先執行 {v2}，再將結果傳入 {v1}。', { v1: from, v2: to, v3: fw })
    else if (e.rule?.endsWith('.set_ev_cls')) text = t('{v1} 以 set_ev_cls 註冊；{v2} 收到這個事件時呼叫它。', { v1: to, v2: fw })
    else if (e.k === 'callback') text = t('{v1} 將 {v2} 所屬的物件交給 {v3}，事件發生時由 {v3} 呼叫 {v2}。', { v1: from, v2: to, v3: fw })
    else text = t('由 {v1} 呼叫。', { v1: fw })
    return { label, title: t('框架呼叫'), text: text + t('程式碼中沒有此呼叫，由框架規則「{v1}」推得。', { v1: e.rule ?? '' }) }
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

  /** A sensible first function to show: a main, else what a framework or a script starts with, else the
   *  one that calls the most functions; outside shared components either way. */
  firstFunc(): string | null {
    const shared = new Set(this.g.comps.filter((c) => c.shared).map((c) => c.id))
    const rank = (f: Func) => (f.name === 'main' ? 3 : f.entry && f.entry.kind !== 'test' && f.entry.kind !== 'fixture' ? 2 : f.kind === 'module' ? 1 : 0)
    let best: string | null = null, n = -1, r = -1
    for (const [id, f] of Object.entries(this.funcs)) {
      if (shared.has(f.comp)) continue
      const k = this.callees(id, false).length, rk = k ? rank(f) : 0
      if (rk > r || (rk === r && k > n)) { best = id; n = k; r = rk }
    }
    return best
  }
}

/** What a framework entry point is, in words: 「route GET /users」「test」「fixture db」. */
export function entryText(e: { kind: string; text: string }): string {
  const KIND: Record<string, string> = { route: '路由', hook: '掛勾', test: '測試', fixture: 'fixture', event: '事件處理', app: '應用程式',
    topology: '拓樸', component: '元件', lifecycle: '生命週期', callback: '回呼' }
  const k = KIND[e.kind] ? t(KIND[e.kind]) : e.kind
  return e.text && e.text !== e.kind ? `${k} ${e.text}` : k
}

/** The graph without test code: its functions, and the edges from or to them. */
export function production(g: Graph): Graph {
  if (!Object.values(g.funcs).some((f) => f.scope === 'test')) return g
  const funcs = Object.fromEntries(Object.entries(g.funcs).filter(([, f]) => f.scope !== 'test'))
  const test = (id: string) => g.funcs[id]?.scope === 'test'
  // what was left out, so the overview can still say the tests are there
  const hidden_tests = Object.entries(g.funcs).filter(([id]) => test(id)).map(([id, f]) => ({ id, name: f.name, file: f.file, line: f.line, comp: f.comp }))
  // per function, the test functions that call it: the panel says they are hidden rather than leaving them out silently
  const hidden_callers: Record<string, number> = {}
  for (const id of new Set(g.edges.filter((e) => test(e.s) && !test(e.d)).map((e) => e.s + '>' + e.d))) {
    const d = id.slice(id.indexOf('>') + 1)
    hidden_callers[d] = (hidden_callers[d] ?? 0) + 1
  }
  return { ...g, funcs, edges: g.edges.filter((e) => !test(e.s) && !test(e.d)), hidden_tests, hidden_callers }
}

/** Add v to the list at m[k]. */
export function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}
