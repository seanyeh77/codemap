// Architecture view layout: where boxes, bars and wires go. Pure, so it is tested without a browser.
import { push } from './graph'
import type { Comp, Link } from './types'

// Layout in CSS pixels: the SVG is drawn at the card's own width, so text keeps its real size.
/** Fonts the box text is measured in; the drawing uses the same ones. */
export const NAME_FONT = '700 15px Inter', META_FONT = '13px Inter'
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
interface Wire { l: Link; d: string; lx: number; ly: number; rule: boolean; label: string }

/** The line under a component's name. */
export function compMeta(c: Comp) {
  return `${c.files} 個檔案 · ${c.funcs} 個函式`
}

function spread(n: number, lo: number, hi: number) {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * (i + 1)) / (n + 1))
}

/** `card` is the card's width: a layer too wide for it widens the drawing, which then scrolls sideways.
 *  `_fontsReady` is unused, but passing it lays the drawing out again once the web font has loaded. */
export function layout(comps: Comp[], links: Link[], card: number, labelOf: (l: Link) => string, _fontsReady = true) {
  const boxComps = comps.filter((c) => !c.shared)
  const bars = comps.filter((c) => c.shared)          // the server orders them: dependencies last
  const byLayer = new Map<number, Comp[]>()
  for (const c of boxComps) push(byLayer, c.layer ?? 0, c)
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  const placed = new Map<string, Box>()
  const rows = layers.map((li) => {
    const list = byLayer.get(li)!.sort((a, b) => a.id.localeCompare(b.id))
    return { list, ws: list.map((c) => Math.ceil(Math.max(textWidth(c.id, NAME_FONT), textWidth(compMeta(c), META_FONT)) + 32)) }
  })
  // links that skip a row run down a channel right of the boxes, 14 px apart
  const rowOf = new Map(rows.flatMap(({ list }, r) => list.map((c) => [c.id, r] as const)))
  const long = links.filter((l) => rowOf.has(l.a) && rowOf.has(l.b) && rowOf.get(l.b)! > rowOf.get(l.a)! + 1).length
  const channel = long ? 20 + 14 * long : 0
  const boxW = Math.max(card - channel, ...rows.map(({ list, ws }) => ws.reduce((a, b) => a + b, 0) + 12 * (list.length + 1) + 16))
  const W = boxW + channel
  rows.forEach(({ list, ws }, r) => {
    const gap = Math.max(12, Math.min(48, (boxW - 16 - ws.reduce((a, b) => a + b, 0)) / Math.max(1, list.length + 1)))
    const total = ws.reduce((a, b) => a + b, 0) + gap * (list.length - 1)
    let x = Math.max(8, (boxW - total) / 2)
    list.forEach((c, i) => { placed.set(c.id, { c, x, y: 0, w: ws[i], row: r }); x += ws[i] + gap })
  })
  const boxes = [...placed.values()]
  const sharedIds = new Set(bars.map((c) => c.id))
  const toShared = new Map<string, number>()
  for (const l of links) if (l.kind === 'call' && placed.has(l.a) && sharedIds.has(l.b)) toShared.set(l.a, (toShared.get(l.a) ?? 0) + l.n)
  const between = links.filter((l) => placed.has(l.a) && placed.has(l.b) && placed.get(l.a)!.row < placed.get(l.b)!.row)
  // one lane per link in the gap below its source row
  const lanes = new Map<number, Link[]>()
  for (const l of between) { const r = placed.get(l.a)!.row; push(lanes, r, l) }
  // a link that skips rows enters its target's gap on its own line, above that gap's lanes
  const entries = new Map<number, number>()
  for (const l of between) { const g = placed.get(l.b)!.row - 1; if (g > placed.get(l.a)!.row) entries.set(g, (entries.get(g) ?? 0) + 1) }
  let y = TOP
  const rowY: number[] = [], gapTop: number[] = [], laneTop: number[] = []
  layers.forEach((_, r) => {
    rowY[r] = y; gapTop[r] = y + BOX_H; laneTop[r] = gapTop[r] + 24 + 4 * (entries.get(r) ?? 0)
    y = laneTop[r] + LANE * (lanes.get(r)?.length ?? 0) + 24
  })
  for (const b of boxes) b.y = rowY[b.row]
  const barTop = (layers.length ? gapTop[layers.length - 1] : TOP) + 44
  // where lines leave and enter each box
  const sharedX = new Map<string, number>()
  for (const b of boxes) {
    if (!toShared.has(b.c.id)) continue
    const below = boxes.filter((o) => o.row > b.row)
    const cands = [b.x + 18, b.x + b.w - 18, b.x + b.w / 2]
    sharedX.set(b.c.id, cands.find((x) => below.every((o) => x < o.x - 8 || x > o.x + o.w + 8)) ?? cands[0])
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
      if (b.row === a.row + 1) {
        wires.push({ l, rule, label, lx: (x1 + x2) / 2, ly: ly - 7, d: `M${x1},${a.y + BOX_H} V${ly} H${x2} V${b.y}` })
      } else {
        const g = b.row - 1, n = entered.get(g) ?? 0
        const sx = right + 20 + 14 * side, ay = gapTop[g] + 12 + 4 * n
        side++
        entered.set(g, n + 1)
        wires.push({ l, rule, label, lx: (x1 + sx) / 2, ly: ly - 7, d: `M${x1},${a.y + BOX_H} V${ly} H${sx} V${ay} H${x2} V${b.y}` })
      }
    })
  }
  const height = barTop + bars.length * (BAR_H + BAR_GAP) + 4
  return { boxes, bars, barTop, wires, toShared, sharedX, height, width: W }
}
