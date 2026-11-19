// A function, for reading it: what runs it, what it touches, its parameters, what it returns and changes, what its
// declaration guarantees and its contract. Only facts: what might be wrong is the check tab's. Every item that is
// about one line is marked when the reader clicks that line in the code, and the panel brings it into view unless
// the reader is busy in the panel.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as UI from '@seanyeh77/ui'
import { t, local } from '../i18n'
import type { Index } from '../data/graph'
import type { InfoItem, SigParam } from '../data/types'
import { codeSpans, descriptions, useDescOrder } from '../data/describe'
import { DescText } from '../components/DescText'
import { conceptEx, conceptText, keywordText } from '../data/glossary'
import { affected } from './Impact'

type Src = 'sure' | 'guess' | 'ai'
interface Row { key: string; line?: number; src: Src; body: ReactNode }

const SECTIONS = ['Execution context', 'Shared state', 'Parameters', 'Return value', 'Side effects', 'Declaration', 'Contract'] as const
const CONTRACT: Record<string, string> = { pre: 'precondition', post: 'postcondition', error: '', ownership: 'ownership' }

/** The AI's text in the reader's language, else the other one. */
const say = (it: InfoItem) => local({ 'zh-TW': it['zh-TW'] ?? '', en: it.en ?? '' }) || it['zh-TW'] || it.en || ''

export function FnPanel(p: { ix: Index; id: string; line: number | null }) {
  const f = p.ix.funcs[p.id]
  const order = useDescOrder()
  const info = f.ai?.state === 'wrong' ? undefined : f.ai?.info
  const sig = f.sig
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
        body: <>{term('static local', t('static 區域變數'))} <code className="desc-code">{s.name}</code>{t('：呼叫之間保留它的值。')}</> })),
      ...(sig?.params ?? []).filter((x) => x.default_mutable).map((x) => ({ key: 'dm' + x.name, line: x.line, src: 'sure' as Src,
        body: <>{t('參數')} <code className="desc-code">{x.name}</code>{t(' 的預設值在定義時只建立一次，所有不傳它的呼叫共用同一個物件。')}</> })),
      ...ai('shared'),
    ],
    'Parameters': (sig?.params ?? []).filter((x) => x.name !== '...').map((x) => paramRow(x, info?.params?.find((y) => y.name === x.name.replace(/^[*.]+|\?$/g, '')))),
    'Return value': ai('returns'),
    'Side effects': ai('effects'),
    'Declaration': [...new Map((sig?.decl ?? []).map((d) => [d.kw, d])).values()].map((d) => ({ key: 'kw' + d.kw, line: d.line, src: 'sure' as Src, body: <>{keywordText(d.kw)}</> })),
    'Contract': ai('contract', (it) => (CONTRACT[it.kind ?? ''] ? <>{term(CONTRACT[it.kind!])}{t('：')}</> : it.kind === 'error' ? t('出錯時：') : null)),
  }

  function paramRow(x: SigParam, a?: InfoItem): Row {
    // the role the language settles: const, a plain value, an object that cannot change; the rest is the AI's
    const sure = x.ro || (x.mech === 'value' && !x.note) || x.note === 'immutable' ? 'in' : undefined
    const role = sure ?? a?.role
    const mech = x.mech === 'value' ? 'Pass by Value' : x.mech === 'reference' ? 'Pass by Reference' : x.mech === 'sharing' ? 'Pass by Sharing' : 'move'
    const note = x.note === 'address' ? t('，複製位址') : x.note === 'slice' ? t('，複製 slice header，底層陣列共用') : x.note === 'map' || x.note === 'chan' ? t('，底層資料共用')
      : x.note === 'immutable' ? t('，物件不可變') : ''
    return { key: 'p' + x.name, line: x.line, src: 'sure', body: <>
      <div className="fp-prm-h"><span className="fp-prm-n">{x.name}</span>{x.type ? <span className="fp-prm-t">{x.type}</span> : null}{x.recv ? <span className="small muted">{t('receiver')}</span> : null}</div>
      <dl className="fp-prm-d">
        <dt>{t('用途')}</dt><dd>{role ? <>{term(role)}{!sure ? <Src s="ai" /> : null}</> : <span className="muted">{t('未知')}</span>}</dd>
        <dt>{t('傳遞方式')}</dt><dd>{term(mech)}{note}{x.ro ? t('，唯讀') : ''}</dd>
        {a && say(a) ? <><dt>{t('說明')}</dt><dd>{text(say(a))}<Src s="ai" /></dd></> : null}
      </dl></> }
  }

  const here = (r: Row) => p.line != null && r.line === p.line
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

  const empty = useMemo(() => SECTIONS.every((s) => !rows[s].length), [rows])   // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="info fp" ref={box} onPointerEnter={() => setBusy(true)} onPointerLeave={() => setBusy(false)}
    onFocus={() => setBusy(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setBusy(false) }}>
    <p className="fp-status small muted" aria-live="polite">{(busy ? t('暫停跟隨（正在看說明）· ') : '')
      + (p.line == null ? t('在程式碼點一行，這裡會標出與那一行有關的資料。') : n ? t('第 {v1} 行：{v2} 筆相關資料', { v1: p.line, v2: n }) : t('第 {v1} 行：沒有相關資料', { v1: p.line }))}</p>
    {d ? <p><DescText d={d} full />{d.kind === 'ai' ? <Src s="ai" /> : null}</p> : <p className="small muted">{t('還沒有說明。在 repo 執行 codemap describe 可請 AI 撰寫。')}</p>}
    {SECTIONS.map((s) => rows[s].length ? <section key={s} className="fp-sec" aria-label={s}>
      <h3 className="info-h">{term(s)}<span className="fp-cnt">{t('{v1} 項', { v1: rows[s].length })}</span></h3>
      <ul className="fp-rows">{rows[s].map((r) => <li key={r.key} className={'fp-it' + (here(r) ? ' is-here' : '')}>{r.body}{r.src !== 'sure' && s !== 'Parameters' ? <Src s={r.src} /> : null}</li>)}</ul>
    </section> : null)}
    {empty && !info ? <p className="small muted">{t('執行環境、參數用途、回傳值與 contract 由 AI 撰寫：在 repo 執行 codemap describe。')}</p> : null}
    <p className="fp-legend small muted">{t('沒有標註的資料來自程式碼或語言規則。標「推測」的只從寫法推得，可能不準；標「AI 撰寫」的是 AI 讀程式碼後寫成，可能有誤。')}</p>
  </div>
}

function Src(p: { s: Src }) {
  return p.s === 'sure' ? null : <span className="fp-src">{p.s === 'ai' ? t('AI 撰寫') : t('推測')}</span>
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
  return <section className="chk-sec">
    <h3 className="info-h">{t('{v1} 的檢查', { v1: f.name.split('.').pop()! })}</h3>
    {checks.length ? <ul className="fp-rows">{checks.map((c, i) => <li key={i} className="fp-it">
      <span className="small muted">{KIND[c.kind ?? ''] ?? c.kind}{c.line ? <>{' · '}<button type="button" className="linklike" onClick={() => p.open(f.file, c.line!)}>{t('第 {v1} 行', { v1: c.line })}</button></> : null}</span>
      <div>{codeSpans(say(c)).map((x, j) => (typeof x === 'string' ? x : <code key={j} className="desc-code">{x.code}</code>))}<Src s="ai" /></div></li>)}</ul>
      : <p className="small muted">{f.ai?.info ? t('沒有發現問題。') : t('還沒有 AI 檢查：在 repo 執行 codemap describe。')}</p>}
    <p className="small"><UI.Term variant="inline" title="Change impact" text={t('修改這個函式後，可能跟著受影響的範圍。')}>Change impact</UI.Term>{t('：')}
      {n ? t('修改它可能影響 {n} 個函式，最遠 {v1} 層。', { n, v1: far }) : t('repo 內沒有函式呼叫它。')}
      {tests ? t('另有 {v1} 個測試函式呼叫它。', { v1: tests }) : ''}</p>
  </section>
}
