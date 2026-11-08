import { useMemo, type ReactNode } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import type { Link, Sel } from '../data/types'
import { vscodeURL } from '../prefs'

/** One line per link: a pair of components can have calls and an environment variable at once. */
export const edgeId = (l: Link) => `${l.kind}:${l.a}->${l.b}`

/** The label on an inferred relation; `backticks` are code. */
function labelOf(l: Link) {
  if (l.kind === 'env') {
    const names = (l.names ?? []).map((n) => `\`${n}\``)
    return names.length ? `環境變數 ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` 等 ${names.length} 個` : ''}` : '環境變數'
  }
  return `攔截 ${l.n} 個 \`${l.api}\` 呼叫`
}

/** Components in layers with the calls between them, drawn by UI.LayerGraph; shared ones are listed under it. */
export function Arch(p: { ix: Index; sel: string; onSel: (id: string) => void; edge: string; onEdge: (id: string) => void }) {
  const g = p.ix.g
  const nodes = useMemo(() => g.comps.map((c) => ({ id: c.id, name: c.id, layer: c.layer ?? 0, size: c.funcs, shared: c.shared })), [g])
  const edges = useMemo(() => g.links.map((l) => (l.kind === 'call'
    ? { id: edgeId(l), from: l.a, to: l.b, count: l.n }
    : { id: edgeId(l), from: l.a, to: l.b, inferred: true, label: labelOf(l) })), [g])
  return (
    <UI.Card className="pane fit">
      <div data-tour="arch">
      <UI.LayerGraph nodes={nodes} edges={edges} selected={p.sel || null} onSelect={(id) => p.onSel(id ?? '')}
        selectedEdge={p.edge || null} onSelectEdge={(id) => p.onEdge(id ?? '')}
        label="元件和它們之間的呼叫" sizeLabel="{n} 個函式" sharedLabel="共用元件" sharedMeta="{a} 個元件使用，共 {b} 次"
        inferredText="函式指標、環境變數、`LD_PRELOAD` 攔截等編譯器看不到的關係，由原始碼文字推得。" />
      </div>
    </UI.Card>
  )
}

const SHOWN = 30   // call sites listed for one line; the rest are counted

/** What one line of the diagram stands for, each with its source line: who sets and who reads an
 *  environment variable, which calls an LD_PRELOAD library hooks, or where the calls are made. */
export function EdgeDetail(p: { ix: Index; id: string; open: (fid: string, edge: Sel['edge']) => void }) {
  const { root, host } = p.ix.g
  const l = p.ix.g.links.find((x) => edgeId(x) === p.id)
  if (!l) return null
  // the component of a file: the longest component path it sits under (setters can be scripts, not functions)
  const ids = p.ix.g.comps.map((c) => c.id).sort((x, y) => y.length - x.length)
  const compOf = (file: string) => ids.find((c) => file === c || file.startsWith(c + '/'))
  const at = (fid: string | null, file: string, line: number) => (
    <span className="row nowrap">
      <UI.InlineCode href={vscodeURL(file, line, root, host) ?? undefined}>{`${file}:${line}`}</UI.InlineCode>
      {fid && p.ix.funcs[fid] ? <UI.Button onClick={() => p.open(fid, { f: file, l: line })}>看這一行</UI.Button> : null}
    </span>
  )
  const name = (fid: string) => p.ix.funcs[fid]?.name ?? fid.split(':').pop()!
  let kind = '', body: ReactNode = null
  if (l.kind === 'env') {
    kind = '環境變數'
    const es = p.ix.g.edges.filter((e) => e.rule === 'env' && compOf(e.f) === l.a && e.read_at && compOf(e.read_at.split(':')[0]) === l.b)
    const vars = [...new Set(es.map((e) => e.name!))].sort()
    body = vars.map((v) => {
      const mine = es.filter((e) => e.name === v)
      return (
        <section key={v} className="edge-group">
          <h3 className="small"><UI.InlineCode>{v}</UI.InlineCode></h3>
          <UI.DetailList items={[
            ...[...new Map(mine.map((e) => [`${e.s}@${e.l}`, e])).values()].map((e) => ({ label: `設定：${name(e.s)}`, value: at(e.s, e.f, e.l) })),
            ...[...new Map(mine.map((e) => [`${e.d}@${e.read_at}`, e])).values()].map((e) => {
              const [f, ln] = [e.read_at!.slice(0, e.read_at!.lastIndexOf(':')), Number(e.read_at!.split(':').pop())]
              return { label: `讀取：${name(e.d)}`, value: at(e.d, f, ln) }
            }),
          ]} />
        </section>
      )
    })
  } else if (l.kind === 'interpose') {
    kind = `LD_PRELOAD 攔截 ${l.api}`
    body = <UI.DetailList items={(l.sites ?? []).slice(0, SHOWN).map((s) => ({ label: `${name(s.s)} 呼叫 ${s.name}`, value: at(s.s, s.f, s.l) }))} />
  } else {
    kind = `${l.n} 次呼叫`
    const es = p.ix.g.edges.filter((e) => e.src === 'compiler' && p.ix.funcs[e.s]?.comp === l.a && p.ix.funcs[e.d]?.comp === l.b)
    body = <UI.DetailList items={es.slice(0, SHOWN).map((e) => ({ label: `${name(e.s)} → ${name(e.d)}`, value: at(e.s, e.f, e.l) }))} />
  }
  const total = l.kind === 'interpose' ? l.sites?.length ?? 0 : l.kind === 'call' ? l.n : 0
  return (
    <UI.Card className="detail" title={`${l.a} → ${l.b}`}>
      <p className="small muted">{kind}</p>
      {body}
      {total > SHOWN ? <p className="small muted">{`另有 ${total - SHOWN} 處未列出。`}</p> : null}
    </UI.Card>
  )
}

export function CompDetail(p: { ix: Index; comp: string; onPick: (id: string) => void }) {
  if (!p.comp) return <UI.Card className="detail fit"><UI.EmptyState title="未選擇元件" description="點選方塊查看函式，點選線查看依據。" /></UI.Card>
  return <CompTree {...p} />
}

function CompTree(p: { ix: Index; comp: string; onPick: (id: string) => void }) {
  const items = useMemo(() => {
    const files = [...p.ix.byFile()].filter(([, ids]) => p.ix.funcs[ids[0]].comp === p.comp).sort(([a], [b]) => a.localeCompare(b))
    return files.map(([f, ids]) => ({
      id: 'file:' + f, name: f.split('/').pop()!, path: f, icon: 'file-text' as const,
      children: ids.map((id) => ({
        id, name: p.ix.funcs[id].name, meta: `${p.ix.callerCount(id)} 個 caller`,
      })),
    }))
  }, [p.ix, p.comp])
  // the tree is the whole panel: its own card, header and scrolling list
  return (
    <div className="detail tree-panel">
      <UI.TreeList key={p.comp} kind="plain" title={p.comp} subtitle={`${items.length} 個檔案`} height="100%"
        label={p.comp + ' 的函式'} items={items} defaultOpen={items.map((i) => i.id)}
        onSelect={(n) => { if (p.ix.funcs[n.id]) p.onPick(n.id) }} />
    </div>
  )
}
