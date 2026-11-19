import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { TermText, TermsCtx } from './Terms'

describe('TermText', () => {
  it('explains each term once, at its first whole-word appearance', () => {
    const terms = [{ term: 'cookie', text: 'A 64-bit tag on a flow.' }, { term: 'FRR', text: 'A routing suite.' }]
    const html = renderToString(<TermsCtx.Provider value={{ terms, open: () => {} }}>
      <TermText text="The cookies hold a cookie; FRR sets the cookie." seen={new Set()} />
    </TermsCtx.Provider>)
    // "cookies" is not the word; the first "cookie" and "FRR" are explained, the second "cookie" is not
    expect(html.match(/ui-term/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('The cookies hold a ')
    expect(html.indexOf('sets the cookie.')).toBeGreaterThan(-1)
  })
})
