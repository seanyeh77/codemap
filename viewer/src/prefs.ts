// Per-viewer conveniences kept in this browser (theme, layout, how to open files).
// Nothing here is shared with other viewers; storage can be unavailable, so every access is guarded.

export interface Prefs {
  theme: 'auto' | 'light' | 'dark'
  ruleStyle: 'dash' | 'color'
  panel: 'right' | 'below'
  showExtDefault: boolean
  editor: 'ssh' | 'local' | 'none'
  sshHost: string
  clone: string
}

const KEY = 'codemap.prefs.v1'
const DEFAULTS: Prefs = { theme: 'auto', ruleStyle: 'dash', panel: 'right', showExtDefault: false, editor: 'ssh', sshHost: '', clone: '' }

function read(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

let current = read()
const listeners = new Set<() => void>()

export const prefs = {
  get: () => current,
  set<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    current = { ...current, [k]: v }
    try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* private mode */ }
    listeners.forEach((f) => f())
  },
  subscribe(f: () => void) {
    listeners.add(f)
    return () => { listeners.delete(f) }
  },
}

/** A vscode:// link that opens file:line the way the person chose in settings, or null. */
export function vscodeURL(file: string, line: number, root: string, host: string | undefined) {
  const pr = current
  if (pr.editor === 'none') return null
  if (pr.editor === 'local') {
    if (!pr.clone) return null
    const dir = pr.clone.replace(/\\/g, '/').replace(/\/$/, '')            // C:\src\repo -> /C:/src/repo
    return `vscode://file${dir.startsWith('/') ? '' : '/'}${dir}/${file}:${line}`
  }
  const h = pr.sshHost || host
  return h ? `vscode://vscode-remote/ssh-remote+${h}${root}/${file}:${line}` : null
}
