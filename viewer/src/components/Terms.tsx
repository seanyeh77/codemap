// The project's own words (term:WORD descriptions an AI wrote with codemap describe), explained where they appear
import { createContext, useContext, type ReactNode } from 'react'
import * as UI from '@seanyeh77/ui'
import type { Index } from '../data/graph'
import { aiItem, type DescOrder } from '../data/describe'
import { t } from '../i18n'

export interface Term { term: string; text: string; at?: { f: string; l: number } }

/** The terms with a description that still holds, longest first (so 「network namespace」 wins over 「namespace」). */
export function termsOf(ix: Index, order: DescOrder): Term[] {
  const out: Term[] = []
  for (const [k, d] of Object.entries(ix.g.described ?? {})) {
    if (!k.startsWith('term:') || d.state === 'wrong' || !d.term) continue
    const desc = aiItem(ix, k, order)
    if (!desc) continue
    const r = d.evidence?.[0]
    out.push({ term: d.term, text: desc.text, at: r ? { f: r.slice(0, r.lastIndexOf(':')), l: Number(r.slice(r.lastIndexOf(':') + 1)) } : undefined })
  }
  return out.sort((a, b) => b.term.length - a.term.length)
}

/** The same terms as the design system takes them (CodeView and Markdown `terms`): the card's action opens where the
 *  term is used. */
export function termDefs(terms: Term[], open: (f: string, l: number) => void): UI.TermDef[] {
  return terms.map((x) => ({ term: x.term, text: x.text, ...(x.at ? { action: { label: t('看它出現的地方'), onClick: () => open(x.at!.f, x.at!.l) } } : {}) }))
}

export const TermsCtx = createContext<{ terms: Term[]; defs: UI.TermDef[]; open: (f: string, l: number) => void }>({ terms: [], defs: [], open: () => {} })

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Text with each term's first appearance explained in place: the word underlined, and on resting on it the AI's
 *  description with a link to where the term is used. `seen` keeps one explanation per block of text. */
export function TermText(p: { text: string; seen: Set<string> }) {
  const { terms, open } = useContext(TermsCtx)
  if (!terms.length) return <>{p.text}</>
  // a word of letters needs a boundary (cookie, not cookies' middle); CJK words match as they are
  const re = new RegExp(terms.map((x) => (/^\w/.test(x.term) ? '\\b' : '') + esc(x.term) + (/\w$/.test(x.term) ? '\\b' : '')).join('|'), 'g')
  const out: ReactNode[] = []
  let last = 0
  for (const m of p.text.matchAll(re)) {
    const term = terms.find((x) => x.term === m[0])
    if (!term || p.seen.has(term.term)) continue
    p.seen.add(term.term)
    out.push(p.text.slice(last, m.index), <UI.Term key={m.index} variant="inline" title={term.term} text={term.text}
      action={term.at ? { label: t('看它出現的地方'), onClick: () => open(term.at!.f, term.at!.l) } : undefined}>{m[0]}</UI.Term>)
    last = m.index! + m[0].length
  }
  out.push(p.text.slice(last))
  return <>{out}</>
}
