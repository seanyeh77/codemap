import { useMemo } from 'react'
import { UI } from '../ui'
import { countUnit, t } from '../i18n'
import { MAX_DEPTH, type Index } from '../data/graph'
import type { Sel } from '../data/types'

/** direct: calls the start. state: shares a file-scope variable with the start. indirect: reaches either. */
type Kind = 'direct' | 'indirect' | 'state'
interface Row {
  id: string; fid: string; name: string; comp: string; loc: string; f: string; l: number; lines: number[]; depth: number
  kind: Kind; how: string; via: string; source: string; inferred: boolean; api?: string; entry: 'yes' | 'no'
}

/** Who is affected when a function changes: its callers, and their callers, up to MAX_DEPTH; plus
 *  the functions that use the same file-scope variables as the start (one level: what they share
 *  with each other is not followed) and their callers. LD_PRELOAD entry points are marked, since
 *  what calls them is outside the repo. */
function affected(ix: Index, start: string): Row[] {
  const seen = new Set([start]), res: Row[] = [], frontier: [string, number, Kind][] = [[start, 0, 'direct']]
  const add = (fid: string, d: number, kind: Kind, f: string, l: number, how: string, via: string, source: string, inferred: boolean, lines = [l]) => {
    seen.add(fid)
    const fn = ix.funcs[fid]
    // every line the caller uses it on: a reviewer needs the call sites, not only the first
    res.push({ id: String(res.length), fid, name: fn.name, comp: fn.comp, loc: t('{v1}:{v2}', { v1: f, v2: lines.join(t('、')) }), f, l, lines, depth: d, kind, how, via, source, inferred, api: fn.api, entry: fn.api ? 'yes' : 'no' })
    if (d < MAX_DEPTH) frontier.push([fid, d, kind])
  }
  for (const g of ix.g.state ?? []) {
    if (!g.users.some(([u]) => u === start)) continue
    for (const [u, l] of g.users) {
      if (!seen.has(u) && ix.funcs[u]) add(u, 1, 'state', ix.funcs[u].file, l, t('使用 {v1}', { v1: g.name }), g.name, t('共用變數'), false)
    }
  }
  while (frontier.length) {
    const [cur, d] = frontier.shift()!
    const all = ix.callers(cur)
    for (const e of all) {
      if (!ix.funcs[e.s] || seen.has(e.s)) continue
      const lines = [...new Set(all.filter((x) => x.s === e.s && x.f === e.f).map((x) => x.l))].sort((a, b) => a - b)
      add(e.s, d + 1, d === 0 ? 'direct' : 'indirect', e.f, e.l, (e.k === 'fnptr_assign' ? t('存入') : e.k === 'fnptr_pass' ? t('傳給 ') + e.slot + '()' : e.k === 'fnptr_table' ? t('列在 ') + e.slot : t('呼叫')) + (d === 0 ? '' : ` ${ix.nameOf(cur)}`), ix.nameOf(cur), ix.explain(e).label, e.src === 'rule', lines)
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
  const name = p.ix.funcs[p.start]?.name ?? p.ix.bareName(p.start)     // an external function: who in the repo calls it
  const entryTerm = (api: string) => t('和 {v1} 程式庫的函式同名，以 LD_PRELOAD 載入後會先執行這裡的版本。呼叫者在 repo 外，不在此表中。', { v1: api })
  return (
    <div className="pane">
      <UI.Card data-tour="impact" className="stack">
        <div className="row">
          <UI.Button icon="magnifying-glass" onClick={p.openSearch}>{t('更換函式')}</UI.Button>
        </div>
        {rows.length ? (
          <div>
            {p.ix.funcs[p.start]
              ? <UI.CodeText as="p" text={t('修改 `{name}` 影響 {v1} 個函式，跨 {v2} 個元件。', { name, v1: rows.length, v2: comps.length })} />
              : <UI.CodeText as="p" text={t('有 {v1} 個函式呼叫 `{name}`（repo 外的函式）；連同呼叫它們的函式，共 {v2} 個，跨 {v3} 個元件。', { name, v1: rows.filter((r) => r.kind === 'direct').length, v2: rows.length, v3: comps.length })} />}
            {vars.length ? <p className="small">{t('其中 {v1} 個和它使用相同的全域變數（{v2}），沒有呼叫關係也會受影響。', { v1: rows.filter((r) => r.kind === 'state').length, v2: vars.join(t('、')) })}</p> : null}
            {entries.length ? (
              <p className="small">
                {t('受影響的函式中有 {v1} 個是 ', { v1: entries.length })}
                <UI.Term text={entryTerm(apis.join(t('、')))}>{t('外部進入點')}</UI.Term>
                {t('：被追蹤的程式呼叫 {v2} 的同名函式時執行。', { v2: apis.join(t('、')) })}
                {t('repo 裡共有 {v1} 個外部進入點（{v2}）。', { v1: Object.values(p.ix.funcs).filter((f) => f.api).length,
                  v2: Object.entries(Object.values(p.ix.funcs).reduce<Record<string, number>>((m, f) => (f.api ? { ...m, [f.api]: (m[f.api] ?? 0) + 1 } : m), {})).sort().map(([a, n]) => `${a} ${n}`).join(t('、')) })}
              </p>
            ) : null}
            <p className="small muted">{t('只計算這個 repo 內的函式；共用變數只從起點函式找一層。')}</p>
          </div>
        ) : (
          <div>
            <p>{t('找不到呼叫')} <UI.InlineCode>{name}</UI.InlineCode> {t('或和它共用全域變數的函式。')}</p>
            {p.ix.callerInfo(p.start).others.length || p.ix.callerInfo(p.start).load ? <p className="small muted">{t('它不是由函式直接呼叫：{v1}。', { v1: p.ix.callerText(p.start).split('；').slice(1).join(t('；')) })}</p> : null}
            <p className="small muted">{p.ix.funcs[p.start]?.api
              ? t('它是外部進入點：呼叫者是載入此程式庫、呼叫 {v1} 同名函式的程式，不在 repo 內。', { v1: p.ix.funcs[p.start].api })
              : t('編譯器和規則都沒找到。經由函式指標或從 repo 外的呼叫可能沒有偵測到。')}</p>
          </div>
        )}
      </UI.Card>
      {rows.length ? (
        <UI.DataTable resetKey={`${p.sourceId}:${p.start}`} label={t('受影響的函式')} pageSize={10} urlSync={false} search={{ placeholder: t('篩選函式') }}
          summary={{ key: 'kind', items: (['direct', 'state', 'indirect'] as const).filter((k) => k !== 'state' || vars.length).map((k) => ({ value: k, label: t(KIND_LABEL[k]) })), unit: countUnit('個', 'function', 'functions') }}
          columns={[
            { key: 'name', label: t('函式'), width: 160, grow: 2, mobile: 'title', searchText: (r: Row) => r.name + ' ' + r.source,
              render: (r: Row) => (
                <span className="fnname"><b>{r.name}</b>
                  {r.inferred ? <UI.Tag>{r.source}</UI.Tag> : null}
                  {r.api ? <UI.Tag><UI.Term text={entryTerm(r.api)}>{t('外部進入點')}</UI.Term></UI.Tag> : null}
                </span>
              ) },
            // 元件 starts hidden so the table fits beside the panel at 1280 px; the 元件 filter and the 欄位 menu still have it
            { key: 'comp', label: t('元件'), width: 100, grow: 1, hidden: true },
            { key: 'how', label: t('關係'), width: 110, grow: 1, searchText: (r: Row) => r.how, render: (r: Row) => r.how },
            { key: 'loc', label: t('位置'), width: 100, grow: 1, searchText: (r: Row) => r.loc, fullText: (r: Row) => `${r.f}:${r.lines.join(t('、'))}`,
              // the file name and every line; the full path is the cell's description
              render: (r: Row) => <span className="locs">{r.lines.map((l) => (
                <UI.InlineCode key={l} href={`#${r.f}:${l}`} onClick={(e) => { e.preventDefault(); p.onSel(r.fid, { f: r.f, l }) }}>{`${r.f.split('/').pop()}:${l}`}</UI.InlineCode>))}</span> },
            { key: 'depth', label: t('距離'), numeric: true, unit: t('層'), width: 72, grow: 0.5, hidden: true },
          ]}
          rows={rows}
          filters={[{ key: 'comp' as const, label: t('元件'), options: comps.map((c) => ({ value: c, label: c })) },
            ...(entries.length ? [{ key: 'entry' as const, label: t('外部進入點'), options: [{ value: 'yes', label: t('是外部進入點') }, { value: 'no', label: t('不是外部進入點') }] }] : [])]} />
      ) : null}
    </div>
  )
}
