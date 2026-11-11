// Interface text: Traditional Chinese is the source, as the design system has it. Every string goes
// through t(); English comes from en.ts, added to the design system's own English (UI.addMessages).
import { UI } from './ui'
import { EN } from './en'

UI.addMessages('en', EN)

export type Lang = 'zh-TW' | 'en'

let current: Lang = 'zh-TW'

/** English nouns after the number 1 go singular: the dictionary is written for many. */
const ONE = /\b1 (more )?(functions|callers|callees|calls|files|places|components|times|products|levels|lines|variables|headers|source files|references|source files|translation units)\b/g
const single = (w: string) => (w === 'places' ? 'place' : w.replace(/s$/, ''))

/** The text in the current language; {name} placeholders take vars. */
export const t = (zh: string, vars?: Record<string, string | number | null | undefined>) => {
  // numbers in the interface's language, not the browser's: 1,033 in English even on a German browser
  const s = UI.t(zh, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'number' ? (lineLike(zh, k) ? String(v) : num(v)) : v ?? ''])))
  return current === 'en' ? s.replace(ONE, (_, more = '', w) => `1 ${more}${single(w)}`).replace(/\b1 function (call|use|interpose)\b/g, '1 function $1s')
    .replace(VERB, (_, subject: string, verb: string) => `${subject} ${AGREE[verb]}`) : s
}

/** The verb after a singular count agrees with it: 「1 more variable is」, not 「1 more variable are」. */
const VERB = /\b(1 (?:more )?(?:function|caller|callee|call|file|place|component|time|product|level|line|variable|header|source file|reference|translation unit)) (are|appear|were|have)\b/g
const AGREE: Record<string, string> = { are: 'is', appear: 'appears', were: 'was', have: 'has' }

/** A line number (file:{l}, 第 {l} 行, line {l}) is never grouped: ring.c:1024, not ring.c:1,024. */
const lineLike = (zh: string, k: string) => new RegExp(`(:|第 ?|行 ?)\\{${k}\\}|\\{${k}\\} ?行`).test(zh)

/** A unit after a count, for UI.Tabs and DataTable summaries: 「項」 in Chinese, item or items in English. */
export const countUnit = (zh: string, one: string, many: string) => (n: number) => (current === 'en' ? (n === 1 ? one : many) : zh)

/** A date and time as the interface's language writes it. Chinese: 2026/11/09（一） 14:06, the design system's
 *  format; English: Mon 2026-11-09 14:06, which no reader takes for 9 November or 11 September by mistake. */
export function dateTime(d: Date): string {
  if (current !== 'en') return UI.format.dateTime(d, { weekday: true })
  const p = (n: number) => String(n).padStart(2, '0')
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  return `${day} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A count as the interface's language writes it. */
export const num = (n: number) => new Intl.NumberFormat(current === 'en' ? 'en-US' : 'zh-TW').format(n)

/** A noun after a count: 「caller」 in Chinese, "caller" or "callers" in English. */
export const noun = (n: number, word: string) => (current === 'en' && n !== 1 ? word + 's' : word)

/** Items joined the way the current language lists them: 「a、b」 or "a, b". */
export const list = (items: readonly string[]) => items.join(t('、'))

/** Text a project wrote in its config, as one string or one per language ({"zh-TW": "啟動", "en": "start-up"}):
 *  the interface's language, else English, else the first one written. */
export const local = (v: string | Record<string, string>) =>
  typeof v === 'string' ? v : v[current] ?? (current === 'zh-TW' ? v.zh ?? v['zh-Hant'] : undefined) ?? v.en ?? Object.values(v)[0] ?? ''

export function setLang(lang: Lang) {
  current = lang
  UI.setLocale(lang === 'en' ? 'en' : 'zh-TW')
}
