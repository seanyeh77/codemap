import type { Index } from './graph'
import { written, type Edge, type Graph } from './types'

export type Role = 'editable' | 'protected'

// the first words of a file's top comment: 「Editable os-ken controller」, 「Protected, authoritative checks」
const EDITABLE = /^\s*editable\b/i
const PROTECTED = /^\s*(protected|read-only|(auto-?)?generated|do not (edit|modify|change)|don't (edit|modify))\b/i

/** Whether the project lets people change a file: .codemap/rules.json "roles" (longest path wins), else the
 *  first words of the file's own top comment. null when neither says. */
export function roleOf(g: Graph, file: string): Role | null {
  const set = Object.entries(g.roles ?? {}).filter(([p]) => file === p || file.startsWith(p.replace(/\/$/, '') + '/'))
  if (set.length) return set.sort((a, b) => b[0].length - a[0].length)[0][1]
  const d = g.files?.[file]
  if (!d || (d.file && d.file !== file)) return null           // a header's comment speaks for the header
  return EDITABLE.test(d.text) ? 'editable' : PROTECTED.test(d.text) ? 'protected' : null
}

export interface FileLink { a: string; b: string; es: Edge[] }

/** The production files and the calls between them, laid out like the components (arch.layout): each file sits on the
 *  layer of its longest call path. Among many files, those most others call that call only such files are shared bars
 *  under the diagram; among a dozen or fewer every file is a box, or nearly all of them would be bars. */
export function fileGraph(ix: Index) {
  const comps = new Set(ix.g.comps.filter((c) => !c.lang).map((c) => c.id))
  const fileOf = (id: string) => { const f = ix.funcs[id]; return f && f.scope !== 'test' && comps.has(f.comp) ? f.file : null }
  const files = new Map<string, { comp: string; funcs: number }>()
  for (const [id, f] of Object.entries(ix.funcs)) {
    if (!fileOf(id)) continue
    const x = files.get(f.file)
    files.set(f.file, { comp: f.comp, funcs: (x?.funcs ?? 0) + 1 })
  }
  const pairs = new Map<string, FileLink>()
  for (const e of ix.g.edges) {
    const a = fileOf(e.s), b = fileOf(e.d)
    if (!a || !b || a === b || !written(e)) continue
    const k = `${a}->${b}`
    const x = pairs.get(k) ?? { a, b, es: [] }
    x.es.push(e)
    pairs.set(k, x)
  }
  const names = [...files.keys()].sort()
  const callers = new Map<string, Set<string>>()
  for (const l of pairs.values()) callers.set(l.b, (callers.get(l.b) ?? new Set()).add(l.a))
  const shared: string[] = []
  for (;;) {
    if (names.length <= 12) break
    const more = names.filter((n) => !shared.includes(n) && [...(callers.get(n) ?? [])].filter((c) => !shared.includes(c)).length >= 3
      && [...pairs.values()].every((l) => l.a !== n || shared.includes(l.b)))
    if (!more.length) break
    shared.push(...more)
  }
  const boxes = names.filter((n) => !shared.includes(n))
  const layer = new Map(boxes.map((n) => [n, 0]))
  const order = [...pairs.values()].filter((l) => layer.has(l.a) && layer.has(l.b)).sort((x, y) => `${x.a}>${x.b}`.localeCompare(`${y.a}>${y.b}`))
  for (let i = 0; i < boxes.length; i++) {           // longest path; a cycle stops at the iteration limit
    for (const l of order) if (layer.get(l.b)! < layer.get(l.a)! + 1 && layer.get(l.a)! + 1 <= boxes.length) layer.set(l.b, layer.get(l.a)! + 1)
  }
  return { files, shared: new Set(shared), layer, links: [...pairs.values()] }
}

/** The file diagram is offered when a box per file still reads as a diagram, and drawn first when the components
 *  are too few to say anything (lab3: harness and topo). */
export function fileView(ix: Index) {
  const comps = ix.g.comps.filter((c) => !c.lang).length
  const files = new Set(Object.values(ix.funcs).filter((f) => f.scope !== 'test' && ix.g.comps.some((c) => c.id === f.comp && !c.lang)).map((f) => f.file)).size
  return { offered: files >= 2 && files <= 40, first: comps <= 3 && files >= 2 && files <= 40 }
}
