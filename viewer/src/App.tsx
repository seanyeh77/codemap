import { SRC_LABEL, oneLine as descLine, useDescOrder, type DescOrder } from './data/describe'
import { OpenCall, OpenFunc } from './components/CallLinks'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { UI } from './ui'
import { early, stopEarly } from './early'
import { t } from './i18n'
import { Index, isEnv, production, push } from './data/graph'
import { usePrefs } from './data/hooks'
import { prefs } from './prefs'
import { rank } from './data/search'
import { embeddedSnapshot, live, liveMeta, snapshotFromFile, snapshotFromURL } from './data/load'
import { written, type Func, type Graph, type GrepHit, type Meta } from './data/types'
import { OpenFile, PeekLine } from './components/DocRefs'
import { Defs } from './pages/Defs'
import { Arch, CompDetail, EdgeDetail, Overview, TRACED, jump } from './pages/Arch'
import { Flow } from './pages/Flow'
import { Impact } from './pages/Impact'
import { Check, DescHealth } from './pages/Check'
import { Settings } from './pages/Settings'
import { FileReader, compOfFile } from './pages/Reader'
import { Info, fnAt, type At } from './pages/Info'
import { FnChecks, ScopeChecks } from './pages/FnPanel'
import { EditorButton } from './pages/CodeAt'
import { Relations } from './pages/Relations'
import { Explorer, flagged } from './pages/Explorer'
import { TermsCtx, termDefs, termsOf } from './components/Terms'
import { OpenSnapshot, useFilePicker } from './pages/OpenSnapshot'
import { onLaunchFile } from './pwa'

type View = 'overview' | 'arch' | 'flow' | 'impact' | 'check' | 'settings'
const PAGES: Record<View, { title: string; icon: UI.IconName; detail: string }> = {
  overview: { title: '總覽', icon: 'house', detail: '專案在做什麼、從哪裡讀起、對外介面' },
  arch: { title: '架構', icon: 'squares-four', detail: '元件與其間的呼叫' },
  flow: { title: '流程', icon: 'share-network', detail: '追蹤函式的呼叫' },
  impact: { title: '影響範圍', icon: 'pulse', detail: '修改函式的影響範圍' },
  check: { title: '檢查筆記', icon: 'check-circle', detail: '核對筆記與程式碼' },
  settings: { title: '設定', icon: 'gear', detail: '資料來源、開啟方式、主題' },
}
// phones have no Ctrl K: the tour points at the search button instead
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

interface Snap { id: string; name: string | null; graph: Graph }   // name null: embedded in this page

/** Where the data comes from: decided once at start-up. */
function useBoot() {
  return useQuery({
    queryKey: ['boot'],
    queryFn: async () => {
      const embedded = await embeddedSnapshot()
      if (embedded) return { meta: null as Meta | null, snap: { id: 'embedded', name: null, graph: embedded } }
      const url = new URLSearchParams(location.search).get('snapshot')
      if (url) {
        const g = await snapshotFromURL(url)
        return { meta: null, snap: { id: 'url', name: url.split('/').pop() || url, graph: g } }
      }
      return { meta: await liveMeta(), snap: null as Snap | null }
    },
  })
}

export function App() {
  const boot = useBoot()
  const [snaps, setSnaps] = useState<Snap[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const meta = boot.data?.meta ?? null
  const all = useMemo(() => (boot.data?.snap ? [boot.data.snap, ...snaps] : snaps), [boot.data, snaps])
  const sourceId = current ?? (meta ? 'live' : all[0]?.id ?? null)
  const isLive = sourceId === 'live'
  const liveGraph = useQuery({ queryKey: ['graph'], queryFn: live.graph, enabled: !!meta })
  const snap = all.find((s) => s.id === sourceId)
  const graph = isLive ? liveGraph.data : snap?.graph

  async function open(file: File) {
    try {
      const g = await snapshotFromFile(file)
      const id = 'file:' + file.name + ':' + Date.now()
      setSnaps((s) => [...s, { id, name: file.name, graph: g }])
      setCurrent(id)
      setOpenError(null)
    } catch (e) {
      setOpenError(String((e as Error).message || e))
    }
  }
  const picker = useFilePicker(open)
  // a .codemap file the system opened with the installed app
  useEffect(() => onLaunchFile((f) => { void open(f) }), [])   // eslint-disable-line react-hooks/exhaustive-deps

  if (boot.isPending || (isLive && liveGraph.isPending)) {
    return <div className="boot"><UI.Skeleton width="100%" height={64} /><UI.Skeleton width="60%" height={24} /><UI.Skeleton width="100%" height={320} /></div>
  }
  const err = boot.error || (isLive && liveGraph.error)
  if (err) {
    return <div className="boot"><UI.Alert tone="danger" title={t('無法載入資料')}>{String((err as Error).message || err)}</UI.Alert></div>
  }
  if (!graph) return <OpenSnapshot onOpen={open} error={openError} />
  return (
    <>
      <Shell key={sourceId} graph={graph} meta={isLive ? meta : null} hasLive={!!meta}
        sources={[...(meta ? [{ id: 'live', label: meta.repo, detail: t('{v1} 即時', { v1: meta.host }) }] : []),
          ...all.map((s) => ({ id: s.id, label: s.graph.repo, detail: t('快照 ') + (s.graph.commit ?? s.name ?? t('此頁面')) }))]}
        sourceId={sourceId!} setSource={setCurrent} snapName={snap?.name ?? null} openSnapshot={picker.open} openError={openError} />
      {picker.input}
    </>
  )
}

interface ShellProps {
  graph: Graph
  meta: Meta | null
  hasLive: boolean
  sources: { id: string; label: string; detail: string }[]
  sourceId: string
  setSource: (id: string) => void
  snapName: string | null
  openSnapshot: () => void
  openError: string | null
}

// 說明; 呼叫 (what it calls, down) and 被呼叫 (what calls it, up, with what a change reaches); 檢查
// 對外介面: the commands, environment variables, files and entry points of what is open
type ViewId = 'info' | 'defs' | 'down' | 'up' | 'world' | 'check'
const VIEW_IDS: ViewId[] = ['info', 'down', 'up', 'world', 'check']
// the overview's parts in 對外介面; the overview page keeps what the project is and its components
const WORLD = ['ov-entry', 'ov-cmds', 'ov-env', 'ov-build', 'ov-writes', 'ov-reads']
// the layout a first visit gets: 說明 on the right; 呼叫流程, 影響範圍 and 檢查 in the panel below
// the layout a first visit gets: 說明 on the right; 呼叫流程, 影響範圍 and 檢查 in the panel below
const LAYOUT = { side: ['info', 'defs'], panel: ['down', 'up', 'world', 'check'] }
// the tour points at the explorer, the search, the stage and three of the views, wherever the reader moved them
const TOUR_TARGETS = ['tree', 'search', 'stage', ...['info', 'down', 'check'].map((v) => `.ui-wb-tab[data-id="${v}"]`)]

function Shell(p: ShellProps) {
  const pr = usePrefs()
  // production code by default: test files, and what they call or set, come in only when asked for
  const ix = useMemo(() => new Index(pr.tests ? p.graph : production(p.graph)), [p.graph, pr.tests])
  const qc = useQueryClient()
  const isLive = !!p.meta
  // what the address opens: the project, a component, a place in a file, or settings; and which view to show
  const init = useMemo(() => readHash(ix), [])   // eslint-disable-line react-hooks/exhaustive-deps
  const [at, setAtState] = useState<At>(init.at ?? { kind: 'proj' })
  const [edge, setEdge] = useState('')          // a line of the architecture diagram, explained in 說明
  // the design system's editor layout keeps where each view is; codemap asks it to show one and reads which is open
  const wb = useRef<UI.WorkbenchHandle>(null)
  const [layout, setLayout] = useState<UI.WorkbenchLayout | null>(null)
  const [q, setQ] = useState('')
  // the function the code is in: what 說明, 呼叫流程 and 影響範圍 are about
  const fn = at.kind === 'file' ? fnAt(ix, at.f, at.l) : null
  // the panel keeps its start while the reader follows it: a name clicked in the call tree opens that function above,
  // and the tree stays rooted where it was. Moving anywhere else (the explorer, the code, the search) roots it there:
  // the pin holds only while the function open is the one the panel went to
  const [pin, setPin] = useState<{ id: string; for: string | null } | null>(() => init.s ? { id: init.s, for: init.at?.kind === 'file' ? fnAt(ix, init.at.f, init.at.l) : null } : null)
  const known = (id: string) => !!(ix.funcs[id] || ix.inn.has(id))
  const start = pin && pin.for === fn && known(pin.id) ? pin.id : fn
  // the row picked in each tree, for the start it was picked under
  const [flowSel, setFlowSel] = useState<Record<'down' | 'up', { start: string | null; key: string }>>({ down: { start, key: 'root' }, up: { start, key: 'root' } })
  const selKey = (d: 'down' | 'up') => (flowSel[d].start === start ? flowSel[d].key : 'root')
  // 被呼叫 as a tree, or as the table of everything a change reaches
  const [upTable, setUpTable] = useState(false)
  const [showExt, setShowExt] = useState(pr.showExtDefault)
  const [cat, setCatState] = useState(lastCat)
  const setCat = (c: string) => { lastCat = c; setCatState(c) }
  const [alertOpen, setAlertOpen] = useState(true)
  const [paletteKey, setPaletteKey] = useState(0)

  // where to go; every move clears the diagram's chosen line and tells a narrow screen's explorer to close
  const setAt = (a: At) => { setEdge(''); setPicked(false); setAtState(a) }
  // the reader clicked or moved to a line in the code: 說明 marks what is about that line (not on opening)
  const [picked, setPicked] = useState(false)
  const openFile = (f: string, l: number) => setAt({ kind: 'file', f, l })
  const placeOf = (id: string): At | null => (ix.funcs[id] ? { kind: 'file', f: ix.funcs[id].file, l: ix.funcs[id].line } : null)
  const openFn = (id: string) => {
    const a = placeOf(id)
    if (a) setAt(a)
    else if (ix.inn.has(id)) { setPin({ id, for: fn }); show('up') }       // a function outside the repo: who in the repo calls it
  }
  const openComp = (c: string) => (c.startsWith('file:') ? openFile(c.slice(5), 1) : c ? setAt({ kind: 'comp', id: c }) : setAt({ kind: 'proj' }))
  /** Opens a place from the panel: the panel stays on its start. */
  // a function picked in callee or caller becomes what everything shows (code, 說明, both trees); the way there is
  // kept as a trail above the trees, each step a way back
  const [trail, setTrail] = useState<string[]>(() => init.p ?? [])
  const [mdMode, setMdMode] = useState<{ f: string; m: 'preview' | 'source' } | null>(null)
  // the line an item in 說明 points at while the pointer is on it
  const [peekLine, setPeekLine] = useState<number | null>(null)
  const fromPanel = (id: string, a: At | null) => {
    if (!a) return
    setTrail((tr) => {
      const at = tr.indexOf(id)
      if (at >= 0) return tr.slice(0, at + 1)
      const base = fn && tr[tr.length - 1] === fn ? tr : fn ? [fn] : []
      return [...base, id]
    })
    setPin(null)
    setAt(a)
  }
  /** Shows a view wherever the reader has put it, opening its area. */
  const show = (v: ViewId) => wb.current?.show(v)
  const flags = useMemo(() => flagged(ix.g, ix), [ix])
  const explorerOpen = (id: string) => {
    // what is already open, picked again: nothing moves
    if (id === 'proj' && at.kind === 'proj') return
    if (id.startsWith('comp:') && at.kind === 'comp' && at.id === id.slice(5)) return
    if (id.startsWith('file:') && at.kind === 'file' && at.f === id.slice(5) && !fn) return
    if (id.startsWith('fn:') && fn === id.slice(3)) return
    if (id === 'proj') setAt({ kind: 'proj' })
    else if (id.startsWith('comp:')) setAt({ kind: 'comp', id: id.slice(5) })
    else if (id.startsWith('file:')) openFile(id.slice(5), 1)
    else if (id.startsWith('fn:')) {
      openFn(id.slice(3))
    }
    // a dot: what was found is in 檢查, so it opens there too
    if (flags.has(id)) show('check')
    // 文件 is a folder: choosing it only opens it
  }

  // the address: what is open (each a step back can return to) and the panel's view (replaced, not a new step)
  // the browsing path is part of the address while it leads to what is open: a reload or a link keeps it
  const shownTrail = fn && trail.length > 1 && trail[trail.length - 1] === fn ? trail : undefined
  const base = hashOf(at, start !== fn ? start : null, shownTrail)
  const here = base + (layout?.open.panel && layout.active.panel ? (base.includes('?') ? '&' : '?') + 'v=' + layout.active.panel : '')
  const placed = useRef(false)
  const lastBase = useRef(base)
  useEffect(() => {
    if (location.hash !== here) {
      if (placed.current && lastBase.current !== base) history.pushState(null, '', here)
      else history.replaceState(null, '', here)
    }
    lastBase.current = base
    placed.current = true
  }, [here, base])
  useEffect(() => {
    const onPop = () => {
      const h = readHash(ix)
      if (h.at) { setEdge(''); setPicked(false); setAtState(h.at) }
      setTrail(h.p ?? [])
      setPin(h.s ? { id: h.s, for: h.at?.kind === 'file' ? fnAt(ix, h.at.f, h.at.l) : null } : null)
      if (h.v) show(h.v)
    }
    addEventListener('popstate', onPop)
    addEventListener('hashchange', onPop)
    return () => { removeEventListener('popstate', onPop); removeEventListener('hashchange', onPop) }
  }, [ix])   // eslint-disable-line react-hooks/exhaustive-deps
  // an address that asks for a view shows it once, at start
  useEffect(() => { if (init.v) show(init.v) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  // what changed on screen, for screen readers
  useEffect(() => { if (at.kind === 'file') UI.announce(t('已開啟 {v1} 第 {v2} 行', { v1: at.f.split('/').pop(), v2: at.l })) }, [at])
  useEffect(() => { try { if (fn) localStorage.setItem(`codemap:last:${p.graph.repo}`, fn) } catch { /* private mode */ } }, [fn, p.graph.repo])

  const [searchOpen, setSearchOpen] = useState(early.search)
  // opening and closing in one place: a closed box forgets its words and starts empty next time
  const setPalette = (o: boolean) => { setSearchOpen(o); if (!o) { setQuery(''); setPaletteKey((k) => k + 1) } }
  const paletteOpen = useRef(setPalette)
  paletteOpen.current = setPalette
  const openRef = useRef(searchOpen)
  openRef.current = searchOpen
  // from here the palette's own Ctrl K listens; the page says it is ready for the early listener
  useEffect(() => { early.search = false; stopEarly(); document.body.dataset.codemapReady = '1' }, [])
  // Ctrl K / ⌘ K, caught first (capture phase) and by the physical key too (KeyK, whatever the keyboard
  // layout): reports said it sometimes did nothing; this way no handler further in, and no layout, can lose it.
  // The palette's own listener is told to stand down for this press, so the box does not open and close at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !['k', 'p'].includes(e.key.toLowerCase()) && e.code !== 'KeyK' && e.code !== 'KeyP') return
      e.preventDefault()
      e.stopImmediatePropagation()
      paletteOpen.current(!openRef.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const [recent, setRecent] = useState<PaletteItem[]>([])
  const descOrder = useDescOrder()
  const palette = useMemo(() => paletteItems(ix, descOrder), [ix, descOrder])
  const [query, setQuery] = useState('')
  // words the graph has no name for (overrun, SIGTERM): the text of the files, from the server when
  // live, from the functions a snapshot keeps otherwise; listed after every name that matches
  const typed = useDebounced(query.trim(), 250)
  const grepLive = useQuery({ queryKey: ['grep', p.sourceId, typed], enabled: isLive && !!p.meta?.capabilities.grep && typed.length >= 2,
    queryFn: () => live.grep(typed), staleTime: 30_000, placeholderData: keepPreviousData })   // no flash of an empty list between two queries
  // nothing has the words as typed (ttl_expired): look for the pieces (ttl, expired), lines with more of them first
  const parts = useMemo(() => [...new Set(typed.split(/[\s_\-./]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase()).filter((w) => w.length >= 3))].slice(0, 3), [typed])
  const primaryEmpty = isLive ? grepLive.isSuccess && !grepLive.isPlaceholderData && !(grepLive.data ?? []).length : typed.length >= 2 && !snapshotGrep(ix, typed).length
  const grepParts = useQuery({ queryKey: ['grep-parts', p.sourceId, parts.join(' ')], enabled: primaryEmpty && parts.length >= 2,
    queryFn: async () => {
      const lists = await Promise.all(parts.map((w) => (isLive ? live.grep(w) : Promise.resolve(snapshotGrep(ix, w)))))
      const score = new Map<string, { h: GrepHit; n: number }>()
      for (const list of lists) for (const h of list) {
        const k = `${h.file}:${h.line}`
        score.set(k, { h, n: (score.get(k)?.n ?? 0) + 1 })
      }
      return [...score.values()].sort((a, b) => b.n - a.n).map((x) => x.h)
    }, staleTime: 30_000 })
  const partial = primaryEmpty && parts.length >= 2 && !!grepParts.data?.length
  const textHits = useMemo(() => {
    if (typed.length < 2) return []
    const hits: GrepHit[] = partial ? grepParts.data ?? [] : isLive ? grepLive.data ?? [] : snapshotGrep(ix, typed)
    const indexed = new Set(ix.byFile().keys())
    // what a line outside every function is: a macro, a file-scope variable, or just text there
    const symAt = new Map((ix.g.symbols ?? []).map((s) => [`${s.file}:${s.line}`, s]))
    return hits.slice(0, 30).map((h): PaletteItem => {
      // the innermost definition around the line: a method, not the class that holds it
      const fid = Object.keys(ix.funcs).filter((id) => { const f = ix.funcs[id]; return f.file === h.file && f.line <= h.line && h.line <= f.end })
        .sort((a, b) => ix.funcs[b].line - ix.funcs[a].line)[0]
      const kind = /^\s*(\/\/|\/\*|\*|#(?!\s*(include|define|if|ifdef|ifndef|else|elif|endif|pragma|undef)\b))/.test(h.text) && textKind(h.file) !== '文件' ? '註解' : textKind(h.file)
      // a C line outside every indexed function: either between functions, or in a file the build does not compile
      const where = fid ? ` · ${ix.funcs[fid].name}` : kind !== '程式碼' && kind !== '測試' ? ''
        : ((u) => u ? ` · ${t('{v1}（{v2}，本次 build 未編入）', { v1: u.name, v2: u.cond })}` : null)(
            ix.g.uncompiled_funcs?.find((u) => u.f === h.file && u.line <= h.line && h.line <= u.end))
          ?? (indexed.has(h.file) || symAt.has(`${h.file}:${h.line}`)
            ? ((s) => s ? ` · ${t(s.kind === 'macro' ? '{v1} 巨集定義' : '{v1} 全域變數宣告', { v1: s.name })}`
              : /^#\s*define\b/.test(h.text) ? ` · ${t('巨集定義')}` : ` · ${t('在函式之外')}`)(symAt.get(`${h.file}:${h.line}`))
            : ix.g.stats.backends && !ix.g.stats.backends.includes('gcc') ? ` · ${t('在函式之外')}` : ` · ${t('此檔案不在 build 中，僅有文字，無呼叫關係')}`)
      // a call on this line to a name defined more than once: which definition it reaches
      const twinCalls = fid ? [...new Set(ix.callees(fid, true).filter((e) => e.l === h.line && e.f === h.file && ix.funcs[e.d]
        && Object.values(ix.funcs).some((g) => g !== ix.funcs[e.d] && g.name.split('.').pop() === ix.funcs[e.d].name.split('.').pop())).map((e) => e.d))] : []
      // named, so parse_fib(_run(…)) does not read as if parse_fib were the one defined at _run's line
      const reaches = twinCalls.length ? t('；這行的 {v1}', { v1: twinCalls.map((d) => t('{v1} 呼叫的是 {v2} 的定義', { v1: ix.funcs[d].name.split('.').pop(), v2: `${ix.funcs[d].file}:${ix.funcs[d].line}` })).join(t('、')) }) : ''
      // a name searched for: whether this line calls it, imports it, defines it, or only mentions it
      const ident = /^[A-Za-z_]\w*$/.test(typed) ? typed : ''
      const role = !ident || !new RegExp(`\\b${ident}\\b`).test(h.text) ? ''
        : new RegExp(`^\\s*(async\\s+)?(def|class|func|function)\\s+${ident}\\b`).test(h.text) ? t('定義')
        : /^\s*(from\s+\S+\s+)?import\b/.test(h.text) || (/^\s*[\w.]+,?\s*$/.test(h.text) && /\.py$/.test(h.file)) ? t('匯入或列出名稱')
        : fid && ix.callees(fid, true).some((e) => e.l === h.line && e.f === h.file && (ix.funcs[e.d]?.name ?? ix.bareName(e.d, e)).split('.').pop() === ident) ? t('呼叫')
        : t('僅提及此名稱，並非呼叫')
      const roleText = role ? ` · ${role}` : ''
      return { id: `t:${h.file}:${h.line}`, kind, label: kind === '文件' ? plainDoc(h.text) : h.text, code: kind !== '文件' && kind !== '註解',
        detail: (partial ? t('找不到「{v1}」，改列含 {v2} 的行 · ', { v1: typed, v2: parts.join(t('、')) }) : '') + `${h.file}:${h.line}` + where + roleText + reaches, target: { type: 'file', f: h.file, l: h.line } }
    }).sort((a, b) => TEXT_ORDER.indexOf(a.kind!) - TEXT_ORDER.indexOf(b.kind!)).slice(0, 20)
  }, [typed, isLive, grepLive.data, ix, partial, grepParts.data, parts])
  const ranked = useMemo(() => rank(palette, query, 40), [palette, query])
  // how many there are before the lists are cut (40 names, 20 lines): the box says how many it left out
  const total = useMemo(() => {
    if (query.trim().length < 1) return undefined
    const names = rank(palette, query, Number.MAX_SAFE_INTEGER).length
    const lines = typed.length >= 2 ? (isLive ? grepLive.data ?? [] : snapshotGrep(ix, typed)).length : 0
    return names + lines
  }, [palette, query, typed, isLive, grepLive.data, ix])
  // the count is said once the text results are in, not while they are still arriving
  const searching = query.trim().length >= 2 && (typed !== query.trim() || (isLive && grepLive.isFetching))
  // a phrase of several words is a question about the code: the lines that say it come before a
  // file whose name merely holds the same words (ring overrun: reader.c:110 before ring-overrun.md)
  const found = useMemo(() => {
    if (!/\s/.test(query.trim())) return [...ranked, ...textHits]
    const code = textHits.filter((h) => h.kind === '程式碼')
    const files = ranked.filter((r) => r.kind === '檔案')
    return [...ranked.filter((r) => r.kind !== '檔案'), ...code, ...files, ...textHits.filter((h) => h.kind !== '程式碼')]
  }, [ranked, textHits, query])
  const seenTour = UI.useTour('codemap')
  const [tourOpen, setTourOpen] = useState(false)
  const [welcome, setWelcome] = useState(() => !seenTour.seen)
  const [tourStep, setTourStep] = useState(0)
  const tourStart = () => { setWelcome(false); setTourStep(0); setTourOpen(true) }
  const tourClose = () => { seenTour.close(); setTourOpen(false) }

  function select(item: PaletteItem) {
    setRecent((r) => [item, ...r.filter((x) => x.id !== item.id)].slice(0, 6))
    const g = item.target
    if (g.type === 'func') openFn(g.id)
    else if (g.type === 'comp') openComp(g.id)
    else if (g.type === 'page') { if (g.id === 'settings') setAt({ kind: 'settings' }); else if (g.id === 'overview' || g.id === 'arch') setAt({ kind: 'proj' }); else show(g.id === 'flow' ? 'down' : g.id === 'impact' ? 'up' : g.id as ViewId) }
    else if (g.type === 'line' || g.type === 'file') openFile(g.f, g.l)
    else if (g.type === 'ext') { setPin({ id: g.id, for: fn }); show('up') }
    else if (g.type === 'overview') {
      // what to check is in 檢查; how the program meets the world in 對外介面 (for the whole project); the rest is the
      // project's page. The ideas without a section (constructors, LD_PRELOAD, environment variables) are 對外介面's
      if (g.sec && WORTH_SECTIONS.has(g.sec)) show('check')
      else if (!g.sec || WORLD.includes(g.sec)) { setAt({ kind: 'proj' }); show('world') }
      else setAt({ kind: 'proj' })
      const sec = g.sec
      if (sec) for (const ms of [150, 500, 900]) setTimeout(() => jump(sec), ms)
    }
  }

  const empty = !p.graph.comps.length
  const isFile = at.kind === 'file'
  // a Markdown file: its preview or its source, chosen in the bar above the code (no row of its own)
  const isMd = isFile && /\.(md|markdown)$/i.test(at.f)
  const mdShown = isMd ? (mdMode?.f === at.f ? mdMode.m : at.l > 1 ? 'source' : 'preview') : 'preview'
  const flowStart = start && (ix.funcs[start] || ix.inn.has(start)) ? start : null
  /** 呼叫 or 被呼叫: the call tree one way from the function above (or where the panel was pinned); with no function
   *  open, the files or components it is tied to. */
  function flowView(d: 'down' | 'up', title: string): UI.WorkbenchView & { id: ViewId } {
    const tree = (s: string) => <Flow key={s + d} ix={ix} start={s} dir={d} predict={pr.selfTest} showExt={showExt} setShowExt={setShowExt}
      selKey={selKey(d)}
      onSel={(id, e, key) => {
        const moved = key !== selKey(d)
        setFlowSel((x) => ({ ...x, [d]: { start: s, key } }))
        // a row picked in the tree opens that function everywhere: above, in 說明, and as the trees' start
        if (moved && key !== 'root') fromPanel(id, placeOf(id) ?? (e ? { kind: 'file', f: e.f, l: e.l } : null))
      }} />
    return { id: d, title, render: () => <div className="view">
      {shownTrail ? <nav className="trail small" aria-label={t('瀏覽路徑')}>
        <span className="muted">{t('瀏覽路徑：')}</span>
        {trail.map((id, i) => <span key={id}>{i ? <span className="info-sep" aria-hidden="true">›</span> : null}
          {i === trail.length - 1 ? <span className="mono trail-here" aria-current="true">{ix.funcs[id]?.name.split('.').pop() ?? id}</span>
            : <button type="button" className="linklike mono" onClick={() => { const a = placeOf(id); if (a) { setTrail((tr) => tr.slice(0, i + 1)); setPin(null); setAt(a) } }}>{ix.funcs[id]?.name.split('.').pop() ?? id}</button>}</span>)}
      </nav> : null}
      {!flowStart ? <Relations ix={ix} at={at} mode={d} openFile={(f) => openFile(f, 1)} openComp={openComp} />
        : d === 'down' ? (ix.funcs[flowStart] ? tree(flowStart) : <p className="small muted">{t('repo 外的函式：僅能顯示其呼叫者。')}</p>)
        : <>
          {/* how far a change reaches is said once, in 檢查; here only the two ways to list it */}
          <p className="small impact-sum"><button type="button" className="linklike" onClick={() => setUpTable(!upTable)}>{upTable ? t('改為呼叫樹') : t('列成表')}</button></p>
          {upTable ? <Impact ix={ix} start={flowStart} sourceId={p.sourceId} openSearch={() => setPalette(true)}
              onSel={(id, e) => fromPanel(id, placeOf(id) ?? (e ? { kind: 'file', f: e.f, l: e.l } : null))} />
            : ix.funcs[flowStart] ? tree(flowStart) : null}
        </>}
    </div> }
  }
  // 對外介面 follows what is open: the whole project, a component, a file, or the function the code is in
  const within = at.kind === 'comp' ? (fid: string | undefined, f: string) => (fid ? ix.funcs[fid]?.comp === at.id : compOfFile(ix, f) === at.id)
    : at.kind === 'file' ? (fn ? (fid: string | undefined) => fid === fn : (_: string | undefined, f: string) => f === at.f)
    : undefined
  // the project's words, explained where they appear (說明, the call trees' descriptions) and found by the search
  const termsCtx = useMemo(() => { const terms = termsOf(ix, descOrder), open = (f: string, l: number) => openFile(f, l); return { terms, defs: termDefs(terms, open), open } }, [ix, descOrder])   // eslint-disable-line react-hooks/exhaustive-deps
  const views: (UI.WorkbenchView & { id: ViewId })[] = [
    { id: 'info', title: t('說明'), render: () => <div className="view">{edge
      ? <EdgeDetail ix={ix} id={edge} isLive={isLive} sourceId={p.sourceId} open={(id, e) => (e ? openFile(e.f, e.l) : openFn(id))} onBack={() => setEdge('')} />
      : <Info ix={ix} at={at} fn={fn} openFn={openFn} line={picked && at.kind === 'file' ? at.l : null} />}</div> },
    { id: 'defs', title: t('定義'), render: () => <div className="view">
      <Defs ix={ix} file={at.kind === 'file' ? at.f : null} line={picked && at.kind === 'file' ? at.l : null} open={openFile} openFn={openFn} /></div> },
    flowView('down', 'callee'),
    flowView('up', 'caller'),
    { id: 'world', title: t('對外介面'), render: () => <div className="view world-view">
      <Overview ix={ix} isLive={isLive} sourceId={p.sourceId} onComp={openComp} onPick={openFn} mode="bare" only={WORLD} compact within={within}
        empty={<p className="small muted">{at.kind === 'comp' ? t('此元件不執行外部指令，亦不讀寫環境變數或檔案。')
          : fn ? t('此函式不執行外部指令，亦不讀寫環境變數或檔案。') : t('此檔案不執行外部指令，亦不讀寫環境變數或檔案。')}</p>} />
    </div> },
    { id: 'check', title: t('檢查'), render: () => <div className="view check-view">
      <div className="check-cols">
      {fn ? <FnChecks ix={ix} id={fn} open={openFile} />
        : at.kind === 'file' ? <ScopeChecks ix={ix} title={t('{v1} 的檢查', { v1: at.f.split('/').pop()! })} inside={(_, f) => f === at.f} open={openFile} openFn={openFn} />
        : at.kind === 'comp' ? <ScopeChecks ix={ix} title={t('{v1} 的檢查', { v1: at.id })} inside={(id) => ix.funcs[id]?.comp === at.id} open={openFile} openFn={openFn} /> : null}
      <Check compact ix={ix} isLive={isLive} sourceId={p.sourceId} open={(id, e) => (e ? openFile(e.f, e.l) : openFn(id))} />
      <DescHealth compact ix={ix} />
      {at.kind === 'proj' || at.kind === 'settings' ? <section className="chk-sec chk-worth"><Overview ix={ix} isLive={isLive} sourceId={p.sourceId} onComp={openComp} onPick={openFn} mode="bare" only={['ov-worth']} compact /></section> : null}
      </div>
    </div> },
  ]

  const comp = at.kind === 'comp' ? p.graph.comps.find((c) => c.id === at.id) : undefined
  const stage = at.kind === 'settings'
    ? <div className="stage-scroll"><Settings graph={p.graph} meta={p.meta} cat={cat} setCat={setCat} snapName={p.snapName} hasLive={p.hasLive}
        backLive={() => p.setSource('live')} openSnapshot={p.openSnapshot} openError={p.openError}
        onShowExtDefault={setShowExt} refresh={() => qc.invalidateQueries()} resetLayout={() => wb.current?.resetLayout()}
        openAt={(f, l) => openFile(f, l)} /></div>
    : empty ? <UI.EmptyState title={t('索引中無函式')} description={t('請確認 compile_commands.json 包含目標檔案，再執行 codemap index。')} />
    : at.kind === 'proj' ? <div className="stage-scroll"><Overview ix={ix} isLive={isLive} sourceId={p.sourceId} onComp={openComp} onPick={openFn} mode="page" only={['ov-project', 'ov-comps']} /></div>
    : at.kind === 'comp' ? (comp?.lang
      ? <div className="stage-scroll"><CompDetail ix={ix} comp={at.id} isLive={isLive} sourceId={p.sourceId} onPick={openFn} onComp={openComp} /></div>
      : <Arch ix={ix} sel={at.id} onSel={openComp} edge={edge} onEdge={(e) => { setEdge(e); if (e) show('info') }} />)
    : <FileReader key={at.f} ix={ix} at={at} isLive={isLive} sourceId={p.sourceId} onFunc={openFn} bare mdMode={isMd ? mdShown : undefined} peek={peekLine}
        onLine={(n) => { setPicked(true); setAtState((a) => (a.kind === 'file' ? { ...a, l: n } : a)) }} />

  // where the open thing is: each step up is a link (the address handles it, like a step back)
  const crumbs: UI.BreadcrumbItem[] = [{ label: p.graph.repo, href: '#overview' }]
  if (at.kind === 'settings') crumbs.push({ label: t('設定') })
  const cid = at.kind === 'comp' ? at.id : isFile ? compOfFile(ix, at.f) : undefined
  if (cid) crumbs.push({ label: cid === TRACED ? t('被追蹤的程式') : cid, href: hashOf({ kind: 'comp', id: cid }, null) })
  if (isFile) crumbs.push({ label: at.f.split('/').pop()!, href: hashOf({ kind: 'file', f: at.f, l: 1 }, null) })
  if (fn) crumbs.push({ label: ix.funcs[fn].name })
  delete crumbs[crumbs.length - 1].href

  const snapAlert = !isLive && alertOpen ? (
    <UI.Alert tone="info" title={t('目前開啟的是快照')}
      actionLabel={p.hasLive ? t('回到即時') : undefined} onAction={p.hasLive ? () => p.setSource('live') : undefined}
      onDismiss={() => setAlertOpen(false)}>
      {t('commit {v1} 的快照，僅供瀏覽。重新檢查筆記需執行 codemap serve。', { v1: p.graph.commit ?? t('（無）') })}
    </UI.Alert>
  ) : null
  // an address that points at test code while test code is hidden: say so, rather than showing something else
  const testAlert = init.s && !ix.funcs[init.s] && p.graph.funcs[init.s]?.scope === 'test' ? (
    <UI.Alert tone="info" title={t('{v1} 是測試程式碼', { v1: p.graph.funcs[init.s].name })} actionLabel={t('包含測試程式碼')} onAction={() => prefs.set('tests', true)}>
      {t('流程、影響範圍與搜尋預設不含測試程式碼，因此此處顯示其他函式；開啟此設定即可查看。')}
    </UI.Alert>
  ) : init.s && !known(init.s) && !p.graph.funcs[init.s] ? (
    <UI.Alert tone="warning" title={t('找不到「{v1}」', { v1: init.s })} actionLabel={t('搜尋')} onAction={() => setPalette(true)}>
      {t('網址指定的函式不在索引中。')}
    </UI.Alert>
  ) : null

  return (
    <OpenFile.Provider value={openFile}><PeekLine.Provider value={setPeekLine}><OpenFunc.Provider value={openFn}><OpenCall.Provider value={(id) => (fn && ix.funcs[id] && id !== fn ? fromPanel(id, placeOf(id)) : openFn(id))}><TermsCtx.Provider value={termsCtx}>
    <UI.Workbench ref={wb} id="codemap" className="wb" views={views} defaultLayout={LAYOUT} onLayoutChange={setLayout}
      brand={{ mark: <span className="brand-mark" />, name: 'codemap', href: '#overview' }}
      crumbs={crumbs}
      mainBar={isFile ? <>{isMd ? <UI.SegmentedControl label={t('顯示方式')} iconOnly value={mdShown}
        onChange={(m) => setMdMode({ f: at.f, m })}
        items={[{ id: 'preview', label: t('預覽'), icon: 'eye' }, { id: 'source', label: t('原始碼'), icon: 'file-code' }]} /> : null}
        <EditorButton ix={ix} file={at.f} line={at.l} /></> : undefined}
      explorerFilter={{ value: q, onChange: setQ, label: t('篩選檔案與函式') }}
      explorer={<Explorer ix={ix} at={at} fn={fn} q={q} open={explorerOpen} />}
      explorerFoot={<button type="button" className={'ex-foot' + (at.kind === 'settings' ? ' is-on' : '')} onClick={() => setAt({ kind: 'settings' })}><UI.Icon name="gear" />{t('設定')}</button>}
      actions={<>
        <UI.IconButton variant="quiet" icon="magnifying-glass" label={t('搜尋（Ctrl K）')} onClick={() => setPalette(true)} data-tour="search" />
        {/* a first visit: a dot on the help button and a bubble under it, until it is started or closed */}
        <UI.IconButton variant="quiet" icon="question" label={t('重看導覽')} onClick={tourStart}
          hint={welcome ? { text: t('導覽：六個步驟介紹這個版面。'), onAction: tourStart, onDismiss: () => { setWelcome(false); seenTour.close() } } : undefined} />
        <UI.ProjectSwitcher project={p.graph.repo} status={isLive ? 'live' : 'stale'} statusLabel={isLive ? undefined : t('快照')}
          value={p.sourceId} onChange={p.setSource} options={p.sources}
          footer={<a className="link" href="#settings" onClick={(e) => { e.preventDefault(); setCat('source'); setAt({ kind: 'settings' }) }}>{t('所有資料來源設定')}</a>} />
      </>}>
      {snapAlert || testAlert ? <div className="wb-notice">{snapAlert}{testAlert}</div> : null}
      <div className="stage" data-tour="stage">{stage}</div>
    </UI.Workbench>
    <UI.CommandPalette key={paletteKey} open={searchOpen} onOpenChange={setPalette} items={found.map(localKind)} recent={recent.map(localKind)} filter={false} onQueryChange={setQuery} loading={searching} total={total}
      noResultsText={(q) => noResults(q)}
      placeholder={t('搜尋名稱，或程式碼與文件中的文字')} label={t('搜尋名稱與程式碼、文件內文')} onSelect={select}
      kinds={Object.fromEntries(Object.entries(KIND_ICONS).map(([k, v]) => [t(k), v]))} />
    <UI.Tour open={tourOpen} onClose={tourClose} step={tourStep} onStepChange={setTourStep} steps={[
      { target: TOUR_TARGETS[0], title: t('檔案總管'), text: t('專案、元件、檔案與函式。選取項目即於中間開啟；圓點：有值得注意之處。上方可篩選名稱。') },
      { target: TOUR_TARGETS[1], title: t('搜尋'), text: COARSE ? t('搜尋函式、檔案、元件與環境變數。') : t('Ctrl K 或 Ctrl P：搜尋函式、檔案、元件與環境變數。') },
      { target: TOUR_TARGETS[2], title: t('主畫面'), text: t('專案：總覽；元件：架構圖；檔案與函式：程式碼。程式碼中的藍色名稱為連結。') },
      { target: TOUR_TARGETS[3], title: t('說明'), text: t('開啟項目的說明；函式另列 Parameters、Contract 等資料。選取程式碼中的一行，即標示與該行相關的資料。') },
      { target: TOUR_TARGETS[4], title: t('callee 與 caller'), text: t('callee：目前函式呼叫的函式。caller：呼叫目前函式的函式。選取名稱即開啟該函式，上方列出瀏覽路徑；分頁可拖曳至右側欄或下方面板。') },
      { target: TOUR_TARGETS[5], title: t('檢查'), text: t('自動檢查的結果、說明與程式碼不一致之處，以及修改的影響範圍。檔案總管中有圓點的項目會開啟此分頁。') },
    ]} />
    </TermsCtx.Provider></OpenCall.Provider></OpenFunc.Provider></PeekLine.Provider></OpenFile.Provider>
  )
}

type Target = { type: 'func'; id: string } | { type: 'comp'; id: string } | { type: 'page'; id: View } | { type: 'line'; fid: string; f: string; l: number }
  | { type: 'ext'; id: string } | { type: 'overview'; sec?: string } | { type: 'file'; f: string; l: number }
/** A search result, with where it leads (onSelect gets the same type back). */
type PaletteItem = UI.PaletteItem & { target: Target; weight?: number }

/** Everything the search finds: functions, files, components, environment variables and pages. */
function paletteItems(ix: Index, order: DescOrder): PaletteItem[] {
  const short = (ref: string) => '`' + UI.format.path(ref) + '`'
  const readable = new Set(ix.g.readable ?? [])
  const items: PaletteItem[] = []
  // static functions of the same name in different files: say so, the first one is not the only one
  const sameName = new Map<string, number>()
  const byName = new Map<string, Func[]>()
  for (const f of Object.values(ix.funcs)) {
    sameName.set(f.name, (sameName.get(f.name) ?? 0) + 1)
    byName.set(f.name, [...(byName.get(f.name) ?? []), f])
  }
  for (const [id, f] of Object.entries(ix.funcs)) {
    const twins = sameName.get(f.name)! - 1
    // what it does, when someone wrote it: shown first, and its words find the function (「同步路由」 finds _sync_as)
    const d = descLine(ix, id, order)
    const what = d && d.kind !== 'facts' ? `${d.text} · ${t(SRC_LABEL[d.kind])} · ` : ''
    items.push({ id: 'f:' + id, kind: ({ method: '方法', class: '類別', module: '模組', page: '頁面', stylesheet: '樣式表' } as Record<string, string>)[f.kind ?? ''] ?? '函式', label: f.name, code: true,
      keywords: [f.file, ...(f.doc ? [f.doc] : []), ...Object.values(f.ai?.text ?? {})],
      // functions of the same name differ only by their path: shown in full, never shortened
      detail: what + `${twins ? '`' + `${f.file}:${f.line}` + '`' : short(`${f.file}:${f.line}`)} · ${f.comp}` + (twins ? t('（同名的還有 {v1}）', { v1: (byName.get(f.name) ?? []).filter((g) => g !== f).slice(0, 3).map((g) => '`' + `${g.file}:${g.line}` + '`').join(t('、')) + (twins > 3 ? t(' 等') : '') }) : ''),
      weight: ix.callers(id).length + ix.callees(id, false).length, target: { type: 'func', id } })
  }
  for (const c of ix.g.comps) {
    items.push({ id: 'c:' + c.id, kind: '元件', label: c.id, code: true, detail: t('{v1} 個檔案 · {v2} 個函式{v3}', { v1: c.files, v2: c.funcs, v3: c.shared ? t(' · 共用') : '' }), target: { type: 'comp', id: c.id } })
  }
  // every variable the rules found, from the graph's table (older graphs: from the env edges)
  const envs: [string, { set: string[]; get: string[] }][] = ix.g.env ? Object.entries(ix.g.env)
    : [...new Set(ix.g.edges.filter((e) => isEnv(e) && e.name).map((e) => e.name!))].map((n) => [n, {
        set: ix.g.edges.filter((e) => isEnv(e) && e.name === n).map((e) => `${e.f}:${e.l}`),
        get: ix.g.edges.filter((e) => isEnv(e) && e.name === n && e.read_at).map((e) => e.read_at!) }])
  for (const [name, v] of envs.sort(([a], [b]) => a.localeCompare(b))) {
    const refs = [...v.get, ...v.set]
    const hit = refs.map((r) => [r, ix.at(r)] as const).find(([, h]) => h)
    const more = (n: number) => (n > 2 ? t(' 等 {n} 處', { n }) : '')
    const detail = [v.get.length ? t('讀取於 {v1}{v2}', { v1: v.get.slice(0, 2).map(short).join(t('、')), v2: more(v.get.length) }) : '',
      v.set.length ? t('設定於 {v1}{v2}', { v1: v.set.slice(0, 2).map(short).join(t('、')), v2: more(v.set.length) }) : ''].filter(Boolean).join(t('；'))
    items.push({ id: 'env:' + name, kind: '環境變數', label: name, code: true, detail,
      target: hit ? { type: 'line', fid: hit[1]!.id, f: hit[1]!.edge.f, l: hit[1]!.edge.l }
        : ((r) => r ? { type: 'file' as const, f: r.slice(0, r.lastIndexOf(':')), l: Number(r.split(':').pop()) } : { type: 'overview' as const })(refs.find((r) => readable.has(r.slice(0, r.lastIndexOf(':'))))) })
  }
  // functions outside the repo, to find who calls them (getenv, shm_open, dlsym ...)
  const ext = new Map<string, string[]>()
  for (const e of ix.g.edges) if (written(e) && !ix.funcs[e.d] && ix.funcs[e.s]) push(ext, e.d, e.s)
  for (const [id, callers] of [...ext].sort(([a], [b]) => a.localeCompare(b))) {
    items.push({ id: 'x:' + id, kind: '外部函式', label: ix.bareName(id), code: true, detail: ix.g.stats.backends && !ix.g.stats.backends.includes('gcc') ? t('repo 內有 {v1} 個函式呼叫，共 {v2} 處', { v1: new Set(callers).size, v2: callers.length }) : t('repo 內有 {v1} 個函式呼叫，共 {v2} 處（僅計 compile_commands.json 中的檔案）', { v1: new Set(callers).size, v2: callers.length }), target: { type: 'ext', id } })
  }
  // ideas a reader searches for by name, answered on the overview
  for (const [label, keywords] of [[t('載入與結束時自動執行的函式（constructor / destructor）'), ['constructor', 'destructor', 'ctor', 'dtor', '__attribute__']],
    [t('外部進入點（LD_PRELOAD 攔截）'), ['LD_PRELOAD', 'interpose', 'hook', t('攔截'), 'entry point']],
    [t('執行期設定（環境變數）'), ['env', 'getenv', 'environment', t('設定')]]] as const) {
    items.push({ id: 'k:' + label, kind: '概觀', label, detail: t('總覽'), keywords: [...keywords], target: { type: 'overview' } })
  }
  // the project's words: a term found by name, its description beside it, opening where it is used
  for (const x of termsOf(ix, order)) {
    items.push({ id: 't:' + x.term, kind: '名詞', label: x.term, code: true, detail: x.text.length > 80 ? x.text.slice(0, 79) + '…' : x.text,
      target: x.at ? { type: 'file' as const, f: x.at.f, l: x.at.l } : { type: 'overview' as const } })
  }
  // every section of the overview, by its heading
  for (const [sec, label] of OVERVIEW_SECTIONS) {
    items.push({ id: 'k:' + sec, kind: '概觀', label: t(label), detail: t('總覽'), keywords: [label, t(label), ...(SECTION_WORDS[sec] ?? [])], target: { type: 'overview', sec } })
  }
  // every readable file (headers, Makefile, linker maps too), and macros and file-scope variables by name
  // one entry per file: its name, with the path and the number of functions under it
  const byFile = ix.byFile()
  for (const f of new Set([...(ix.g.readable ?? []), ...byFile.keys()])) {
    const n = byFile.get(f)?.length
    items.push({ id: 'file:' + f, kind: '檔案', label: f.split('/').pop()!, detail: n ? t('{v1} · {v2} 個函式', { v1: f, v2: n }) : f, keywords: [f], code: true, target: { type: 'file', f, l: 1 } })
  }
  for (const s of ix.g.symbols ?? []) {
    items.push({ id: `s:${s.file}:${s.line}`, kind: s.kind === 'macro' ? '巨集' : '全域變數', label: s.name, code: true,
      detail: t('{v1}（{v2}:{v3}）', { v1: s.text, v2: s.file.split('/').pop(), v3: s.line }), target: { type: 'file', f: s.file, l: s.line } })
  }
  for (const v of Object.keys(PAGES) as View[]) items.push({ id: 'p:' + v, kind: '頁面', label: t(PAGES[v].title), detail: t(PAGES[v].detail), target: { type: 'page', id: v } })
  return items
}

/** Each kind of search result and its icon; the kinds stay in Chinese inside (the ranking orders by
 *  them) and are shown in the current language. */
const KIND_ICONS: Record<string, UI.IconSource> = { 程式碼: 'file-code', 測試: 'check-square', 註解: 'info', Python: 'terminal-window', 文件: 'file', 函式: 'brackets-curly', 環境變數: 'terminal-window', 元件: 'squares-four', 外部函式: 'arrow-square-out', 概觀: 'info', 檔案: 'file-text', 巨集: 'hash', 全域變數: 'database', 頁面: 'house', 名詞: 'chat-centered' }
const localKind = <T extends { kind?: string }>(i: T): T => ({ ...i, kind: i.kind && t(i.kind) })

/** What a line of text found in a file is: the project's C code first, then its tests, its Python tools, its documents. */
const TEXT_ORDER = ['程式碼', '註解', '測試', 'Python', '文件']

/** What to try when nothing matched: each word of a phrase on its own, and the overview's words
 *  for the questions people come with. */
function noResults(q: string): string {
  const words = q.trim().split(/\s+/).filter((w) => w.length >= 2)
  const tryWords = (ws: string[]) => ws.map((w) => t('「{v1}」', { v1: w })).join(t('、'))
  return words.length > 1
    ? t('找不到「{v1}」。可分開搜尋{v2}；若要找風險或限制，可搜尋{v3}。', { v1: q, v2: tryWords(words), v3: tryWords([t('風險'), 'overrun', t('上限')]) })
    : t('找不到「{v1}」：請改用較短的詞或名稱的一部分；查詢風險或限制時，可搜尋{v2}。', { v1: q, v2: tryWords([t('風險'), 'overrun', t('上限')]) })
}
function textKind(file: string): string {
  if (/\.(md|rst|txt|adoc)$/i.test(file) || /(^|\/)docs?\//.test(file) && !/\.(c|h|py)$/.test(file)) return '文件'
  if (/(^|\/)tests?\//.test(file) || /(^|\/)test_[^/]*$/.test(file)) return '測試'
  if (/\.py$/.test(file)) return 'Python'
  return '程式碼'
}
/** A Markdown line as it reads: no heading marks, emphasis, code ticks or table bars. */
function plainDoc(s: string): string {
  return s.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').replace(/\*\*|__|`/g, '').replace(/\s*\|\s*/g, ' · ').replace(/^ · | · $/g, '').trim()
}
/** Other words a reader may search for a section with. */
const SECTION_WORDS: Record<string, string[]> = { 'ov-docs': ['docs', 'documentation', 'design', 'README', '設計文件', '說明文件', '文件'], 'ov-leftovers': ['shm_unlink', 'unlink', '/dev/shm', 'leak', '殘留', '清除', 'cleanup'], 'ov-loss': ['overrun', 'lost', 'loss', 'drop', '遺失', '丟失', '資料遺失', '覆寫'], 'ov-limits': ['上限', 'limit', 'MAX', 'silent', '靜默'], 'ov-worth': ['風險', '問題', '限制', 'risk', 'risks', 'issue'], 'ov-env': ['env', 'getenv', '設定', 'dynamic loader', 'loader', 'LD_PRELOAD'],
  'ov-build': ['make', 'Makefile', '安裝', 'install'], 'ov-writes': ['輸出', 'output', 'fopen'], 'ov-entry': ['constructor', 'destructor', 'LD_PRELOAD'] }

/** The overview's sections and their headings (ids are the headings' element ids). */
// the overview's sections about what to check: they are on the check page
const WORTH_SECTIONS = new Set(['ov-worth', 'ov-stops', 'ov-arrays', 'ov-unset', 'ov-errors', 'ov-loss', 'ov-leftovers', 'ov-limits', 'ov-plain', 'ov-nullenv'])
const OVERVIEW_SECTIONS = [['ov-comps', '元件'], ['ov-entry', '進入與結束'], ['ov-env', '執行期設定（環境變數）'], ['ov-build', '建置產物'],
  ['ov-writes', '寫出的檔案'], ['ov-worth', '值得檢查的地方'], ['ov-stops', '結束程式的呼叫'], ['ov-arrays', '固定大小的全域陣列'],
  ['ov-unset', '只在未設定時才設定的環境變數'], ['ov-errors', '回傳固定錯誤碼的地方'], ['ov-docs', '專案文件'], ['ov-loss', '會丟掉資料的地方'], ['ov-leftovers', '程式結束後會留下的東西'], ['ov-limits', '到達上限時直接返回、不印訊息'], ['ov-plain', '不經 atomic 操作就修改的全域變數'],
  ['ov-nullenv', '未檢查 NULL 就使用的 getenv 結果']] as const

let lastCat = 'source'

interface Loc { at: At | null; s?: string; d?: string; v?: ViewId; p?: string[] }

/** What the address opens. #overview, #comp?c=harness, #code?f=harness/controller.py&l=698, #settings; v= a view
 *  (info, flow, impact, check), s= the function the panel starts from when it is not the open one, d=up.
 *  Older addresses still open: #arch?c=…, #arch?o=path:line, #flow?s=…&f=…, #impact?s=…, #check, #notes; and one typed
 *  by hand, #harness/routing.py:108 or #parse_fib, opens that function. */
function readHash(ix: Index): Loc {
  const [page, query = ''] = location.hash.slice(1).split('?')
  const q = new URLSearchParams(query)
  const get = (k: string) => q.get(k) ?? undefined
  const place = (id: string | undefined): At | null => (id && ix.funcs[id] ? { kind: 'file', f: ix.funcs[id].file, l: ix.funcs[id].line } : null)
  // older addresses named the tabs flow and impact, and the direction d=up
  const view = (v: string | undefined) => {
    const w = v === 'flow' ? (get('d') === 'up' ? 'up' : 'down') : v === 'impact' ? 'up' : v
    return (VIEW_IDS as string[]).includes(w ?? '') ? w as ViewId : undefined
  }
  const o = /^(.+):(\d+)$/.exec(get('o') ?? '')
  const base = { d: get('d'), v: view(get('v')), p: get('p')?.split(',').filter((x) => ix.funcs[x]) }
  switch (page) {
    case '': case 'overview': return { at: { kind: 'proj' }, ...base }
    case 'settings': return { at: { kind: 'settings' }, ...base }
    case 'comp': return { at: get('c') ? { kind: 'comp', id: get('c')! } : { kind: 'proj' }, s: get('s'), ...base }
    case 'code': return { ...base, at: get('f') ? { kind: 'file', f: get('f')!, l: Number(get('l') ?? 1) || 1 } : null, s: get('s') }
    case 'arch': {
      const c = get('c')
      return { at: o ? { kind: 'file', f: o[1], l: +o[2] } : c?.startsWith('file:') ? { kind: 'file', f: c.slice(5), l: 1 } : c ? { kind: 'comp', id: c } : { kind: 'proj' }, ...base }
    }
    case 'flow': case 'impact': {
      const s = get('s'), f = get('f')
      return { at: o ? { kind: 'file', f: o[1], l: +o[2] } : place(f ?? s), s: f && f !== s ? s : undefined, v: view(page) }
    }
    case 'check': case 'notes': return { at: null, v: 'check' }
  }
  const raw = decodeURIComponent(location.hash.slice(1))
  const m = /^(.+?):(\d+)$/.exec(raw)
  if (m) return { at: { kind: 'file', f: m[1], l: +m[2] } }
  const id = ix.funcs[raw] ? raw : Object.keys(ix.funcs).find((k) => ix.funcs[k].name === raw || ix.funcs[k].name.split('.').pop() === raw)
  return { at: place(id) }
}

/** The address of what is open; s when the panel starts elsewhere. */
function hashOf(at: At, s: string | null, trail?: string[]): string {
  const q = new URLSearchParams()
  if (at.kind === 'comp') q.set('c', at.id)
  if (at.kind === 'file') { q.set('f', at.f); q.set('l', String(at.l)) }
  if (s) q.set('s', s)
  if (trail && trail.length > 1) q.set('p', trail.join(','))
  const qs = q.toString()
  return '#' + ({ proj: 'overview', comp: 'comp', file: 'code', settings: 'settings' } as const)[at.kind] + (qs ? '?' + qs : '')
}

/** A value that follows v after it has stopped changing for ms. */
function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

/** Search a snapshot's function sources, the only text it keeps. */
function snapshotGrep(ix: Index, q: string): GrepHit[] {
  // as the server does: a name with a capital or an underscore matches as written
  const exact = /[A-Z_]/.test(q), want = exact ? q : q.toLowerCase(), out: GrepHit[] = []
  for (const f of Object.values(ix.funcs)) {
    const top = f.top ?? f.line
    ;(f.src ?? []).forEach((s, i) => { if (out.length < 20 && (exact ? s : s.toLowerCase()).includes(want)) out.push({ file: f.file, line: top + i, text: s.trim().slice(0, 200) }) })
    if (out.length >= 20) break
  }
  return out
}
