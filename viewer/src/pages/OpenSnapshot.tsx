import { useRef } from 'react'
import { UI } from '../ui'

/** A hidden file input that the 「開啟快照」 buttons open. */
export function useFilePicker(onFile: (f: File) => void) {
  const ref = useRef<HTMLInputElement>(null)
  return {
    open: () => ref.current?.click(),
    input: <input ref={ref} type="file" accept=".codemap,application/gzip,application/json" hidden
      onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />,
  }
}

/** Static viewer with no data yet: explain how to get a snapshot and let the person pick one. */
export function OpenSnapshot(p: { onOpen: (f: File) => void; error: string | null }) {
  return (
    <div className="open-wrap">
      <UI.Card className="open-card">
        <UI.EmptyState title="開啟 codemap 快照"
          steps={['在 build 環境執行 codemap export', '下載產生的 .codemap 檔', '在下方選擇檔案']} />
        <UI.FileUpload label="快照檔" accept=".codemap" limitText=".codemap 檔"
          onAdd={(fs) => fs[0] && p.onOpen(fs[0])} />
        {p.error ? <UI.Alert tone="danger" title="無法開啟此檔案">{p.error}</UI.Alert> : null}
        <p className="small muted">也可在網址加上 <UI.InlineCode>?snapshot=網址</UI.InlineCode>。即時索引請在 build 環境執行 <UI.InlineCode>codemap serve</UI.InlineCode>。</p>
      </UI.Card>
    </div>
  )
}
