// A function, for reading it: what runs it, what it touches, its parameters, what it returns and changes, what its
// declaration guarantees and its contract. Only facts: what might be wrong is the check tab's. Every item that is
// about one line is marked when the reader clicks that line in the code, and the panel brings it into view unless
// the reader is busy in the panel.
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as UI from '@seanyeh77/ui'
import { t, local } from '../i18n'
import type { Index } from '../data/graph'
import type { InfoItem, SigParam } from '../data/types'
import { codeSpans, descriptions, useDescOrder } from '../data/describe'
import { DescText } from '../components/DescText'
import { conceptEx, conceptText, keywordText } from '../data/glossary'
import { affected } from './Impact'
import { worthIn, worthLists } from './Reader'
import { OpenFile, PeekLine } from '../components/DocRefs'

type Src = 'sure' | 'guess' | 'ai'
interface Row { key: string; line?: number; lines?: number[]; src: Src; body: ReactNode }

const SECTIONS = ['Execution context', 'Shared state', 'Parameters', 'Return value', 'Side effects', 'Declaration', 'Contract'] as const
const CONTRACT: Record<string, string> = { pre: 'precondition', post: 'postcondition', error: '', ownership: 'ownership' }

/** The AI's text in the reader's language, else the other one. */
const say = (it: InfoItem) => local({ 'zh-TW': it['zh-TW'] ?? '', en: it.en ?? '' }) || it['zh-TW'] || it.en || ''

export function FnPanel(p: { ix: Index; id: string; line: number | null }) {
  const f = p.ix.funcs[p.id]
  const order = useDescOrder()
  const info = f.ai?.state === 'wrong' ? undefined : f.ai?.info
  const sig = f.sig
  const analyzed = new Set((f.use?.shared ?? []).map((v) => v.name))
  const covered = (it?: InfoItem) => { const ns = it ? codeSpans(say(it)).filter((x) => typeof x !== 'string').map((x) => (x as { code: string }).code) : []
    return ns.some((n) => analyzed.has(n.split(/[.\->[]/)[0])) }
  // a term is underlined where it first appears in the panel, plain text after that
  const seen = new Set<string>()
  const term = (k: string, shown?: string) => {
    if (seen.has(k) || !conceptText(k)) return <>{shown ?? k}</>
    seen.add(k)
    return <UI.Term variant="inline" title={k} text={conceptText(k)} code={conceptEx(k, f.lang)}>{shown ?? k}</UI.Term>
  }
  const text = (s: string) => codeSpans(s).map((x, i) => (typeof x === 'string' ? x : <code key={i} className="desc-code">{x.code}</code>))
  const ai = (part: keyof NonNullable<typeof info>, pre?: (it: InfoItem) => ReactNode): Row[] =>
    (info?.[part] ?? []).map((it, i) => ({ key: part + i, line: it.line, src: 'ai', body: <>{pre?.(it)}{text(say(it))}</> }))

  const rows: Record<(typeof SECTIONS)[number], Row[]> = {
    'Execution context': [
      ...(f.entry ? [{ key: 'entry', src: 'sure' as Src, body: <>{t('由 {v1} 呼叫', { v1: f.entry.framework })}</> }] : []),
      ...(f.api ? [{ key: 'api', src: 'sure' as Src, body: <>{t('與 {v1} 程式庫的函式同名，以 LD_PRELOAD 載入後會優先執行此版本。', { v1: f.api })}</> }] : []),
      ...ai('context'),
    ],
    'Shared state': [
      ...(sig?.statics ?? []).map((s) => ({ key: 'st' + s.name, line: s.line, src: 'sure' as Src,
        body: <>{term('static local', t('static 區域變數'))} <code className="desc-code">{s.name}</code>{t('：在多次呼叫之間保留其值。')}</> })),
      ...(sig?.params ?? []).filter((x) => x.default_mutable).map((x) => ({ key: 'dm' + x.name, line: x.line, src: 'sure' as Src,
        body: <>{t('參數')} <code className="desc-code">{x.name}</code>{t(' 的預設值僅於定義時建立一次，省略此參數的呼叫皆共用同一物件。')}</> })),
      ...(f.use?.shared ?? []).map((v) => ({ key: 'sh' + v.name, line: (v.writes[0] ?? v.reads[0]), lines: [...v.writes, ...v.reads], src: 'guess' as Src,
        body: <>{v.writes.length ? (v.reads.length ? t('讀寫') : t('寫入')) : t('讀取')} <code className="desc-code">{v.name}</code>
          {t('（{v1}）', { v1: SCOPE[v.scope] ? t(SCOPE[v.scope]) : v.scope })}{v.atomic ? t('，以 atomic 操作') : v.writes.length ? t('，非 atomic 操作') : ''}
          <span className="small muted">{' · '}{lineList(v.writes, v.reads)}</span></> })),
      // the AI's lines about the same variables are left out: the code already says it
      ...ai('shared').filter((_, i) => !covered(info?.shared?.[i])),
    ],
    'Parameters': (sig?.params ?? []).filter((x) => x.name !== '...').map((x) => paramRow(x, info?.params?.find((y) => y.name === x.name.replace(/^[*.]+|\?$/g, '')))),
    'Return value': ai('returns'),
    'Side effects': ai('effects'),
    'Declaration': [...new Map((sig?.decl ?? []).map((d) => [d.kw, d])).values()].map((d) => ({ key: 'kw' + d.kw, line: d.line, src: 'sure' as Src, body: <>{keywordText(d.kw)}</> })),
    'Contract': ai('contract', (it) => (CONTRACT[it.kind ?? ''] ? <>{term(CONTRACT[it.kind!])}{t('：')}</> : it.kind === 'error' ? t('錯誤處理：') : null)),
  }

  function paramRow(x: SigParam, a?: InfoItem): Row {
    // the role the language settles: const, a plain value, an object that cannot change; the rest is the AI's
    const sure = x.ro || (x.mech === 'value' && !x.note) || x.note === 'immutable' ? 'in' : undefined
    const used = f.use?.params?.[x.name.replace(/^[*.]+|\?$/g, '')]
    const role = sure ?? used?.role ?? a?.role
    const roleSrc: Src = sure ? 'sure' : used?.role ? 'guess' : 'ai'
    const mech = x.mech === 'value' ? 'Pass by Value' : x.mech === 'reference' ? 'Pass by Reference' : x.mech === 'sharing' ? 'Pass by Sharing' : 'move'
    const note = x.note === 'address' ? t('，複製位址') : x.note === 'slice' ? t('，複製 slice header，共用底層陣列') : x.note === 'map' || x.note === 'chan' ? t('，共用底層資料')
      : x.note === 'immutable' ? t('，物件不可變') : ''
    return { key: 'p' + x.name, line: x.line, lines: [x.line, ...(used?.writes ?? [])], src: 'sure', body: <>
      <div className="fp-prm-h"><span className="fp-prm-n">{x.name}</span>{x.type ? <span className="fp-prm-t">{x.type}</span> : null}{x.recv ? <span className="small muted">{t('receiver')}</span> : null}</div>
      <dl className="fp-prm-d">
        <dt>{t('用途')}</dt><dd>{role ? <>{term(role)}{used?.writes.length ? <span className="small muted">{t('（寫入：第 {v1} 行）', { v1: used.writes.slice(0, 4).join(t('、')) })}</span> : null}<Src s={roleSrc} /></> : <span className="muted">{t('未知')}</span>}</dd>
        <dt>{t('傳遞方式')}</dt><dd>{term(mech)}{note}{x.ro ? t('，唯讀') : ''}</dd>
        {a && say(a) ? <><dt>{t('說明')}</dt><dd>{text(say(a))}<Src s="ai" /></dd></> : null}
      </dl></> }
  }

  const here = (r: Row) => p.line != null && (r.line === p.line || !!r.lines?.includes(p.line))
  const n = SECTIONS.reduce((k, s) => k + rows[s].filter(here).length, 0)
  const d = descriptions(p.ix, p.id, order).find((x) => x.kind !== 'facts')

  // follow the line: bring its first item into view, unless the reader is in the panel
  const box = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (busy || p.line == null) return
    const el = box.current?.querySelector('.fp-it.is-here') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [p.line, p.id])   // eslint-disable-line react-hooks/exhaustive-deps

  const peek = useContext(PeekLine)
  useEffect(() => () => peek(null), [])   // eslint-disable-line react-hooks/exhaustive-deps
  const empty = useMemo(() => SECTIONS.every((s) => !rows[s].length), [rows])   // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="info fp" ref={box} onPointerEnter={() => setBusy(true)} onPointerLeave={() => setBusy(false)}
    onFocus={() => setBusy(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setBusy(false) }}>
    <InfoTitle kind={t('函式')} name={f.name.split('.').pop()!} where={`${f.file}:${f.line}`} />
    <p className="fp-status small muted" aria-live="polite">{(p.line == null ? t('選取程式碼中的一行，即標示與該行相關的資料。') : n ? t('第 {v1} 行：{v2} 筆相關資料', { v1: p.line, v2: n }) : t('第 {v1} 行：無相關資料', { v1: p.line }))}</p>
    {d ? <p><DescText d={d} full />{d.kind === 'ai' ? <Src s="ai" /> : null}</p> : <UI.CodeText as="p" className="small muted" text={t('尚無說明：於 repo 執行 `codemap describe` 以產生 AI 說明。')} />}
    {SECTIONS.map((s) => rows[s].length ? <section key={s} className="fp-sec" aria-label={s}>
      <h3 className="info-h">{term(s)}<span className="fp-cnt">{t('{v1} 項', { v1: rows[s].length })}</span></h3>
      <ul className="fp-rows">{rows[s].map((r) => <li key={r.key} className={'fp-it' + (here(r) ? ' is-here' : '') + (r.line ? ' has-line' : '')}
        onPointerEnter={r.line ? () => peek(r.line!) : undefined} onPointerLeave={r.line ? () => peek(null) : undefined}>{r.body}{r.src !== 'sure' && s !== 'Parameters' ? <Src s={r.src} /> : null}</li>)}</ul>
    </section> : null)}
    {empty && !info ? <UI.CodeText as="p" className="small muted" text={t('Execution context、參數用途、回傳值與 Contract 由 AI 撰寫：於 repo 執行 `codemap describe`。')} /> : null}
    <p className="fp-legend small muted">{t('未標註者來自程式碼或語言規則。「推測」僅依寫法推得，「AI 撰寫」由 AI 依程式碼撰寫，兩者皆可能有誤。')}</p>
  </div>
}

const SCOPE: Record<string, string> = { global: '全域變數', extern: '全域變數', static: '檔案內的 static 變數', module: '模組變數', package: 'package 變數', field: 'static 欄位', member: '物件欄位' }

function lineList(writes: number[], reads: number[]) {
  const n = (xs: number[]) => xs.slice(0, 4).join(t('、')) + (xs.length > 4 ? t(' 等') : '')
  return [writes.length ? t('寫入：第 {v1} 行', { v1: n(writes) }) : '', reads.length ? t('讀取：第 {v1} 行', { v1: n(reads) }) : ''].filter(Boolean).join(t('；'))
}

function Src(p: { s: Src }) {
  return p.s === 'sure' ? null : <UI.AiMark text={p.s === 'ai' ? t('AI 撰寫') : t('推測')} />
}

/** The check tab's part about the open function: the pitfalls and mismatches the AI found in it, and what a change
 *  to it reaches. Kept out of 說明, which only says what the code does. */
export function FnChecks(p: { ix: Index; id: string; open: (f: string, l: number) => void }) {
  const f = p.ix.funcs[p.id]
  const checks = f.ai?.state === 'wrong' ? [] : f.ai?.info?.checks ?? []
  const rows = useMemo(() => affected(p.ix, p.id), [p.ix, p.id])
  const n = new Set(rows.map((r) => r.fid)).size
  const far = rows.reduce((m, r) => Math.max(m, r.depth), 0)
  const tests = p.ix.g.hidden_callers?.[p.id] ?? 0
  const KIND: Record<string, string> = { trap: t('語言陷阱'), desc: t('說明與程式碼不一致') }
  const found = worthIn(p.ix.g, p.id)
  const at = (l?: number) => (l ? <>{' · '}<button type="button" className="linklike" onClick={() => p.open(f.file, l)}>{t('第 {v1} 行', { v1: l })}</button></> : null)
  return <section className="chk-sec">
    <h3 className="info-h">{t('{v1} 的檢查', { v1: f.name.split('.').pop()! })}</h3>
    {found.length || f.ai?.state === 'stale' ? <ul className="fp-rows">
      {found.map(([label, l], i) => <li key={'w' + i} className="fp-it"><span className="small muted">{t('自動檢查')}{at(l)}</span><div>{t(label)}</div></li>)}
      {f.ai?.state === 'stale' ? <li className="fp-it"><span className="small muted">{t('說明')}</span><UI.CodeText as="div" text={t('說明撰寫後函式已修改，內容可能過時；執行 `codemap describe` 以重新撰寫。')} /></li> : null}
    </ul> : null}
    {checks.length ? <ul className="fp-rows">{checks.map((c, i) => <li key={i} className="fp-it">
      <span className="small muted">{KIND[c.kind ?? ''] ?? c.kind}{c.line ? <>{' · '}<button type="button" className="linklike" onClick={() => p.open(f.file, c.line!)}>{t('第 {v1} 行', { v1: c.line })}</button></> : null}</span>
      <div>{codeSpans(say(c)).map((x, j) => (typeof x === 'string' ? x : <code key={j} className="desc-code">{x.code}</code>))}<Src s="ai" /></div></li>)}</ul>
      : found.length || f.ai?.state === 'stale' ? null : <UI.CodeText as="p" className="small muted" text={f.ai?.info ? t('未發現問題。') : t('尚無 AI 檢查：於 repo 執行 `codemap describe`。')} />}
    <p className="small"><UI.Term variant="inline" title="Change impact" text={t('修改此函式可能影響的範圍。')}>Change impact</UI.Term>{t('：')}
      {n ? t('修改此函式可能影響 {n} 個函式，最遠 {v1} 層。', { n, v1: far }) : t('repo 內沒有函式呼叫此函式。')}
      {tests ? t('另有 {v1} 個測試函式呼叫此函式。', { v1: tests }) : ''}</p>
  </section>
}

/** What 說明 is about: its kind, its name and where it is, so the panel says whose description it shows. */
export function InfoTitle(p: { kind: string; name: string; where?: string; code?: boolean }) {
  // where it is (file, or file:line) is a link to that place in the code
  const open = useContext(OpenFile)
  const m = p.where?.match(/^(.*?)(?::(\d+))?$/)
  return <header className="info-what">
    <span className="small muted">{p.kind}</span>
    <h2 className={'info-title' + (p.code === false ? '' : ' mono')}>{p.name}</h2>
    {p.where && m ? <span className="small"><UI.InlineCode look="name" href="#" onClick={(e) => { e.preventDefault(); open(m[1], Number(m[2] ?? 1)) }}>{p.where}</UI.InlineCode></span> : null}
  </header>
}

/** The check tab's part about an open file, component or the project: each finding of the checks there, with its
 *  function and line, and the functions whose AI description is older than their code. */
export function ScopeChecks(p: { ix: Index; title: string; inside: (fid: string, f: string) => boolean
  open: (f: string, l: number) => void; openFn: (id: string) => void }) {
  const groups = worthLists(p.ix.g).map(([label, xs]) => [label, xs.filter((x) => p.inside(x.fid, x.f))] as const).filter(([, xs]) => xs.length)
  const stale = Object.entries(p.ix.funcs).filter(([id, f]) => f.ai?.state === 'stale' && p.inside(id, f.file)).map(([id]) => id)
  const name = (id: string) => p.ix.funcs[id]?.name.split('.').pop() ?? id
  return <section className="chk-sec">
    <h3 className="info-h">{p.title}</h3>
    {!groups.length && !stale.length ? <p className="small muted">{t('未發現問題。')}</p> : null}
    {groups.map(([label, xs]) => <div key={label} className="fp-sec">
      <h4 className="small">{t(label)}<span className="fp-cnt">{t('{v1} 處', { v1: xs.length })}</span></h4>
      <ul className="fp-rows">{xs.slice(0, 20).map((x, i) => <li key={i} className="fp-it small">
        <button type="button" className="linklike mono" onClick={() => p.openFn(x.fid)}>{name(x.fid)}</button>
        {(x as { l?: number }).l ? <>{' · '}<button type="button" className="linklike muted" onClick={() => p.open(x.f, (x as { l?: number }).l!)}>{`${x.f}:${(x as { l?: number }).l}`}</button></> : null}
      </li>)}{xs.length > 20 ? <li className="small muted">{t('另有 {v1} 處', { v1: xs.length - 20 })}</li> : null}</ul>
    </div>)}
    {stale.length ? <div className="fp-sec"><h4 className="small">{t('說明撰寫後已修改的函式')}<span className="fp-cnt">{t('{v1} 個', { v1: stale.length })}</span></h4>
      <ul className="fp-rows">{stale.slice(0, 20).map((id) => <li key={id} className="fp-it small"><button type="button" className="linklike mono" onClick={() => p.openFn(id)}>{name(id)}</button></li>)}</ul>
      <UI.CodeText as="p" className="small muted" text={t('執行 `codemap describe` 以重新撰寫。')} /></div> : null}
  </section>
}
