import { useMemo } from 'react'
import { UI } from '../ui'
import { t } from '../i18n'
import type { Index } from '../data/graph'
import { fileGraph } from '../data/files'
import type { At } from './Info'
import { TRACED } from './Arch'

/** One row: a file or a component, how it is tied to the open one, and a line about it. */
interface Rel { id: string; name: string; rel: string; text: string; depth?: number }

/** The panel's 呼叫流程 and 影響範圍 when what is open is not a function: the same questions one level up. For a file,
 *  which files call it and which it calls (and, for 影響範圍, every file a change can reach through callers); for a
 *  component, the same between components; for the project, the components and how they call each other. */
export function Relations(p: { ix: Index; at: At; mode: 'down' | 'up'; openFile: (f: string) => void; openComp: (c: string) => void }) {
  const { ix, at } = p
  const fg = useMemo(() => fileGraph(ix), [ix])
  const rows = useMemo((): Rel[] => {
    const base = (f: string) => f.split('/').pop()!
    if (at.kind === 'file') {
      const out = fg.links.filter((l) => l.a === at.f)
      const names = (es: { d: string }[]) => [...new Set(es.map((e) => ix.funcs[e.d]?.name).filter(Boolean))]
      if (p.mode === 'down') return [
        ...out.sort((x, y) => y.es.length - x.es.length).map((l) => ({ id: 'file:' + l.b, name: base(l.b), rel: t('呼叫'),
          text: t('{n} 次，呼叫 {v1}', { n: l.es.length, v1: names(l.es).slice(0, 4).join(t('、')) }) })),
      ]
      return reach(fg.links.map((l) => [l.a, l.b] as const), at.f).map(([f, d, via]) => ({ id: 'file:' + f, name: base(f), rel: d === 1 ? t('直接呼叫') : t('經由 {v1}', { v1: base(via) }), text: f, depth: d }))
    }
    if (at.kind === 'comp') {
      const ls = ix.g.links.filter((l) => l.a !== l.b && (l.a === at.id || l.b === at.id))
      if (p.mode === 'down') return ls.filter((l) => l.a === at.id).map((l) => ({ id: 'comp:' + (l.a === at.id ? l.b : l.a), name: l.a === at.id ? l.b : l.a,
        rel: l.a === at.id ? t('呼叫') : t('被呼叫'), text: l.kind === 'call' ? t('{n} 次', { n: l.n }) : t('推測：{v1}', { v1: l.kind }) }))
      return reach(ix.g.links.filter((l) => l.a !== l.b).map((l) => [l.a, l.b] as const), at.id).map(([c, d, via]) => ({ id: 'comp:' + c, name: c, rel: d === 1 ? t('直接呼叫') : t('經由 {v1}', { v1: via }), text: '', depth: d }))
    }
    if (p.mode === 'down') return ix.g.links.filter((l) => l.a !== l.b && l.kind === 'call').map((l) => ({ id: 'comp:' + l.a, name: `${l.a} → ${l.b}`, rel: t('呼叫'), text: t('{n} 次', { n: l.n }) }))
    return []
  }, [ix, at, fg, p.mode])
  const lead = at.kind === 'proj' || at.kind === 'settings'
    ? (p.mode === 'down' ? t('元件之間的呼叫。選取元件、檔案或函式，即改列其呼叫關係。') : t('選取元件、檔案或函式，即列出修改後受影響的範圍。'))
    // one sentence per kind: English names a file or a component in lower case inside a sentence
    : at.kind === 'file' ? (p.mode === 'down' ? t('此檔案呼叫的其他檔案。選取函式即改列其呼叫的函式。') : t('修改此檔案可能影響的檔案（向上追溯呼叫者）。選取函式即顯示函式層級的影響範圍。'))
    : p.mode === 'down' ? t('此元件呼叫的其他元件。選取函式即改列其呼叫的函式。') : t('修改此元件可能影響的元件（向上追溯呼叫者）。選取函式即顯示函式層級的影響範圍。')
  return <div className="rel">
    <p className="small muted">{lead}</p>
    {rows.length ? <ul className="rel-list">
      {rows.map((r) => <li key={r.rel + r.id} className="rel-row">
        <span className="rel-kind small muted">{r.depth ? t('{v1}（{n} 層）', { v1: r.rel, n: r.depth }) : r.rel}</span>
        <UI.InlineCode look="name" href={'#'} onClick={(e) => { e.preventDefault(); if (r.id.startsWith('file:')) p.openFile(r.id.slice(5)); else p.openComp(r.id.slice(5)) }}>{r.name}</UI.InlineCode>
        {r.text ? <span className="small muted rel-text">{r.text}</span> : null}
      </li>)}
    </ul> : at.kind !== 'proj' && at.kind !== 'settings' ? <p className="small">{at.kind === 'comp' && at.id === TRACED ? t('repo 外的程式，無可列出的呼叫。') : at.kind === 'file' ? (p.mode === 'down' ? t('未呼叫其他檔案。') : t('無其他檔案呼叫。')) : p.mode === 'down' ? t('未呼叫其他元件。') : t('無其他元件呼叫。')}</p> : null}
  </div>
}

/** Everything that reaches `to` by following links backwards: [node, distance, the node it was reached through]. */
function reach(links: (readonly [string, string])[], to: string): [string, number, string][] {
  const out: [string, number, string][] = []
  const seen = new Set([to])
  let front = [to], d = 0
  while (front.length && d < 8) {
    d++
    const next: string[] = []
    for (const x of front) for (const [a, b] of links) if (b === x && !seen.has(a)) { seen.add(a); out.push([a, d, x]); next.push(a) }
    front = next
  }
  return out
}
