import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { prefs } from '../prefs'
import { live } from './load'
import type { Func, SourceLines } from './types'

export function usePrefs() {
  return useSyncExternalStore(prefs.subscribe, prefs.get)
}

/** Source lines of one function: from the server when live, from the snapshot otherwise.
 *  sourceId is part of the key, so two snapshots of the same repo never share cached lines. */
export function useFuncSource(f: Func | undefined, isLive: boolean, sourceId: string) {
  return useQuery<SourceLines | null>({
    queryKey: ['source', sourceId, f?.file, f?.line, f?.end],
    enabled: !!f,
    staleTime: isLive ? 0 : Infinity,     // live files change on disk; a snapshot never does
    queryFn: async () => {
      if (!f) return null                  // never: the query is enabled only with f; narrows the type
      if (!isLive) return f.src?.length ? { file: f.file, start: f.line, lines: f.src } : null
      return live.source(f.file, f.line, f.end)
    },
  })
}
