// Interface text: Traditional Chinese is the source, as the design system has it. Every string goes
// through t(); English comes from en.ts, added to the design system's own English (UI.addMessages).
import { UI } from './ui'
import { EN } from './en'

UI.addMessages('en', EN)

export type Lang = 'zh-TW' | 'en'

let current: Lang = 'zh-TW'

/** English nouns after the number 1 go singular: the dictionary is written for many. */
const ONE = /\b1 (more )?(functions|callers|callees|calls|files|places|components|times|products|levels|lines|variables|references|source files|translation units)\b/g
const single = (w: string) => (w === 'places' ? 'place' : w.replace(/s$/, ''))

/** The text in the current language; {name} placeholders take vars. */
export const t = (zh: string, vars?: Record<string, string | number | null | undefined>) => {
  const s = UI.t(zh, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v ?? ''])))
  return current === 'en' ? s.replace(ONE, (_, more = '', w) => `1 ${more}${single(w)}`).replace(/\b1 function (call|use|interpose)\b/g, '1 function $1s') : s
}

/** A noun after a count: 「caller」 in Chinese, "caller" or "callers" in English. */
export const noun = (n: number, word: string) => (current === 'en' && n !== 1 ? word + 's' : word)

/** Items joined the way the current language lists them: 「a、b」 or "a, b". */
export const list = (items: readonly string[]) => items.join(t('、'))

export function setLang(lang: Lang) {
  current = lang
  UI.setLocale(lang === 'en' ? 'en' : 'zh-TW')
}
