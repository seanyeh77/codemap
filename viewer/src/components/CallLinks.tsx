// The calls in shown code as links: runtime.deploy in `emit(runtime.deploy(args.plane))` opens that function
import { createContext, useContext, useMemo } from 'react'
import * as UI from '@seanyeh77/ui'
import type { Index } from '../data/graph'
import { local, t } from '../i18n'
import { oneLine, useDescOrder } from '../data/describe'
import { DescText } from './DescText'

/** Opens a function's flow page; App provides it. */
export const OpenFunc = createContext<(id: string) => void>(() => {})
/** Opens a function from a call in the code: App extends the browsing path with it, like a pick in callee. */
export const OpenCall = createContext<((id: string) => void) | null>(null)

type CallLink = { line: number; col: number; text: string; href: string; label: string; ids: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The name a call is written with: deploy for runtime.deploy, VirtualRouter for a constructor (VirtualRouter.__init__). */
function calledName(name: string): string {
  const parts = name.split('.')
  const last = parts[parts.length - 1]
  return (last === '__init__' || last === 'constructor') && parts.length > 1 ? parts[parts.length - 2] : last
}

/** Links for the calls on the shown lines: each found in its line as `qualifier.name(`, so the link covers the whole
 *  dotted name the code writes and carries its column (two calls of one name on a line stay apart). */
export function callLinks(ix: Index, file: string, start: number, lines: string[]): CallLink[] {
  const end = start + lines.length - 1
  const byLine = new Map<number, string[]>()
  for (const e of ix.g.edges) {
    // a function of the repository, or one outside it an AI described (ext:accept)
    if (e.f !== file || e.l < start || e.l > end || !(ix.funcs[e.d] || (e.d.startsWith('ext:') && ix.g.described?.[e.d]))) continue
    const ids = byLine.get(e.l) ?? []
    if (!ids.includes(e.d)) ids.push(e.d)
    byLine.set(e.l, ids)
  }
  const out: CallLink[] = []
  for (const [line, ids] of byLine) {
    const text = lines[line - start] ?? ''
    // targets that share one written call (one of several candidates) become one link
    const at = new Map<number, CallLink>()
    for (const id of ids) {
      const n = calledName(ix.funcs[id]?.name ?? id.slice(4))
      if (!/^[A-Za-z_$][\w$]*$/.test(n)) continue
      const re = new RegExp(`(?<![\\w$.])((?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*${esc(n)})(?![\\w$])(?=\\s*\\()`, 'g')
      for (const m of text.matchAll(re)) {
        const col = (m.index ?? 0) + 1
        const hit = at.get(col)
        if (hit) { if (!hit.ids.includes(id)) hit.ids.push(id); continue }
        at.set(col, { line, col, text: m[1], href: '#' + id, label: '', ids: [id] })
      }
    }
    for (const l of at.values()) {
      const f = ix.funcs[l.ids[0]]
      l.label = !f ? t('{v1}，位於 repo 外', { v1: l.ids[0].slice(4) }) : l.ids.length > 1
        ? t('{v1}：{v2} 個可能的目標', { v1: l.text, v2: l.ids.length })
        : t('{v1}，定義在 {v2}', { v1: f.name, v2: `${f.file}:${f.line}` })
      out.push(l)
    }
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col)
}

/** The props that make the calls in a CodeView links: open the function, and a card with where it is defined. */
export function useCallLinks(ix: Index, file: string | undefined, start: number, lines: string[] | undefined) {
  const openFn = useContext(OpenFunc)
  const open = useContext(OpenCall) ?? openFn
  const order = useDescOrder()
  const links = useMemo(() => (file && lines ? callLinks(ix, file, start, lines) : []), [ix, file, start, lines])
  if (!links.length) return {}
  return {
    links,
    onLink: (l: { line: number; text: string; col?: number; href?: string }) => {
      const hit = links.find((x) => x.line === l.line && x.col === l.col) ?? links.find((x) => x.line === l.line && x.text === l.text)
      if (hit && ix.funcs[hit.ids[0]]) open(hit.ids[0])
    },
    preview: (l: { line: number; text: string; col?: number }) => {
      const hit = links.find((x) => x.line === l.line && x.col === l.col)
      if (!hit) return null
      return (
        <div className="call-preview">
          {hit.ids.map((id) => {
            if (!ix.funcs[id]) return <ExtPreview key={id} ix={ix} id={id} />
            const f = ix.funcs[id]
            return (
              <div key={id}>
                <UI.InlineCode look="name" href={'#' + id} onClick={(e) => { e.preventDefault(); open(id) }}>{f.name}</UI.InlineCode>
                {((d) => d ? <div className="small"><DescText d={d} tag /></div> : null)(oneLine(ix, id, order))}
                <div className="small muted">{t('定義在 {v1}', { v1: `${f.file}:${f.line}` })}{f.comp ? ` · ${f.comp}` : ''}</div>
              </div>
            )
          })}
        </div>
      )
    },
  }
}


/** A function outside the repository, as an AI described it: what it does, and each parameter's role. */
function ExtPreview(p: { ix: Index; id: string }) {
  const d = p.ix.g.described?.[p.id]
  if (!d) return null
  const say = (x: { 'zh-TW'?: string; en?: string }) => local({ 'zh-TW': x['zh-TW'] ?? '', en: x.en ?? '' })
  const ps = d.info?.params ?? []
  return <div>
    <span className="mono">{p.id.slice(4)}</span> <span className="small muted">{t('repo 外的函式')}</span>
    <div className="small">{say(d.text)}<UI.AiMark text={t('AI 撰寫')} /></div>
    {ps.length ? <dl className="fp-prm-d small">{ps.map((x) => <div key={x.name} style={{ display: 'contents' }}>
      <dt className="mono">{x.name}</dt><dd>{x.role}{x.type ? <span className="muted"> · {x.type}</span> : null}{say(x) ? ' · ' + say(x) : ''}</dd></div>)}</dl> : null}
    {(d.info?.returns ?? []).map((x, i) => <div key={i} className="small">{t('回傳：')}{say(x)}</div>)}
  </div>
}
