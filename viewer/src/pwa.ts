// The GitHub Pages build is an installable app (the 'pages' build mode): it registers the service worker, offers
// the browser's install prompt, and opens a .codemap file the system hands it. The page `codemap serve` returns
// and `codemap export --html` writes does none of this.
import { useSyncExternalStore } from 'react'

export const isApp = import.meta.env.MODE === 'pages'

interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
interface LaunchParams { files: { getFile: () => Promise<File> }[] }
declare global { interface Window { launchQueue?: { setConsumer: (f: (p: LaunchParams) => void) => void } } }

let pending: InstallEvent | null = null
const subs = new Set<() => void>()
const tell = () => subs.forEach((f) => f())

/** Once at start-up: the service worker, and the install prompt kept for the 安裝 button. */
export function startApp() {
  if (!isApp) return
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { /* offline use only: the page works without it */ })
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); pending = e as InstallEvent; tell() })
  addEventListener('appinstalled', () => { pending = null; tell() })
}

/** How the app can be installed here: the browser's prompt, Safari's 加入主畫面, already running as an app, or not at all. */
export type InstallWay = 'prompt' | 'ios' | 'installed' | null
function way(): InstallWay {
  if (!isApp) return null
  if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) return 'installed'
  if (pending) return 'prompt'
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : null
}
export function useInstall(): InstallWay {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, way)
}
export async function install() {
  if (!pending) return
  await pending.prompt()
  await pending.userChoice
  pending = null
  tell()
}

/** A .codemap file opened with the installed app (the system's 「開啟檔案」, a double-click). */
export function onLaunchFile(open: (f: File) => void) {
  if (!isApp || !window.launchQueue) return
  window.launchQueue.setConsumer((p) => { if (p.files[0]) p.files[0].getFile().then(open, () => { /* the file is gone */ }) })
}
