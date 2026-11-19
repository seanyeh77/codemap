import { useMemo } from 'react'
import { UI } from '../ui'
import { t } from '../i18n'
import type { Index } from '../data/graph'
import { roleOf } from '../data/files'
import { aiItem, descriptions, useDescOrder } from '../data/describe'
import { useFileSource } from '../data/hooks'
import { DescText } from '../components/DescText'
import { Notes, Parts, Q, signature, worthAt } from './Reader'
import { EditorButton } from './CodeAt'
import { TRACED } from './Arch'
import { entryPath } from './Detail'

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
export function Info(p: { ix: Index; at: At; fn: string | null; isLive: boolean; sourceId: string
  /** opens a function; chain: the calls from an entry point down to it, opened in the call tree */
  openFn: (id: string) => void; chain: (ids: string[]) => void }) {
  const { ix, at } = p
  const order = useDescOrder()
  const g = ix.g
  if (at.kind === 'proj' || at.kind === 'settings') {
    const project = aiItem(ix, 'project', order)
    const found = worthAt(g, (x) => !!ix.funcs[x.fid] && ix.funcs[x.fid].scope !== 'test')
    return <div className="info">
      <h2 className="info-title">{g.repo}</h2>
      <p className="small muted">{t('專案')} · {t('{v1} 個元件、{v2} 個函式', { v1: g.comps.length, v2: Object.keys(ix.funcs).length })}</p>
      <Parts>
        <Q title={t('是什麼')}>{project ? <p><DescText d={project} tag full /></p> : <p className="muted">{t('沒有說明。在 repo 執行 codemap describe 可請 AI 撰寫。')}</p>}</Q>
        <Q title={t('值得注意')}>
          {found.length ? <ul className="level-notes">{found.map(([label, n]) => <li key={label}>{t('{v1}：{v2} 處', { v1: t(label), v2: n })}</li>)}</ul> : <p className="small muted">{t('沒有發現。')}</p>}
          {found.length ? <a className="link small" href="#check">{t('到檢查看細節')}</a> : null}
        </Q>
      </Parts>
    </div>
  }
  if (at.kind === 'comp') {
    const c = g.comps.find((x) => x.id === at.id)
    const ai = aiItem(ix, 'comp:' + at.id, order)
    const found = worthAt(g, (x) => ix.funcs[x.fid]?.comp === at.id)
    return <div className="info">
      <h2 className="info-title mono">{at.id === TRACED ? t('被追蹤的程式（repo 外）') : at.id}</h2>
      <p className="small muted">{t('元件')}{c ? ' · ' + t('{v1} 個檔案、{v2} 個函式', { v1: c.files, v2: c.funcs }) : ''}</p>
      <Parts>
        <Q title={t('是什麼')}>
          {ai ? <p><DescText d={ai} tag full /></p> : null}
          {c?.doc ? <p className="small">{c.doc.text}</p> : null}
          {!ai && !c?.doc ? <p className="small muted">{t('沒有說明註解。')}</p> : null}
        </Q>
        <Q title={t('值得注意')}>
          {found.length ? <><ul className="level-notes">{found.map(([label, n]) => <li key={label}>{t('{v1}：{v2} 處', { v1: t(label), v2: n })}</li>)}</ul>
            <a className="link small" href="#check">{t('到檢查看細節')}</a></> : <p className="small muted">{t('沒有發現。')}</p>}
        </Q>
      </Parts>
    </div>
  }
  return p.fn ? <FnInfo ix={ix} isLive={p.isLive} sourceId={p.sourceId} openFn={p.openFn} chain={p.chain} f={at.f} l={at.l} id={p.fn} /> : <FileInfo ix={ix} f={at.f} l={at.l} />
}

function FileInfo(p: { ix: Index; f: string; l: number }) {
  const order = useDescOrder()
  const ai = aiItem(p.ix, 'file:' + p.f, order)
  const doc = p.ix.g.files?.[p.f]
  const role = roleOf(p.ix.g, p.f)
  const byRules = Object.keys(p.ix.g.roles ?? {}).some((x) => p.f === x || p.f.startsWith(x.replace(/\/$/, '') + '/'))
  const n = (p.ix.byFile().get(p.f) ?? []).length
  return <div className="info">
    <div className="info-head"><h2 className="info-title mono">{p.f.split('/').pop()}</h2><EditorButton ix={p.ix} file={p.f} line={p.l} /></div>
    <p className="small muted">{t('檔案')} · {p.f}{n ? ' · ' + t('{v1} 個函式', { v1: n }) : ''}</p>
    <Parts>
      <Q title={t('是什麼')}>
        {ai ? <p><DescText d={ai} tag full /></p> : null}
        {doc ? <p className="small">{doc.text.split('\n\n')[0]}</p> : null}
        {!ai && !doc ? <p className="small muted">{t('沒有說明註解。')}</p> : null}
      </Q>
      <Notes ix={p.ix} f={p.f} why={role ? (byRules ? t('可修改／受保護的依據：.codemap/rules.json 的 roles') : t('可修改／受保護的依據：檔案開頭註解的第一個詞')) : undefined} />
    </Parts>
  </div>
}

function FnInfo(p: { ix: Index; f: string; l: number; id: string; isLive: boolean; sourceId: string; openFn: (id: string) => void; chain: (ids: string[]) => void }) {
  const order = useDescOrder()
  const fn = p.ix.funcs[p.id]
  const src = useFileSource(p.f, p.isLive, p.sourceId)
  const ds = useMemo(() => descriptions(p.ix, p.id, order).filter((d) => d.kind !== 'facts'), [p.ix, p.id, order])
  // how the program gets here: the shortest chain of calls from a function nothing in the repo calls
  const path = useMemo(() => entryPath(p.ix, p.id), [p.ix, p.id])
  const twins = Object.entries(p.ix.funcs).filter(([id, g]) => id !== p.id && g.name === fn.name)
  const uncompiled = p.ix.g.uncompiled?.[p.id] ?? []
  const name = (id: string) => <UI.InlineCode key={id} look="name" href={'#'} onClick={(e) => { e.preventDefault(); p.openFn(id) }}>{p.ix.funcs[id]?.name ?? id}</UI.InlineCode>
  const sig = signature(src.data?.lines ?? (fn.src ? [...Array<string>((fn.top ?? fn.line) - 1).fill(''), ...fn.src] : undefined), fn.line)
  return <div className="info">
    <div className="info-head"><h2 className="info-title mono" id="detail-title" tabIndex={-1}>{fn.name}</h2><EditorButton ix={p.ix} file={p.f} line={p.l} /></div>
    <p className="small muted">{t('函式')} · <UI.InlineCode>{`${p.f}:${fn.line}`}</UI.InlineCode></p>
    <Parts>
      <Q title={t('是什麼')}>
        {ds.map((d, i) => <p key={i} className="reader-desc"><DescText d={d} tag full /></p>)}
        {!ds.length && sig ? <pre className="reader-sig mono">{sig}</pre> : null}
        {!ds.length ? <p className="small muted">{t('還沒有說明。在 repo 執行 codemap describe 可請 AI 撰寫。')}</p> : null}
        {fn.entry?.framework ? <p className="small muted">{t('由 {v1} 呼叫', { v1: fn.entry.framework })}</p> : null}
        {fn.api ? <p className="small">{t('與 {v1} 程式庫的函式同名，以 LD_PRELOAD 載入後會優先執行此版本。', { v1: fn.api })}</p> : null}
        {path && path.length > 1 ? <div className="info-path">
          <p className="small muted">{t('從進入點到這裡')}</p>
          <ol className="info-chain">{path.map((c) => <li key={c.id}>{name(c.id)}</li>)}</ol>
          <button type="button" className="linklike small" onClick={() => p.chain(path.map((c) => c.id))}>{t('在 callee 分頁展開這條路徑')}</button>
        </div> : null}
      </Q>
      <Notes ix={p.ix} f={p.f} id={p.id} extra={[
        ...(twins.length ? [t('同名的還有 {v1}', { v1: twins.slice(0, 3).map(([, g]) => `${g.file}:${g.line}`).join(t('、')) })] : []),
        ...(uncompiled.length ? [t('另有 {v1} 處呼叫在條件編譯中，本次 build 未編入，因此未計入。', { v1: uncompiled.length })] : []),
        ...(fn.types_incomplete ? [t('此檔案的型別檢查不完整，可能漏掉部分呼叫。')] : []),
      ]} />
    </Parts>
  </div>
}
