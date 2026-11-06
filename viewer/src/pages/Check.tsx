import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import { live } from '../data/load'
import type { CheckFile, CheckItem, Sel } from '../data/types'

/** A Markdown line without its list marker (「- 」), as the suggestion shows it; the copy keeps the line whole. */
const unlisted = (md: string) => md.replace(/^\s*[-*+]\s+/, '')

const LABEL: Record<CheckItem['status'], string> = { done: '正確', fail: '錯誤', review: '待確認' }

export function Check(p: { ix: Index; isLive: boolean; sourceId: string; open: (id: string, edge: Sel['edge']) => void }) {
  // a snapshot carries its checks; live, the notes may have changed since indexing, so they are checked again on open
  const q = useQuery<CheckFile[]>({ queryKey: ['checks', p.ix.g.generated], queryFn: live.checks, enabled: p.isLive, staleTime: 0 })
  const files = q.data ?? p.ix.g.checks ?? []
  const [fileSel, setFile] = useState<string | null>(null)
  const cur = files.find((f) => f.file === fileSel) ?? files[0]

  if (p.isLive && q.isPending) {
    return <div className="card pane" data-tour="notes"><UI.Skeleton width="60%" height={16} /><UI.Skeleton width="80%" height={16} /></div>
  }
  if (p.isLive && q.error) {
    return <div className="card pane" data-tour="notes"><UI.Alert tone="danger" title="無法檢查筆記">{(q.error as Error).message}</UI.Alert></div>
  }
  if (!cur) {
    return (
      <div className="card pane" data-tour="notes">
        <UI.EmptyState title="沒有可檢查的筆記"
          description="檢查 Markdown 中的 file:line 引用與呼叫關係。"
          steps={p.isLive ? ['執行 codemap arch 產生 CODEMAP.md，或以 codemap serve --notes 指定筆記', '重新整理此頁']
            : ['以 codemap export --notes 指定筆記，重新匯出快照']} />
      </div>
    )
  }
  const rows = cur.items.map((it) => ({ ...it, id: it.at }))     // in line order already
  // a reference that falls in no function is plain inline code (refHref undefined); the components prevent navigation
  const refHref = (ref: string) => (p.ix.at(ref) ? '#' + ref : undefined)
  const onRef = (ref: string) => {
    const hit = p.ix.at(ref)
    if (hit) p.open(hit.id, hit.edge)
  }
  const code = (t: string) => <UI.CodeText text={t} refHref={refHref} onRef={onRef} />
  const fixes = rows.filter((r) => r.fix)
  return (
    <div className="pane" data-tour="notes">
      {files.length > 1 ? <UI.Tabs label="筆記檔案" items={files.map((f) => ({ id: f.file, label: f.file, count: f.items.length }))} value={cur.file} onChange={setFile} /> : null}
      <div className="card row">
        <span className="grow">
          <UI.InlineCode>{cur.file}</UI.InlineCode>{` · ${cur.refs} 個引用 · ${cur.claims} 個呼叫`}
        </span>
        {p.isLive
          ? <UI.Button variant="primary" loading={q.isFetching} onClick={() => q.refetch()}>{q.isFetching ? '檢查中' : '重新檢查'}</UI.Button>
          : null}
      </div>
      {!p.isLive ? <p className="small muted">此為匯出時的檢查結果。重新檢查需在 build 環境執行 codemap serve。</p> : null}
      {fixes.length ? (
        <section className="card fixes" aria-label="修正建議">
          <h3 className="ttl">{`修正建議（${fixes.length} 個）`}</h3>
          <p className="small muted">複製後貼回筆記，取代原本那一行。</p>
          {fixes.map((r) => (
            <UI.Suggestion key={r.at} title={r.at} before={unlisted(r.fix!.before)} after={unlisted(r.fix!.after)}
              copyText={r.fix!.after} refHref={refHref} onRef={onRef} />
          ))}
        </section>
      ) : null}
      <UI.DataTable resetKey={`${p.sourceId}:${cur.file}`} label="檢查結果" urlSync={false} search={false} columnMenu={false}
        summary={{ key: 'status', items: (['fail', 'review', 'done'] as const).map((v) => ({ value: v, label: LABEL[v] })) }}
        columns={[
          { key: 'at', label: '位置', width: 180, grow: 0.5, mobile: 'title', sortValue: (r: CheckItem) => r.line, render: (r: CheckItem) => <UI.InlineCode>{r.at}</UI.InlineCode> },
          { key: 'text', label: '筆記內容', width: 260, grow: 2, long: true, searchText: (r: CheckItem) => r.text, render: (r: CheckItem) => code(r.text) },
          { key: 'status', label: '結果', width: 110, grow: 0.5, mobile: 'status', render: (r: CheckItem) => <UI.Badge status={r.status}>{LABEL[r.status]}</UI.Badge> },
          { key: 'why', label: '說明', width: 280, grow: 3, long: true, searchText: (r: CheckItem) => r.why, render: (r: CheckItem) => code(r.why) },
        ]}
        rows={rows} />
    </div>
  )
}
