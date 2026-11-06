import { useMemo } from 'react'
import { UI } from '../ui'
import { MAX_DEPTH, type Index } from '../data/graph'
import type { Sel } from '../data/types'

interface Row { id: string; fid: string; name: string; comp: string; loc: string; f: string; l: number; depth: number; kind: 'direct' | 'indirect'; via: string; source: string }

export function Impact(p: { ix: Index; start: string; sourceId: string; onSel: (id: string, edge: Sel['edge']) => void }) {
  const rows = useMemo(() => {
    const seen = new Set([p.start]), res: Row[] = [], frontier: [string, number][] = [[p.start, 0]]
    while (frontier.length) {
      const [cur, d] = frontier.shift()!
      for (const e of p.ix.callers(cur)) {
        if (!p.ix.funcs[e.s] || seen.has(e.s)) continue
        seen.add(e.s)
        res.push({ id: String(res.length), fid: e.s, name: p.ix.funcs[e.s].name, comp: p.ix.funcs[e.s].comp, loc: `${e.f}:${e.l}`, f: e.f, l: e.l,
          depth: d + 1, kind: d === 0 ? 'direct' : 'indirect', via: p.ix.nameOf(cur), source: p.ix.explain(e).label })
        if (d + 1 < MAX_DEPTH) frontier.push([e.s, d + 1])
      }
    }
    return res
  }, [p.ix, p.start])
  const comps = [...new Set(rows.map((r) => r.comp))]
  const open = (r: Row) => p.onSel(r.fid, { f: r.f, l: r.l })
  return (
    <div className="pane">
      <UI.Card>
        {rows.length
          ? <p>修改 <UI.InlineCode>{p.ix.funcs[p.start]?.name}</UI.InlineCode>{` 影響 ${rows.length} 個函式，跨 ${comps.length} 個元件。`}</p>
          : <p>沒有其他函式呼叫 <UI.InlineCode>{p.ix.funcs[p.start]?.name}</UI.InlineCode>。</p>}
      </UI.Card>
      {rows.length ? (
        <UI.DataTable resetKey={`${p.sourceId}:${p.start}`} label="受影響的函式" pageSize={10} urlSync={false}
          summary={{ key: 'kind', items: [{ value: 'direct', label: '直接' }, { value: 'indirect', label: '間接' }] }}
          columns={[
            { key: 'name', label: '函式', width: 200, grow: 2, mobile: 'title', searchText: (r: Row) => r.name + ' ' + r.source,
              render: (r: Row) => <span className="fnname"><b>{r.name}</b><UI.Tag>{r.source}</UI.Tag></span> },
            { key: 'comp', label: '元件', width: 130, grow: 1 },
            { key: 'loc', label: '呼叫位置', width: 200, grow: 2, searchText: (r: Row) => r.loc,
              render: (r: Row) => <UI.InlineCode href={'#' + r.loc} onClick={(e) => { e.preventDefault(); open(r) }}>{UI.format.path(r.loc)}</UI.InlineCode> },
            { key: 'via', label: '經由', width: 130, grow: 1 },
            { key: 'depth', label: '距離', numeric: true, unit: '層', width: 90, grow: 0.5 },
          ]}
          rows={rows}
          filters={[{ key: 'comp', label: '元件', options: comps.map((c) => ({ value: c, label: c })) }]}
          rowActions={(r: Row) => <UI.IconButton label={`開啟 ${r.f.split('/').pop()}:${r.l}`} icon="file-text" onClick={() => open(r)} />} />
      ) : null}
    </div>
  )
}
