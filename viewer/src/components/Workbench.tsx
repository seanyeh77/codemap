import { useEffect, useRef, useState, type ReactNode } from 'react'
import { UI } from '../ui'
import { t } from '../i18n'

/** A view of the workbench: a tab that lives in the side bar or in the panel and can be dragged between them. */
export interface WbView<V extends string> {
  id: V
  title: string
  /** A number after the title, e.g. how many problems the checks found. */
  count?: number
  render: () => ReactNode
}

type Area = 'side' | 'panel'
export interface WbLayout<V extends string> {
  side: V[]
  panel: V[]
  sideOn: V | null
  panelOn: V | null
  tree: boolean
  sideOpen: boolean
  panelOpen: boolean
  treeW: number
  sideW: number
  panelH: number
}

/** How the four areas fit the window: all docked, or the side bar (and then the tree) drawn over the stage. */
type Fit = 'wide' | 'mid' | 'narrow' | 'phone'
function fitOf(w: number): Fit {
  return w >= 1280 ? 'wide' : w >= 960 ? 'mid' : w >= 600 ? 'narrow' : 'phone'
}
function useFit(): Fit {
  const [fit, setFit] = useState(() => fitOf(innerWidth))
  useEffect(() => {
    const on = () => setFit(fitOf(innerWidth))
    addEventListener('resize', on)
    return () => removeEventListener('resize', on)
  }, [])
  return fit
}

const DRAG = 'application/x-codemap-view'

// a frame with the panel's part (below) or the side bar's part (right) filled while it is shown, as an editor draws them
const FRAME = 'M40,40H216a16,16,0,0,1,16,16V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40Z'
const panelIcon = (on: boolean) => `<path fill-rule="evenodd" d="${FRAME}M40,56V152H216V56Z${on ? '' : 'M40,168V200H216V168Z'}"/>` as const
const sideIcon = (on: boolean) => `<path fill-rule="evenodd" d="${FRAME}M40,56V200H152V56Z${on ? '' : 'M168,56V200H216V56Z'}"/>` as const

/** Kept in this browser: which views are where, which areas are open, and their sizes. Views the program no longer
 *  has are dropped; new ones go where the defaults put them. */
export function useLayout<V extends string>(key: string, defaults: WbLayout<V>, all: V[]) {
  const [l, setL] = useState<WbLayout<V>>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(key) ?? 'null') as WbLayout<V> | null
      if (!s) return defaults
      const side = s.side.filter((v) => all.includes(v)), panel = s.panel.filter((v) => all.includes(v) && !side.includes(v))
      for (const v of all) if (!side.includes(v) && !panel.includes(v)) (defaults.side.includes(v) ? side : panel).push(v)
      return { ...defaults, ...s, side, panel, sideOn: side.includes(s.sideOn!) ? s.sideOn : side[0] ?? null, panelOn: panel.includes(s.panelOn!) ? s.panelOn : panel[0] ?? null }
    } catch { return defaults }
  })
  const set = (f: (l: WbLayout<V>) => WbLayout<V>) => setL((old) => {
    const n = f(old)
    try { localStorage.setItem(key, JSON.stringify(n)) } catch { /* storage off */ }
    return n
  })
  const reset = () => set(() => defaults)
  return [l, set, reset] as const
}

/** A divider that is dragged, moved with the arrow keys (16 px a press) and reset with a double-click. */
function Sash(p: { dir: 'x' | 'y'; value: number; set: (n: number) => void; min: number; max: number; def: number; grow: 1 | -1; label: string }) {
  const start = useRef<{ at: number; v: number } | null>(null)
  const clamp = (n: number) => Math.round(Math.max(p.min, Math.min(p.max, n)))
  return <div role="separator" tabIndex={0} aria-orientation={p.dir === 'x' ? 'vertical' : 'horizontal'} aria-label={p.label}
    aria-valuenow={p.value} aria-valuemin={p.min} aria-valuemax={p.max} className={'wb-sash wb-sash-' + p.dir}
    onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = { at: p.dir === 'x' ? e.clientX : e.clientY, v: p.value }; document.body.classList.add('wb-dragging-' + p.dir) }}
    onPointerMove={(e) => { const s = start.current; if (s) p.set(clamp(s.v + p.grow * ((p.dir === 'x' ? e.clientX : e.clientY) - s.at))) }}
    onPointerUp={() => { start.current = null; document.body.classList.remove('wb-dragging-x', 'wb-dragging-y') }}
    onDoubleClick={() => p.set(p.def)}
    onKeyDown={(e) => {
      const k: Record<string, number> = p.dir === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 }
      const d = k[e.key]
      if (d) { e.preventDefault(); p.set(clamp(p.value + d * p.grow * 16)) }
      else if (e.key === 'Home') { e.preventDefault(); p.set(p.def) }
    }} />
}

interface Props<V extends string> {
  views: WbView<V>[]
  layout: WbLayout<V>
  setLayout: (f: (l: WbLayout<V>) => WbLayout<V>) => void
  /** The explorer: the tree of everything there is to open. */
  explorer: ReactNode
  /** Under the tree: settings and the like. */
  explorerFoot?: ReactNode
  /** What is open: a diagram, a document or code. */
  stage: ReactNode
  /** Above the stage: where the open thing is (a breadcrumb). */
  crumbs: ReactNode
  /** Right end of the top bar. */
  actions?: ReactNode
  brand: ReactNode
  /** Above everything in the stage column: notices. */
  notice?: ReactNode
  /** Something chosen in the tree: on narrow screens the tree, drawn over the stage, closes. */
  picked: number
}

/** The editor layout: the explorer on the left, the stage in the middle, the side bar on the right and the panel below.
 *  Every divider is dragged; every view tab is dragged between the side bar and the panel; each area folds away
 *  (Ctrl B the explorer, Ctrl J the panel, Ctrl Alt B the side bar). Narrower than 1280 px the side bar is drawn over the
 *  stage when asked for, narrower than 960 px the explorer too, and on phones the panel is a sheet pulled up from below. */
export function Workbench<V extends string>(p: Props<V>) {
  const l = p.layout, set = p.setLayout
  const fit = useFit()
  const docked = { tree: fit === 'wide' || fit === 'mid', side: fit === 'wide' }
  // drawn over the stage on narrow screens; not kept, a new visit starts with them shut
  const [over, setOver] = useState<{ tree: boolean; side: boolean; sheet: boolean }>({ tree: false, side: false, sheet: false })
  const [dragging, setDragging] = useState<V | null>(null)
  const [hot, setHot] = useState<{ area: Area; before: V | null } | null>(null)
  useEffect(() => { if (!docked.tree) setOver((o) => ({ ...o, tree: false })) }, [p.picked])   // eslint-disable-line react-hooks/exhaustive-deps

  const treeShown = docked.tree ? l.tree : over.tree
  const sideShown = l.side.length > 0 && (docked.side ? l.sideOpen : over.side)
  const panelShown = l.panel.length > 0 && (fit === 'phone' ? over.sheet : l.panelOpen)
  const toggle = {
    tree: () => (docked.tree ? set((x) => ({ ...x, tree: !x.tree })) : setOver((o) => ({ ...o, tree: !o.tree, side: false }))),
    side: () => (docked.side ? set((x) => ({ ...x, sideOpen: !x.sideOpen })) : setOver((o) => ({ ...o, side: !o.side, tree: false }))),
    panel: () => (fit === 'phone' ? setOver((o) => ({ ...o, sheet: !o.sheet })) : set((x) => ({ ...x, panelOpen: !x.panelOpen }))),
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'b' && e.altKey) { e.preventDefault(); toggleRef.current.side() }
      else if (k === 'b' && !e.altKey) { e.preventDefault(); toggleRef.current.tree() }
      else if (k === 'j' && !e.altKey) { e.preventDefault(); toggleRef.current.panel() }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  /** Moves a view to an area (before another view there, or last) and shows it there. */
  const move = (v: V, area: Area, before: V | null = null) => set((x) => {
    const side = x.side.filter((y) => y !== v), panel = x.panel.filter((y) => y !== v)
    const to = area === 'side' ? side : panel
    const i = before ? to.indexOf(before) : -1
    to.splice(i < 0 ? to.length : i, 0, v)
    const n = { ...x, side, panel, [area + 'On']: v, ...(area === 'side' ? { sideOpen: true } : { panelOpen: true }) } as WbLayout<V>
    if (!side.includes(n.sideOn!)) n.sideOn = side[0] ?? null
    if (!panel.includes(n.panelOn!)) n.panelOn = panel[0] ?? null
    return n
  })
  const byId = new Map(p.views.map((v) => [v.id, v]))
  const other = (a: Area): Area => (a === 'side' ? 'panel' : 'side')
  const areaName = (a: Area) => (a === 'side' ? t('右側欄') : t('下方面板'))

  const drop = (area: Area) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-view]')
      const before = (tab?.dataset.view as V | undefined) ?? null
      if (hot?.area !== area || hot.before !== before) setHot({ area, before })
    },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setHot(null) },
    onDrop: (e: React.DragEvent) => {
      const v = e.dataTransfer.getData(DRAG) as V
      e.preventDefault()
      setHot(null); setDragging(null)
      if (byId.has(v)) move(v, area, hot?.area === area && hot.before !== v ? hot.before : null)
    },
  })

  const strip = (area: Area, close: () => void) => {
    const ids = area === 'side' ? l.side : l.panel
    const on = area === 'side' ? l.sideOn : l.panelOn
    return <div className={'wb-strip' + (hot?.area === area ? ' is-hot' : '')} {...drop(area)}>
      <div role="tablist" aria-label={areaName(area)} className="wb-tabs" onKeyDown={(e) => {
        const i = ids.indexOf(on!)
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!d || i < 0) return
        e.preventDefault()
        const n = ids[(i + d + ids.length) % ids.length]
        set((x) => ({ ...x, [area + 'On']: n }))
        requestAnimationFrame(() => document.getElementById(`wb-tab-${n}`)?.focus())
      }}>
        {ids.map((id) => {
          const v = byId.get(id)!
          const sel = id === on
          return <button key={id} id={`wb-tab-${id}`} type="button" role="tab" aria-selected={sel} aria-controls={`wb-body-${area}`} tabIndex={sel ? 0 : -1}
            data-view={id} data-tour={'view-' + id} draggable className={'wb-tab' + (sel ? ' is-on' : '') + (dragging === id ? ' is-dragged' : '') + (hot?.area === area && hot.before === id && dragging !== id ? ' is-before' : '')}
            title={t('拖曳到{v1}可移過去', { v1: areaName(other(area)) })}
            onClick={() => set((x) => ({ ...x, [area + 'On']: id }))}
            onDragStart={(e) => { e.dataTransfer.setData(DRAG, id); e.dataTransfer.effectAllowed = 'move'; setDragging(id) }}
            onDragEnd={() => { setDragging(null); setHot(null) }}>
            {v.title}{v.count ? <span className="wb-count">{v.count}</span> : null}
          </button>
        })}
      </div>
      <span className="grow" />
      {on ? <UI.IconButton icon={area === 'side' ? 'arrow-down' : 'arrow-right'} label={t('把「{v1}」移到{v2}', { v1: byId.get(on)!.title, v2: areaName(other(area)) })}
        onClick={() => { move(on, other(area)); if (area === 'side' && !docked.side) setOver((o) => ({ ...o, side: false })) }} /> : null}
      <UI.IconButton icon={area === 'side' ? 'x' : 'caret-down'} label={area === 'side' ? t('關閉右側欄') : t('收起下方面板')} onClick={close} />
    </div>
  }
  const body = (area: Area) => {
    const on = area === 'side' ? l.sideOn : l.panelOn
    const v = on ? byId.get(on) : null
    return <div id={`wb-body-${area}`} role="tabpanel" aria-labelledby={on ? `wb-tab-${on}` : undefined} className="wb-body" {...drop(area)}>
      {v ? v.render() : null}
      {hot?.area === area ? <div className="wb-drop-hint">{t('放開以移到{v1}', { v1: areaName(area) })}</div> : null}
    </div>
  }
  // while a view is dragged, an area that is hidden or empty shows where it would land
  const ghost = (area: Area) => dragging && !(area === 'side' ? sideShown : panelShown) && (fit === 'wide' || area === 'panel') && fit !== 'phone'
    ? <div className={'wb-ghost wb-ghost-' + area + (hot?.area === area ? ' is-hot' : '')} {...drop(area)}>{t('放到{v1}', { v1: areaName(area) })}</div> : null

  const side = sideShown ? (
    <aside className={'wb-side' + (docked.side ? '' : ' is-over') + (fit === 'phone' ? ' is-full' : '')} style={docked.side ? { width: l.sideW } : undefined} aria-label={areaName('side')}>
      {strip('side', toggle.side)}
      {body('side')}
    </aside>
  ) : null
  const panel = panelShown ? (
    <section className={'wb-panel' + (fit === 'phone' ? ' is-sheet' : '')} style={fit === 'phone' ? undefined : { height: l.panelH }} aria-label={areaName('panel')}>
      {strip('panel', toggle.panel)}
      {body('panel')}
    </section>
  ) : null
  const tree = treeShown ? (
    <nav className={'wb-tree' + (docked.tree ? '' : ' is-over')} style={docked.tree ? { width: l.treeW } : undefined} aria-label={t('檔案總管')}>
      <div className="wb-tree-body">{p.explorer}</div>
      {p.explorerFoot ? <div className="wb-tree-foot">{p.explorerFoot}</div> : null}
    </nav>
  ) : null
  const maxW = Math.max(320, innerWidth / 2)
  return (
    <div className={'wb wb-' + fit}>
      <header className="wb-top">
        <UI.IconButton icon="sidebar-simple" label={treeShown ? t('收起檔案總管（Ctrl B）') : t('打開檔案總管（Ctrl B）')} onClick={toggle.tree} />
        {p.brand}
        <div className="wb-crumbs">{p.crumbs}</div>
        <span className="grow" />
        {p.actions}
        {fit !== 'phone' ? <UI.IconButton icon={panelIcon(panelShown)} label={panelShown ? t('收起下方面板（Ctrl J）') : t('打開下方面板（Ctrl J）')} onClick={toggle.panel} /> : null}
        {l.side.length ? <UI.IconButton icon={sideIcon(sideShown)} label={sideShown ? t('收起右側欄（Ctrl Alt B）') : t('打開右側欄（Ctrl Alt B）')} onClick={toggle.side} data-tour="side-toggle" /> : null}
      </header>
      <div className="wb-row">
        {tree}
        {tree && docked.tree ? <Sash dir="x" value={l.treeW} set={(n) => set((x) => ({ ...x, treeW: n }))} min={180} max={maxW} def={260} grow={1} label={t('調整檔案總管寬度')} /> : null}
        <div className="wb-col">
          {p.notice}
          <main className="wb-stage" id="main" tabIndex={-1}>{p.stage}</main>
          {panel && fit !== 'phone' ? <Sash dir="y" value={l.panelH} set={(n) => set((x) => ({ ...x, panelH: n }))} min={120} max={Math.max(200, innerHeight - 200)} def={280} grow={-1} label={t('調整下方面板高度')} /> : null}
          {panel}
          {ghost('panel')}
          {fit === 'phone' && !panelShown && l.panel.length ? (
            <button type="button" className="wb-sheet-handle" onClick={toggle.panel}><span className="wb-grip" aria-hidden="true" />
              {l.panel.map((v) => byId.get(v)!.title).join(t('・'))}<span className="grow" />▴</button>
          ) : null}
        </div>
        {side && docked.side ? <Sash dir="x" value={l.sideW} set={(n) => set((x) => ({ ...x, sideW: n }))} min={260} max={maxW} def={380} grow={-1} label={t('調整右側欄寬度')} /> : null}
        {side}
        {ghost('side')}
        {(over.tree && !docked.tree) || (over.side && !docked.side) ? <div className="wb-scrim" onClick={() => setOver((o) => ({ ...o, tree: false, side: false }))} /> : null}
      </div>
    </div>
  )
}
