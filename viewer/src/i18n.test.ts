import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EN } from './en'

// every t('…') in the sources needs an English line, or English readers get Chinese
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? sources(join(dir, d.name))
    : /\.tsx?$/.test(d.name) && !d.name.includes('.test.') ? [join(dir, d.name)] : [])
}

describe('English', () => {
  it('has every interface string', () => {
    const missing = new Set<string>()
    for (const f of sources(__dirname)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) {
        const key = m[1].replace(/\\'/g, "'")
        if (/[一-鿿（）「」：，、。；]/.test(key) && !(key in EN)) missing.add(key)
      }
    }
    expect([...missing]).toEqual([])
  })
})
