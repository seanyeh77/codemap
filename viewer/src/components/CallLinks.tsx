// The calls in shown code as links: runtime.deploy in `emit(runtime.deploy(args.plane))` opens that function
import { createContext, useContext, useMemo } from 'react'
import * as UI from '@seanyeh77/ui'
import type { Index } from '../data/graph'
import { t } from '../i18n'

/** Opens a function's flow page; App provides it. */
export const OpenFunc = createContext<(id: string) => void>(() => {})

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
    if (e.f !== file || e.l < start || e.l > end || !ix.funcs[e.d]) continue
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
      const n = calledName(ix.funcs[id].name)
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
      l.label = l.ids.length > 1
        ? t('{v1}：{v2} 個可能的目標', { v1: l.text, v2: l.ids.length })
        : t('{v1}，定義在 {v2}', { v1: f.name, v2: `${f.file}:${f.line}` })
      out.push(l)
    }
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col)
}

/** The props that make the calls in a CodeView links: open the function, and a card with where it is defined. */
export function useCallLinks(ix: Index, file: string | undefined, start: number, lines: string[] | undefined) {
  const open = useContext(OpenFunc)
  const links = useMemo(() => (file && lines ? callLinks(ix, file, start, lines) : []), [ix, file, start, lines])
  if (!links.length) return {}
  return {
    links,
    onLink: (l: { line: number; text: string; col?: number; href?: string }) => {
      const hit = links.find((x) => x.line === l.line && x.col === l.col) ?? links.find((x) => x.line === l.line && x.text === l.text)
      if (hit) open(hit.ids[0])
    },
    preview: (l: { line: number; text: string; col?: number }) => {
      const hit = links.find((x) => x.line === l.line && x.col === l.col)
      if (!hit) return null
      return (
        <div className="call-preview">
          {hit.ids.map((id) => {
            const f = ix.funcs[id]
            return (
              <div key={id}>
                <UI.InlineCode href={'#' + id} onClick={(e) => { e.preventDefault(); open(id) }}>{f.name}</UI.InlineCode>
                <div className="small muted">{t('定義在 {v1}', { v1: `${f.file}:${f.line}` })}{f.comp ? ` · ${f.comp}` : ''}</div>
              </div>
            )
          })}
        </div>
      )
    },
  }
}
