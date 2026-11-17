import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { UI } from '../ui'
import { DocRefs, OpenFile, langLabel, useCodeRefs } from '../components/DocRefs'
import { useCallLinks } from '../components/CallLinks'
import { DescText } from '../components/DescText'
import { aiItem, descriptions, useDescOrder } from '../data/describe'
import type { Index } from '../data/graph'
import { useFileSource } from '../data/hooks'
import { vscodeURL } from '../prefs'
import { t } from '../i18n'
import { EditorButton } from './CodeAt'

/** A file opened to read it, taking the whole page, one topic to a column: the file and its one line on top, its
 *  functions down the left (names only, to jump), the function being read in the middle (what it does, what this
 *  line calls, who calls it, what it calls), and the code on the right. Clicking or moving to a line in the code
 *  makes its function the one in the middle. */
export function FileReader(p: { ix: Index; at: { f: string; l: number }; isLive: boolean; sourceId: string; backLabel: string
  onClose: () => void; onFunc: (id: string) => void }) {
  const src = useFileSource(p.at.f, p.isLive, p.sourceId)
  const view = useRef<UI.CodeViewHandle>(null)
  const refs = useCodeRefs(p.ix)
  const calls = useCallLinks(p.ix, src.data?.file, 1, src.data?.lines)
  const open = useContext(OpenFile)
  const order = useDescOrder()
  // the line being read: where the file was opened, then wherever the reader clicks or moves in the code
  const [cur, setCur] = useState(p.at.l)
  const [was, setWas] = useState(p.at)
  if (was.f !== p.at.f || was.l !== p.at.l) { setWas(p.at); setCur(p.at.l) }
  const fns = useMemo(() => Object.entries(p.ix.funcs).filter(([, f]) => f.file === p.at.f && f.kind !== 'module')
    .sort(([, a], [, b]) => a.line - b.line), [p.ix, p.at.f])
  const names = useMemo(() => new Set(fns.map(([, f]) => f.name)), [fns])
  const inFn = fns.filter(([, f]) => f.line <= cur && cur <= (f.end ?? f.line)).sort(([, a], [, b]) => b.line - a.line)[0]?.[0]
  // a Markdown file opens as its preview, unless a line in it was asked for: the preview has no line numbers
  const md = /\.(md|markdown)$/i.test(p.at.f)
  const [mode, setMode] = useState<'preview' | 'source'>(p.at.l > 1 ? 'source' : 'preview')
  if (was.f !== p.at.f || was.l !== p.at.l) setMode(p.at.l > 1 ? 'source' : 'preview')
  const shown = md ? mode : 'source'
  useEffect(() => { if (src.data && shown === 'source') view.current?.focusTarget() }, [src.data, p.at.f, p.at.l, shown])
  // the line under a click or the keyboard in the code: the code view has no event for it, so it is read from the line
  const follow = (e: React.SyntheticEvent) => {
    const row = (e.target as HTMLElement).closest?.('.ui-cv-line')
    const n = Number(row?.querySelector('.ui-cv-num')?.textContent)
    if (n && n !== cur) setCur(n)
  }
  const fileAi = aiItem(p.ix, 'file:' + p.at.f, order)
  const fileDoc = p.ix.g.files?.[p.at.f]
  const local = (href: string) => {
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return null
    const parts = [...p.at.f.split('/').slice(0, -1), ...href.split('#')[0].split('/')]
    const out: string[] = []
    for (const x of parts) { if (x === '..') out.pop(); else if (x && x !== '.') out.push(x) }
    return out.join('/')
  }
  return (
    // Escape anywhere in the file goes back to where it was opened from
    <div className="reader" onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); p.onClose() } }}>
      <div className="reader-head">
        <UI.Button icon="arrow-left" onClick={p.onClose}>{p.backLabel}</UI.Button>
        <h2 className="reader-file mono">{p.at.f}</h2>
        <span className="reader-about small">
          {fileAi ? <DescText d={fileAi} tag /> : fileDoc ? fileDoc.text.split('\n')[0] : <span className="muted">{t('沒有說明註解。')}</span>}
        </span>
        <EditorButton ix={p.ix} file={p.at.f} line={cur} />
      </div>
      <div className="reader-cols">
        <nav className="reader-toc" aria-label={t('目錄')}>
          <p className="reader-label">{t('目錄')}</p>
          {fns.length ? <ul>
            {fns.map(([id, f]) => {
              // a method under its class in this file: the class once, its methods indented by their own name
              const dot = f.name.lastIndexOf('.')
              const under = dot > 0 && names.has(f.name.slice(0, dot))
              return <li key={id}><button type="button" className={'reader-toc-item mono' + (under ? ' is-member' : '') + (id === inFn ? ' is-on' : '')}
                aria-current={id === inFn ? 'location' : undefined} title={f.name} onClick={() => open(p.at.f, f.line)}>{under ? f.name.slice(dot + 1) : f.name}</button></li>
            })}
          </ul> : <p className="small muted">{t('這個檔案沒有函式。')}</p>}
        </nav>
        <section className="reader-now" aria-label={t('現在讀的')}>
          <p className="reader-label">{t('現在讀的')}</p>
          {inFn ? <NowReading ix={p.ix} id={inFn} f={p.at.f} l={cur} onFunc={p.onFunc} open={open} />
            : <p className="small muted">{t('第 {v1} 行不在任何函式內。點選左側目錄或程式碼裡的一行。', { v1: cur })}</p>}
        </section>
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
    </div>
  )
}

/** The function being read: what it does, what the line calls, who calls it and what it calls. A function in this
 *  file moves the code to it; one in another file opens that file; 「看流程」 opens its flow. */
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
    <div className="reader-now-head">
      <h3 className="mono">{fn.name}</h3>
      <span className="muted small">{t('第 {v1} 行', { v1: p.l })}</span>
      <UI.Button icon="share-network" onClick={() => p.onFunc(p.id)}>{t('看流程')}</UI.Button>
    </div>
    {ds.length ? ds.map((d, i) => <p key={i} className="reader-desc"><DescText d={d} tag full /></p>)
      : <p className="small muted">{t('沒有註解或 AI 說明。在 repo 執行 codemap describe 可請 AI 撰寫。')}</p>}
    <UI.DetailList items={[
      ...(called.length ? [{ label: t('這一行呼叫'), value: list(called, '') }] : []),
      { label: t('誰呼叫它'), value: fw ? <span>{t('由 {v1} 呼叫', { v1: fw })}{callers.length ? <> · {list(callers, '')}</> : null}</span> : list(callers, t('（repo 中沒有）')) },
      { label: t('它呼叫'), value: list(callees, t('（無）')) },
    ]} />
  </>
}
