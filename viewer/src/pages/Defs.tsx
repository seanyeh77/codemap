// The 定義 view: what the open file defines besides its functions (types, file-level variables, constants and macros,
// imports and exports), each with its line and the functions that use it. Like 說明 it follows the line in the code:
// the items that line defines or uses are marked; pointing at an item marks its line in the code.
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as UI from '@seanyeh77/ui'
import { t } from '../i18n'
import type { Index } from '../data/graph'
import type { FileDefs } from '../data/types'
import { conceptEx, conceptText } from '../data/glossary'
import { PeekLine } from '../components/DocRefs'
import { InfoTitle } from './FnPanel'

const SHOWN = 15            // items a section shows before 「顯示其餘」
const FILTER_FROM = 30      // the filter appears when the file has more items than this

type Kind = 'types' | 'vars' | 'consts' | 'imports' | 'exports'
const SECTIONS: { k: Kind; title: string }[] = [
  { k: 'types', title: '型別' }, { k: 'vars', title: '變數' }, { k: 'consts', title: '常數與巨集' },
  { k: 'imports', title: '引入' }, { k: 'exports', title: '匯出' },
]
// the word under each kind, and the glossary entry that explains it
const TYPE_KIND: Record<string, [string, string?]> = {
  struct: ['struct', 'struct'], union: ['union', 'union'], enum: ['enum', 'enum'], typedef: ['typedef', 'typedef'],
  class: ['類別'], interface: ['interface'], type: ['type'], record: ['record'],
}
const VAR_KIND: Record<string, [string, string?]> = {
  static: ['static 變數', 'static variable'], global: ['全域變數', 'global variable'], extern: ['extern 宣告', 'extern'],
  module: ['模組變數', 'module variable'], package: ['package 變數'], field: ['static 欄位'],
}
const CONST_KIND: Record<string, [string, string?]> = { macro: ['巨集', 'macro'], const: ['常數'], enum: ['enum 值', 'enum'] }

interface Item { key: string; name: string; line: number; end?: number; at?: number[]; kind: ReactNode; detail?: ReactNode; more?: ReactNode; users?: string[]; users_n?: number }

export function Defs(p: { ix: Index; file: string | null; line: number | null; open: (f: string, l: number) => void; openFn: (id: string) => void }) {
  const peek = useContext(PeekLine)
  const [q, setQ] = useState('')
  const [all, setAll] = useState<Record<string, boolean>>({})
  const [openTypes, setOpenTypes] = useState<Record<string, boolean>>({})
  const box = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setQ(''); setAll({}); setOpenTypes({}) }, [p.file])
  useEffect(() => () => peek(null), [])   // eslint-disable-line react-hooks/exhaustive-deps
  const d: FileDefs | undefined = p.file ? p.ix.g.defs?.[p.file] : undefined
  const lang = useMemo(() => Object.values(p.ix.funcs).find((f) => f.file === p.file)?.lang, [p.ix, p.file])

  // a kind is underlined where it first appears in the view, plain text after that
  const seen = new Set<string>()
  const kindText = ([shown, k]: [string, string?]) => {
    if (!k || seen.has(k) || !conceptText(k)) return <>{t(shown)}</>
    seen.add(k)
    return <UI.Term variant="inline" title={k} text={conceptText(k)} code={conceptEx(k, lang)}>{t(shown)}</UI.Term>
  }

  const items: Record<Kind, Item[]> = { types: [], vars: [], consts: [], imports: [], exports: [] }
  if (d) {
    items.types = d.types.map((x) => ({ key: 't' + x.name + x.line, name: x.name, line: x.line, end: x.end, at: x.at, users: x.users, users_n: x.users_n,
      kind: <>{kindText(TYPE_KIND[x.kind] ?? [x.kind])}{x.typedef ? <>{t('、')}{kindText(TYPE_KIND.typedef)}</> : null}</>,
      detail: x.of ? <>{t('即 ')}<code className="desc-code">{x.of}</code></> : null,
      more: x.fields.length ? <Fields id={'t' + x.name + x.line} fields={x.fields} enumLike={x.kind === 'enum' || x.of === 'enum'}
        open={!!openTypes['t' + x.name + x.line]} toggle={() => setOpenTypes({ ...openTypes, ['t' + x.name + x.line]: !openTypes['t' + x.name + x.line] })}
        go={(l) => p.file && p.open(p.file, l)} peek={peek} /> : null }))
    items.vars = d.vars.map((x) => ({ key: 'v' + x.name + x.line, name: x.name, line: x.line, at: x.at, users: x.users, users_n: x.users_n,
      kind: kindText(VAR_KIND[x.scope] ?? [x.scope]), detail: x.type ? <code className="desc-code">{x.type}</code> : null }))
    items.consts = d.consts.map((x) => ({ key: 'c' + x.name + x.line, name: x.name + (x.params ?? ''), line: x.line, at: x.at, users: x.users, users_n: x.users_n,
      kind: kindText(CONST_KIND[x.kind] ?? [x.kind]), detail: x.value ? <>= <code className="desc-code">{x.value}</code></> : null }))
    items.imports = d.imports.map((x) => ({ key: 'i' + x.line + x.text, name: x.text, line: x.line, at: x.at,
      kind: x.local === undefined ? null : kindText(x.local ? ['專案內的檔案', 'include'] : ['系統或程式庫', 'include']),
      detail: x.file ? <UI.InlineCode look="name" href="#" onClick={(e) => { e.preventDefault(); p.open(x.file!, 1) }}>{x.file}</UI.InlineCode>
        : x.names?.length && x.names.join() !== x.text ? <>{t('取得：')}{x.names.map((n, i) => <span key={n}>{i ? t('、') : ''}<code className="desc-code">{n}</code></span>)}</> : null }))
    items.exports = d.exports.map((x) => ({ key: 'e' + x.name + x.line, name: x.name, line: x.line, kind: i18nExport(x.name) }))
  }
  const total = SECTIONS.reduce((n, s) => n + items[s.k].length, 0)
  const here = (x: Item) => p.line != null && ((x.line <= p.line && p.line <= (x.end ?? x.line)) || !!x.at?.includes(p.line))
  const n = SECTIONS.reduce((k, s) => k + items[s.k].filter(here).length, 0)
  const match = (x: Item) => !q || x.name.toLowerCase().includes(q.toLowerCase())

  // follow the line: bring its first item into view, unless the reader is in the view
  useEffect(() => {
    if (busy || p.line == null) return
    const el = box.current?.querySelector('.fp-it.is-here') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [p.line, p.file])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!p.file) return <div className="info fp"><p className="small muted">{t('開啟檔案後，此處列出檔案中的型別、變數、常數與巨集，以及引入與匯出。')}</p></div>
  const fname = p.file.split('/').pop()!
  if (!d || !total) return <div className="info fp">
    <InfoTitle kind={t('檔案')} name={fname} where={p.file} />
    <p className="small muted">{p.ix.g.defs ? t('此檔案沒有函式以外的定義，也沒有引入其他檔案。') : t('此快照未包含定義：以新版 codemap 重新匯出即可顯示。')}</p>
  </div>

  const name = (id: string) => p.ix.funcs[id]?.name.split('.').pop() ?? id
  return <div className="info fp defs" ref={box} onPointerEnter={() => setBusy(true)} onPointerLeave={() => setBusy(false)}
    onFocus={() => setBusy(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setBusy(false) }}>
    <InfoTitle kind={t('檔案')} name={fname} where={p.file} />
    <p className="fp-status small muted" aria-live="polite">{p.line == null ? t('選取程式碼中的一行，即標示該行定義或用到的項目。')
      : n ? t('第 {v1} 行：{v2} 項相關', { v1: p.line, v2: n }) : t('第 {v1} 行：無相關項目', { v1: p.line })}</p>
    {total > FILTER_FROM ? <UI.SearchField className="defs-filter" label={t('篩選定義')} value={q} onChange={setQ} /> : null}
    {SECTIONS.map(({ k, title }) => {
      const xs = items[k].filter(match)
      if (!xs.length) return null
      const long = !q && !all[k] && xs.length > SHOWN
      const shown = long ? xs.filter((x, i) => i < SHOWN || here(x)) : xs
      return <section key={k} className="fp-sec" aria-label={t(title)}>
        <h3 className="info-h">{t(title)}<span className="fp-cnt">{t('{v1} 項', { v1: xs.length })}</span></h3>
        <ul className="fp-rows">{shown.map((x) => <li key={x.key} className={'fp-it has-line' + (here(x) ? ' is-here' : '')}
          onPointerEnter={() => peek(x.line)} onPointerLeave={() => peek(null)}>
          <div className="defs-head">
            <UI.InlineCode look="name" href="#" onClick={(e) => { e.preventDefault(); p.open(p.file!, x.line) }}>{x.name}</UI.InlineCode>
            <span className="small muted">{x.kind ? <>{x.kind}{t(' · ')}</> : null}{t('第 {v1} 行', { v1: x.line })}</span>
          </div>
          {x.detail ? <div className="small">{x.detail}</div> : null}
          {x.users?.length ? <div className="small muted">{t('用到的函式：')}{x.users.slice(0, 3).map((id, i) => <span key={id}>{i ? t('、') : ''}
            <UI.InlineCode look="name" href="#" onClick={(e) => { e.preventDefault(); p.openFn(id) }}>{name(id)}</UI.InlineCode></span>)}
            {(x.users_n ?? x.users.length) > 3 ? t(' 等 {v1} 個', { v1: x.users_n ?? x.users.length }) : ''}<UI.AiMark text={t('推測')} /></div> : null}
          {x.more}
        </li>)}</ul>
        {long ? <button type="button" className="linklike small" onClick={() => setAll({ ...all, [k]: true })}>{t('顯示其餘 {v1} 項', { v1: xs.length - shown.length })}</button> : null}
      </section>
    })}
    {q && !SECTIONS.some(({ k }) => items[k].some(match)) ? <p className="small muted">{t('沒有名稱包含「{v1}」的定義。', { v1: q })}</p> : null}
    <p className="fp-legend small muted">{t('定義與行號來自程式碼。「推測」：用到的函式依名稱比對找出，範圍為本檔案與引入本檔案的檔案，可能包含同名的其他東西。')}</p>
  </div>
}

function i18nExport(name: string) {
  return name === 'default' ? <span>{t('預設匯出')}</span> : null
}

function Fields(p: { id: string; fields: { name: string; type: string; line: number }[]; enumLike: boolean; open: boolean; toggle: () => void
  go: (l: number) => void; peek: (l: number | null) => void }) {
  const label = p.enumLike ? t('值 {v1} 個', { v1: p.fields.length }) : t('欄位 {v1} 個', { v1: p.fields.length })
  return <div className="defs-fields">
    <button type="button" className="linklike small" aria-expanded={p.open} aria-controls={p.id} onClick={p.toggle}>
      <UI.Icon name={p.open ? 'caret-down' : 'caret-right'} />{label}</button>
    {p.open ? <ul id={p.id} className="defs-field-list">{p.fields.map((f) => <li key={f.name + f.line}
      onPointerEnter={(e) => { e.stopPropagation(); p.peek(f.line) }}>
      <button type="button" className="defs-field mono" onClick={() => p.go(f.line)}>{f.name}</button>
      {f.type ? <span className="small muted mono">{f.type}</span> : null}</li>)}</ul> : null}
  </div>
}
