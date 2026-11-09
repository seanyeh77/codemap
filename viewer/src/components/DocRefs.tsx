import { createContext, useContext } from 'react'
import { UI } from '../ui'
import { t } from '../i18n'
import type { Index } from '../data/graph'

/** Opens a file at a line in the side panel; App provides it. */
export const OpenFile = createContext<(f: string, l: number) => void>(() => {})

const DOC = /(?:[\w.-]+\/)*[\w.-]+\.(?:md|rst)\b/g

/** The documents the shown code names in its comments (docs/design/ring-overrun.md), as links that open
 *  them: design notes are often where the reason for the code is written down. */
export function DocRefs(p: { ix: Index; lines: string[] | undefined }) {
  const open = useContext(OpenFile)
  const readable = p.ix.g.readable ?? []
  const found = new Map<string, string>()
  for (const ln of p.lines ?? []) {
    for (const m of ln.matchAll(DOC)) {
      const ref = m[0].replace(/^\.\//, '')
      const hit = readable.find((f) => f === ref || f.endsWith('/' + ref))
      if (hit) found.set(hit, ref)
    }
  }
  if (!found.size) return null
  return (
    <p className="small doc-refs">
      {t('這段程式碼提到的文件：')}
      {[...found.keys()].map((f, i) => (
        <span key={f}>{i ? t('、') : ''}<UI.InlineCode href={'#' + f} onClick={(e) => { e.preventDefault(); open(f, 1) }}>{f}</UI.InlineCode></span>
      ))}
    </p>
  )
}
