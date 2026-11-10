/** Search ranking for the command palette: an exact name first, then names that start with the
 *  query, then names that contain it at a word start, then anywhere in the name, then matches only
 *  in the detail line. Ties go by kind (functions first), then by how connected the item is. */
export interface Rankable {
  label: string
  detail?: string
  kind?: string
  keywords?: string[]
  /** Larger comes first among equal matches: for functions, how many calls touch them. */
  weight?: number
}

const KIND_ORDER = ['函式', '巨集', '全域變數', '環境變數', '檔案', '元件', '外部函式', '概觀', '頁面']

function matchClass(item: Rankable, q: string, words: string[]): number {
  const label = item.label.toLowerCase()
  const rest = [item.detail ?? '', ...(item.keywords ?? [])].join(' ').toLowerCase()
  if (!words.every((w) => label.includes(w) || rest.includes(w))) return -1
  // the name itself, with its class in front (VirtualRouter._install_control_flows), before what is nested in it
  if (label === q || label.endsWith('.' + q)) return 0
  if (label.startsWith(q)) return 1
  if (new RegExp(`(^|[_./\\-\\s])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label)) return 2
  if (label.includes(q)) return 3
  return 4
}

export function rank<T extends Rankable>(items: T[], query: string, limit = 50): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  const kind = (k?: string) => { const i = KIND_ORDER.indexOf(k ?? ''); return i < 0 ? KIND_ORDER.length : i }
  return items
    .map((item) => ({ item, c: matchClass(item, q, words) }))
    .filter((x) => x.c >= 0)
    .sort((a, b) => a.c - b.c || kind(a.item.kind) - kind(b.item.kind) || (b.item.weight ?? 0) - (a.item.weight ?? 0)
      || a.item.label.length - b.item.label.length || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map((x) => x.item)
}
