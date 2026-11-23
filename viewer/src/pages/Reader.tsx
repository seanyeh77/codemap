import { Children, isValidElement, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { UI } from '../ui'
import { DocRefs, OpenFile, langLabel, useCodeRefs, type Peek } from '../components/DocRefs'
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
  onFunc: (id: string) => void; frame?: (stage: ReactNode, detail: ReactNode) => ReactNode
  /** The workbench: only the code, without the file's function list (the explorer has it) or the detail column. */
  bare?: boolean
  /** The line the reader clicked or moved to. */
  onLine?: (n: number, how: 'click' | 'key') => void
  /** A Markdown file shown as its preview or its source, when the page above chooses it (the workbench's bar) */
  mdMode?: 'preview' | 'source'
  /** A line marked from outside, e.g. while an item in 說明 about it is pointed at. */
  peek?: Peek | null }) {
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
  // the reader's own click moves the line: the code keeps its place and the text being selected
  const moved = useRef(false)
  if (was.f !== p.at.f || was.l !== p.at.l) {
    setWas(p.at); setCur(p.at.l)
    if (!moved.current) setMode(p.at.l > 1 ? 'source' : 'preview')
  }
  // the file's functions fold away to give the code the room; kept in the browser
  const [rail, setRail] = useState(() => { try { return localStorage.getItem('codemap:rail') !== '0' } catch { return true } })
  const toggleRail = () => { setRail(!rail); try { localStorage.setItem('codemap:rail', rail ? '0' : '1') } catch { /* storage off */ } }
  const fns = useMemo(() => Object.entries(p.ix.funcs).filter(([, f]) => f.file === p.at.f && f.kind !== 'module')
    .sort(([, a], [, b]) => a.line - b.line), [p.ix, p.at.f])
  const names = useMemo(() => new Set(fns.map(([, f]) => f.name)), [fns])
  const inFn = fns.filter(([, f]) => f.line <= cur && cur <= (f.end ?? f.line)).sort(([, a], [, b]) => b.line - a.line)[0]?.[0]
  const shown = md ? p.mdMode ?? mode : 'source'
  useEffect(() => {
    if (moved.current) { moved.current = false; return }
    if (src.data && shown === 'source') view.current?.focusTarget()
  }, [src.data, p.at.f, p.at.l, shown])
  // the line the reader clicks or moves to with the keyboard (selecting text to copy is not a move)
  const follow = (n: number, how: 'click' | 'key') => {
    if (n !== cur) { moved.current = true; setCur(n) }
    p.onLine?.(n, how)
  }
  const local = (href: string) => {
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return null
    const parts = [...p.at.f.split('/').slice(0, -1), ...href.split('#')[0].split('/')]
    const out: string[] = []
    for (const x of parts) { if (x === '..') out.pop(); else if (x && x !== '.') out.push(x) }
    return out.join('/')
  }
  const stage = (
    <div className={'reader-stage' + (rail && !p.bare ? '' : ' no-rail') + (p.bare ? ' is-bare' : '')}>
      {p.bare ? null : rail ? <nav className="reader-toc" aria-label={t('{v1} 的函式', { v1: p.at.f.split('/').pop() })}>
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
        </ul> : <p className="small muted">{t('此檔案無函式。')}</p>}
      </nav> : <div className="reader-rail-closed"><UI.IconButton icon="list" label={t('打開函式清單')} onClick={toggleRail} /></div>}
      <section className="reader-code" aria-label={t('程式碼')}>
        {!p.isLive ? <p className="small muted">{t('快照僅含函式的原始碼，無法顯示整個檔案：於 build 環境執行 codemap serve 查看。')}</p>
          : src.isPending ? <UI.Skeleton width="80%" height={16} />
          : src.error || !src.data ? <UI.Alert tone="danger" title={t('無法讀取檔案')}>{src.error ? (src.error as Error).message : t('此檔案不在索引中。')}</UI.Alert>
          : <>{md && !p.mdMode ? <UI.SegmentedControl label={t('顯示方式')} value={shown} onChange={setMode}
            items={[{ id: 'preview', label: t('預覽'), icon: 'eye' }, { id: 'source', label: t('原始碼'), icon: 'file-code' }]} /> : null}
            {shown === 'preview' ? <div className="md-preview"><UI.Markdown {...refs} linkHref={(h) => (local(h) ? '#' + local(h) : h)}
              onLink={(h) => { const f = local(h); if (f) open(f, 1); else window.open(h, '_blank', 'noopener') }}>{src.data.lines.join('\n')}</UI.Markdown></div>
              : <UI.CodeView {...refs} {...calls} ref={view}
                file={src.data.file} languageLabel={langLabel(src.data.file)}
                // the workbench's bar above already names the file: the language and buttons float over the code
                {...(p.bare ? { header: 'float' as const } : { fileHref: vscodeURL(p.at.f, cur, p.ix.g.root, p.ix.g.host) ?? undefined })}
                code={src.data.lines.join('\n')} start={1}
                target={cur > 1 ? cur : undefined} onLine={follow} peek={p.peek ? (p.peek.to > p.peek.from ? p.peek : p.peek.from) : null} maxHeight="100%" sections={fns.map(([, f]) => ({ line: f.line, label: f.name }))} />}
            {/\.(md|rst)$/.test(p.at.f) ? null : <DocRefs ix={p.ix} lines={src.data.lines} />}</>}
      </section>
    </div>
  )
  if (p.bare || !p.frame) return stage
  const detail = (
    <UI.Card className="detail level-detail" title={<span className="mono">{inFn ? p.ix.funcs[inFn].name : p.at.f.split('/').pop()}</span>}
      actions={<EditorButton ix={p.ix} file={p.at.f} line={cur} />}>
      {inFn ? <NowReading ix={p.ix} id={inFn} f={p.at.f} l={cur} onFunc={p.onFunc} open={open} sig={signature(src.data?.lines, p.ix.funcs[inFn].line)} />
        : <FileLevel ix={p.ix} f={p.at.f} l={cur} />}
    </UI.Card>
  )
  return <div className="arch-frame">
    <Crumbs ix={p.ix} file={p.at.f} fn={inFn ? p.ix.funcs[inFn].name : undefined} />
    {p.frame(stage, detail)}
  </div>
}

/** A function's signature from its first lines: up to the line that ends it (a Python def's colon, a C body's
 *  brace), at most 8 lines, the brace left out. */
export function signature(lines: string[] | undefined, line: number): string | undefined {
  if (!lines || !lines[line - 1]) return undefined
  const out: string[] = []
  for (let i = line - 1; i < Math.min(lines.length, line + 7); i++) {
    const s = lines[i]
    out.push(s)
    if (/[:{]\s*(#.*|\/\/.*)?$/.test(s) || /\)\s*;\s*$/.test(s)) break
  }
  const pad = Math.min(...out.filter((s) => s.trim()).map((s) => s.length - s.trimStart().length))
  return out.map((s) => s.slice(pad)).join('\n').replace(/\s*\{\s*$/, '').trimEnd()
}

/** One of the three parts every level of the architecture page answers: 是什麼, 和誰有關, 值得注意. Inside Parts it is
 *  one tab; its title is the tab's name. */
export function Q(p: { title: string; children: ReactNode }) {
  return <section className="level-q" aria-label={p.title}>{p.children}</section>
}

// the tab being read stays the same from one level, file or function to the next, and in this browser
let shownTab = (() => { try { return Number(localStorage.getItem('codemap:part') ?? 0) || 0 } catch { return 0 } })()

/** The three parts of a level as tabs, one shown at a time. Its children are Q (or Notes, which is 值得注意). */
export function Parts(p: { children: ReactNode }) {
  const qs = Children.toArray(p.children).filter(isValidElement) as ReactElement<{ title?: string }>[]
  const [at, setAt] = useState(Math.min(shownTab, qs.length - 1))
  const pick = (i: number) => { shownTab = i; setAt(i); try { localStorage.setItem('codemap:part', String(i)) } catch { /* storage off */ } }
  const titles = qs.map((q) => q.props.title ?? t('值得注意'))
  const i = Math.min(at, qs.length - 1)
  return <div className="level-parts">
    <UI.Tabs label={t('說明')} items={titles.map((x, k) => ({ id: String(k), label: x }))} value={String(i)} onChange={(v) => pick(Number(v))} />
    {qs[i]}
  </div>
}

/** A line outside every function: the file itself. */
function FileLevel(p: { ix: Index; f: string; l: number }) {
  const order = useDescOrder()
  const ai = aiItem(p.ix, 'file:' + p.f, order)
  const doc = p.ix.g.files?.[p.f]
  return <>
    <p className="small muted">{t('第 {v1} 行不在任何函式內：選取函式清單或程式碼中的一行。', { v1: p.l })}</p>
    <Parts>
    <Q title={t('說明')}>
      {ai ? <p><DescText d={ai} tag full /></p> : null}
      {doc ? <p>{doc.text.split('\n\n')[0]}</p> : null}
      {!ai && !doc ? <p className="muted">{t('無說明註解。')}</p> : null}
    </Q>
    <Notes ix={p.ix} f={p.f} />
    </Parts>
  </>
}

/** The function being read: what it is, who it is tied to (what this line calls, who calls it, what it calls) and what
 *  is worth a note. A function in this file moves the code to it; one in another file opens that file there. */
function NowReading(p: { ix: Index; id: string; f: string; l: number; onFunc: (id: string) => void; open: (f: string, l: number) => void; sig?: string }) {
  const order = useDescOrder()
  const fn = p.ix.funcs[p.id]
  // what it is: what its author or an AI wrote. The facts (who calls it, what it calls) are 和誰有關, with the names
  const ds = descriptions(p.ix, p.id, order).filter((d) => d.kind !== 'facts')
  const called = [...new Set(p.ix.g.edges.filter((e) => e.f === p.f && e.l === p.l && p.ix.funcs[e.d] && e.d !== p.id).map((e) => e.d))]
  const callers = [...new Set(p.ix.callers(p.id).map((e) => e.s).filter((s) => p.ix.funcs[s]))]
  const callees = [...new Set(p.ix.callees(p.id, false).map((e) => e.d).filter((d) => p.ix.funcs[d] && d !== p.id))]
  const go = (id: string) => { const g = p.ix.funcs[id]; p.open(g.file, g.line) }
  const name = (id: string) => <UI.InlineCode key={id} look="name" href={'#' + id} onClick={(e) => { e.preventDefault(); go(id) }}>{p.ix.funcs[id].name}</UI.InlineCode>
  const list = (ids: string[], none: string) => ids.length
    ? <ul className="reader-refs">{ids.slice(0, 12).map((id) => <li key={id}>{name(id)}{p.ix.funcs[id].file !== p.f ? <span className="muted small">{p.ix.funcs[id].file.split('/').pop()}</span> : null}</li>)}
      {ids.length > 12 ? <li className="muted small">{t('還有 {n} 個', { n: ids.length - 12 })}</li> : null}</ul>
    : <span className="muted">{none}</span>
  const fw = fn.entry?.framework
  return <>
    <p className="small muted">{t('第 {v1} 行', { v1: p.l })} · {p.f}</p>
    <Parts>
    <Q title={t('說明')}>
      {ds.map((d, i) => <p key={i} className="reader-desc"><DescText d={d} tag full /></p>)}
      {/* no description: its signature says what goes in and comes out, in the code's own words */}
      {!ds.length && p.sig ? <pre className="reader-sig mono">{p.sig}</pre> : null}
      {!ds.length ? <UI.CodeText as="p" className="small muted" text={t('尚無說明：於 repo 執行 `codemap describe` 以產生 AI 說明。')} /> : null}
    </Q>
    <Q title={t('和誰有關')}>
      <UI.DetailList items={[
        ...(called.length ? [{ label: t('這一行呼叫'), value: list(called, '') }] : []),
        { label: t('呼叫者'), value: fw ? <span>{t('由 {v1} 呼叫', { v1: fw })}{callers.length ? <> · {list(callers, '')}</> : null}</span> : list(callers, t('（repo 中無）')) },
        { label: t('呼叫'), value: list(callees, t('（無）')) },
      ]} />
      <div><UI.Button icon="share-network" onClick={() => p.onFunc(p.id)}>{t('看流程')}</UI.Button></div>
    </Q>
    <Notes ix={p.ix} f={p.f} id={p.id} />
    </Parts>
  </>
}

/** 值得注意: whether people may change the file, and what the checks found in this function (or this file). */
export function Notes(p: { ix: Index; f: string; id?: string; why?: string; extra?: string[]
  /** the workbench's 說明: no tabs around it, a small heading, and nothing at all when there is nothing to note */
  flat?: boolean }) {
  const g = p.ix.g
  const role = roleOf(g, p.f)
  const found = worthAt(g, (x) => (p.id ? x.fid === p.id : x.f === p.f))
  const order = useDescOrder()
  const ai = p.id ? p.ix.funcs[p.id]?.ai : aiItem(p.ix, 'file:' + p.f, order)
  const stale = !!ai && ai.state === 'stale'
  const items = [
    role ? <li key="role">{role === 'editable' ? t('可修改：專案允許修改這個檔案。') : t('請勿修改：專案不希望修改此檔案。')}</li> : null,
    ...found.map(([label, n]) => <li key={label}>{t('{v1}：{v2} 處', { v1: t(label), v2: n })}</li>),
    stale ? <li key="stale">{t('AI 說明撰寫後程式碼已修改，內容可能不準確。')}</li> : null,
    ...(p.extra ?? []).map((x) => <li key={x}>{x}</li>),
  ].filter(Boolean)
  if (p.flat) return items.length ? <section className="info-notes" aria-label={t('值得注意')}>
    <h3 className="info-h">{t('值得注意')}</h3>
    <ul className="level-notes">{items}</ul>
    {found.length ? <a className="link small" href="#check">{t('於檢查查看細節')}</a> : null}
    {p.why ? <UI.CodeText as="p" className="small muted" text={p.why} /> : null}
  </section> : null
  return <Q title={t('值得注意')}>
    {items.length ? <ul className="level-notes">{items}</ul> : <p className="small muted">{t('未發現。')}</p>}
    {found.length ? <a className="link small" href="#check">{t('到檢查筆記看細節')}</a> : null}
    {p.why ? <UI.CodeText as="p" className="small muted" text={p.why} /> : null}
  </Q>
}

/** What the checks found where `at` says, by check: [label, count]. */
export function worthAt(g: Graph, at: (x: { fid: string; f: string }) => boolean): [string, number][] {
  return worthLists(g).map(([label, xs]) => [label, xs.filter(at).length] as [string, number]).filter(([, n]) => n > 0)
}

/** What the checks found in one function, each with its line: [label, line]. */
export function worthIn(g: Graph, fid: string): [string, number | undefined][] {
  return worthLists(g).flatMap(([label, xs]) => xs.filter((x) => x.fid === fid).map((x) => [label, (x as { l?: number }).l] as [string, number | undefined]))
}

export function worthLists(g: Graph): [string, { fid: string; f: string }[]][] {
  const w = g.worth
  if (!w) return []
  return [
    ['捕捉所有例外後繼續執行', w.broad ?? []], ['結束程式的呼叫', w.stops], ['未檢查 NULL 就使用的 getenv 結果', w.env],
    ['只在未設定時才設定的環境變數', w.env_if_unset ?? []], ['回傳固定錯誤碼的地方', w.errors ?? []], ['會丟掉資料的地方', w.loss ?? []],
    ['程式結束後會留下的東西', w.leftovers ?? []], ['到達上限時直接返回、不印訊息', w.limits?.silent ?? []],
    ['不經 atomic 操作就修改的全域變數', (w.plain_writes ?? []).flatMap((v) => v.writes)],
  ]
}

