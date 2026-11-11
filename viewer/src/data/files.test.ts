import { describe, expect, it } from 'vitest'
import { roleOf } from './files'
import type { Graph } from './types'

const g = (over: Partial<Graph>) => ({ files: {}, ...over }) as Graph

describe('roleOf', () => {
  it('reads the first word of a file\'s own comment', () => {
    const x = g({ files: {
      'h/controller.py': { text: 'Editable os-ken controller.', file: 'h/controller.py', line: 1 },
      'h/checks.py': { text: 'Protected, authoritative checks.', file: 'h/checks.py', line: 1 },
      'h/notes.py': { text: 'Parses the protected list.', file: 'h/notes.py', line: 1 },
      'h/a.c': { text: 'Do not edit: made by gen.py', file: 'h/a.h', line: 1 },
    } as Graph['files'] })
    expect(roleOf(x, 'h/controller.py')).toBe('editable')
    expect(roleOf(x, 'h/checks.py')).toBe('protected')
    expect(roleOf(x, 'h/notes.py')).toBeNull()          // the word in the middle of a sentence says nothing
    expect(roleOf(x, 'h/a.c')).toBeNull()               // a header's comment speaks for the header
  })
  it('lets rules.json win, the longest path first', () => {
    const x = g({ roles: { h: 'protected', 'h/controller.py': 'editable' },
      files: { 'h/controller.py': { text: 'Protected.', file: 'h/controller.py', line: 1 } } as Graph['files'] })
    expect(roleOf(x, 'h/controller.py')).toBe('editable')
    expect(roleOf(x, 'h/other.py')).toBe('protected')
  })
})
