import { useEffect, useRef } from 'react'
import { UI } from '../ui'
import { DocRefs, langLabel, useCodeRefs } from '../components/DocRefs'
import { t } from '../i18n'
import type { Index } from '../data/graph'
import { useFileSource, useLineSource } from '../data/hooks'
import { vscodeURL } from '../prefs'

/** 「用 VS Code 開啟」, only once an editor is chosen in settings. */
export function EditorButton(p: { ix: Index; file: string; line: number }) {
  const url = vscodeURL(p.file, p.line, p.ix.g.root, p.ix.g.host)
  return url ? <UI.IconButton icon="arrow-square-out" label={t('用 VS Code 開啟')} onClick={() => { location.href = url }} /> : null
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
  const refs = useCodeRefs(p.ix)
  useEffect(() => { if (src.data && p.focus) view.current?.focusTarget() }, [src.data, p.focus, p.at.f, p.at.l])
  if (src.isPending) return <div><UI.Skeleton width="80%" height={16} /><UI.Skeleton width="60%" height={16} /></div>
  if (src.error) return <UI.Alert tone="danger" title={t('無法讀取原始碼')}>{(src.error as Error).message}</UI.Alert>
  if (!src.data) return <p className="small muted">{p.isLive ? t('這一行不在索引的檔案裡，無法顯示。') : t('快照只含函式的原始碼，這一行不在任何函式裡。請在 build 環境執行 codemap serve 查看。')}</p>
  return <><UI.CodeView {...refs} languageLabel={langLabel(src.data.file)} ref={view} file={src.data.file} fileHref={vscodeURL(p.at.f, p.at.l, p.ix.g.root, p.ix.g.host) ?? undefined}
    code={src.data.lines.join('\n')} start={src.data.start} target={p.at.l} maxHeight={p.maxHeight ?? '40vh'} /><DocRefs ix={p.ix} lines={src.data.lines} /></>
}

/** A whole file opened from the search (a header, the Makefile, where a macro is defined), its line marked. */
export function FileView(p: { ix: Index; at: { f: string; l: number }; isLive: boolean; sourceId: string; onClose: () => void }) {
  const src = useFileSource(p.at.f, p.isLive, p.sourceId)
  const view = useRef<UI.CodeViewHandle>(null)
  const refs = useCodeRefs(p.ix)
  useEffect(() => { if (src.data) view.current?.focusTarget() }, [src.data, p.at.l])
  return (
    // Escape inside the file closes it, back to where it was opened from (the panel had no keyboard way out)
    <div onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); p.onClose() } }}>
    <UI.Card className="detail" title={p.at.f.split('/').pop()} actions={<UI.Button onClick={p.onClose}>{t('關閉檔案')}</UI.Button>}>
      {!p.isLive ? <p className="small muted">{t('快照只含函式的原始碼，無法顯示整個檔案。請在 build 環境執行 codemap serve 查看。')}</p>
        : src.isPending ? <UI.Skeleton width="80%" height={16} />
        : src.error || !src.data ? <UI.Alert tone="danger" title={t('無法讀取檔案')}>{src.error ? (src.error as Error).message : t('這個檔案不在索引裡。')}</UI.Alert>
        : <><UI.CodeView {...refs} languageLabel={langLabel(src.data.file)} ref={view} file={src.data.file} code={src.data.lines.join('\n')} start={1} target={p.at.l > 1 ? p.at.l : undefined} maxHeight="70vh" />
          {/\.(md|rst)$/.test(p.at.f) ? null : <DocRefs ix={p.ix} lines={src.data.lines} />}</>}
    </UI.Card>
    </div>
  )
}
