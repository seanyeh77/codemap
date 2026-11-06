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
    if (!e) return <div className="card detail"><p className="muted">選擇函式以查看原始碼。</p></div>
    const name = p.ix.nameOf(p.sel.id, e)
    return (
      <div className="card detail">
        <h3 className="ttl">{name}</h3>
        <UI.DetailList items={[
          { label: '種類', value: p.ix.explain(e as Edge).title },   // only the flow tree selects a non-function, with its full edge
          ...(e.ext ? [{ label: '宣告', value: <UI.InlineCode>{e.ext}</UI.InlineCode> }] : []),
          { label: '呼叫位置', value: link(e.f, e.l) },
        ]} />
      </div>
    )
  }
  // the edge's line is inside this function only when looking up (it is this function's call)
  const inside = !!e && e.f === f.file && f.line <= e.l && e.l <= f.end
  const focus = inside ? e!.l : f.line
  const nCallers = p.ix.callerCount(p.sel.id), nCallees = p.ix.calleeCount(p.sel.id)
  const open = vscodeURL(f.file, focus, root, host)
  function link(file: string, line: number) {
    return <UI.InlineCode href={vscodeURL(file, line, root, host) ?? undefined}>{`${file}:${line}`}</UI.InlineCode>
  }
  return (
    <div className="card detail">
      <div className="row nowrap">
        <h3 className="ttl grow ellipsis" title={f.name}>{f.name}</h3>
        {open ? <UI.IconButton label="在 VS Code 開啟" icon="arrow-square-out" onClick={() => { location.href = open }} /> : null}
      </div>
      <UI.DetailList items={[
        { label: '定義', value: link(f.file, f.line) },
        { label: '元件', value: f.comp },
        { label: '關係', value: <span>{`${nCallers} 個 `}<UI.Term text="呼叫此函式的函式。">caller</UI.Term>{` · 呼叫 ${nCallees} 個 repo 內的函式`}</span> },
        ...(e && !inside ? [{ label: '呼叫位置', value: link(e.f, e.l) }] : []),
        ...(e && (e.via || e.slot) ? [{ label: '經由', value: <UI.InlineCode>{e.via || e.slot}</UI.InlineCode> }] : []),
      ]} />
      <UI.ActionBar actions={[
        { label: '追流程', primary: true, onClick: () => p.goFlow(p.sel.id) },
        { label: '看影響', onClick: () => p.goImpact(p.sel.id) },
        { label: '展開 macro', disabled: !p.canMacro },
      ]} />
      <div className="code" aria-label={`${f.name} 的原始碼`}>
        {src.isPending ? <div className="code-pad"><UI.Skeleton width="80%" height={16} /><UI.Skeleton width="60%" height={16} /><UI.Skeleton width="70%" height={16} /></div>
          : src.error ? <p className="code-pad small">{`無法讀取原始碼：${(src.error as Error).message}`}</p>
          : !src.data ? <p className="code-pad small muted">此快照不含原始碼。</p>
          : src.data.lines.map((t, i) => {
              const ln = src.data!.start + i
              return <div key={i} className={ln === focus ? 'hl' : ''}><span className="ln">{ln}</span>{t || ' '}</div>
            })}
      </div>
    </div>
  )
}
