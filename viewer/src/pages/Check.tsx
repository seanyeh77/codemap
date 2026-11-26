import { useQuery } from '@tanstack/react-query'
import { useContext, useEffect, useRef, useState } from 'react'
import { OpenFile } from '../components/DocRefs'
import { UI } from '../ui'
import { countUnit, dateTime, list, t } from '../i18n'
import type { Index } from '../data/graph'
import { live } from '../data/load'
import type { CheckFile, CheckItem, Sel } from '../data/types'
import { DescCoverage } from './Arch'

/** A Markdown line without its list marker (「- 」), as the suggestion shows it; the copy keeps the line whole. */
const unlisted = (md: string) => md.replace(/^\s*[-*+]\s+/, '')

const LABEL: Record<string, string> = { fail: '錯誤', review: '待確認', calls: '呼叫已確認', syntax: '呼叫寫在程式碼裡', names: '名稱出現', exists: '行存在', done: '相符' }
/** A row's result: an error, to review, or what its match rests on (a snapshot from before has no basis). */
const result = (r: CheckItem) => (r.status === 'done' ? r.basis ?? 'done' : r.status)

/** The explanation in the reader's language, from the templates the checker sends. */
function whyText(r: CheckItem) {
  if (!r.msgs) return r.why
  return r.msgs.map((m) => t(m.t, Object.fromEntries(Object.entries(m.v).map(([k, v]) => [k, Array.isArray(v) ? list(v) : v])))).join(t('；'))
}

export function Check(p: { ix: Index; isLive: boolean; sourceId: string; open: (id: string, edge: Sel['edge']) => void
  /** 檢查's panel: a heading and one line of where things stand, the table only for what needs a look */
  compact?: boolean }) {
  // a snapshot carries its checks; live, the notes may have changed since indexing, so they are checked again on open
  const q = useQuery<CheckFile[]>({ queryKey: ['checks', p.ix.g.generated], queryFn: live.checks, enabled: p.isLive, staleTime: 0 })
  const files = q.data ?? p.ix.g.checks ?? []
  const [fileSel, setFile] = useState<string | null>(null)
  const cur = files.find((f) => f.file === fileSel) ?? files[0]
  const openFile = useContext(OpenFile)
  // all rows or only those that need a look (錯誤, 待確認); and whether what each result means is shown
  const [all, setAll] = useState(false)
  const [explain, setExplain] = useState(false)
  // the result is said once after 重新檢查, not every time the page opens (the page title is said then)
  const asked = useRef(false)
  useEffect(() => {
    if (!asked.current || q.isFetching || !q.data) return
    asked.current = false
    UI.announce(t('檢查完成，{v1} 項錯誤。', { v1: q.data.flatMap((f) => f.items).filter((r) => r.status === 'fail').length }))
  }, [q.isFetching, q.data])

  if (p.isLive && q.isPending) {
    return <UI.Card className="pane"><UI.Skeleton width="60%" height={16} /><UI.Skeleton width="80%" height={16} /></UI.Card>
  }
  if (p.isLive && q.error) {
    return <UI.Card className="pane"><UI.Alert tone="danger" title={t('無法檢查筆記')}>{(q.error as Error).message}</UI.Alert></UI.Card>
  }
  if (!cur && p.compact) return <section className="chk-sec" data-tour="notes"><h3 className="info-h">{t('筆記')}</h3>
    <UI.CodeText as="p" className="small muted" text={p.isLive ? t('無可檢查的筆記：執行 `codemap arch` 產生 `CODEMAP.md`，或以 `codemap serve --notes` 指定筆記。') : t('無可檢查的筆記：以 `codemap export --notes` 指定筆記，重新匯出快照。')} /></section>
  if (!cur) {
    return (
      <UI.Card className="pane" data-tour="notes">
        <UI.EmptyState title={t('無可檢查的筆記')}
          description={t('檢查 Markdown 中的 file:line 引用與呼叫關係。')}
          steps={p.isLive ? [t('執行 `codemap arch` 產生 `CODEMAP.md`，或以 `codemap serve --notes` 指定筆記'), t('重新整理此頁')]
            : [t('以 `codemap export --notes` 指定筆記，重新匯出快照')]} />
      </UI.Card>
    )
  }
  const rows = cur.items.map((it) => ({ ...it, id: it.at, result: result(it) }))     // in line order already
  // a reference that falls in no function is plain inline code (refHref undefined); the components prevent navigation
  const refHref = (ref: string) => (p.ix.at(ref) ? '#' + ref : undefined)
  const onRef = (ref: string) => {
    const hit = p.ix.at(ref)
    if (hit) p.open(hit.id, hit.edge)
  }
  const code = (t: string) => <UI.CodeText text={t} refHref={refHref} onRef={onRef} />
  const fixes = rows.filter((r) => r.fix)
  const issues = rows.filter((r) => r.status === 'fail' || r.status === 'review')
  const shown = all ? rows : issues
  const head = p.compact ? <>
    <div className="chk-head"><h3 className="info-h">{t('筆記')} <UI.InlineCode>{cur.file}</UI.InlineCode></h3><span className="grow" />
      {p.isLive ? <UI.IconButton variant="quiet" icon="arrows-clockwise" label={q.isFetching ? t('檢查中') : t('重新檢查')} disabled={q.isFetching}
        onClick={() => { asked.current = true; q.refetch() }} /> : null}</div>
    <div className="act-after"><p className="small muted">{p.isLive && q.dataUpdatedAt ? t('{v1} 檢查', { v1: dateTime(new Date(q.dataUpdatedAt)) }) : t('匯出時的結果')}</p>
      <UI.Button variant="quiet" onClick={() => openFile(cur.file, 1)}>{t('開啟全文')}</UI.Button></div>
  </> : null
  return (
    <div className={p.compact ? 'chk-sec' : 'pane'}>
      {head}
      {files.length > 1 ? <UI.Tabs label={t('筆記檔案')} unit={countUnit('項', 'item', 'items')} items={files.map((f) => ({ id: f.file, label: f.file, count: f.items.length }))} value={cur.file} onChange={setFile} /> : null}
      {p.compact ? null : <UI.Card data-tour="notes" title={<UI.InlineCode>{cur.file}</UI.InlineCode>}
        actions={p.isLive ? <UI.Button variant="primary" loading={q.isFetching} onClick={() => { asked.current = true; q.refetch() }}>{q.isFetching ? t('檢查中') : t('重新檢查')}</UI.Button> : undefined}>
        {/* one line of where things stand; what each result means is behind 「結果的意思」 */}
        <p className="small muted">{p.isLive && q.dataUpdatedAt ? t('檢查時間：{v1}。', { v1: dateTime(new Date(q.dataUpdatedAt)) }) + ' ' : ''}
          {t('共 {v1} 項：{v2} 項錯誤、{v3} 項待確認。', { v1: rows.length, v2: issues.filter((r) => r.status === 'fail').length, v3: issues.filter((r) => r.status === 'review').length })}</p>
        <div className="act-after"><UI.Button variant="quiet" aria-expanded={explain} onClick={() => setExplain(!explain)}>{t('結果的意思')}</UI.Button>
          <UI.Button variant="quiet" onClick={() => openFile(cur.file, 1)}>{t('開啟 {v1} 全文', { v1: cur.file })}</UI.Button></div>
        {explain ? <div className="check-explain">
        <p className="small muted">{t('共 {v1} 項：{v2} 個 file:line 引用、{v3} 個呼叫。', { v1: rows.length, v2: cur.refs, v3: cur.claims })}</p>
        {p.isLive && q.dataUpdatedAt ? <p className="small muted">{t('檢查時間：{v1}，{v2} 項錯誤、{v3} 項待確認。', { v1: dateTime(new Date(q.dataUpdatedAt)), v2: rows.filter((r) => r.status === 'fail').length, v3: rows.filter((r) => r.status === 'review').length })
          // what "0 errors" covers: how many references there were, and how many only had their names checked
          + ' ' + t('共檢查 {v1} 處引用：{v2} 處核對呼叫關係，{v3} 處僅核對名稱出現在該行。句子其餘內容未檢查。', { v1: rows.length,
            v2: rows.filter((r) => r.basis === 'calls' || r.basis === 'syntax').length, v3: rows.filter((r) => r.basis === 'names' || r.basis === 'exists').length })}</p> : null}
        {rows.some((r) => r.result === 'syntax') ? <p className="small muted">{t('「呼叫寫在程式碼裡」：目標由靜態分析或 tree-sitter 找到，未經編譯器確認。說明欄註明為哪一種。')}</p> : null}
        <p className="small muted">{t('「呼叫已確認」：筆記寫的呼叫經編譯器確認。「名稱出現」：引用的行含筆記中的名稱，句子其餘說法（例如由誰設定、讀取）未檢查。「待確認」：說明欄列出須對照的位置。')}</p>
        <p className="small muted">{t('無 file:line 引用或呼叫的行不列出。')}</p>
        </div> : null}
        {!p.isLive ? <p className="small muted">{t('此為匯出時的檢查結果。重新檢查需在 build 環境執行 codemap serve。')}</p> : null}
      </UI.Card>}
      {shown.length ? <UI.DataTable resetKey={`${p.sourceId}:${cur.file}`} label={t('檢查結果')} urlSync={false} search={false} columnMenu={false}
        summary={{ key: 'result', items: ['fail', 'review', 'calls', 'syntax', 'names', 'exists', 'done'].filter((v) => shown.some((r) => r.result === v)).map((v) => ({ value: v, label: t(LABEL[v]) })), unit: countUnit('項', 'item', 'items') }}
        columns={[
          { key: 'at', label: t('位置'), width: 180, grow: 0.5, mobile: 'title', sortValue: (r: CheckItem) => r.line, render: (r: CheckItem) => <UI.InlineCode look="location" onClick={() => openFile(r.at.slice(0, r.at.lastIndexOf(':')), r.line)}>{r.at}</UI.InlineCode> },
          { key: 'text', label: t('筆記內容'), width: 260, grow: 2, long: true, searchText: (r: CheckItem) => r.text, render: (r: CheckItem) => code(r.text) },
          { key: 'result', label: t('結果'), width: 120, grow: 0.5, mobile: 'status', render: (r: CheckItem) => <UI.Badge status={r.status}>{t(LABEL[result(r)])}</UI.Badge> },
          { key: 'why', label: t('說明'), width: 280, grow: 3, long: true, searchText: (r: CheckItem) => whyText(r), render: (r: CheckItem) => code(whyText(r)) },
        ]}
        rows={shown} /> : null}
      {/* only what needs a look is listed; the rest is one line, and all of it a click away */}
      {issues.length < rows.length ? <p className="check-rest small">
        <span className="check-ok-dot" aria-hidden="true" />
        {issues.length ? t('其餘 {v1} 項沒問題。', { v1: rows.length - issues.length }) : t('{v1} 項都沒問題。', { v1: rows.length })}
        <UI.Button variant="quiet" aria-expanded={all} onClick={() => setAll(!all)}>{all ? t('只列有問題的') : t('顯示全部')}</UI.Button></p> : null}
      {fixes.length ? (
        <UI.Card className="fixes" title={((a, b) => a && b ? t('修正建議（{v1} 個：{v2} 項{v4}、{v3} 項待確認）', { v1: fixes.length, v2: a, v3: b, v4: countUnit('錯誤', 'error', 'errors')(a) }) : t('修正建議（{v1} 個）', { v1: fixes.length }))(
          fixes.filter((r) => r.status === 'fail').length, fixes.filter((r) => r.status === 'review').length)}>
          <p className="small muted">{t('複製後貼回筆記，取代原本的該行。')}</p>
          {fixes.map((r) => (
            <UI.Suggestion key={r.at} title={r.at} before={unlisted(r.fix!.before)} after={unlisted(r.fix!.after)}
              copyText={r.fix!.after} refHref={refHref} onRef={onRef} />
          ))}
        </UI.Card>
      ) : null}
    </div>
  )
}

/** The map's descriptions: how many functions say what they do, and which AI descriptions the code has moved away from
 *  (stale) or that name places or names the code does not have (wrong). Here because it is about the map, not the code. */
export function DescHealth(p: { ix: Index; compact?: boolean }) {
  const openFile = useContext(OpenFile)
  const fs = Object.entries(p.ix.funcs).filter(([, f]) => f.kind !== 'module' && f.scope !== 'test')
  const bad = fs.filter(([, f]) => f.ai && (f.ai.state === 'stale' || f.ai.state === 'wrong'))
  if (!fs.length) return null
  if (p.compact) return <section className="chk-sec"><h3 className="info-h">{t('函式說明')}</h3>
    <DescCoverage ix={p.ix} />
    {bad.length ? <ul className="level-list">{bad.map(([id, f]) => (
      <li key={id}><UI.InlineCode look="name" href={'#' + id} onClick={(e) => { e.preventDefault(); openFile(f.file, f.line) }}>{f.name}</UI.InlineCode>{' '}
        <span className="small muted">{f.ai!.state === 'stale' ? t('程式碼在說明寫好之後改過') : t('提到的位置或名稱與程式碼不符')}</span></li>))}</ul> : null}
  </section>
  return (
    <UI.Card className="desc-health" title={t('函式說明')}>
      <DescCoverage ix={p.ix} />
      {bad.length ? <>
        <UI.CodeText as="p" className="small" text={t('{v1} 個 AI 說明需要重寫（執行 `codemap describe` 會重寫）：', { v1: bad.length })} />
        <ul className="level-list">{bad.map(([id, f]) => (
          <li key={id}><UI.InlineCode look="name" href={'#' + id} onClick={(e) => { e.preventDefault(); openFile(f.file, f.line) }}>{f.name}</UI.InlineCode>{' '}
            <span className="small muted">{f.ai!.state === 'stale' ? t('程式碼在說明寫好之後改過') : t('提到的位置或名稱與程式碼不符')}</span></li>))}</ul>
      </> : <p className="small muted">{t('AI 說明都和目前的程式碼相符。')}</p>}
    </UI.Card>
  )
}
