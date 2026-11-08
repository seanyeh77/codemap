import { UI } from '../ui'
import type { Index } from '../data/graph'
import { useFuncSource } from '../data/hooks'
import type { Edge, Sel } from '../data/types'
import { vscodeURL } from '../prefs'

interface Props {
  ix: Index
  sel: Sel
  isLive: boolean
  sourceId: string
  canMacro: boolean
  goFlow: (id: string) => void
  goImpact: (id: string) => void
}

/** The selected function: where it is, how it relates, and its source. */
export function Detail(p: Props) {
  const f = p.ix.funcs[p.sel.id]
  const e = p.sel.edge
  const src = useFuncSource(f, p.isLive, p.sourceId)
  const { root, host } = p.ix.g
  if (!f) {
    if (!e) return <UI.Card className="detail"><p className="muted">選擇函式以查看原始碼。</p></UI.Card>
    const name = p.ix.nameOf(p.sel.id, e)
    return (
      <UI.Card className="detail" title={name}>
        <UI.DetailList items={[
          { label: '種類', value: p.ix.explain(e as Edge).title },   // only the flow tree selects a non-function, with its full edge
          ...(e.ext ? [{ label: '宣告', value: <UI.InlineCode>{e.ext}</UI.InlineCode> }] : []),
          { label: '呼叫位置', value: link(e.f, e.l) },
        ]} />
      </UI.Card>
    )
  }
  // the edge's line is inside this function only when looking up (it is this function's call)
  const inside = !!e && e.f === f.file && f.line <= e.l && e.l <= f.end
  const focus = inside ? e!.l : f.line
  const nCallers = p.ix.callerCount(p.sel.id), nCallees = p.ix.calleeCount(p.sel.id)
  function link(file: string, line: number) {
    return <UI.InlineCode href={vscodeURL(file, line, root, host) ?? undefined}>{`${file}:${line}`}</UI.InlineCode>
  }
  return (
    <UI.Card className="detail" title={<span title={f.name}>{f.name}</span>}>
      <UI.DetailList items={[
        { label: '定義', value: link(f.file, f.line) },
        { label: '元件', value: f.comp },
        { label: '關係', value: <span>{`${nCallers} 個 `}<UI.Term text="呼叫此函式的函式。">caller</UI.Term>{` · ${nCallees} 個 `}<UI.Term text="此函式呼叫的 repo 內函式。">callee</UI.Term></span> },
        ...(e && !inside ? [{ label: '呼叫位置', value: link(e.f, e.l) }] : []),
        ...(e && (e.via || e.slot) ? [{ label: '經由', value: <UI.InlineCode>{e.via || e.slot}</UI.InlineCode> }] : []),
      ]} />
      <UI.ActionBar actions={[
        { label: '追蹤流程', primary: true, onClick: () => p.goFlow(p.sel.id) },
        { label: '查看影響範圍', onClick: () => p.goImpact(p.sel.id) },
        { label: '展開 macro', disabled: !p.canMacro },
      ]} />
      {src.isPending ? <div><UI.Skeleton width="80%" height={16} /><UI.Skeleton width="60%" height={16} /><UI.Skeleton width="70%" height={16} /></div>
        : src.error ? <UI.Alert tone="danger" title="無法讀取原始碼">{(src.error as Error).message}</UI.Alert>
        : !src.data ? <p className="small muted">匯出快照時讀不到這個檔案。請在 build 環境重新執行 codemap export。</p>
        : <UI.CodeView file={src.data.file} fileHref={vscodeURL(f.file, focus, root, host) ?? undefined}
            code={src.data.lines.join('\n')} start={src.data.start} target={focus} maxHeight="60vh" />}
    </UI.Card>
  )
}
