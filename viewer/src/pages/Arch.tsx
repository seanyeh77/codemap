import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import type { Link } from '../data/types'
import { BAR_GAP, BAR_H, BOX_H, META_FONT, NAME_FONT, compMeta, layout, textWidth } from '../data/archLayout'

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

export function Arch(p: { ix: Index; sel: string; onSel: (id: string) => void; ruleStyle: 'dash' | 'color' }) {
  const g = p.ix.g
  const [ref, width] = useWidth<HTMLDivElement>()
  const card = Math.max(300, width)
  const dash = p.ruleStyle === 'dash'
  const ruleColor = dash ? 'var(--line-strong)' : 'var(--chart-3)'
  const ruleText = dash ? 'var(--ink-muted)' : 'var(--warning-text)'
  // widths are measured on a canvas: measure again once the web font has loaded
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => { let on = true; document.fonts?.ready.then(() => on && setFontsReady(true)); return () => { on = false } }, [])
  const L = useMemo(() => layout(g.comps, g.links, card, labelOf, fontsReady), [g, card, fontsReady])
  const W = L.width
  const pressable = (id: string) => ({
    role: 'button', tabIndex: 0, 'aria-pressed': p.sel === id, style: { cursor: 'pointer' },
    onClick: () => p.onSel(id), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSel(id) } },
  })
  return (
    <div className="card pane arch">
      <div className="legend">
        <span><svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" stroke="var(--line-strong)" strokeWidth="2" /></svg>
          <UI.Term title="編譯器確認" text="以 gcc 重新編譯每個檔案時記錄的呼叫，存在於目前的 build。">編譯器確認的呼叫</UI.Term></span>
        <span><svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" stroke={ruleColor} strokeWidth="2" strokeDasharray={dash ? '6 4' : undefined} /></svg>
          <UI.Term title="推測（規則）" text="函式指標、環境變數等編譯器看不到的關係，由原始碼文字推得。請查看依據確認。">規則推出的關係</UI.Term></span>
        {g.links.some((l) => l.kind === 'interpose') ? (
          <span><UI.Term title="LD_PRELOAD 攔截" text="`LD_PRELOAD` 指定的函式庫會先載入，其中的同名函式取代原本的版本。">LD_PRELOAD 攔截</UI.Term></span>
        ) : null}
      </div>
      <div className="canvas" ref={ref}>
        {width ? (
          <svg width={W} height={L.height} viewBox={`0 0 ${W} ${L.height}`} role="img" aria-label="元件和它們之間的呼叫">
            <defs>
              <marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={ruleColor} /></marker>
              <marker id="ahc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)" /></marker>
            </defs>
            {L.boxes.filter((b) => L.toShared.has(b.c.id)).map((b) => {
              const x = L.sharedX.get(b.c.id)!
              const t = `${L.toShared.get(b.c.id)} 次呼叫`, right = x + 8 + textWidth(t, META_FONT) < W - 4
              return (
                <g key={'s' + b.c.id}>
                  <path d={`M${x},${b.y + BOX_H} V${L.barTop - 2}`} stroke="var(--line-strong)" strokeWidth="2" fill="none" markerEnd="url(#ahc)" />
                  <text className="wire-label" x={right ? x + 8 : x - 8} textAnchor={right ? 'start' : 'end'} y={L.barTop - 12} fontSize="13" fill="var(--ink-muted)">{t}</text>
                </g>
              )
            })}
            {L.wires.map((w, i) => (
              <path key={'w' + i} d={w.d} stroke={w.rule ? ruleColor : 'var(--line-strong)'} strokeWidth="2" fill="none"
                strokeDasharray={w.rule && dash ? '7 5' : undefined} markerEnd={`url(#${w.rule ? 'ahr' : 'ahc'})`} />
            ))}
            {L.wires.map((w, i) => (
              <text key={'t' + i} className="wire-label" x={w.lx} y={w.ly} textAnchor="middle" fontSize="13" fill={w.rule ? ruleText : 'var(--ink-muted)'}>{w.label}</text>
            ))}
            {L.boxes.map((b) => {
              const on = p.sel === b.c.id
              return (
                <g key={b.c.id} {...pressable(b.c.id)} aria-label={`${b.c.id}，${b.c.files} 個檔案，${b.c.funcs} 個函式`}>
                  <rect x={b.x} y={b.y} width={b.w} height={BOX_H} rx="10" fill="var(--surface)" stroke={on ? 'var(--accent)' : 'var(--line)'} strokeWidth={on ? 2 : 1} />
                  <text x={b.x + 16} y={b.y + 27} fontSize="15" fontWeight="700" fill="var(--ink)">{b.c.id}</text>
                  <text x={b.x + 16} y={b.y + 47} fontSize="13" fill="var(--ink-muted)">{compMeta(b.c)}</text>
                </g>
              )
            })}
            {L.bars.map((c, k) => {
              const on = p.sel === c.id, y = L.barTop + k * (BAR_H + BAR_GAP)
              const full = `共用 · ${c.callers} 個元件呼叫 · ${c.files} 個檔案 · ${c.funcs} 個函式`
              const meta = textWidth(c.id, NAME_FONT) + textWidth(full, META_FONT) + 72 < W ? full : `共用 · ${c.funcs} 個函式`
              return (
                <g key={c.id} {...pressable(c.id)} aria-label={`${c.id}，${full}`}>
                  <rect x="8" y={y} width={W - 16} height={BAR_H} rx="10" fill="var(--surface-sub)" stroke={on ? 'var(--accent)' : 'var(--line)'} strokeWidth={on ? 2 : 1} />
                  <text x="24" y={y + 33} fontSize="15" fontWeight="700" fill="var(--ink)">{c.id}</text>
                  <text x={W - 24} y={y + 33} textAnchor="end" fontSize="13" fill="var(--ink-muted)">{meta}</text>
                </g>
              )
            })}
          </svg>
        ) : null}
      </div>
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
  return (
    <div className="card detail">
      <h3 className="ttl">{p.comp}</h3>
      <p className="small muted">{`${items.length} 個檔案`}</p>
      <UI.TreeList key={p.comp} kind="plain" label={p.comp + ' 的函式'} items={items} defaultOpen={items.map((i) => i.id)}
        onSelect={(n) => { if (p.ix.funcs[n.id]) p.onPick(n.id) }} />
    </div>
  )
}
