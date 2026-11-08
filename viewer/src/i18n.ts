// Interface text: Traditional Chinese is the source, as the design system has it. Every string goes
// through t(); English comes from en.ts, added to the design system's own English (UI.addMessages).
import { UI } from './ui'
import { EN } from './en'

UI.addMessages('en', EN)

export type Lang = 'zh-TW' | 'en'

/** The text in the current language; {name} placeholders take vars. */
export const t = (zh: string, vars?: Record<string, string | number | null | undefined>) =>
  UI.t(zh, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v ?? ''])))

/** Items joined the way the current language lists them: 「a、b」 or "a, b". */
export const list = (items: readonly string[]) => items.join(t('、'))

export function setLang(lang: Lang) {
  UI.setLocale(lang === 'en' ? 'en' : 'zh-TW')
}
