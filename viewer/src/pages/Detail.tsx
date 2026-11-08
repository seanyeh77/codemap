import { useState } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import { useFileSource, useFuncSource } from '../data/hooks'
import type { Edge, Sel } from '../data/types'
import { vscodeURL } from '../prefs'
import { CodeAt, LineLink } from './CodeAt'

interface Props {
  ix: Index
  sel: Sel
  isLive: boolean
  sourceId: string
  canMacro: boolean
  goFlow: (id: string) => void
  goImpact: (id: string) => void
  /** The page and its start function: the action that would only reopen this page is left out. */
  view: string
  start: string | null
}

/** The selected function: where it is, how it relates, and its source. */
export function Detail(p: Props) {
  const f = p.ix.funcs[p.sel.id]
  const e = p.sel.edge
  const src = useFuncSource(f, p.isLive, p.sourceId)
  // a file:line clicked in this panel, shown in place of the function until another selection
  const [shown, setShown] = useState<{ key: string; f: string; l: number } | null>(null)
  const selKey = `${p.sel.id}@${e?.f}:${e?.l}`
  const at = shown?.key === selKey ? shown : null
  // the whole file instead of the function, until another selection
  const [wholeKey, setWhole] = useState<string | null>(null)
  const whole = wholeKey === selKey
  const file = useFileSource(whole && f ? f.file : null, p.isLive, p.sourceId)
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
        <CodeAt ix={p.ix} at={{ f: e.f, l: e.l }} isLive={p.isLive} sourceId={p.sourceId} maxHeight="60vh" />
      </UI.Card>
    )
  }
  // the edge's line is inside this function only when looking up (it is this function's call)
  const inside = !!e && e.f === f.file && f.line <= e.l && e.l <= f.end
  const focus = inside ? e!.l : f.line
  const nCallers = p.ix.callerCount(p.sel.id), nCallees = p.ix.calleeCount(p.sel.id)
  const atLoad = p.ix.callers(p.sel.id).some((x) => x.k === 'constructor')
  const atExit = p.ix.callers(p.sel.id).some((x) => x.k === 'destructor')
  const here = p.sel.id === p.start
  function link(file: string, line: number) {
    const own = !!f && file === f.file && f.line <= line && line <= f.end
    return <LineLink ix={p.ix} file={file} line={line} onOpen={() => setShown(own ? null : { key: selKey, f: file, l: line })} />
  }
  return (
    <UI.Card className="detail" title={<span title={f.name}>{f.name}</span>}>
      <UI.DetailList items={[
        { label: '定義', value: link(f.file, f.line) },
        { label: '元件', value: f.comp },
        { label: '關係', value: <span>{`${nCallers} 個 `}<UI.Term text="呼叫此函式的函式。">caller</UI.Term>{` · ${nCallees} 個 `}<UI.Term text="此函式呼叫的 repo 內函式，同一個函式只算一次；流程樹會在每個呼叫位置各列一次。">callee</UI.Term>{atLoad ? '。程式載入時自動執行（constructor）' : ''}{atExit ? '。程式結束時自動執行（destructor）' : ''}</span> },
        ...(f.api ? [{ label: '進入方式', value: <span><UI.Term text={`和 ${f.api} 程式庫的函式同名。以 LD_PRELOAD 載入這個程式庫的程式呼叫該函式時，會先執行這裡的版本；呼叫者在 repo 外，所以 caller 可能是 0 個。`}>外部進入點</UI.Term>{`：攔截 ${f.api} 的同名函式`}</span> }] : []),
        ...(e && !inside ? [{ label: '呼叫位置', value: link(e.f, e.l) }] : []),
        ...(e && (e.via || e.slot) ? [{ label: '經由', value: <UI.InlineCode>{e.via || e.slot}</UI.InlineCode> }] : []),
      ]} />
      <UI.ActionBar actions={[
        ...(p.view === 'flow' && here ? [] : [{ label: p.view === 'flow' ? '從這裡追蹤流程' : '追蹤流程', primary: true, onClick: () => p.goFlow(p.sel.id) }]),
        ...(p.view === 'impact' && here ? [] : [{ label: '查看影響範圍', primary: p.view === 'flow' && here, onClick: () => p.goImpact(p.sel.id) }]),
        ...(p.canMacro ? [{ label: '展開 macro' }] : []),     // shown only where the server can do it
      ]} />
      {whole ? (
        file.isPending ? <UI.Skeleton width="80%" height={16} />
          : file.error || !file.data ? <UI.Alert tone="danger" title="無法讀取檔案">{file.error ? (file.error as Error).message : '這個檔案不在索引裡。'}</UI.Alert>
          : <UI.CodeView file={file.data.file} code={file.data.lines.join('\n')} start={1} target={focus} maxHeight="60vh" />
      ) : at ? <CodeAt ix={p.ix} at={at} isLive={p.isLive} sourceId={p.sourceId} maxHeight="60vh" focus />
        : src.isPending ? <div><UI.Skeleton width="80%" height={16} /><UI.Skeleton width="60%" height={16} /><UI.Skeleton width="70%" height={16} /></div>
        : src.error ? <UI.Alert tone="danger" title="無法讀取原始碼">{(src.error as Error).message}</UI.Alert>
        : !src.data ? <p className="small muted">匯出快照時讀不到這個檔案。請在 build 環境重新執行 codemap export。</p>
        : <UI.CodeView file={src.data.file} fileHref={vscodeURL(f.file, focus, p.ix.g.root, p.ix.g.host) ?? undefined}
            code={src.data.lines.join('\n')} start={src.data.start} target={focus} maxHeight="60vh" />}
      {p.isLive ? <UI.Button onClick={() => setWhole(whole ? null : selKey)}>{whole ? '只顯示這個函式' : '顯示整個檔案'}</UI.Button> : null}
    </UI.Card>
  )
}
