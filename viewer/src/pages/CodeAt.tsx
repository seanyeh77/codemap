import { useEffect, useRef } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import { useLineSource } from '../data/hooks'
import { vscodeURL } from '../prefs'

/** 「用 VS Code 開啟」, only once an editor is chosen in settings. */
export function EditorButton(p: { ix: Index; file: string; line: number }) {
  const url = vscodeURL(p.file, p.line, p.ix.g.root, p.ix.g.host)
  return url ? <UI.IconButton icon="arrow-square-out" label="用 VS Code 開啟" onClick={() => { location.href = url }} /> : null
}

/** A file:line that shows its code inside codemap, plus the VS Code button when one is set up. */
export function LineLink(p: { ix: Index; file: string; line: number; onOpen: () => void }) {
  const loc = `${p.file}:${p.line}`
  const link = <UI.InlineCode href={'#' + loc} onClick={(e) => { e.preventDefault(); p.onOpen() }}>{loc}</UI.InlineCode>
  // alone it stays inline text; with the VS Code button the two sit on one row
  return vscodeURL(p.file, p.line, p.ix.g.root, p.ix.g.host)
    ? <span className="row nowrap">{link}<EditorButton ix={p.ix} file={p.file} line={p.line} /></span>
    : link
}

/** The code around one file:line, with the line marked. */
export function CodeAt(p: { ix: Index; at: { f: string; l: number }; isLive: boolean; sourceId: string; maxHeight?: string; focus?: boolean }) {
  const src = useLineSource(p.ix, p.at, p.isLive, p.sourceId)
  // opened from a link: keyboard and screen-reader focus go to the line it names
  const view = useRef<UI.CodeViewHandle>(null)
  useEffect(() => { if (src.data && p.focus) view.current?.focusTarget() }, [src.data, p.focus, p.at.f, p.at.l])
  if (src.isPending) return <div><UI.Skeleton width="80%" height={16} /><UI.Skeleton width="60%" height={16} /></div>
  if (src.error) return <UI.Alert tone="danger" title="無法讀取原始碼">{(src.error as Error).message}</UI.Alert>
  if (!src.data) return <p className="small muted">{p.isLive ? '這一行不在索引的檔案裡，無法顯示。' : '快照只含函式的原始碼，這一行不在任何函式裡。請在 build 環境執行 codemap serve 查看。'}</p>
  return <UI.CodeView ref={view} file={src.data.file} fileHref={vscodeURL(p.at.f, p.at.l, p.ix.g.root, p.ix.g.host) ?? undefined}
    code={src.data.lines.join('\n')} start={src.data.start} target={p.at.l} maxHeight={p.maxHeight ?? '40vh'} />
}
