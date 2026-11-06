import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import type { Link } from '../data/types'
import { BOX_H, compMeta, labelParts, layout } from '../data/archLayout'

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** The text on a wire between two components. */
function labelOf(l: Link) {
  if (l.kind === 'env') {
    const names = l.names ?? []
    return names.length ? `環境變數 ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` 等 ${names.length} 個` : ''}` : '環境變數'
  }
  return l.kind === 'interpose' ? `攔截 ${l.n} 個 ${l.api} 呼叫` : `${l.n} 次呼叫`
}

export function Arch(p: { ix: Index; sel: string; onSel: (id: string) => void }) {
  const g = p.ix.g
  const [ref, width] = useWidth<HTMLDivElement>()
  const card = Math.max(300, width)
  // widths are measured on a canvas: measure again once the web font has loaded
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => { let on = true; document.fonts?.ready.then(() => on && setFontsReady(true)); return () => { on = false } }, [])
  const L = useMemo(() => layout(g.comps, g.links, card, labelOf, fontsReady), [g, card, fontsReady])
  const W = L.width, scale = Math.min(1, card / W)       // a slightly wide drawing shrinks to the card
  const pressable = (id: string) => ({
    role: 'button', tabIndex: 0, 'aria-pressed': p.sel === id, style: { cursor: 'pointer' },
    onClick: () => p.onSel(id), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSel(id) } },
  })
  // the selected component, the lines that touch it and the components at their other ends stay; the rest dims
  const sel = p.sel
  const callsBar = (from: string) => (L.callersOf.get(sel) ?? []).some((x) => x.id === from)
  const wireOn = (l: Link) => l.a === sel || l.b === sel
  const dropOn = (from: string) => from === sel || callsBar(from)
  const near = new Set<string>([sel])
  for (const w of L.wires) if (wireOn(w.l)) { near.add(w.l.a); near.add(w.l.b) }
  for (const d of L.drops) if (dropOn(d.from)) near.add(d.from)
  for (const [bar, list] of L.callersOf) if (list.some((x) => x.id === sel)) near.add(bar)
  const edge = (on: boolean, inferred: boolean) => ({
    className: `ui-graph-edge${inferred ? ' is-inferred' : ''}${on ? ' is-related' : ''}`, markerEnd: on ? 'url(#ui-arrow-accent)' : 'url(#ui-arrow)',
  })
  const drawn = (on: boolean) => ({
    drops: L.drops.filter((d) => dropOn(d.from) === on).map((d) => <path key={'d' + d.from} d={d.d} {...edge(on, false)} />),
    wires: L.wires.filter((w) => wireOn(w.l) === on).map((w) => <path key={'w' + w.d} d={w.d} {...edge(on, w.rule)} />),
    labels: L.wires.filter((w) => wireOn(w.l) === on).map((w) => (
      <text key={'t' + w.d} className={`ui-graph-label${on ? ' is-related' : ''}`} x={w.lx} y={w.ly} textAnchor={w.anchor}>
        {labelParts(w.label).map((x, i) => (x.code ? <tspan key={i} className="ui-graph-code">{x.text}</tspan> : x.text))}
      </text>)),
    boxes: L.boxes.filter((b) => near.has(b.c.id) === on).map((b) => (
      <g key={b.c.id} {...pressable(b.c.id)} aria-label={`${b.c.id}，${b.c.files} 個檔案，${b.c.funcs} 個函式`}>
        <rect x={b.x} y={b.y} width={b.w} height={BOX_H} rx="10" className={`ui-graph-node${sel === b.c.id ? ' is-selected' : ''}`} />
        <text x={b.x + 16} y={b.y + 26} className="ui-graph-name">{b.c.id}</text>
        <text x={b.x + 16} y={b.y + 46} fontSize="13" fill="var(--ink-muted)">{compMeta(b.c)}</text>
      </g>
    )),
    bars: L.bars.filter((x) => near.has(x.c.id) === on).map(({ c, y, h, inline, text, lines }) => (
      <g key={c.id} {...pressable(c.id)} aria-label={`${c.id}，共用 · ${c.callers} 個元件呼叫 · ${c.files} 個檔案 · ${c.funcs} 個函式，${text}`}>
        <rect x="8" y={y} width={W - 16} height={h} rx="10" className={`ui-graph-node${sel === c.id ? ' is-selected' : ''}`} />
        <text x="24" y={y + (inline ? 32 : 27)} className="ui-graph-name">{c.id}</text>
        {inline ? <text x={W - 24} y={y + 32} textAnchor="end" fontSize="13" fill="var(--ink-muted)">{text}</text>
          : lines.map((t, i) => <text key={i} x="24" y={y + 49 + 20 * i} fontSize="13" fill="var(--ink-muted)">{t}</text>)}
      </g>
    )),
  })
  const dim = drawn(false), lit = drawn(true)
  return (
    <div className="card pane arch">
      <div className="canvas ui-graph" ref={ref}>
        {width ? (
          <svg width={W * scale} height={L.height * scale} viewBox={`0 0 ${W} ${L.height}`} role="img" aria-label="元件和它們之間的呼叫">
            <UI.GraphDefs />
            <g className="is-dim">{dim.drops}{dim.wires}{dim.labels}{dim.boxes}{dim.bars}</g>
            {lit.drops}{lit.wires}{lit.boxes}{lit.bars}{lit.labels}
          </svg>
        ) : null}
      </div>
      <UI.GraphLegend items={[
        { type: 'edge', label: '編譯器確認', text: '以 gcc 重新編譯每個檔案時記錄的呼叫，存在於目前的 build。' },
        { type: 'inferred', label: '推測（規則）', text: '函式指標、環境變數、`LD_PRELOAD` 攔截等編譯器看不到的關係，由原始碼文字推得。' },
      ]} />
      <p className="small muted">點選元件查看其函式，點選函式追蹤流程。
        <UI.Term text="被兩個以上元件呼叫、本身不呼叫其他元件的部分，例如共用標頭檔。">共用元件</UI.Term>以底部長條表示。</p>
    </div>
  )
}

export function CompDetail(p: { ix: Index; comp: string; onPick: (id: string) => void }) {
  const items = useMemo(() => {
    const files = [...p.ix.byFile()].filter(([, ids]) => p.ix.funcs[ids[0]].comp === p.comp).sort(([a], [b]) => a.localeCompare(b))
    return files.map(([f, ids]) => ({
      id: 'file:' + f, name: f.split('/').pop()!, path: f, icon: 'file-text',
      children: ids.map((id) => ({
        id, name: p.ix.funcs[id].name, meta: `${p.ix.callerCount(id)} 個 caller`,
      })),
    }))
  }, [p.ix, p.comp])
  // the tree is the whole panel: its own card, header and scrolling list
  return (
    <div className="detail tree-panel">
      <UI.TreeList key={p.comp} kind="plain" title={p.comp} subtitle={`${items.length} 個檔案`} height="100%"
        label={p.comp + ' 的函式'} items={items} defaultOpen={items.map((i) => i.id)}
        onSelect={(n) => { if (p.ix.funcs[n.id]) p.onPick(n.id) }} />
    </div>
  )
}
