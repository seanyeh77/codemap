import type { Graph, Meta, SourceLines, CheckFile } from './types'

async function gunzipJSON<T>(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<T> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const isGzip = u8[0] === 0x1f && u8[1] === 0x8b
  const text = isGzip
    ? await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(u8)
  return JSON.parse(text) as T
}

function checkSnapshot(g: Graph, from: string): Graph {
  if (g?.format !== 'codemap-snapshot') throw new Error(`${from} 不是 codemap 快照，請改用 codemap export 產生的 .codemap 檔。`)
  return g
}

/** A snapshot that `codemap export --html` put inside this page. */
export async function embeddedSnapshot(): Promise<Graph | null> {
  const el = document.getElementById('codemap-snapshot')
  if (!el?.textContent) return null
  const bin = Uint8Array.from(atob(el.textContent.trim()), (c) => c.charCodeAt(0))
  return checkSnapshot(await gunzipJSON<Graph>(bin), '此頁面的資料')
}

export async function snapshotFromURL(url: string): Promise<Graph> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`無法下載 ${url}（HTTP ${r.status}），請確認網址。`)
  return checkSnapshot(await gunzipJSON<Graph>(await r.arrayBuffer()), url)
}

export async function snapshotFromFile(file: File): Promise<Graph> {
  return checkSnapshot(await gunzipJSON<Graph>(await file.arrayBuffer()), file.name)
}

/** The server's own message for a failed request (FastAPI's detail), or the status. */
async function errorOf(r: Response, path: string) {
  const d = await r.json().then((b) => b?.detail, () => null)
  return new Error(typeof d === 'string' ? d : `${path} 回傳 HTTP ${r.status}`)
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) throw await errorOf(r, path)
  return r.json() as Promise<T>
}

/** null when no `codemap serve` answers (static viewer or file://); its error when it answers with one. */
export async function liveMeta(): Promise<Meta | null> {
  if (location.protocol === 'file:') return null
  let r: Response
  try { r = await fetch('api/meta') } catch { return null }
  if (!(r.headers.get('content-type') || '').includes('json')) return null   // a static server: no codemap serve
  if (!r.ok) throw await errorOf(r, 'api/meta')
  return (await r.json()) as Meta
}

export const live = {
  graph: () => api<Graph>('api/graph'),
  checks: () => api<CheckFile[]>('api/checks'),
  source: (file: string, start: number, end: number) =>
    api<SourceLines>(`api/source?file=${encodeURIComponent(file)}&start=${start}&end=${end}`),
  snapshotURL: 'api/snapshot',
}
