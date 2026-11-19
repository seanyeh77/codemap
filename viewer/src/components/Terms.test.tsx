import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import * as UI from '@seanyeh77/ui'
import { TermText, TermsCtx, termDefs } from './Terms'

describe('TermText', () => {
  it('explains each term once, at its first whole-word appearance', () => {
    const terms = [{ term: 'cookie', text: 'A 64-bit tag on a flow.' }, { term: 'FRR', text: 'A routing suite.' }]
    const html = renderToString(<TermsCtx.Provider value={{ terms, defs: [], open: () => {} }}>
      <TermText text="The cookies hold a cookie; FRR sets the cookie." seen={new Set()} />
    </TermsCtx.Provider>)
    // "cookies" is not the word; the first "cookie" and "FRR" are explained, the second "cookie" is not
    expect(html.match(/ui-term/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('The cookies hold a ')
    expect(html.indexOf('sets the cookie.')).toBeGreaterThan(-1)
    // marked inside the sentence, not with a question mark
    expect(html).toContain('is-word')
  })

  it('gives the same terms to Markdown and CodeView, with a way to where each is used', () => {
    let opened = ''
    const defs = termDefs([{ term: 'cookie', text: 'A tag.', at: { f: 'a.c', l: 3 } }], (f, l) => { opened = f + ':' + l })
    defs[0].action!.onClick()
    expect(opened).toBe('a.c:3')
    expect(renderToString(<UI.Markdown terms={defs}>{'A cookie here.'}</UI.Markdown>)).toContain('is-word')
    expect(renderToString(<UI.CodeView code={'int a; // the cookie\n'} language="c" terms={defs} />)).toContain('is-word')
  })
})
