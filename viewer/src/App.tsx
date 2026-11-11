import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { UI } from './ui'
import { early, stopEarly } from './early'
import { t } from './i18n'
import { Index, isEnv, production, push } from './data/graph'
import { usePrefs } from './data/hooks'
import { prefs } from './prefs'
import { rank } from './data/search'
import { revealTop } from './scroll'
import { embeddedSnapshot, live, liveMeta, snapshotFromFile, snapshotFromURL } from './data/load'
import { written, type Func, type Graph, type GrepHit, type Meta, type Sel } from './data/types'
import { OpenFile } from './components/DocRefs'
import { Arch, CompDetail, EdgeDetail, TRACED, edgeId, jump } from './pages/Arch'
import { Flow, chainKeys } from './pages/Flow'
import { Impact } from './pages/Impact'
import { Check } from './pages/Check'
import { Settings } from './pages/Settings'
import { Detail } from './pages/Detail'
import { FileView } from './pages/CodeAt'
import { OpenSnapshot, useFilePicker } from './pages/OpenSnapshot'

type View = 'arch' | 'flow' | 'impact' | 'check' | 'settings'
const PAGES: Record<View, { title: string; icon: UI.IconName; detail: string }> = {
  arch: { title: '架構', icon: 'squares-four', detail: '元件與其間的呼叫' },
  flow: { title: '流程', icon: 'share-network', detail: '追蹤函式的呼叫' },
  impact: { title: '影響範圍', icon: 'pulse', detail: '修改函式的影響範圍' },
  check: { title: '檢查筆記', icon: 'check-circle', detail: '核對筆記與程式碼' },
  settings: { title: '設定', icon: 'gear', detail: '資料來源、開啟方式、主題' },
}
const nav = (id: View) => ({ id, label: t(PAGES[id].title), icon: PAGES[id].icon })
// the tour shows the flow tree and the check page, so it moves between pages and returns afterwards
const TOUR_VIEWS: (View | null)[] = ['arch', null, 'flow', 'impact', 'check']
const TOUR_TARGETS = ['arch', 'search', 'tree', 'impact', 'notes']
// phones have no Ctrl K: the tour points at the search button instead
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/** 600 to 1024 px: no sidebar, the navigation opens in a drawer from the menu button (design system AppShell). */
const TABLET = '(min-width: 600px) and (max-width: 1023px)'
function useTablet() {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(TABLET).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(TABLET), f = () => setOn(m.matches)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])
  return on
}
// built when drawn, in the current language
const navItems = () => (['arch', 'flow', 'impact', 'check'] as const).map(nav)

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

function Shell(p: ShellProps) {
  const pr = usePrefs()
  // production code by default: test files, and what they call or set, come in only when asked for
  const ix = useMemo(() => new Index(pr.tests ? p.graph : production(p.graph)), [p.graph, pr.tests])
  const qc = useQueryClient()
  const isLive = !!p.meta
  const first = useMemo(() => ix.firstFunc(), [ix])
  // where the address points: the page, and what is chosen on it (#flow?s=main&k=…)
  // #harness/routing.py:108 or #parse_fib: an address someone typed by hand opens the function there
  const init = useMemo(() => typedHash(ix), [])   // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = useState<View>(init.view ?? 'arch')
  const [collapsed, setCollapsed] = useState(false)
  // nothing selected at first: the whole diagram reads at full strength and the panel says what to click
  const [chosenComp, setSelComp] = useState(init.c ?? '')
  const [selEdge, setSelEdge] = useState(init.e ?? '')        // a line of the architecture diagram; '' when a box or nothing is selected
  // with no start in the address, the function last looked at in this repository (kept per browser), not main
  const lastKey = `codemap:last:${p.graph.repo}`
  const remembered = ((id) => (id && ix.funcs[id] ? id : null))((() => { try { return localStorage.getItem(lastKey) } catch { return null } })())
  const [chosenStart, setStart] = useState<string | null>(init.s ?? remembered ?? first)
  const [chosenSel, setSel] = useState<Sel>({ id: init.f ?? init.s ?? remembered ?? first ?? '', edge: null, key: init.k ?? 'root' })
  useEffect(() => { try { if (chosenStart && ix.funcs[chosenStart]) localStorage.setItem(lastKey, chosenStart) } catch { /* private mode */ } }, [chosenStart, ix, lastKey])
  // 重新載入索引 swaps the graph in place: a choice the new index no longer has falls back to the default
  // '' : nothing selected; a component the new index lacks falls back to nothing
  // a component, the traced program, or a file of the file diagram (file:harness/controller.py)
  const selComp = p.graph.comps.some((c) => c.id === chosenComp) || chosenComp === TRACED
    || (chosenComp.startsWith('file:') && Object.values(p.graph.funcs).some((f) => f.file === chosenComp.slice(5))) ? chosenComp : ''
  // a repo function, or an external one the repo calls (the impact page then lists its callers)
  const start = chosenStart && (ix.funcs[chosenStart] || ix.inn.has(chosenStart)) ? chosenStart : first
  const sel: Sel = ix.funcs[chosenSel.id] || ix.inn.has(chosenSel.id) || ix.out.has(chosenSel.id) ? chosenSel : { id: start ?? '', edge: null, key: 'root' }
  const [dir, setDirState] = useState<'down' | 'up'>(init.d === 'up' ? 'up' : 'down')
  // the flow tree is rebuilt when the direction changes: the keyboard goes back to the direction tabs
  const dirMoved = useRef(false)
  const setDir = (d: 'down' | 'up') => { dirMoved.current = true; setDirState(d) }
  const [predict, setPredict] = useState(false)
  const [showExt, setShowExt] = useState(pr.showExtDefault)
  // kept outside the component: a language change redraws the whole app and must not leave the settings tab
  const [cat, setCatState] = useState(lastCat)
  const setCat = (c: string) => { lastCat = c; setCatState(c) }
  const [alertOpen, setAlertOpen] = useState(true)
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
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key.toLowerCase() !== 'k' && e.code !== 'KeyK')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      paletteOpen.current(!openRef.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const tablet = useTablet()
  const [navOpen, setNavOpen] = useState(false)
  const [recent, setRecent] = useState<PaletteItem[]>([])
  const palette = useMemo(() => paletteItems(ix), [ix])
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
            : ix.g.stats.backends && !ix.g.stats.backends.includes('gcc') ? ` · ${t('在函式之外')}` : ` · ${t('此檔案不在 build 中，只有文字，沒有呼叫關係')}`)
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
        : t('提到這個名稱，不是呼叫')
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
  // the tour starts only when asked: opened by itself on a first visit it covered the page, and readers who
  // came for one answer had to find 「略過」 first. A first visit shows an offer instead (welcome, below)
  // a new box each time the search closes: the next search starts empty, not after the last words
  const [paletteKey, setPaletteKey] = useState(0)
  const seenTour = UI.useTour('codemap')
  const [tourOpen, setTourOpen] = useState(false)
  const [welcome, setWelcome] = useState(() => !seenTour.seen)
  const tour = { open: tourOpen, start: () => { setWelcome(false); setTourOpen(true) }, close: () => { seenTour.close(); setTourOpen(false) } }
  const [tourStep, setTourStep] = useState(0)
  const beforeTour = useRef<{ view: View; comp: string; edge: string } | null>(null)

  // each page and each choice on it is a history entry: back and forward return to the previous
  // selection, and the address can be shared (a typed #check opens that page)
  const here = hashOf({ view, c: selComp, e: selEdge, s: start ?? '', f: sel.id, k: sel.key ?? '', d: dir })
  const placed = useRef(false)
  // what had the keyboard on each address when it was left: going back puts the keyboard there again
  const leftFrom = useRef(new Map<string, string>())
  // the last thing focused: by the time the address changes, the page that had it may be gone already
  const lastFocus = useRef('')
  useEffect(() => {
    const on = (e: FocusEvent) => { const el = e.target as HTMLElement; if (el && el !== document.body) lastFocus.current = (el.textContent ?? '').trim().slice(0, 120) }
    addEventListener('focusin', on)
    return () => removeEventListener('focusin', on)
  }, [])
  useEffect(() => {
    // the first address only gains what was filled in by default: no extra step back
    if (location.hash !== here) {
      if (placed.current && lastFocus.current) leftFrom.current.set(location.hash, lastFocus.current)
      if (placed.current) history.pushState(null, '', here)
      else history.replaceState(null, '', here)
    }
    placed.current = true
  }, [here])
  useEffect(() => {
    const onPop = () => {
      const h = typedHash(ix)
      if (!h.view) return
      setFileAt(null)
      setView(h.view)
      setSelComp(h.c ?? ''); setSelEdge(h.e ?? '')
      if (h.s) setStart(h.s)
      if (h.s || h.f) setSel({ id: h.f ?? h.s!, edge: null, key: h.k ?? 'root' })
      setDirState(h.d === 'up' ? 'up' : 'down')
      const text = leftFrom.current.get(location.hash)
      // the page is drawn again first: look for it for up to a second
      if (text) {
        let tries = 0
        const find = () => {
          const el = [...document.querySelectorAll<HTMLElement>('main [role=treeitem], main button, main a, main [tabindex]')].find((x) => (x.textContent ?? '').trim().slice(0, 120) === text)
          if (el) el.focus()
          else if (++tries < 10) setTimeout(find, 100)
        }
        setTimeout(find, 100)
      }
    }
    addEventListener('popstate', onPop)
    addEventListener('hashchange', onPop)
    return () => { removeEventListener('popstate', onPop); removeEventListener('hashchange', onPop) }
  }, [])
  // what changed on screen, for screen readers
  useEffect(() => { if (selComp) UI.announce(t('已開啟 {v1}', { v1: selComp === TRACED ? t('被追蹤的程式（repo 外）') : selComp.replace(/^file:/, '') })) }, [selComp])
  useEffect(() => {
    if (!selEdge) return
    const l = ix.g.links.find((x) => edgeId(x) === selEdge)
    const to = selEdge.startsWith('ext:') ? selEdge.split('->').pop()! : null      // a line from the traced program
    const launch = selEdge.startsWith('ext:launch->')
    const files = selEdge.startsWith('file:') ? selEdge.slice(5).split('->') : null
    UI.announce(l ? t('已開啟 {v1} 到 {v2} 的說明', { v1: l.a, v2: l.b }) : files ? t('已開啟 {v1} 到 {v2} 的說明', { v1: files[0], v2: files[1] })
      : to ? t('已開啟 {v1} 到 {v2} 的說明', launch ? { v1: to, v2: t('被追蹤的程式') } : { v1: t('被追蹤的程式'), v2: to }) : '')
  }, [selEdge, ix])
  // changes on the same page that a screen reader would not otherwise hear about
  useEffect(() => { if (sel.id && ix.funcs[sel.id] && (view === 'flow' || view === 'impact')) UI.announce(t('已選取 {v1}', { v1: ix.funcs[sel.id].name })) }, [sel.id, ix])
  // a file opened from the search belongs to the page it was opened on, not to every page after it
  const [fileAt, setFileAt] = useState<{ f: string; l: number; view: View } | null>(null)
  useEffect(() => { if (fileAt) UI.announce(t('已開啟 {v1} 第 {v2} 行', { v1: fileAt.f.split('/').pop(), v2: fileAt.l })) }, [fileAt])
  // Esc on the architecture page clears the selected box or line (dialogs handle their own Esc first)
  useEffect(() => {
    if (view !== 'arch') return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !searchOpen && !tour.open) { setSelComp(''); setSelEdge('') } }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [view, searchOpen, tour.open])

  const pick = (id: string, edge?: Sel['edge'], key?: string | null) => {
    setFileAt(null); setSel({ id, edge: edge ?? null, key: key ?? null })
    // stacked layout (phones, tablets): the details sit below the list, out of sight; bring them up
    if (key !== 'root' && matchMedia('(max-width: 959px)').matches) {
      requestAnimationFrame(() => revealTop(document.querySelector('.body .detail:not(.pane)')))
    }
  }
  // a page change made here (not by the search or the navigation, which move focus themselves): focus goes to the new page
  const moved = (v: View) => { if (v !== view) requestAnimationFrame(() => UI.focusMain()) }
  const [along, setAlong] = useState<{ start: string; keys: string[] } | null>(null)
  const goFlow = (id: string, edge: Sel['edge'] = null) => { setFileAt(null); setAlong(null); setStart(id); setSel({ id, edge, key: 'root' }); setView('flow'); moved('flow') }
  // a chain of calls from an entry point: the flow starts there, opened row by row down to the last one, which is selected
  const goChain = (ids: string[]) => {
    const keys = chainKeys(ix, ids, showExt)
    if (!keys) return goFlow(ids[ids.length - 1])
    setFileAt(null); setDirState('down'); setPredict(false); setAlong({ start: ids[0], keys: keys.slice(0, -1) }); setStart(ids[0])
    setSel({ id: ids[ids.length - 1], edge: null, key: keys[keys.length - 1] }); setView('flow'); moved('flow')
  }
  const goImpact = (id: string) => { setFileAt(null); setStart(id); setSel({ id, edge: null, key: null }); setView('impact'); moved('impact') }
  // the impact page starts from the function the reader has open, not from where the flow began
  const switchView = (v: View) => {
    if (v === 'impact' && view !== 'impact' && ix.funcs[sel.id] && sel.id !== start) goImpact(sel.id)
    else setView(v)
  }

  function select(item: PaletteItem) {
    setRecent((r) => [item, ...r.filter((x) => x.id !== item.id)].slice(0, 6))
    const t = item.target
    // a new start from the search follows its calls downward, whatever direction was used last
    if (t.type === 'func' || t.type === 'line') setDirState('down')
    if (t.type === 'func') (view === 'impact' ? goImpact : goFlow)(t.id)
    else if (t.type === 'comp') { setSelComp(t.id); setSelEdge(''); setView('arch') }
    else if (t.type === 'page') setView(t.id)
    // on the impact page a hit stays there: the function it is in becomes the one whose impact is shown
    else if (t.type === 'line') (view === 'impact' ? goImpact(t.fid) : goFlow(t.fid, { f: t.f, l: t.l }))
    else if (t.type === 'ext') goImpact(t.id)
    else if (t.type === 'overview') {
      setFileAt(null); setSelComp(''); setSelEdge(''); setView('arch')
      const sec = t.sec
      if (sec) for (const ms of [150, 500, 900]) setTimeout(() => jump(sec), ms)     // after the overview is drawn, and again once its lists have settled
    }
    else if (t.type === 'file' && ((hit) => !!hit && ix.funcs[hit.id].line === t.l)(ix.at(`${t.f}:${t.l}`))) (view === 'impact' ? goImpact : goFlow)(ix.at(`${t.f}:${t.l}`)!.id)   // the line that defines a function: the function, with its callers
    else if (t.type === 'file') { const v = view === 'check' || view === 'settings' ? 'flow' : view; setFileAt({ f: t.f, l: t.l, view: v }); setView(v) }
    // a function chosen in the search: focus its name in the detail panel, where a screen reader hears what was opened
    if (t.type === 'func' || t.type === 'line' || t.type === 'file') for (const ms of [120, 400]) setTimeout(() => document.getElementById('detail-title')?.focus(), ms)
  }
  function tourGo(i: number) {
    setTourStep(i)
    const v = TOUR_VIEWS[i]
    if (v) setView(v)
    if (v === 'arch') { setSelComp(''); setSelEdge(''); setFileAt(null) }      // step 1 points at the overview
  }
  function tourStart() {
    beforeTour.current = { view, comp: selComp, edge: selEdge }
    tourGo(0)
    tour.start()
  }
  function tourClose() {
    tour.close()
    const was = beforeTour.current
    if (was) { setView(was.view); setSelComp(was.comp); setSelEdge(was.edge) }     // back where the reader was
    beforeTour.current = null
  }
  // opened on its own on a first visit, maybe on a shared link to another page: show each step on its own page
  useEffect(() => {
    if (!tour.open || beforeTour.current !== null) return
    beforeTour.current = { view, comp: selComp, edge: selEdge }
    tourGo(tourStep)
  }, [tour.open])
  // a target below a phone's fold, inside the stacked panel's own scrolling: bring it up before the card points at it
  useEffect(() => {
    if (!tour.open) return
    const id = setTimeout(() => {
      const el = document.querySelector(`[data-tour="${TOUR_TARGETS[tourStep]}"]`)
      const r = el?.getBoundingClientRect()
      if (el && r && (r.top < 0 || r.bottom > innerHeight)) revealTop(el, 72)
    }, 250)
    return () => clearTimeout(id)
  }, [tour.open, tourStep, view])

  const caps = p.meta?.capabilities
  const detail = start ? (
    <Detail ix={ix} sel={sel} isLive={isLive} sourceId={p.sourceId} canMacro={!!caps?.macro} goFlow={goFlow} goChain={goChain} goImpact={goImpact} view={view} start={start} />
  ) : null
  const empty = !p.graph.comps.length
  const main = view === 'arch' && !empty ? <Arch ix={ix} sel={selComp} onSel={(c) => { setFileAt(null); setSelComp(c) }} edge={selEdge} onEdge={(e) => { setFileAt(null); setSelEdge(e) }} />
    : view === 'flow' && start ? <Flow key={start + dir} ix={ix} start={start} dir={dir} setDir={setDir} dirMoved={dirMoved}
        predict={predict} setPredict={setPredict} showExt={showExt} setShowExt={setShowExt} selKey={sel.key} along={along?.start === start ? along.keys : undefined} onSel={pick} openSearch={() => setSearchOpen(true)} />
    : view === 'impact' && start ? <Impact ix={ix} start={start} sourceId={p.sourceId} onSel={pick} openSearch={() => setSearchOpen(true)} />
    : view === 'check' ? <Check ix={ix} isLive={isLive} sourceId={p.sourceId} open={goFlow} />
    : <UI.Card className="pane"><UI.EmptyState title={t('索引中沒有函式')} description={t('請確認 compile_commands.json 包含目標檔案，再執行 codemap index。')} /></UI.Card>
  const side = fileAt && fileAt.view === view ? <FileView ix={ix} at={fileAt} isLive={isLive} sourceId={p.sourceId} onClose={() => { setFileAt(null); UI.announce(t('已關閉檔案')); requestAnimationFrame(() => UI.focusMain()) }} />
    : view === 'arch' ? (empty ? null : selEdge ? <EdgeDetail ix={ix} id={selEdge} isLive={isLive} sourceId={p.sourceId} open={goFlow} onBack={() => setSelEdge('')} /> : <CompDetail ix={ix} comp={selComp} isLive={isLive} sourceId={p.sourceId} onPick={goFlow} onComp={(id) => { setSelEdge(''); setSelComp(id) }} />) : view === 'check' ? null : detail

  const snapAlert = !isLive && alertOpen ? (
    <div className="alert-wrap">
      <UI.Alert tone="info" title={t('目前開啟的是快照')}
        actionLabel={p.hasLive ? t('回到即時') : undefined} onAction={p.hasLive ? () => p.setSource('live') : undefined}
        onDismiss={() => setAlertOpen(false)}>
        {t('commit {v1} 的快照，僅供瀏覽。重新檢查筆記需執行 codemap serve。', { v1: p.graph.commit ?? t('（無）') })}
      </UI.Alert>
    </div>
  ) : null

  const openFile = (f: string, l: number) => setFileAt({ f, l, view })
  return (
    <OpenFile.Provider value={openFile}>
    <div className="app">
      <a className="ui-skip" href="#main" onClick={(e) => { e.preventDefault(); UI.focusMain() }}>{t('跳到主要內容')}</a>
      <a className="ui-skip" href="#nav" onClick={(e) => { e.preventDefault(); (document.querySelector<HTMLElement>('.mobile-only:not([hidden]) [role=tab][aria-selected=true], nav [aria-current=page]') ?? document.querySelector<HTMLElement>('nav a, nav button'))?.focus() }}>{t('跳到導覽')}</a>
      {tablet ? (
        <UI.Drawer open={navOpen} onClose={() => setNavOpen(false)} title={t('導覽')} side="left" width={280}>
          <UI.SideNav value={view} onChange={(v) => { switchView(v as View); setNavOpen(false) }}
            brand={<><span className="brand-mark" /><span>codemap</span></>} sections={[{ items: navItems() }, { items: [nav('settings')] }]} />
        </UI.Drawer>
      ) : (
        <UI.SideNav value={view} onChange={(v) => switchView(v as View)} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}
          brand={<><span className="brand-mark" />{collapsed ? null : <span>codemap</span>}</>}
          sections={[{ items: navItems() }, { items: [nav('settings')] }]} />
      )}
      <main className="main">
        <UI.TopBar title={t(PAGES[view].title)} searchLabel={t('搜尋')} onSearch={() => setSearchOpen(true)} onMenu={tablet ? () => setNavOpen(true) : undefined}>
          <UI.IconButton icon="question" label={t('重看導覽')} onClick={tourStart} />
          <UI.ProjectSwitcher project={p.graph.repo} status={isLive ? 'live' : 'stale'} statusLabel={isLive ? undefined : t('快照')}
            value={p.sourceId} onChange={p.setSource} options={p.sources}
            footer={<a className="link" href="#settings" onClick={(e) => { e.preventDefault(); setCat('source'); setView('settings') }}>{t('所有資料來源設定')}</a>} />
        </UI.TopBar>
        {snapAlert}
        {/* an address or a choice that points at test code while test code is hidden: say so, rather than showing main */}
        {((id) => id && !ix.funcs[id] && p.graph.funcs[id]?.scope === 'test' ? (
          <div className="alert-wrap">
            <UI.Alert tone="info" title={t('{v1} 是測試程式碼', { v1: p.graph.funcs[id].name })} actionLabel={t('包含測試程式碼')} onAction={() => prefs.set('tests', true)}>
              {t('流程、影響範圍與搜尋預設不含測試程式碼，因此這裡顯示其他函式。開啟後即可查看。')}
            </UI.Alert>
          </div>
        ) : null)(chosenStart ?? '')}
        {welcome && view !== 'settings' ? (
          <div className="alert-wrap">
            <UI.Alert tone="info" title={t('第一次使用 codemap')} actionLabel={t('開始導覽')} onAction={tourStart}
              onDismiss={() => { setWelcome(false); seenTour.close() }}>
              {COARSE ? t('五個步驟介紹架構、搜尋（上方的放大鏡）、流程、影響範圍與檢查筆記。') : t('五個步驟介紹架構、搜尋（Ctrl K）、流程、影響範圍與檢查筆記。')}
            </UI.Alert>
          </div>
        ) : null}
        {view === 'settings'
          ? <Settings graph={p.graph} meta={p.meta} cat={cat} setCat={setCat} snapName={p.snapName} hasLive={p.hasLive}
              backLive={() => p.setSource('live')} openSnapshot={p.openSnapshot} openError={p.openError}
              onShowExtDefault={setShowExt} refresh={() => qc.invalidateQueries()}
              openAt={(f, l) => select({ id: `t:${f}:${l}`, label: `${f}:${l}`, target: { type: 'file', f, l } })} />
          : side && pr.panel !== 'below'
            // the side panel's width is the reader's: drag the divider, arrow keys, double-click to reset
            ? <div className="body split-body"><UI.SplitPane className="split" a={main} b={side} defaultB={440} minA={420} minB={320} storageKey="codemap-side" label={t('調整面板寬度')} /></div>
            : <div className={'body' + (pr.panel === 'below' && side ? ' below' : '')}>{main}{side}</div>}
        <UI.CommandPalette key={paletteKey} open={searchOpen} onOpenChange={setPalette} items={found.map(localKind)} recent={recent.map(localKind)} filter={false} onQueryChange={setQuery} loading={searching} total={total}
          noResultsText={(q) => noResults(q)}
          placeholder={t('搜尋名稱，或程式碼與文件中的文字')} label={t('搜尋名稱與程式碼、文件內文')} onSelect={select}
          kinds={Object.fromEntries(Object.entries(KIND_ICONS).map(([k, v]) => [t(k), v]))} />
        <UI.Tour open={tour.open} onClose={tourClose} step={tourStep} onStepChange={tourGo} steps={[
          { target: 'arch', title: t('架構圖'), text: t('方塊為元件，線為元件之間的關係。點選概觀的段落名稱可跳到該段。') },
          { target: 'search', title: t('搜尋'), text: COARSE ? t('點選畫面上方的放大鏡，搜尋函式、檔案、元件與環境變數。') : t('Ctrl K：搜尋函式、檔案、元件與環境變數。') },
          { target: 'tree', title: t('流程樹'), text: t('標有「推測（規則：…）」的關係由括號中的規則推得，點選標籤可查看依據。') },
          { target: 'impact', title: t('影響範圍'), text: t('列出修改一個函式後會受影響的函式。') },
          { target: 'notes', title: t('檢查筆記'), text: t('比對筆記裡的引用與目前的程式碼。錯誤的引用附有修正建議，可直接複製。') },
        ]} />
        <div className="mobile-only">
          <UI.MobileTabBar value={view} onChange={(v) => switchView(v as View)} items={[...navItems(), nav('settings')]} />
        </div>
      </main>
    </div>
    </OpenFile.Provider>
  )
}

type Target = { type: 'func'; id: string } | { type: 'comp'; id: string } | { type: 'page'; id: View } | { type: 'line'; fid: string; f: string; l: number }
  | { type: 'ext'; id: string } | { type: 'overview'; sec?: string } | { type: 'file'; f: string; l: number }
/** A search result, with where it leads (onSelect gets the same type back). */
type PaletteItem = UI.PaletteItem & { target: Target; weight?: number }

/** Everything the search finds: functions, files, components, environment variables and pages. */
function paletteItems(ix: Index): PaletteItem[] {
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
    items.push({ id: 'f:' + id, kind: ({ method: '方法', class: '類別', module: '模組', page: '頁面', stylesheet: '樣式表' } as Record<string, string>)[f.kind ?? ''] ?? '函式', label: f.name, code: true, keywords: [f.file],
      // functions of the same name differ only by their path: shown in full, never shortened
      detail: `${twins ? '`' + `${f.file}:${f.line}` + '`' : short(`${f.file}:${f.line}`)} · ${f.comp}` + (twins ? t('（同名的還有 {v1}）', { v1: (byName.get(f.name) ?? []).filter((g) => g !== f).slice(0, 3).map((g) => '`' + `${g.file}:${g.line}` + '`').join(t('、')) + (twins > 3 ? t(' 等') : '') }) : ''),
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
    items.push({ id: 'x:' + id, kind: '外部函式', label: ix.bareName(id), code: true, detail: ix.g.stats.backends && !ix.g.stats.backends.includes('gcc') ? t('{v1} 個 repo 內的函式呼叫它，共 {v2} 處', { v1: new Set(callers).size, v2: callers.length }) : t('{v1} 個 repo 內的函式呼叫它，共 {v2} 處（只算 compile_commands.json 裡的檔案）', { v1: new Set(callers).size, v2: callers.length }), target: { type: 'ext', id } })
  }
  // ideas a reader searches for by name, answered on the overview
  for (const [label, keywords] of [[t('載入與結束時自動執行的函式（constructor / destructor）'), ['constructor', 'destructor', 'ctor', 'dtor', '__attribute__']],
    [t('外部進入點（LD_PRELOAD 攔截）'), ['LD_PRELOAD', 'interpose', 'hook', t('攔截'), 'entry point']],
    [t('執行期設定（環境變數）'), ['env', 'getenv', 'environment', t('設定')]]] as const) {
    items.push({ id: 'k:' + label, kind: '概觀', label, detail: t('架構頁的概觀'), keywords: [...keywords], target: { type: 'overview' } })
  }
  // every section of the overview, by its heading
  for (const [sec, label] of OVERVIEW_SECTIONS) {
    items.push({ id: 'k:' + sec, kind: '概觀', label: t(label), detail: t('架構頁的概觀'), keywords: [label, t(label), ...(SECTION_WORDS[sec] ?? [])], target: { type: 'overview', sec } })
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
const KIND_ICONS: Record<string, UI.IconSource> = { 程式碼: 'file-code', 測試: 'check-square', 註解: 'info', Python: 'terminal-window', 文件: 'file', 函式: 'brackets-curly', 環境變數: 'terminal-window', 元件: 'squares-four', 外部函式: 'arrow-square-out', 概觀: 'info', 檔案: 'file-text', 巨集: 'hash', 全域變數: 'database', 頁面: 'house' }
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
    : t('找不到「{v1}」。請改用較短的詞或名稱的一部分；若要找風險或限制，可搜尋{v2}。', { v1: q, v2: tryWords([t('風險'), 'overrun', t('上限')]) })
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
const OVERVIEW_SECTIONS = [['ov-comps', '元件'], ['ov-entry', '進入與結束'], ['ov-env', '執行期設定（環境變數）'], ['ov-build', '建置產物'],
  ['ov-writes', '寫出的檔案'], ['ov-worth', '值得檢查的地方'], ['ov-stops', '結束程式的呼叫'], ['ov-arrays', '固定大小的全域陣列'],
  ['ov-unset', '只在未設定時才設定的環境變數'], ['ov-errors', '回傳固定錯誤碼的地方'], ['ov-docs', '專案文件'], ['ov-loss', '會丟掉資料的地方'], ['ov-leftovers', '程式結束後會留下的東西'], ['ov-limits', '到達上限時直接返回、不印訊息'], ['ov-plain', '不經 atomic 操作就修改的全域變數'],
  ['ov-nullenv', '未檢查 NULL 就使用的 getenv 結果']] as const

let lastCat = 'source'

interface Loc { view: View | null; c?: string; e?: string; s?: string; f?: string; k?: string; d?: string }

/** The page and the choice on it, from the address: #arch?c=src/ibmon, #flow?s=main&k=root/x@12&d=up,
 *  #impact?s=emit&f=ibt_ring_claim. #notes is another name for the notes page. */
function parseHash(): Loc {
  const [page, query = ''] = location.hash.slice(1).split('?')
  const v = page === 'notes' ? 'check' : page
  const q = new URLSearchParams(query)
  const get = (k: string) => q.get(k) ?? undefined
  return { view: Object.hasOwn(PAGES, v) ? (v as View) : null, c: get('c'), e: get('e'), s: get('s'), f: get('f'), k: get('k'), d: get('d') }
}

/** The address, also when typed by hand: #harness/routing.py:108 or #parse_fib opens that function's flow. */
function typedHash(ix: Index): Loc {
  const h = parseHash()
  const raw = decodeURIComponent(location.hash.slice(1))
  if (h.view || !raw) return h
  const m = /^(.+?):(\d+)$/.exec(raw)
  const id = m ? Object.keys(ix.funcs).filter((k) => ix.funcs[k].file === m[1] && ix.funcs[k].line <= +m[2] && +m[2] <= ix.funcs[k].end)
    .sort((a, b) => ix.funcs[b].line - ix.funcs[a].line)[0]
    : ix.funcs[raw] ? raw : Object.keys(ix.funcs).find((k) => ix.funcs[k].name === raw || ix.funcs[k].name.split('.').pop() === raw)
  return id ? { view: 'flow', s: id } : h
}

/** The address for a page and its choice; only what that page uses goes in. */
function hashOf(l: Required<Omit<Loc, 'view'>> & { view: View }): string {
  const q = new URLSearchParams()
  if (l.view === 'arch') { if (l.c) q.set('c', l.c); if (l.e) q.set('e', l.e) }
  if (l.view === 'flow' || l.view === 'impact') {
    if (l.s) q.set('s', l.s)
    if (l.f && l.f !== l.s) q.set('f', l.f)
    if (l.view === 'flow' && l.k && l.k !== 'root') q.set('k', l.k)
    if (l.view === 'flow' && l.d === 'up') q.set('d', 'up')
  }
  const qs = q.toString()
  return '#' + l.view + (qs ? '?' + qs : '')
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
