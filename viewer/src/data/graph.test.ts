import { describe, expect, it } from 'vitest'
import { Index } from './graph'
import type { Graph } from './types'

const g = {
  format: 'codemap-snapshot', version: 1, repo: 'r', root: '/r', host: 'h', commit: 'abc', dirty: [], generated: 0,
  stats: { units: 1, failed: 0, funcs: 3, edges: 2 },
  comps: [{ id: 'src/a', files: 1, funcs: 3, shared: false, layer: 0, callers: 0 }], links: [], checks: [],
  config: { cc: 'gcc', scope: null },
  funcs: {
    main: { name: 'main', file: 'src/a/main.c', line: 3, end: 9, comp: 'src/a' },
    'src/a/main.c:helper': { name: 'helper', file: 'src/a/main.c', line: 11, end: 14, comp: 'src/a' },
    run: { name: 'run', file: 'src/a/run.c', line: 1, end: 5, comp: 'src/a' },
  },
  edges: [
    { s: 'main', d: 'run', f: 'src/a/main.c', l: 6, k: 'call', src: 'compiler' },
    { s: 'main', d: 'src/a/main.c:helper', f: 'src/a/main.c', l: 5, k: 'call', src: 'compiler' },
    { s: 'main', d: 'printf', f: 'src/a/main.c', l: 7, k: 'call', src: 'compiler', dn: 'printf', ext: '/usr/include/stdio.h' },
    { s: 'run', d: 'src/a/main.c:helper', f: 'src/a/run.c', l: 2, k: 'fnptr_assign', src: 'rule', rule: 'fnptr_assign', slot: 'cb' },
  ],
} satisfies Graph

describe('Index', () => {
  const ix = new Index(g)
  it('lists callees in line order and hides external ones unless asked', () => {
    expect(ix.callees('main', false).map((e) => e.d)).toEqual(['src/a/main.c:helper', 'run'])
    expect(ix.callees('main', true).map((e) => ix.nameOf(e.d, e))).toEqual(['helper', 'run', 'printf'])
  })
  it('includes rule edges among callers and tags them', () => {
    const callers = ix.callers('src/a/main.c:helper')
    expect(callers.map((e) => e.s)).toEqual(['main', 'run'])
    const x = ix.explain(callers[1])
    expect(x.label).toMatch(/^推測（規則：.+）$/)
    expect(x.text).toContain('`cb`')
    expect(ix.explain(callers[0]).label).toBe('編譯器確認')
    expect(ix.explain(ix.callees('main', true)[2]).label).toBe('外部')
  })
  it('finds the function a file:line falls in', () => {
    expect(ix.at('main.c:12')?.id).toBe('src/a/main.c:helper')
    expect(ix.at('main.c:10')).toBeNull()
  })
  it('does not guess between two files with the same name', () => {
    const two = new Index({ ...g, funcs: { ...g.funcs, other: { name: 'other', file: 'src/b/main.c', line: 10, end: 14, comp: 'src/a' } } })
    expect(two.at('main.c:12')).toBeNull()
    expect(two.at('src/b/main.c:12')?.id).toBe('other')
  })
  it('starts at the function with the most callees', () => {
    expect(ix.firstFunc()).toBe('main')
  })
})
