import { useMemo } from 'react'
import { UI } from '../ui'
import { MAX_DEPTH, type Index } from '../data/graph'
import type { Sel } from '../data/types'

/** direct: calls the start. state: shares a file-scope variable with the start. indirect: reaches either. */
type Kind = 'direct' | 'indirect' | 'state'
interface Row {
  id: string; fid: string; name: string; comp: string; loc: string; f: string; l: number; depth: number
  kind: Kind; how: string; via: string; source: string; inferred: boolean; api?: string
}

/** Who is affected when a function changes: its callers, and their callers, up to MAX_DEPTH; plus
 *  the functions that use the same file-scope variables as the start (one level: what they share
 *  with each other is not followed) and their callers. LD_PRELOAD entry points are marked, since
 *  what calls them is outside the repo. */
function affected(ix: Index, start: string): Row[] {
  const seen = new Set([start]), res: Row[] = [], frontier: [string, number, Kind][] = [[start, 0, 'direct']]
  const add = (fid: string, d: number, kind: Kind, f: string, l: number, how: string, via: string, source: string, inferred: boolean) => {
    seen.add(fid)
    const fn = ix.funcs[fid]
    res.push({ id: String(res.length), fid, name: fn.name, comp: fn.comp, loc: `${f}:${l}`, f, l, depth: d, kind, how, via, source, inferred, api: fn.api })
    if (d < MAX_DEPTH) frontier.push([fid, d, kind])
  }
  for (const g of ix.g.state ?? []) {
    if (!g.users.some(([u]) => u === start)) continue
    for (const [u, l] of g.users) {
      if (!seen.has(u) && ix.funcs[u]) add(u, 1, 'state', ix.funcs[u].file, l, `使用 ${g.name}`, g.name, '共用變數', false)
    }
  }
  while (frontier.length) {
    const [cur, d] = frontier.shift()!
    for (const e of ix.callers(cur)) {
      if (!ix.funcs[e.s] || seen.has(e.s)) continue
      add(e.s, d + 1, d === 0 ? 'direct' : 'indirect', e.f, e.l, (e.k === 'fnptr_assign' ? '存入' : e.k === 'fnptr_pass' ? '傳給 ' + e.slot + '()' : e.k === 'fnptr_table' ? '列在 ' + e.slot : '呼叫') + (d === 0 ? '' : ` ${ix.nameOf(cur)}`), ix.nameOf(cur), ix.explain(e).label, e.src === 'rule')
    }
  }
  return res
}

const KIND_LABEL: Record<Kind, string> = { direct: '直接', state: '共用變數', indirect: '間接' }

export function Impact(p: { ix: Index; start: string; sourceId: string; onSel: (id: string, edge: Sel['edge']) => void; openSearch: () => void }) {
  const rows = useMemo(() => affected(p.ix, p.start), [p.ix, p.start])
  const comps = [...new Set(rows.map((r) => r.comp))]
  const vars = [...new Set(rows.filter((r) => r.kind === 'state').map((r) => r.via))]
  const entries = rows.filter((r) => r.api)
  const apis = [...new Set(entries.map((r) => r.api))]
  const open = (r: Row) => p.onSel(r.fid, { f: r.f, l: r.l })
  const name = p.ix.funcs[p.start]?.name ?? p.ix.bareName(p.start)     // an external function: who in the repo calls it
  const entryTerm = (api: string) => `和 ${api} 程式庫的函式同名。程式以 LD_PRELOAD 載入這個程式庫後，呼叫該函式時會先執行這裡的版本；這些呼叫來自 repo 外，不在此表中。`
  return (
    <div className="pane">
      <UI.Card data-tour="impact" className="stack">
        <div className="row">
          <UI.Button icon="magnifying-glass" onClick={p.openSearch}>更換函式</UI.Button>
        </div>
        {rows.length ? (
          <div>
            <p>修改 <UI.InlineCode>{name}</UI.InlineCode>{` 影響 ${rows.length} 個函式，跨 ${comps.length} 個元件。`}</p>
            {vars.length ? <p className="small">{`其中 ${rows.filter((r) => r.kind === 'state').length} 個和它使用相同的全域變數（${vars.join('、')}），沒有呼叫關係也會受影響。`}</p> : null}
            {entries.length ? (
              <p className="small">
                {`其中 ${entries.length} 個是 `}
                <UI.Term text={entryTerm(apis.join('、'))}>外部進入點</UI.Term>
                {`：被追蹤的程式呼叫 ${apis.join('、')} 的同名函式時會執行它們，這些呼叫者不在 repo 內。`}
              </p>
            ) : null}
            <p className="small muted">只計算這個 repo 內的函式；共用變數只從起點函式找一層。</p>
          </div>
        ) : (
          <div>
            <p>找不到呼叫 <UI.InlineCode>{name}</UI.InlineCode> 或和它共用全域變數的函式。</p>
            <p className="small muted">{p.ix.funcs[p.start]?.api
              ? `它是外部進入點：呼叫者是載入此程式庫、呼叫 ${p.ix.funcs[p.start].api} 同名函式的程式，不在 repo 內。`
              : '編譯器和規則都沒找到，但經由函式指標或從 repo 外的呼叫可能沒有偵測到。'}</p>
          </div>
        )}
      </UI.Card>
      {rows.length ? (
        <UI.DataTable resetKey={`${p.sourceId}:${p.start}`} label="受影響的函式" pageSize={10} urlSync={false}
          summary={{ key: 'kind', items: (['direct', 'state', 'indirect'] as const).filter((k) => k !== 'state' || vars.length).map((k) => ({ value: k, label: KIND_LABEL[k] })), unit: '個' }}
          columns={[
            { key: 'name', label: '函式', width: 220, grow: 2, mobile: 'title', searchText: (r: Row) => r.name + ' ' + r.source,
              render: (r: Row) => (
                <span className="fnname"><b>{r.name}</b>
                  {r.inferred ? <UI.Tag>{r.source}</UI.Tag> : null}
                  {r.api ? <UI.Tag><UI.Term text={entryTerm(r.api)}>外部進入點</UI.Term></UI.Tag> : null}
                </span>
              ) },
            { key: 'comp', label: '元件', width: 120, grow: 1 },
            { key: 'how', label: '關係', width: 150, grow: 1, searchText: (r: Row) => r.how, render: (r: Row) => r.how },
            { key: 'loc', label: '位置', width: 170, grow: 2, searchText: (r: Row) => r.loc,
              render: (r: Row) => <UI.InlineCode href={'#' + r.loc} onClick={(e) => { e.preventDefault(); open(r) }}>{UI.format.path(r.loc)}</UI.InlineCode> },
            { key: 'depth', label: '距離', numeric: true, unit: '層', width: 72, grow: 0.5 },
          ]}
          rows={rows}
          filters={[{ key: 'comp', label: '元件', options: comps.map((c) => ({ value: c, label: c })) }]}
          rowActions={(r: Row) => <UI.IconButton label={`開啟 ${r.f.split('/').pop()}:${r.l}`} icon="file-text" onClick={() => open(r)} />} />
      ) : null}
    </div>
  )
}
