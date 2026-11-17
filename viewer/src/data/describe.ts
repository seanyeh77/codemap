// What a function does, in three kinds the reader can rank (Settings):
//   ai      C: written by an AI with `codemap describe`, checked by `codemap check` (not there yet: Func.ai)
//   author  A: the docstring, or the comment right above the definition
//   facts   B: what codemap knows it touches: the command that runs it, the commands it runs, the files it reads
//           and writes, who calls it. Always there, and always true, but says what it touches, not why.
import { useSyncExternalStore } from 'react'
import { commandsOf } from './cli'
import type { Graph } from './types'
import type { Index } from './graph'
import { lang, t } from '../i18n'

export type DescKind = 'ai' | 'author' | 'facts'
export type DescOrder = 'ai-author-facts' | 'author-ai-facts' | 'author-facts' | 'facts'

export const ORDERS: { id: DescOrder; kinds: DescKind[] }[] = [
  { id: 'ai-author-facts', kinds: ['ai', 'author', 'facts'] },
  { id: 'author-ai-facts', kinds: ['author', 'ai', 'facts'] },
  { id: 'author-facts', kinds: ['author', 'facts'] },
  { id: 'facts', kinds: ['facts'] },
]

const KEY = 'codemap:desc-order'
const listeners = new Set<() => void>()

function read(): DescOrder {
  try {
    const v = localStorage.getItem(KEY)
    if (ORDERS.some((o) => o.id === v)) return v as DescOrder
  } catch { /* storage refused: the default */ }
  return 'ai-author-facts'
}

export function setDescOrder(v: DescOrder) {
  try { localStorage.setItem(KEY, v) } catch { /* kept for this page only */ }
  current = v
  listeners.forEach((f) => f())
}

let current: DescOrder | null = null
export function useDescOrder(): DescOrder {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f) }, () => (current ??= read()))
}

/** An AI description in the reader's language, or in the other one, marked; with its state. */
export function aiText(ai: { text?: Record<string, string>; state?: 'ok' | 'stale' | 'wrong' } | undefined): { text: string; lang?: string; state?: 'ok' | 'stale' | 'wrong' } | null {
  const text = ai?.text
  if (!text) return null
  const want = lang()
  if (text[want]) return { text: text[want], state: ai?.state }
  const other = Object.keys(text).find((k) => text[k])
  return other ? { text: text[other], lang: other, state: ai?.state } : null
}

/** B: the facts about one function, most telling first. Each is short; callers use the first few. */
export function facts(ix: Index, id: string): string[] {
  const g: Graph = ix.g
  const f = ix.funcs[id]
  if (!f) return []
  const out: string[] = []
  const cmds = commandsOf(g, id)
  const prog = (s: string) => s.split(' ').pop()!.split('/').pop()!
  const reads = (g.cli ?? []).filter((x) => x.dispatch === id || x.main === id)
  for (const x of reads) out.push(x.cmds.length ? t('讀取 {v1} 的命令列，分派 {v2} 個指令', { v1: prog(x.prog), v2: x.cmds.length }) : t('讀取 {v1} 的命令列', { v1: prog(x.prog) }))
  if (cmds.length) out.push(t('由命令列 {v1} 執行', { v1: cmds.map(({ p, c }) => `${prog(p.prog)} ${c.name}`).join(t('、')) }))
  if (f.entry) out.push(t('由 {v1} 呼叫（{v2}）', { v1: f.entry.framework, v2: f.entry.kind }))
  if (f.api) out.push(t('取代外部函式 {v1}', { v1: f.api }))
  const spawned = (g.spawns ?? []).filter((s) => s.target === id)
  if (spawned.length) out.push(t('在背景執行，由 {v1} 啟動', { v1: [...new Set(spawned.map((s) => ix.funcs[s.fid]?.name ?? s.fid))].join(t('、')) }))
  const run = [...new Set((g.commands ?? []).filter((c) => c.fid === id).map((c) => c.cmd.split(/\s+/).slice(0, 3).join(' ')))]
  if (run.length) out.push(t('執行外部指令 {v1}', { v1: run.slice(0, 2).join(t('、')) + (run.length > 2 ? t(' 等 {v1} 個', { v1: run.length }) : '') }))
  const names = (xs?: { fid: string; name?: string; runtime?: boolean }[]) =>
    [...new Set((xs ?? []).filter((x) => x.fid === id).map((x) => x.name ?? (x.runtime ? t('執行時才知道的檔案') : '')).filter(Boolean))]
  const w = names(g.writes), r = names(g.reads)
  if (w.length) out.push(t('寫入 {v1}', { v1: w.slice(0, 2).join(t('、')) + (w.length > 2 ? t(' 等 {v1} 個', { v1: w.length }) : '') }))
  if (r.length) out.push(t('讀取 {v1}', { v1: r.slice(0, 2).join(t('、')) + (r.length > 2 ? t(' 等 {v1} 個', { v1: r.length }) : '') }))
  const callers = new Set(g.edges.filter((e) => e.d === id && e.s !== id && ix.funcs[e.s]).map((e) => e.s)).size
  const callees = new Set(g.edges.filter((e) => e.s === id && e.d !== id && ix.funcs[e.d]).map((e) => e.d)).size
  out.push(callers ? t('被 {v1} 個函式呼叫', { v1: callers }) : t('repo 內沒有呼叫者'))
  if (callees) out.push(t('呼叫 {v1} 個 repo 內的函式', { v1: callees }))
  return out
}

export interface Desc { kind: DescKind; text: string; lang?: string; state?: 'ok' | 'stale' | 'wrong' }

/** Every description of a function, in the reader's order (for the panel). */
export function descriptions(ix: Index, id: string, order: DescOrder): Desc[] {
  const f = ix.funcs[id]
  if (!f) return []
  const out: Desc[] = []
  const late: Desc[] = []
  for (const k of ORDERS.find((o) => o.id === order)!.kinds) {
    // an AI's description the code no longer matches (stale) or contradicts (wrong) goes after the facts
    if (k === 'ai') { const a = aiText(f.ai); if (a) (a.state === 'stale' || a.state === 'wrong' ? late : out).push({ kind: 'ai', ...a }) }
    if (k === 'author' && f.doc) out.push({ kind: 'author', text: f.doc })
    if (k === 'facts') { const b = facts(ix, id); if (b.length) out.push({ kind: 'facts', text: b.join(t('；')) }) }
  }
  return [...out, ...late]
}

/** The one line where only one fits (the file's list, a link's card, the flow tree, search): the first kind
 *  there is, in the reader's order; facts are cut to the first three. */
export function oneLine(ix: Index, id: string, order: DescOrder): Desc | null {
  for (const d of descriptions(ix, id, order)) {
    if (d.state === 'wrong') continue                   // never the one line: it cites what the code does not have
    if (d.kind !== 'facts') return d
    return { ...d, text: facts(ix, id).slice(0, 3).join(t('；')) }
  }
  return null
}

export const KIND_LABEL: Record<DescKind, string> = { ai: 'AI', author: '註解', facts: '事實' }

/** Text with `names` in code font, as React parts. */
export function codeSpans(text: string): (string | { code: string })[] {
  return text.split(/`([^`]+)`/).map((x, i) => (i % 2 ? { code: x } : x)).filter((x) => x !== '')
}

/** Text without the backticks, for a place that shows plain text only (a list's second line). */
export const plain = (text: string) => text.replace(/`([^`]+)`/g, '$1')

/** Whether the reader's order uses AI descriptions, and whether before the author's. */
export const usesAi = (order: DescOrder) => ORDERS.find((o) => o.id === order)!.kinds.includes('ai')
export const aiFirst = (order: DescOrder) => ORDERS.find((o) => o.id === order)!.kinds[0] === 'ai'

/** An item's AI description (a file, a component, a command, the project...), when the order uses them and it does
 *  not contradict the code. */
export function aiItem(ix: Index, key: string, order: DescOrder): Desc | null {
  if (!usesAi(order)) return null
  const a = aiText(ix.g.described?.[key])
  return a && a.state !== 'wrong' ? { kind: 'ai', ...a } : null
}

/** A route step's text in the reader's language. */
export const stepText = (s: Record<string, string>) => s[lang()] || s['zh-TW'] || s.en || ''
