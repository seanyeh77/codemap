// Architecture view layout: where boxes, bars and wires go. Pure, so it is tested without a browser.
import { push } from './graph'
import type { Comp, Link } from './types'

// Layout in CSS pixels: the SVG is drawn at the card's own width, so text keeps its real size.
/** Fonts the box text is measured in; the drawing uses the same ones. */
/** Fonts the drawing uses (the design system's Graph styles), for measuring text. */
export const NAME_FONT = '13px "Geist Mono"', META_FONT = '13px Inter', LABEL_FONT = '600 12px Inter', LABEL_CODE = '600 12px "Geist Mono"'

/** A wire label in pieces: names and numbers are code (tspan.ui-graph-code), the rest is plain text. */
export function labelParts(label: string): { text: string; code: boolean }[] {
  return label.split(/([A-Za-z0-9_./:-]+)/).filter(Boolean).map((text) => ({ text, code: /^[A-Za-z0-9_./:-]+$/.test(text) }))
}
const labelWidth = (label: string) => labelParts(label).reduce((w, p) => w + textWidth(p.text, p.code ? LABEL_CODE : LABEL_FONT), 0)
export const BOX_H = 62, BAR_H = 54, BAR_GAP = 12
const TOP = 16, LANE = 28

let ctx: CanvasRenderingContext2D | null = null
export function textWidth(text: string, font: string) {
  if (typeof document === 'undefined') return text.length * 8       // tests run without a DOM
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return text.length * 8
  ctx.font = font
  return ctx.measureText(text).width
}

interface Box { c: Comp; x: number; y: number; w: number; row: number }
interface Wire { l: Link; d: string; lx: number; ly: number; rule: boolean; label: string; anchor: 'start' | 'middle' | 'end' }
type Rect = [number, number, number, number]          // left, top, right, bottom

/** The straight pieces of an M/H/V path, as rectangles one pixel wide. */
function pieces(d: string): Rect[] {
  const out: Rect[] = []
  let x = 0, y = 0
  for (const [, c, v] of d.matchAll(/([MVH])([\d.,-]+)/g)) {
    if (c === 'M') { [x, y] = v.split(',').map(Number); continue }
    const [nx, ny] = c === 'H' ? [Number(v), y] : [x, Number(v)]
    out.push([Math.min(x, nx) - 1, Math.min(y, ny) - 1, Math.max(x, nx) + 1, Math.max(y, ny) + 1])
    ;[x, y] = [nx, ny]
  }
  return out
}
const hits = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/** A box's width: its name or its counts, whichever is longer. */
const boxWidth = (c: Comp) => Math.ceil(Math.max(textWidth(c.id, NAME_FONT), textWidth(compMeta(c), META_FONT)) + 32)

/** The line under a component's name. */
export function compMeta(c: Comp) {
  return `${c.files} 個檔案 · ${c.funcs} 個函式`
}

function spread(n: number, lo: number, hi: number) {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i + 1)) / (n + 1))
}

/** `card` is the card's width. A drawing up to a quarter wider is scaled down to fit; a layer wider than that
 *  wraps onto more rows. Only a single box wider than the card leaves the drawing wider, and it scrolls sideways.
 *  `_fontsReady` is unused, but passing it lays the drawing out again once the web font has loaded. */
export function layout(comps: Comp[], links: Link[], card: number, labelOf: (l: Link) => string, _fontsReady = true) {
  const boxComps = comps.filter((c) => !c.shared)
  const bars = comps.filter((c) => c.shared)          // the server orders them: dependencies last
  const byLayer = new Map<number, Comp[]>()
  for (const c of boxComps) push(byLayer, c.layer ?? 0, c)
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  // lay out for the room given; if detours still widen it past the card, try again with less room
  function attempt(room: number) {
    const placed = new Map<string, Box>()
    // a layer wider than the room it has wraps onto more rows, in name order
    const rows: { list: Comp[]; ws: number[] }[] = []
    for (const li of layers) {
      let row: { list: Comp[]; ws: number[] } | null = null
      for (const c of byLayer.get(li)!.sort((a, b) => a.id.localeCompare(b.id))) {
        const w = boxWidth(c)
        if (!row || row.ws.reduce((a, b) => a + b, w) + 12 * (row.list.length + 2) + 16 > room) rows.push(row = { list: [], ws: [] })
        row.list.push(c); row.ws.push(w)
      }
    }
    // links that skip a row run down a channel right of the boxes, 14 px apart
    const rowOf = new Map(rows.flatMap(({ list }, r) => list.map((c) => [c.id, r] as const)))
    const long = links.filter((l) => rowOf.has(l.a) && rowOf.has(l.b) && rowOf.get(l.b)! > rowOf.get(l.a)! + 1).length
    const sharedIds = new Set(bars.map((c) => c.id))
    const channel = long ? 20 + 14 * long : 0
    const boxW = Math.max(Math.min(card, room) - channel, ...rows.map(({ list, ws }) => ws.reduce((a, b) => a + b, 0) + 12 * (list.length + 1) + 16))
    let W = boxW + channel                              // wider still if a line to the bars must detour
    rows.forEach(({ list, ws }, r) => {
      const gap = Math.max(12, Math.min(48, (boxW - 16 - ws.reduce((a, b) => a + b, 0)) / Math.max(1, list.length + 1)))
      const total = ws.reduce((a, b) => a + b, 0) + gap * (list.length - 1)
      let x = Math.max(8, (boxW - total) / 2)
      list.forEach((c, i) => { placed.set(c.id, { c, x, y: 0, w: ws[i], row: r }); x += ws[i] + gap })
    })
    const boxes = [...placed.values()]
    const toShared = new Set(links.filter((l) => l.kind === 'call' && placed.has(l.a) && sharedIds.has(l.b)).map((l) => l.a))
    // who calls each bar and how often, most first: written on the bar instead of on the lines
    const callersOf = new Map<string, { id: string; n: number }[]>()
    for (const l of links) if (l.kind === 'call' && sharedIds.has(l.b)) push(callersOf, l.b, { id: l.a, n: l.n })
    for (const list of callersOf.values()) list.sort((p, q) => q.n - p.n || p.id.localeCompare(q.id))
    const between = links.filter((l) => placed.has(l.a) && placed.has(l.b) && placed.get(l.a)!.row < placed.get(l.b)!.row)
    // one lane per link in the gap below its source row
    const lanes = new Map<number, Link[]>()
    for (const l of between) { const r = placed.get(l.a)!.row; push(lanes, r, l) }
    // a link that skips rows enters its target's gap on its own line, above that gap's lanes
    const entries = new Map<number, number>()
    for (const l of between) { const g = placed.get(l.b)!.row - 1; if (g > placed.get(l.a)!.row) entries.set(g, (entries.get(g) ?? 0) + 1) }
    let y = TOP
    const rowY: number[] = [], gapTop: number[] = [], laneTop: number[] = []
    rows.forEach((_, r) => {
      rowY[r] = y; gapTop[r] = y + BOX_H; laneTop[r] = gapTop[r] + 24 + 4 * (entries.get(r) ?? 0)
      y = laneTop[r] + LANE * (lanes.get(r)?.length ?? 0) + 24
    })
    for (const b of boxes) b.y = rowY[b.row]
    const barTop = (rows.length ? gapTop[rows.length - 1] : TOP) + 32
    // where lines leave and enter each box
    // a line to the bars goes straight down where no box below is in the way; otherwise it leaves
    // from the box's right side and goes down the channel
    const sharedX = new Map<string, number>(), blocked = new Set<string>()
    for (const b of boxes) {
      if (!toShared.has(b.c.id)) continue
      const below = boxes.filter((o) => o.row > b.row)
      const cands = [b.x + 18, b.x + b.w - 18, b.x + b.w / 2]
      const clear = cands.find((x) => below.every((o) => x < o.x - 8 || x > o.x + o.w + 8))
      if (clear === undefined) blocked.add(b.c.id)
      sharedX.set(b.c.id, clear ?? b.x + b.w - 18)
    }
    const outX = new Map<Link, number>(), inX = new Map<Link, number>()
    for (const b of boxes) {
      const outs = between.filter((l) => l.a === b.c.id).sort((p, q) => placed.get(p.b)!.x - placed.get(q.b)!.x)
      const sx = sharedX.get(b.c.id)
      const [lo, hi] = sx === undefined ? [b.x + 16, b.x + b.w - 16] : sx < b.x + b.w / 2 ? [sx + 16, b.x + b.w - 16] : [b.x + 16, sx - 16]
      spread(outs.length, lo, hi).forEach((x, i) => outX.set(outs[i], x))
      const ins = between.filter((l) => l.b === b.c.id).sort((p, q) => placed.get(p.a)!.x - placed.get(q.a)!.x)
      spread(ins.length, b.x + 16, b.x + b.w - 16).forEach((x, i) => inX.set(ins[i], x))
    }
    const wires: Wire[] = []
    // a link that skips rows goes round the boxes it would cross, through a channel on the right
    const right = Math.max(0, ...boxes.map((b) => b.x + b.w))
    let side = 0
    const entered = new Map<number, number>()
    for (const [r, ls] of lanes) {
      ls.sort((p, q) => outX.get(p)! - outX.get(q)!).forEach((l, k) => {
        const a = placed.get(l.a)!, b = placed.get(l.b)!
        const x1 = outX.get(l)!, x2 = inX.get(l)!, ly = laneTop[r] + LANE * k + LANE / 2
        const rule = l.kind !== 'call', label = labelOf(l)
        if (b.row === a.row + 1 && Math.abs(x1 - x2) < 16 && x2 >= a.x + 16 && x2 <= a.x + a.w - 16 && Math.abs(x2 - (sharedX.get(a.c.id) ?? -99)) >= 16) {
          // ends a few pixels apart: one straight line instead of a small jog
          wires.push({ l, rule, label, lx: x2, ly: ly - 7, anchor: 'middle', d: `M${x2},${a.y + BOX_H} V${b.y}` })
        } else if (b.row === a.row + 1) {
          wires.push({ l, rule, label, lx: (x1 + x2) / 2, ly: ly - 7, anchor: 'middle', d: `M${x1},${a.y + BOX_H} V${ly} H${x2} V${b.y}` })
        } else {
          const g = b.row - 1, n = entered.get(g) ?? 0
          const sx = right + 20 + 14 * side, ay = gapTop[g] + 12 + 4 * n
          side++
          entered.set(g, n + 1)
          wires.push({ l, rule, label, lx: (x1 + sx) / 2, ly: ly - 7, anchor: 'middle', d: `M${x1},${a.y + BOX_H} V${ly} H${sx} V${ay} H${x2} V${b.y}` })
        }
      })
    }
    const drops: { from: string; d: string }[] = []
    for (const b of boxes) {
      const x = sharedX.get(b.c.id)
      if (x === undefined) continue
      if (!blocked.has(b.c.id)) { drops.push({ from: b.c.id, d: `M${x},${b.y + BOX_H} V${barTop - 2}` }); continue }
      const cx = right + 20 + 14 * side++
      drops.push({ from: b.c.id, d: `M${x},${b.y + BOX_H} V${gapTop[b.row] + 6} H${cx} V${barTop - 2}` })
      W = Math.max(W, cx + 8)
    }
    // a label goes over its lane, or beside the line leaving the box, wherever it crosses no line, box or other label
    const taken: Rect[] = [...wires.flatMap((w) => pieces(w.d)), ...drops.flatMap((x) => pieces(x.d)), ...boxes.map((b): Rect => [b.x, b.y, b.x + b.w, b.y + BOX_H])]
    for (const w of wires) {
      const tw = labelWidth(w.label), top = w.ly - 12, bottom = w.ly + 3
      const x1 = Number(/^M([\d.-]+)/.exec(w.d)![1])
      const tries: [number, Wire['anchor'], Rect][] = [
        [w.lx, 'middle', [w.lx - tw / 2, top, w.lx + tw / 2, bottom]],
        [x1 - 8, 'end', [x1 - 8 - tw, top, x1 - 8, bottom]],
        [x1 + 8, 'start', [x1 + 8, top, x1 + 8 + tw, bottom]],
      ]
      const ok = tries.find(([, , r]) => r[0] >= 4 && r[2] <= W - 4 && !taken.some((t) => hits(r, t)))
      const [lx, anchor, r] = ok ?? tries[0]
      Object.assign(w, { lx, anchor })
      taken.push(r)
    }
    // each bar names who calls it: beside the name when it fits, otherwise on lines below it
    let by = barTop
    const placedBars = bars.map((c) => {
      const items = (callersOf.get(c.id) ?? []).map((x) => `${x.id} ${x.n} 次`)
      const text = items.join(' · ') || `共用 · ${c.callers} 個元件呼叫`
      const inline = textWidth(c.id, NAME_FONT) + textWidth(text, META_FONT) + 72 < W
      const lines: string[] = []
      if (!inline) {
        for (const it of items) {
          const next = lines.length ? `${lines[lines.length - 1]} · ${it}` : it
          if (lines.length && textWidth(next, META_FONT) + 48 < W) lines[lines.length - 1] = next
          else lines.push(it)
        }
      }
      const bar = { c, y: by, h: inline ? BAR_H : 46 + 20 * lines.length, inline, text, lines }
      by += bar.h + BAR_GAP
      return bar
    })
    const height = by + 4
    return { boxes, bars: placedBars, barTop, wires, drops, callersOf, height, width: W }
  }
  // up to a quarter too wide, the viewer scales the drawing down instead (text at 80 % or more)
  const fit = card * 1.25
  let room = fit, L = attempt(room)
  for (let i = 0; i < 3 && L.width > fit && room > 200; i++) L = attempt(room -= L.width - fit)
  return L
}
