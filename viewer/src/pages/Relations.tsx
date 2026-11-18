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
export function Relations(p: { ix: Index; at: At; mode: 'flow' | 'impact'; openFile: (f: string) => void; openComp: (c: string) => void }) {
  const { ix, at } = p
  const fg = useMemo(() => fileGraph(ix), [ix])
  const rows = useMemo((): Rel[] => {
    const base = (f: string) => f.split('/').pop()!
    if (at.kind === 'file') {
      const inn = fg.links.filter((l) => l.b === at.f), out = fg.links.filter((l) => l.a === at.f)
      const names = (es: { d: string }[]) => [...new Set(es.map((e) => ix.funcs[e.d]?.name).filter(Boolean))]
      if (p.mode === 'flow') return [
        ...inn.sort((x, y) => y.es.length - x.es.length).map((l) => ({ id: 'file:' + l.a, name: base(l.a), rel: t('呼叫它'),
          text: t('{n} 次，呼叫 {v1}', { n: l.es.length, v1: names(l.es).slice(0, 4).join(t('、')) }) })),
        ...out.sort((x, y) => y.es.length - x.es.length).map((l) => ({ id: 'file:' + l.b, name: base(l.b), rel: t('它呼叫'),
          text: t('{n} 次，呼叫 {v1}', { n: l.es.length, v1: names(l.es).slice(0, 4).join(t('、')) }) })),
      ]
      return reach(fg.links.map((l) => [l.a, l.b] as const), at.f).map(([f, d, via]) => ({ id: 'file:' + f, name: base(f), rel: d === 1 ? t('直接呼叫') : t('經由 {v1}', { v1: base(via) }), text: f, depth: d }))
    }
    if (at.kind === 'comp') {
      const ls = ix.g.links.filter((l) => l.a !== l.b && (l.a === at.id || l.b === at.id))
      if (p.mode === 'flow') return ls.map((l) => ({ id: 'comp:' + (l.a === at.id ? l.b : l.a), name: l.a === at.id ? l.b : l.a,
        rel: l.a === at.id ? t('它呼叫') : t('呼叫它'), text: l.kind === 'call' ? t('{n} 次', { n: l.n }) : t('推測：{v1}', { v1: l.kind }) }))
      return reach(ix.g.links.filter((l) => l.a !== l.b).map((l) => [l.a, l.b] as const), at.id).map(([c, d, via]) => ({ id: 'comp:' + c, name: c, rel: d === 1 ? t('直接呼叫') : t('經由 {v1}', { v1: via }), text: '', depth: d }))
    }
    if (p.mode === 'flow') return ix.g.links.filter((l) => l.a !== l.b && l.kind === 'call').map((l) => ({ id: 'comp:' + l.a, name: `${l.a} → ${l.b}`, rel: t('呼叫'), text: t('{n} 次', { n: l.n }) }))
    return []
  }, [ix, at, fg, p.mode])
  const what = at.kind === 'file' ? t('檔案') : at.kind === 'comp' ? t('元件') : ''
  const lead = at.kind === 'proj' || at.kind === 'settings'
    ? (p.mode === 'flow' ? t('元件之間的呼叫。選一個元件、檔案或函式，這裡會改列它的關係。') : t('選一個元件、檔案或函式，這裡會列出修改它會影響誰。'))
    : p.mode === 'flow' ? t('這個{v1}和其他{v1}之間的呼叫。選一個函式，這裡會改成它的呼叫流程。', { v1: what })
    : t('修改這個{v1}，可能影響這些{v1}（往上找呼叫者）。選一個函式，可以看到函式層級的影響範圍。', { v1: what })
  return <div className="rel">
    <p className="small muted">{lead}</p>
    {rows.length ? <ul className="rel-list">
      {rows.map((r) => <li key={r.rel + r.id} className="rel-row">
        <span className="rel-kind small muted">{r.depth ? t('{v1}（{n} 層）', { v1: r.rel, n: r.depth }) : r.rel}</span>
        <UI.InlineCode look="name" href={'#'} onClick={(e) => { e.preventDefault(); if (r.id.startsWith('file:')) p.openFile(r.id.slice(5)); else p.openComp(r.id.slice(5)) }}>{r.name}</UI.InlineCode>
        {r.text ? <span className="small muted rel-text">{r.text}</span> : null}
      </li>)}
    </ul> : at.kind !== 'proj' && at.kind !== 'settings' ? <p className="small">{at.kind === 'comp' && at.id === TRACED ? t('repo 外的程式，沒有可列的呼叫。') : p.mode === 'flow' ? t('和其他{v1}沒有呼叫關係。', { v1: what }) : t('沒有其他{v1}呼叫它。', { v1: what })}</p> : null}
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
