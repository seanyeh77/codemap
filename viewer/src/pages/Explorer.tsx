import { useEffect, useMemo, useState } from 'react'
import { UI } from '../ui'
import { t } from '../i18n'
import type { Index } from '../data/graph'
import type { Graph } from '../data/types'
import type { At } from './Info'

/** The ids of the explorer's rows: the project, a component, a file, a function. */
export const nodeOf = (at: At, fn: string | null): string =>
  at.kind === 'comp' ? 'comp:' + at.id : at.kind === 'file' ? (fn ? 'fn:' + fn : 'file:' + at.f) : 'proj'

/** Where the checks found something, and functions whose AI description is older than their code: the explorer marks
 *  them, and the rows above them, with a dot. */
export function flagged(g: Graph, ix: Index): Set<string> {
  const out = new Set<string>()
  const w = g.worth
  const add = (fid: string, f: string) => {
    out.add('fn:' + fid); out.add('file:' + f)
    const c = ix.funcs[fid]?.comp
    if (c) out.add('comp:' + c)
  }
  if (w) for (const xs of [w.broad ?? [], w.stops, w.env, w.env_if_unset ?? [], w.errors ?? [], w.loss ?? [], w.leftovers ?? [], w.limits?.silent ?? [],
    (w.plain_writes ?? []).flatMap((v) => v.writes)]) for (const x of xs) add(x.fid, x.f)
  for (const [id, f] of Object.entries(ix.funcs)) if (f.ai?.state === 'stale') add(id, f.file)
  return out
}

/** The explorer: the project, its components, their files and each file's functions. The path to what is open stays
 *  expanded and selected; a filter above it lists every file and function whose name has the words. */
export function Explorer(p: { ix: Index; at: At; fn: string | null; q: string; open: (id: string) => void }) {
  const { ix, q } = p
  const wb = UI.useWorkbench()
  const flags = useMemo(() => flagged(ix.g, ix), [ix])
  const mark = (id: string) => (flags.has(id) ? { label: t('有值得注意的地方') } : undefined)
  const files = useMemo(() => {
    const by = new Map<string, string[]>()
    for (const [f, ids] of ix.byFile()) {
      const live = ids.filter((id) => ix.funcs[id].kind !== 'module' && ix.funcs[id].scope !== 'test')
      if (!live.length && ids.every((id) => ix.funcs[id].scope === 'test')) continue
      const c = ix.funcs[ids[0]].comp
      by.set(c, [...(by.get(c) ?? []), f])
    }
    return by
  }, [ix])
  // a method by its own name: the file's tree already says where it is
  const fnNode = (id: string) => ({ id: 'fn:' + id, name: ix.funcs[id].name.split('.').pop()!, icon: 'brackets-curly' as const, mark: mark('fn:' + id) })
  const fileNode = (f: string) => ({ id: 'file:' + f, name: f.split('/').pop()!, icon: 'file-text' as const, mark: mark('file:' + f),
    children: (ix.byFile().get(f) ?? []).filter((id) => ix.funcs[id].kind !== 'module' && ix.funcs[id].scope !== 'test')
      .sort((a, b) => ix.funcs[a].line - ix.funcs[b].line).map(fnNode) })
  const items = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length) {
      const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w))
      const fs = [...files.values()].flat().filter((f) => hit(f)).slice(0, 60).map((f) => ({ ...fileNode(f), path: f, children: undefined }))
      const fns = Object.entries(ix.funcs).filter(([, f]) => f.kind !== 'module' && f.scope !== 'test' && hit(f.name)).slice(0, 120)
        .map(([id, f]) => ({ ...fnNode(id), name: f.name, path: `${f.file}:${f.line}` }))
      return [...fs, ...fns]
    }
    // the project's documents (README, docs/…) after its components: files too, opened in the stage like code
    const docs = ix.g.docs ?? []
    return [{ id: 'proj', name: ix.g.repo, icon: 'house' as const, mark: mark('proj'),
      children: [...ix.g.comps.map((c) => ({ id: 'comp:' + c.id, name: c.id, icon: 'squares-four' as const, mark: mark('comp:' + c.id),
        children: (files.get(c.id) ?? []).sort().map(fileNode) })),
        ...(docs.length ? [{ id: 'docs', name: t('文件'), icon: 'file' as const, ariaLabel: t('專案的說明文件'),
          children: docs.map((d) => ({ id: 'file:' + d.file, name: d.file, icon: 'file-text' as const })) }] : [])] }]
  }, [q, files, ix, flags])   // eslint-disable-line react-hooks/exhaustive-deps
  const cur = nodeOf(p.at, p.fn)
  // the path to what is open is opened; whatever else the reader opened stays open
  const path = useMemo(() => {
    const ids = ['proj']
    const comp = p.at.kind === 'comp' ? p.at.id : p.at.kind === 'file' ? ix.funcs[ix.byFile().get(p.at.f)?.[0] ?? '']?.comp : undefined
    if (comp) ids.push('comp:' + comp)
    if (p.at.kind === 'file') ids.push('file:' + p.at.f)
    if (p.at.kind === 'file' && ix.g.docs?.some((d) => d.file === (p.at as { f: string }).f)) ids.push('docs')
    return ids
  }, [p.at, ix])
  const [open, setOpen] = useState<string[]>(path)
  useEffect(() => setOpen((o) => [...new Set([...o, ...path])]), [path])
  // the selected row comes into view when it changes from elsewhere (the code, the panel, the search)
  useEffect(() => {
    const id = requestAnimationFrame(() => document.querySelector('.ex-tree [aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(id)
  }, [cur])
  return <div className="ex">
    <div className="ex-tree" data-tour="tree">
      <UI.TreeList kind="plain" density="compact" bare height="100%" label={t('專案的元件、檔案與函式')} items={items} value={cur}
        open={q.trim() ? [] : open} onToggle={(_, __, ids) => setOpen(ids)} onChange={(id) => { p.open(id); wb.explorerPicked() }} />
    </div>
  </div>
}
