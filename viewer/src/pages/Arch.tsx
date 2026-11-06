import { useMemo } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import type { Link } from '../data/types'

/** The label on an inferred relation; `backticks` are code. */
function labelOf(l: Link) {
  if (l.kind === 'env') {
    const names = (l.names ?? []).map((n) => `\`${n}\``)
    return names.length ? `環境變數 ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` 等 ${names.length} 個` : ''}` : '環境變數'
  }
  return `攔截 ${l.n} 個 \`${l.api}\` 呼叫`
}

/** Components in layers with the calls between them, drawn by UI.LayerGraph; shared ones are listed under it. */
export function Arch(p: { ix: Index; sel: string; onSel: (id: string) => void }) {
  const g = p.ix.g
  const nodes = useMemo(() => g.comps.map((c) => ({ id: c.id, name: c.id, layer: c.layer ?? 0, fns: c.funcs, shared: c.shared })), [g])
  const edges = useMemo(() => g.links.map((l) => (l.kind === 'call'
    ? { from: l.a, to: l.b, count: l.n }
    : { from: l.a, to: l.b, inferred: true, label: labelOf(l) })), [g])
  return (
    <div className="card pane">
      <UI.LayerGraph nodes={nodes} edges={edges} selected={p.sel || null} onSelect={(id) => p.onSel(id ?? '')}
        label="元件和它們之間的呼叫"
        inferredText="函式指標、環境變數、`LD_PRELOAD` 攔截等編譯器看不到的關係，由原始碼文字推得。" />
    </div>
  )
}

export function CompDetail(p: { ix: Index; comp: string; onPick: (id: string) => void }) {
  if (!p.comp) return <div className="card detail"><UI.EmptyState title="未選擇元件" description="點選圖中的元件以查看其函式。" /></div>
  return <CompTree {...p} />
}

function CompTree(p: { ix: Index; comp: string; onPick: (id: string) => void }) {
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
