import { describe, expect, it } from 'vitest'
import { BOX_H, layout } from './archLayout'
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

  it('never runs a line to the shared bars through a box, and lists who calls each bar', () => {
    const comps = [comp('src/ibmon', 0), comp('src/libibtrace', 1), { ...comp('include/ibtrace', 2), shared: true }]
    const links: Link[] = [{ a: 'src/ibmon', b: 'src/libibtrace', n: 1, kind: 'env', names: ['IBTRACE_SHM'] },
      { a: 'src/ibmon', b: 'include/ibtrace', n: 13, kind: 'call' }, { a: 'src/libibtrace', b: 'include/ibtrace', n: 8, kind: 'call' }]
    const L = layout(comps, links, 300, () => '')
    expect(L.drops).toHaveLength(2)
    for (const d of L.drops) {
      const pts: [number, number][] = []
      let x = 0, y = 0
      for (const [, c, v] of d.matchAll(/([MVH])([\d.,-]+)/g)) {
        if (c === 'M') [x, y] = v.split(',').map(Number) as [number, number]
        else if (c === 'V') { pts.push([x, y]); y = Number(v) } else { pts.push([x, y]); x = Number(v) }
        pts.push([x, y])
      }
      for (let i = 1; i < pts.length; i++) {
        const [[x1, y1], [x2, y2]] = [pts[i - 1], pts[i]]
        for (const b of L.boxes) {
          const inX = Math.max(x1, x2) > b.x && Math.min(x1, x2) < b.x + b.w
          const inY = Math.max(y1, y2) > b.y + 1 && Math.min(y1, y2) < b.y + BOX_H - 1
          expect(inX && inY, `${d} crosses ${b.c.id}`).toBe(false)
        }
      }
    }
    const env = L.wires.find((w) => w.l.kind === 'env')!
    expect(env.d.match(/H/g)).toBeNull()                                  // straight, no small jog
    expect(env.anchor).not.toBe('middle')                                 // beside the line, not over it
    expect(L.callersOf.get('include/ibtrace')).toEqual([{ id: 'src/ibmon', n: 13 }, { id: 'src/libibtrace', n: 8 }])
  })

  it('widens the drawing when a layer does not fit the card', () => {
    const comps = Array.from({ length: 8 }, (_, i) => comp('component-' + i, 0))
    const L = layout(comps, [], 400, () => '')
    const right = Math.max(...L.boxes.map((b) => b.x + b.w))
    expect(L.width).toBeGreaterThan(400)
    expect(right).toBeLessThanOrEqual(L.width - 8)
  })
})
