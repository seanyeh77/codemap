import { describe, expect, it } from 'vitest'
import { layout } from './archLayout'
import type { Comp, Link } from './types'

const comp = (id: string, layer: number): Comp => ({ id, files: 1, funcs: 1, shared: false, layer, callers: 0 })

describe('architecture layout', () => {
  it('routes a link that skips a row around the boxes in between', () => {
    const comps = [comp('a', 0), comp('b', 1), comp('c', 2)]
    const links: Link[] = [{ a: 'a', b: 'b', n: 1, kind: 'call' }, { a: 'b', b: 'c', n: 1, kind: 'call' }, { a: 'a', b: 'c', n: 1, kind: 'call' }]
    const L = layout(comps, links, 640, (l) => `${l.n}`)
    const mid = L.boxes.find((b) => b.c.id === 'b')!
    const long = L.wires.find((w) => w.l.a === 'a' && w.l.b === 'c')!
    const xs = [...long.d.matchAll(/H(-?[\d.]+)/g)].map((m) => Number(m[1]))
    expect(Math.max(...xs)).toBeGreaterThan(mid.x + mid.w)          // goes out to the right of b
    const short = L.wires.find((w) => w.l.a === 'a' && w.l.b === 'b')!
    expect(short.d.match(/H/g)).toHaveLength(1)
  })

  it('gives every long link its own channel inside the drawing', () => {
    const comps = [comp('a', 0), comp('d', 0), comp('b', 1), comp('c', 2)]
    const links: Link[] = [{ a: 'a', b: 'c', n: 1, kind: 'call' }, { a: 'd', b: 'c', n: 1, kind: 'call' }, { a: 'a', b: 'b', n: 1, kind: 'call' }]
    const L = layout(comps, links, 300, (l) => `${l.n}`)
    const xs = L.wires.filter((w) => w.l.b === 'c').map((w) => Math.max(...[...w.d.matchAll(/H(-?[\d.]+)/g)].map((m) => Number(m[1]))))
    expect(new Set(xs).size).toBe(2)
    expect(Math.max(...xs)).toBeLessThan(L.width)
  })

  it('keeps many long links into one gap above its lanes', () => {
    const comps = [...Array.from({ length: 10 }, (_, i) => comp('top' + i, 0)), comp('mid', 1), comp('end', 2)]
    const links: Link[] = [...comps.slice(0, 10).map((c): Link => ({ a: c.id, b: 'end', n: 1, kind: 'call' })),
      { a: 'top0', b: 'mid', n: 1, kind: 'call' }, { a: 'mid', b: 'end', n: 1, kind: 'call' }]
    const L = layout(comps, links, 2000, () => '')
    const end = L.boxes.find((b) => b.c.id === 'end')!
    const lane = Number(/V([\d.]+)/.exec(L.wires.find((w) => w.l.a === 'mid')!.d)![1])
    const entries = L.wires.filter((w) => w.l.b === 'end' && w.l.a !== 'mid').map((w) => Number([...w.d.matchAll(/V([\d.]+)/g)][1][1]))
    expect(new Set(entries).size).toBe(10)
    expect(Math.max(...entries)).toBeLessThan(lane)
    expect(Math.max(...entries)).toBeLessThan(end.y)
  })

  it('widens the drawing when a layer does not fit the card', () => {
    const comps = Array.from({ length: 8 }, (_, i) => comp('component-' + i, 0))
    const L = layout(comps, [], 400, () => '')
    const right = Math.max(...L.boxes.map((b) => b.x + b.w))
    expect(L.width).toBeGreaterThan(400)
    expect(right).toBeLessThanOrEqual(L.width - 8)
  })
})
