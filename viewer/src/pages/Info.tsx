import { useEffect, useRef } from 'react'
import { UI } from '../ui'
import { t } from '../i18n'
import type { Index } from '../data/graph'
import { roleOf } from '../data/files'
import { aiItem, descriptions, useDescOrder } from '../data/describe'
import { DescText } from '../components/DescText'
import { Notes, worthAt } from './Reader'
import { TRACED } from './Arch'

/** What is open in the workbench: the project, a component, or a place in a file. */
export type At = { kind: 'proj' } | { kind: 'comp'; id: string } | { kind: 'file'; f: string; l: number } | { kind: 'settings' }

/** The innermost function around a line of a file, or null between functions. */
export function fnAt(ix: Index, f: string, l: number): string | null {
  let best: string | null = null
  for (const [id, x] of Object.entries(ix.funcs)) {
    if (x.file !== f || x.kind === 'module' || x.line > l || l > (x.end ?? x.line)) continue
    if (!best || ix.funcs[best].line < x.line) best = id
  }
  return best
}

/** The side bar's 說明: what the open thing is and what is worth a note about it, two tabs. Who it calls and who calls
 *  it are the panel's (呼叫流程, 影響範圍), so they are not repeated here. */
export function Info(p: { ix: Index; at: At; fn: string | null; openFn: (id: string) => void }) {
  const { ix, at } = p
  const order = useDescOrder()
  const g = ix.g
  if (at.kind === 'proj' || at.kind === 'settings') {
    const project = aiItem(ix, 'project', order)
    const found = worthAt(g, (x) => !!ix.funcs[x.fid] && ix.funcs[x.fid].scope !== 'test')
    return <div className="info">
      {project ? <p><DescText d={project} tag full /></p> : <p className="muted">{t('沒有說明。在 repo 執行 codemap describe 可請 AI 撰寫。')}</p>}
      <p className="small muted">{t('{v1} 個元件、{v2} 個函式', { v1: g.comps.length, v2: Object.keys(ix.funcs).length })}</p>
      <Found found={found} />
    </div>
  }
  if (at.kind === 'comp') {
    const c = g.comps.find((x) => x.id === at.id)
    const ai = aiItem(ix, 'comp:' + at.id, order)
    const found = worthAt(g, (x) => ix.funcs[x.fid]?.comp === at.id)
    return <div className="info">
      {at.id === TRACED ? <p className="small muted">{t('被追蹤的程式（repo 外）')}</p> : null}
      {ai ? <p><DescText d={ai} tag full /></p> : null}
      {c?.doc ? <p className="small">{c.doc.text}</p> : null}
      {!ai && !c?.doc ? <p className="small muted">{t('沒有說明註解。')}</p> : null}
      {c ? <p className="small muted">{t('{v1} 個檔案、{v2} 個函式', { v1: c.files, v2: c.funcs })}</p> : null}
      <Found found={found} />
    </div>
  }
  return <FileInfo ix={ix} f={at.f} fn={p.fn} openFn={p.openFn} />
}

/** A file: what it is, what is worth a note, and its functions in line order, each with what it does. The function
 *  the code is in is marked and shows all it has (its whole description and its own notes); a name moves the code to
 *  it and leaves this outline where it is. */
function FileInfo(p: { ix: Index; f: string; fn: string | null; openFn: (id: string) => void }) {
  const order = useDescOrder()
  const ai = aiItem(p.ix, 'file:' + p.f, order)
  const doc = p.ix.g.files?.[p.f]
  const role = roleOf(p.ix.g, p.f)
  const byRules = Object.keys(p.ix.g.roles ?? {}).some((x) => p.f === x || p.f.startsWith(x.replace(/\/$/, '') + '/'))
  const fns = (p.ix.byFile().get(p.f) ?? []).filter((id) => p.ix.funcs[id].kind !== 'module').sort((a, b) => p.ix.funcs[a].line - p.ix.funcs[b].line)
  const here = useRef<HTMLLIElement>(null)
  // the code moved to another function: bring its row into view, without moving the page around it
  useEffect(() => { here.current?.scrollIntoView({ block: 'nearest' }) }, [p.fn])
  return <div className="info">
    {ai ? <p><DescText d={ai} tag full /></p> : null}
    {doc ? <p className="small">{doc.text.split('\n\n')[0]}</p> : null}
    {!ai && !doc ? <p className="small muted">{t('沒有說明註解。')}</p> : null}
    <Notes flat ix={p.ix} f={p.f} why={role ? (byRules ? t('可修改／受保護的依據：.codemap/rules.json 的 roles') : t('可修改／受保護的依據：檔案開頭註解的第一個詞')) : undefined} />
    {fns.length ? <section className="info-notes" aria-label={t('函式')}>
      <h3 className="info-h">{t('函式')}</h3>
      <ul className="info-outline">{fns.map((id) => id === p.fn
        ? <li key={id} ref={here} className="is-here" aria-current="true"><FnHere ix={p.ix} id={id} /></li>
        : <li key={id}>
          <UI.InlineCode look="name" href={'#'} onClick={(e) => { e.preventDefault(); p.openFn(id) }}>{p.ix.funcs[id].name.split('.').pop()!}</UI.InlineCode>
          <OneLine ix={p.ix} id={id} />
        </li>)}</ul>
    </section> : null}
  </div>
}

function OneLine(p: { ix: Index; id: string }) {
  const d = descriptions(p.ix, p.id, useDescOrder()).find((x) => x.kind !== 'facts')
  return d ? <span className="info-outline-desc"><DescText d={d} tag /></span> : <span className="small muted">{t('沒有說明')}</span>
}

/** The function the code is in: its name, every description it has, and what is worth a note about it alone. */
function FnHere(p: { ix: Index; id: string }) {
  const order = useDescOrder()
  const fn = p.ix.funcs[p.id]
  const ds = descriptions(p.ix, p.id, order).filter((d) => d.kind !== 'facts')
  const twins = Object.entries(p.ix.funcs).filter(([id, g]) => id !== p.id && g.name === fn.name)
  const uncompiled = p.ix.g.uncompiled?.[p.id] ?? []
  const found = worthAt(p.ix.g, (x) => x.fid === p.id)
  const notes = [
    ...found.map(([label, n]) => t('{v1}：{v2} 處', { v1: t(label), v2: n })),
    ...(fn.ai?.state === 'stale' ? [t('AI 說明寫好之後程式碼改過了，可能不準。')] : []),
    ...(fn.entry?.framework ? [t('由 {v1} 呼叫', { v1: fn.entry.framework })] : []),
    ...(fn.api ? [t('與 {v1} 程式庫的函式同名，以 LD_PRELOAD 載入後會優先執行此版本。', { v1: fn.api })] : []),
    ...(twins.length ? [t('同名的還有 {v1}', { v1: twins.slice(0, 3).map(([, g]) => `${g.file}:${g.line}`).join(t('、')) })] : []),
    ...(uncompiled.length ? [t('另有 {v1} 處呼叫在條件編譯中，本次 build 未編入，因此未計入。', { v1: uncompiled.length })] : []),
    ...(fn.types_incomplete ? [t('此檔案的型別檢查不完整，可能漏掉部分呼叫。')] : []),
  ]
  return <>
    <span className="mono info-here">{fn.name.split('.').pop()!}</span>
    {ds.length ? ds.map((d, i) => <span key={i} className="info-here-desc"><DescText d={d} tag full /></span>) : <span className="small muted">{t('沒有說明')}</span>}
    {notes.length ? <ul className="level-notes info-here-notes">{notes.map((x) => <li key={x}>{x}</li>)}</ul> : null}
  </>
}

/** What the checks found here, under a small heading; nothing when they found nothing. */
function Found(p: { found: [string, number][] }) {
  return p.found.length ? <section className="info-notes" aria-label={t('值得注意')}>
    <h3 className="info-h">{t('值得注意')}</h3>
    <ul className="level-notes">{p.found.map(([label, n]) => <li key={label}>{t('{v1}：{v2} 處', { v1: t(label), v2: n })}</li>)}</ul>
    <a className="link small" href="#check">{t('到檢查看細節')}</a>
  </section> : null
}
