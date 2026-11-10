import { describe, expect, it } from 'vitest'
import { rank } from './search'

describe('rank', () => {
  const items = [
    { label: 'ibt_real_ns', kind: '函式' },
    { label: 'IBT_REAL', kind: '巨集' },
    { label: 'main', kind: '函式', weight: 3, detail: 'src/ucx_ib_test/main.c' },
    { label: 'main', kind: '函式', weight: 40, detail: 'src/ibmon/main.c' },
    { label: 'main.c', kind: '檔案' },
    { label: 'domain_x', kind: '函式' },
  ]
  it('puts an exact name first, whatever its kind', () => {
    expect(rank(items, 'IBT_REAL')[0].label).toBe('IBT_REAL')
  })
  it('breaks ties by how connected a function is', () => {
    expect(rank(items, 'main').slice(0, 2).map((x) => x.detail)).toEqual(['src/ibmon/main.c', 'src/ucx_ib_test/main.c'])
    expect(rank(items, 'main').at(-1)!.label).toBe('domain_x')
  })
  it('puts a method named exactly before what is nested in it', () => {
    const methods = [
      { label: 'VirtualRouter._install_control_flows.add', kind: '函式', weight: 30 },
      { label: 'VirtualRouter._install_control_flows', kind: '函式', weight: 2 },
    ]
    expect(rank(methods, '_install_control_flows')[0].label).toBe('VirtualRouter._install_control_flows')
  })
  it('needs every word somewhere', () => {
    expect(rank(items, 'main ibmon').map((x) => x.detail)).toEqual(['src/ibmon/main.c'])
    expect(rank(items, '   ')).toEqual([])
  })
})
