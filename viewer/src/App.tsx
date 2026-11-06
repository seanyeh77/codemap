import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { UI } from './ui'
import { Index, isEnv, push } from './data/graph'
import { usePrefs } from './data/hooks'
import { embeddedSnapshot, live, liveMeta, snapshotFromFile, snapshotFromURL } from './data/load'
import type { Graph, Meta, Sel } from './data/types'
import { Arch, CompDetail } from './pages/Arch'
import { Flow } from './pages/Flow'
import { Impact } from './pages/Impact'
import { Check } from './pages/Check'
import { Settings } from './pages/Settings'
import { Detail } from './pages/Detail'
import { OpenSnapshot, useFilePicker } from './pages/OpenSnapshot'

type View = 'arch' | 'flow' | 'impact' | 'check' | 'settings'
const PAGES: Record<View, { title: string; icon: string; detail: string }> = {
  arch: { title: '架構', icon: 'squares-four', detail: '元件與其間的呼叫' },
  flow: { title: '流程', icon: 'share-network', detail: '追蹤函式的呼叫' },
  impact: { title: '影響範圍', icon: 'pulse', detail: '修改函式的影響範圍' },
  check: { title: '檢查筆記', icon: 'check-circle', detail: '核對筆記與程式碼' },
  settings: { title: '設定', icon: 'gear', detail: '資料來源、開啟方式、主題' },
}
const nav = (id: View) => ({ id, label: PAGES[id].title, icon: PAGES[id].icon })
// the tour shows the flow tree and the check page, so it moves between pages and returns afterwards
const TOUR_VIEWS: (View | null)[] = [null, 'flow', 'check']
const NAV = (['arch', 'flow', 'impact', 'check'] as const).map(nav)
const SETTINGS_NAV = nav('settings')

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
    return <div className="boot"><UI.Alert tone="danger" title="無法載入資料">{String((err as Error).message || err)}</UI.Alert></div>
  }
  if (!graph) return <OpenSnapshot onOpen={open} error={openError} />
  return (
    <>
      <Shell key={sourceId} graph={graph} meta={isLive ? meta : null} hasLive={!!meta}
        sources={[...(meta ? [{ id: 'live', label: meta.repo, detail: `${meta.host} 即時` }] : []),
          ...all.map((s) => ({ id: s.id, label: s.graph.repo, detail: '快照 ' + (s.graph.commit ?? s.name ?? '此頁面') }))]}
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
  const ix = useMemo(() => new Index(p.graph), [p.graph])
  const pr = usePrefs()
  const qc = useQueryClient()
  const isLive = !!p.meta
  const first = useMemo(() => ix.firstFunc(), [ix])
  const [view, setView] = useState<View>(() => Object.hasOwn(PAGES, location.hash.slice(1)) ? (location.hash.slice(1) as View) : 'arch')
  const [collapsed, setCollapsed] = useState(false)
  const firstComp = p.graph.comps.find((c) => !c.shared)?.id ?? p.graph.comps[0]?.id ?? ''
  const [chosenComp, setSelComp] = useState<string>(firstComp)
  const [chosenStart, setStart] = useState<string | null>(first)
  const [chosenSel, setSel] = useState<Sel>({ id: first ?? '', edge: null, key: 'root' })
  // 重新載入索引 swaps the graph in place: a choice the new index no longer has falls back to the default
  const selComp = p.graph.comps.some((c) => c.id === chosenComp) ? chosenComp : firstComp
  const start = chosenStart && ix.funcs[chosenStart] ? chosenStart : first
  const sel: Sel = ix.funcs[chosenSel.id] || ix.inn.has(chosenSel.id) || ix.out.has(chosenSel.id) ? chosenSel : { id: start ?? '', edge: null, key: 'root' }
  const [dir, setDir] = useState<'down' | 'up'>('down')
  const [predict, setPredict] = useState(false)
  const [showExt, setShowExt] = useState(pr.showExtDefault)
  const [cat, setCat] = useState('source')
  const [alertOpen, setAlertOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [recent, setRecent] = useState<PaletteItem[]>([])
  const palette = useMemo(() => paletteItems(ix), [ix])
  const tour = UI.useTour('codemap')
  const [tourStep, setTourStep] = useState(0)
  const beforeTour = useRef<View | null>(null)

  useEffect(() => { history.replaceState(null, '', '#' + view) }, [view])

  const pick = (id: string, edge?: Sel['edge'], key?: string | null) => setSel({ id, edge: edge ?? null, key: key ?? null })
  const goFlow = (id: string, edge: Sel['edge'] = null) => { setStart(id); setSel({ id, edge, key: 'root' }); setView('flow') }
  const goImpact = (id: string) => { setStart(id); setSel({ id, edge: null, key: null }); setView('impact') }

  function select(item: PaletteItem) {
    setRecent((r) => [item, ...r.filter((x) => x.id !== item.id)].slice(0, 6))
    const t = item.target as Target
    if (t.type === 'func') goFlow(t.id)
    else if (t.type === 'comp') { setSelComp(t.id); setView('arch') }
    else if (t.type === 'page') setView(t.id)
    else if (t.type === 'line') goFlow(t.fid, { f: t.f, l: t.l })
  }
  function tourGo(i: number) {
    setTourStep(i)
    const v = TOUR_VIEWS[i]
    if (v) setView(v)
  }
  function tourStart() {
    setTourStep(0)
    tour.start()
  }
  function tourClose() {
    tour.close()
    if (beforeTour.current) setView(beforeTour.current)
    beforeTour.current = null
  }
  useEffect(() => { if (tour.open && beforeTour.current === null) beforeTour.current = view }, [tour.open])

  const caps = p.meta?.capabilities
  const detail = start ? (
    <Detail ix={ix} sel={sel} isLive={isLive} sourceId={p.sourceId} canMacro={!!caps?.macro} goFlow={goFlow} goImpact={goImpact} />
  ) : null
  const empty = !p.graph.comps.length
  const main = view === 'arch' && !empty ? <Arch ix={ix} sel={selComp} onSel={setSelComp} />
    : view === 'flow' && start ? <Flow key={start + dir} ix={ix} start={start} dir={dir} setDir={setDir}
        predict={predict} setPredict={setPredict} showExt={showExt} setShowExt={setShowExt} selKey={sel.key} onSel={pick} openSearch={() => setSearchOpen(true)} />
    : view === 'impact' && start ? <Impact ix={ix} start={start} sourceId={p.sourceId} onSel={pick} />
    : view === 'check' ? <Check ix={ix} isLive={isLive} sourceId={p.sourceId} open={goFlow} />
    : <div className="card pane"><UI.EmptyState title="索引中沒有函式" description="請確認 compile_commands.json 包含目標檔案，再執行 codemap index。" /></div>
  const side = view === 'arch' ? (empty ? null : <CompDetail ix={ix} comp={selComp} onPick={goFlow} />) : view === 'check' ? null : detail

  const snapAlert = !isLive && alertOpen ? (
    <div className="alert-wrap">
      <UI.Alert tone="info" title="目前開啟的是快照"
        actionLabel={p.hasLive ? '回到即時' : undefined} onAction={p.hasLive ? () => p.setSource('live') : undefined}
        onDismiss={() => setAlertOpen(false)}>
        {`commit ${p.graph.commit ?? '（無）'} 的快照，僅供瀏覽。重新檢查筆記需執行 codemap serve。`}
      </UI.Alert>
    </div>
  ) : null

  return (
    <div className="app">
      <UI.SideNav value={view} onChange={(v) => setView(v as View)} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}
        brand={<><span className="brand-mark" />{collapsed ? null : <span>codemap</span>}</>}
        sections={[{ items: NAV }, { items: [SETTINGS_NAV] }]} />
      <div className="main">
        <UI.TopBar title={PAGES[view].title} searchLabel="搜尋" onSearch={() => setSearchOpen(true)}>
          <UI.IconButton icon="question" label="重看導覽" onClick={tourStart} />
          <UI.ProjectSwitcher project={p.graph.repo} status={isLive ? 'live' : 'stale'} statusLabel={isLive ? undefined : '快照'}
            value={p.sourceId} onChange={p.setSource} options={p.sources}
            footer={<a className="link" href="#settings" onClick={(e) => { e.preventDefault(); setCat('source'); setView('settings') }}>所有資料來源設定</a>} />
        </UI.TopBar>
        {snapAlert}
        {view === 'settings'
          ? <Settings graph={p.graph} meta={p.meta} cat={cat} setCat={setCat} snapName={p.snapName} hasLive={p.hasLive}
              backLive={() => p.setSource('live')} openSnapshot={p.openSnapshot} openError={p.openError}
              onShowExtDefault={setShowExt} refresh={() => qc.invalidateQueries()} />
          : <div className={'body' + (pr.panel === 'below' && side ? ' below' : '')}>{main}{side}</div>}
        <UI.CommandPalette open={searchOpen} onOpenChange={setSearchOpen} items={palette} recent={recent}
          placeholder="搜尋函式、檔案、元件、環境變數" onSelect={select} />
        <UI.Tour open={tour.open} onClose={tourClose} step={tourStep} onStepChange={tourGo} steps={[
          { target: 'search', title: '搜尋', text: '搜尋函式、檔案、元件與環境變數。快捷鍵 Ctrl K。' },
          { target: 'tree', title: '流程樹', text: '名稱旁的標籤是關係的來源，點選問號查看依據。' },
          { target: 'notes', title: '檢查筆記', text: '錯誤的位置附有修正建議，可直接複製。' },
        ]} />
        <div className="mobile-only">
          <UI.MobileTabBar value={view} onChange={(v) => setView(v as View)} items={[...NAV, SETTINGS_NAV]} />
        </div>
      </div>
    </div>
  )
}

type Target = { type: 'func'; id: string } | { type: 'comp'; id: string } | { type: 'page'; id: View } | { type: 'line'; fid: string; f: string; l: number }
type PaletteItem = Parameters<typeof UI.CommandPalette>[0]['items'][number]

/** Everything the search finds: functions, files, components, environment variables and pages. */
function paletteItems(ix: Index): PaletteItem[] {
  const short = (ref: string) => '`' + UI.format.path(ref) + '`'
  const items: PaletteItem[] = []
  for (const [id, f] of Object.entries(ix.funcs)) {
    items.push({ id: 'f:' + id, kind: '函式', label: f.name, code: true, detail: `${short(`${f.file}:${f.line}`)} · ${f.comp}`, keywords: [f.file], target: { type: 'func', id } })
  }
  for (const [file, ids] of [...ix.byFile()].sort()) {
    items.push({ id: 'file:' + file, kind: '檔案', label: file, code: true, detail: `${ids.length} 個函式`, target: { type: 'func', id: ids[0] } })
  }
  for (const c of ix.g.comps) {
    items.push({ id: 'c:' + c.id, kind: '元件', label: c.id, code: true, detail: `${c.files} 個檔案 · ${c.funcs} 個函式${c.shared ? ' · 共用' : ''}`, target: { type: 'comp', id: c.id } })
  }
  const env = new Map<string, typeof ix.g.edges>()
  for (const e of ix.g.edges) if (isEnv(e) && e.name) push(env, e.name, e)
  for (const [name, es] of [...env].sort()) {
    const e = es.find((x) => ix.funcs[x.s])          // setters in Python or at a site have no page to open
    if (!e) continue
    const fid = e.s
    items.push({ id: 'env:' + name, kind: '環境變數', label: name, code: true,
      detail: `設定於 ${short(`${e.f}:${e.l}`)}${e.read_at ? `，讀取於 ${short(e.read_at)}` : ''}`, target: { type: 'line', fid, f: e.f, l: e.l } })
  }
  for (const v of Object.keys(PAGES) as View[]) items.push({ id: 'p:' + v, kind: '頁面', label: PAGES[v].title, detail: PAGES[v].detail, target: { type: 'page', id: v } })
  return items
}
