import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { UI } from '../ui'
import { DocRefs, OpenFile, langLabel, useCodeRefs } from '../components/DocRefs'
import { useCallLinks } from '../components/CallLinks'
import { DescText } from '../components/DescText'
import { aiItem, descriptions, useDescOrder } from '../data/describe'
import { roleOf } from '../data/files'
import type { Index } from '../data/graph'
import type { Graph } from '../data/types'
import { useFileSource } from '../data/hooks'
import { vscodeURL } from '../prefs'
import { t } from '../i18n'
import { EditorButton } from './CodeAt'

/** Where the architecture page is: 專案 › component › file › function, each but the last a link back up. */
export function Crumbs(p: { ix: Index; comp?: string; file?: string; fn?: string }) {
  const comp = p.comp ?? (p.file ? compOfFile(p.ix, p.file) : undefined)
  const items: { label: string; href?: string }[] = [{ label: t('專案'), href: '#arch' }]
  if (comp) items.push({ label: comp, href: '#arch?c=' + encodeURIComponent(comp) })
  if (p.file) items.push({ label: p.file.split('/').pop()!, href: '#arch?c=' + encodeURIComponent('file:' + p.file) })
  if (p.fn) items.push({ label: p.fn })
  delete items[items.length - 1].href
  return <UI.Breadcrumb className="arch-crumbs" items={items} />
}

/** The component a file belongs to: the one most of its functions are in. */
export function compOfFile(ix: Index, file: string): string | undefined {
  const n = new Map<string, number>()
  for (const f of Object.values(ix.funcs)) if (f.file === file) n.set(f.comp, (n.get(f.comp) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** A file being read on the architecture page, in the page's one layout: the breadcrumb on top, then the stage (the
 *  file's functions, which fold away, and its code) and the detail column (the function being read, in the same three
 *  parts as every other level). Clicking or moving to a line in the code makes its function the one in the detail. */
export function FileReader(p: { ix: Index; at: { f: string; l: number }; isLive: boolean; sourceId: string
  onFunc: (id: string) => void; frame: (stage: ReactNode, detail: ReactNode) => ReactNode }) {
  const src = useFileSource(p.at.f, p.isLive, p.sourceId)
  const view = useRef<UI.CodeViewHandle>(null)
  const refs = useCodeRefs(p.ix)
  const calls = useCallLinks(p.ix, src.data?.file, 1, src.data?.lines)
  const open = useContext(OpenFile)
  // the line being read: where the file was opened, then wherever the reader clicks or moves in the code
  const [cur, setCur] = useState(p.at.l)
  const [was, setWas] = useState(p.at)
  const md = /\.(md|markdown)$/i.test(p.at.f)
  // a Markdown file opens as its preview, unless a line in it was asked for: the preview has no line numbers
  const [mode, setMode] = useState<'preview' | 'source'>(p.at.l > 1 ? 'source' : 'preview')
  if (was.f !== p.at.f || was.l !== p.at.l) { setWas(p.at); setCur(p.at.l); setMode(p.at.l > 1 ? 'source' : 'preview') }
  // the file's functions fold away to give the code the room; kept in the browser
  const [rail, setRail] = useState(() => { try { return localStorage.getItem('codemap:rail') !== '0' } catch { return true } })
  const toggleRail = () => { setRail(!rail); try { localStorage.setItem('codemap:rail', rail ? '0' : '1') } catch { /* storage off */ } }
  const fns = useMemo(() => Object.entries(p.ix.funcs).filter(([, f]) => f.file === p.at.f && f.kind !== 'module')
    .sort(([, a], [, b]) => a.line - b.line), [p.ix, p.at.f])
  const names = useMemo(() => new Set(fns.map(([, f]) => f.name)), [fns])
  const inFn = fns.filter(([, f]) => f.line <= cur && cur <= (f.end ?? f.line)).sort(([, a], [, b]) => b.line - a.line)[0]?.[0]
  const shown = md ? mode : 'source'
  useEffect(() => { if (src.data && shown === 'source') view.current?.focusTarget() }, [src.data, p.at.f, p.at.l, shown])
  // the line under a click or the keyboard in the code: the code view has no event for it, so it is read from the line
  const follow = (e: React.SyntheticEvent) => {
    const row = (e.target as HTMLElement).closest?.('.ui-cv-line')
    const n = Number(row?.querySelector('.ui-cv-num')?.textContent)
    if (n && n !== cur) setCur(n)
  }
  const local = (href: string) => {
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return null
    const parts = [...p.at.f.split('/').slice(0, -1), ...href.split('#')[0].split('/')]
    const out: string[] = []
    for (const x of parts) { if (x === '..') out.pop(); else if (x && x !== '.') out.push(x) }
    return out.join('/')
  }
  const stage = (
    <div className={'reader-stage' + (rail ? '' : ' no-rail')}>
      {rail ? <nav className="reader-toc" aria-label={t('{v1} 的函式', { v1: p.at.f.split('/').pop() })}>
        <div className="reader-toc-head"><span className="reader-label">{t('函式')}</span>
          <UI.IconButton icon="caret-left" label={t('收起函式清單')} onClick={toggleRail} /></div>
        {fns.length ? <ul>
          {fns.map(([id, f]) => {
            // a method under its class in this file: the class once, its methods indented by their own name
            const dot = f.name.lastIndexOf('.')
            const under = dot > 0 && names.has(f.name.slice(0, dot))
            return <li key={id}><button type="button" className={'reader-toc-item mono' + (under ? ' is-member' : '') + (id === inFn ? ' is-on' : '')}
              aria-current={id === inFn ? 'location' : undefined} title={f.name} onClick={() => open(p.at.f, f.line)}>{under ? f.name.slice(dot + 1) : f.name}</button></li>
          })}
        </ul> : <p className="small muted">{t('這個檔案沒有函式。')}</p>}
      </nav> : <div className="reader-rail-closed"><UI.IconButton icon="list" label={t('打開函式清單')} onClick={toggleRail} /></div>}
      <section className="reader-code" aria-label={t('程式碼')} onClickCapture={follow} onFocusCapture={follow}>
        {!p.isLive ? <p className="small muted">{t('快照只含函式的原始碼，無法顯示整個檔案。請在 build 環境執行 codemap serve 查看。')}</p>
          : src.isPending ? <UI.Skeleton width="80%" height={16} />
          : src.error || !src.data ? <UI.Alert tone="danger" title={t('無法讀取檔案')}>{src.error ? (src.error as Error).message : t('此檔案不在索引中。')}</UI.Alert>
          : <>{md ? <UI.Tabs label={t('顯示方式')} items={[{ id: 'preview', label: t('預覽') }, { id: 'source', label: t('原始碼') }]} value={shown} onChange={(v) => setMode(v as 'preview' | 'source')} /> : null}
            {shown === 'preview' ? <div className="md-preview"><UI.Markdown {...refs} linkHref={(h) => (local(h) ? '#' + local(h) : h)}
              onLink={(h) => { const f = local(h); if (f) open(f, 1); else window.open(h, '_blank', 'noopener') }}>{src.data.lines.join('\n')}</UI.Markdown></div>
              : <UI.CodeView {...refs} {...calls} languageLabel={langLabel(src.data.file)} ref={view} file={src.data.file}
                fileHref={vscodeURL(p.at.f, cur, p.ix.g.root, p.ix.g.host) ?? undefined} code={src.data.lines.join('\n')} start={1}
                target={cur > 1 ? cur : undefined} maxHeight="100%" sections={fns.map(([, f]) => ({ line: f.line, label: f.name }))} />}
            {/\.(md|rst)$/.test(p.at.f) ? null : <DocRefs ix={p.ix} lines={src.data.lines} />}</>}
      </section>
    </div>
  )
  const detail = (
    <UI.Card className="detail level-detail" title={<span className="mono">{inFn ? p.ix.funcs[inFn].name : p.at.f.split('/').pop()}</span>}
      actions={<EditorButton ix={p.ix} file={p.at.f} line={cur} />}>
      {inFn ? <NowReading ix={p.ix} id={inFn} f={p.at.f} l={cur} onFunc={p.onFunc} open={open} />
        : <FileLevel ix={p.ix} f={p.at.f} l={cur} />}
    </UI.Card>
  )
  return <div className="arch-frame">
    <Crumbs ix={p.ix} file={p.at.f} fn={inFn ? p.ix.funcs[inFn].name : undefined} />
    {p.frame(stage, detail)}
  </div>
}

/** One of the three parts every level of the architecture page answers: 是什麼, 和誰有關, 值得注意. */
export function Q(p: { title: string; children: ReactNode }) {
  return <section className="level-q"><h3 className="level-q-title">{p.title}</h3>{p.children}</section>
}

/** A line outside every function: the file itself. */
function FileLevel(p: { ix: Index; f: string; l: number }) {
  const order = useDescOrder()
  const ai = aiItem(p.ix, 'file:' + p.f, order)
  const doc = p.ix.g.files?.[p.f]
  return <>
    <p className="small muted">{t('第 {v1} 行不在任何函式內。點選函式清單或程式碼裡的一行。', { v1: p.l })}</p>
    <Q title={t('是什麼')}>
      {ai ? <p><DescText d={ai} tag full /></p> : null}
      {doc ? <p>{doc.text.split('\n\n')[0]}</p> : null}
      {!ai && !doc ? <p className="muted">{t('沒有說明註解。')}</p> : null}
    </Q>
    <Notes ix={p.ix} f={p.f} />
  </>
}

/** The function being read: what it is, who it is tied to (what this line calls, who calls it, what it calls) and what
 *  is worth a note. A function in this file moves the code to it; one in another file opens that file there. */
function NowReading(p: { ix: Index; id: string; f: string; l: number; onFunc: (id: string) => void; open: (f: string, l: number) => void }) {
  const order = useDescOrder()
  const fn = p.ix.funcs[p.id]
  const ds = descriptions(p.ix, p.id, order)
  const called = [...new Set(p.ix.g.edges.filter((e) => e.f === p.f && e.l === p.l && p.ix.funcs[e.d] && e.d !== p.id).map((e) => e.d))]
  const callers = [...new Set(p.ix.callers(p.id).map((e) => e.s).filter((s) => p.ix.funcs[s]))]
  const callees = [...new Set(p.ix.callees(p.id, false).map((e) => e.d).filter((d) => p.ix.funcs[d] && d !== p.id))]
  const go = (id: string) => { const g = p.ix.funcs[id]; p.open(g.file, g.line) }
  const name = (id: string) => <UI.InlineCode key={id} href={'#' + id} onClick={(e) => { e.preventDefault(); go(id) }}>{p.ix.funcs[id].name}</UI.InlineCode>
  const list = (ids: string[], none: string) => ids.length
    ? <ul className="reader-refs">{ids.slice(0, 12).map((id) => <li key={id}>{name(id)}{p.ix.funcs[id].file !== p.f ? <span className="muted small">{p.ix.funcs[id].file.split('/').pop()}</span> : null}</li>)}
      {ids.length > 12 ? <li className="muted small">{t('還有 {n} 個', { n: ids.length - 12 })}</li> : null}</ul>
    : <span className="muted">{none}</span>
  const fw = fn.entry?.framework
  return <>
    <p className="small muted">{t('第 {v1} 行', { v1: p.l })} · {p.f}</p>
    <Q title={t('是什麼')}>
      {ds.length ? ds.map((d, i) => <p key={i} className="reader-desc"><DescText d={d} tag full /></p>)
        : <p className="small muted">{t('沒有註解或 AI 說明。在 repo 執行 codemap describe 可請 AI 撰寫。')}</p>}
    </Q>
    <Q title={t('和誰有關')}>
      <UI.DetailList items={[
        ...(called.length ? [{ label: t('這一行呼叫'), value: list(called, '') }] : []),
        { label: t('誰呼叫它'), value: fw ? <span>{t('由 {v1} 呼叫', { v1: fw })}{callers.length ? <> · {list(callers, '')}</> : null}</span> : list(callers, t('（repo 中沒有）')) },
        { label: t('它呼叫'), value: list(callees, t('（無）')) },
      ]} />
      <div><UI.Button icon="share-network" onClick={() => p.onFunc(p.id)}>{t('看流程')}</UI.Button></div>
    </Q>
    <Notes ix={p.ix} f={p.f} id={p.id} />
  </>
}

/** 值得注意: whether people may change the file, and what the checks found in this function (or this file). */
export function Notes(p: { ix: Index; f: string; id?: string }) {
  const g = p.ix.g
  const role = roleOf(g, p.f)
  const found = worthAt(g, (x) => (p.id ? x.fid === p.id : x.f === p.f))
  const order = useDescOrder()
  const ai = p.id ? p.ix.funcs[p.id]?.ai : aiItem(p.ix, 'file:' + p.f, order)
  const stale = !!ai && ai.state === 'stale'
  const items = [
    role ? <li key="role"><UI.Tag>{role === 'editable' ? t('可修改') : t('受保護')}</UI.Tag> {role === 'editable' ? t('專案允許修改這個檔案。') : t('專案不希望修改這個檔案。')}</li> : null,
    ...found.map(([label, n]) => <li key={label}>{t('{v1}：{v2} 處', { v1: t(label), v2: n })}</li>),
    stale ? <li key="stale">{t('AI 說明寫好之後程式碼改過了，可能不準。')}</li> : null,
  ].filter(Boolean)
  return <Q title={t('值得注意')}>
    {items.length ? <ul className="level-notes">{items}</ul> : <p className="small muted">{t('沒有發現。')}</p>}
    {found.length ? <a className="link small" href="#check">{t('到檢查筆記看細節')}</a> : null}
  </Q>
}

/** What the checks found where `at` says, by check: [label, count]. */
export function worthAt(g: Graph, at: (x: { fid: string; f: string }) => boolean): [string, number][] {
  const w = g.worth
  if (!w) return []
  const lists: [string, { fid: string; f: string }[]][] = [
    ['捕捉所有例外後繼續執行', w.broad ?? []], ['結束程式的呼叫', w.stops], ['未檢查 NULL 就使用的 getenv 結果', w.env],
    ['只在未設定時才設定的環境變數', w.env_if_unset ?? []], ['回傳固定錯誤碼的地方', w.errors ?? []], ['會丟掉資料的地方', w.loss ?? []],
    ['程式結束後會留下的東西', w.leftovers ?? []], ['到達上限時直接返回、不印訊息', w.limits?.silent ?? []],
    ['不經 atomic 操作就修改的全域變數', (w.plain_writes ?? []).flatMap((v) => v.writes)],
  ]
  return lists.map(([label, xs]) => [label, xs.filter(at).length] as [string, number]).filter(([, n]) => n > 0)
}
