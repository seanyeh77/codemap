import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { prefs } from '../prefs'
import { live } from './load'
import type { Index } from './graph'
import type { Func, SourceLines } from './types'

export function usePrefs() {
  return useSyncExternalStore(prefs.subscribe, prefs.get)
}

/** Source lines of one function: from the server when live, from the snapshot otherwise.
 *  sourceId is part of the key, so two snapshots of the same repo never share cached lines. */
export function useFuncSource(f: Func | undefined, isLive: boolean, sourceId: string) {
  return useQuery<SourceLines | null>({
    queryKey: ['source', sourceId, f?.file, f?.top ?? f?.line, f?.end],
    enabled: !!f,
    staleTime: isLive ? 0 : Infinity,     // live files change on disk; a snapshot never does
    queryFn: async () => {
      if (!f) return null                  // never: the query is enabled only with f; narrows the type
      const top = f.top ?? f.line             // the comment and attributes above it are shown too
      if (!isLive) return f.src?.length ? { file: f.file, start: top, lines: f.src } : null
      return live.source(f.file, top, f.end)
    },
  })
}

/** Source around one file:line: the whole function it falls in, or, live, a few lines around it
 *  (a line outside every function, such as a script that sets an environment variable). */
export function useLineSource(ix: Index, at: { f: string; l: number } | null, isLive: boolean, sourceId: string) {
  const hit = at ? ix.at(`${at.f}:${at.l}`) : null
  const f = hit ? ix.funcs[hit.id] : undefined
  return useQuery<SourceLines | null>({
    queryKey: ['line', sourceId, at?.f, at?.l],
    enabled: !!at,
    staleTime: isLive ? 0 : Infinity,
    queryFn: async () => {
      if (!at) return null
      if (f) return isLive ? live.source(f.file, f.top ?? f.line, f.end) : f.src?.length ? { file: f.file, start: f.top ?? f.line, lines: f.src } : null
      return isLive ? live.source(at.f, Math.max(1, at.l - 6), at.l + 6) : null
    },
  })
}

/** A whole file, live only: a snapshot keeps functions, not files. */
export function useFileSource(file: string | null, isLive: boolean, sourceId: string) {
  return useQuery<SourceLines | null>({
    queryKey: ['file', sourceId, file],
    enabled: !!file && isLive,
    staleTime: 0,
    queryFn: () => live.source(file!, 1, 1_000_000),
  })
}
