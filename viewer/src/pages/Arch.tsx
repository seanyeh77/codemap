import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import type { Doc, Edge, Link, Sel } from '../data/types'
import { CodeAt, LineLink } from './CodeAt'

/** One line per link: a pair of components can have calls and an environment variable at once. */
export const edgeId = (l: Link) => `${l.kind}:${l.a}->${l.b}`

/** The label on an inferred relation; `backticks` are code. */
function labelOf(l: Link) {
  if (l.kind === 'env') {
    const names = (l.names ?? []).map((n) => `\`${n}\``)
    return names.length ? `環境變數 ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` 等 ${names.length} 個` : ''}` : '環境變數'
  }
  if (l.kind === 'channel') return `經由 \`${l.via}\` 傳資料${l.label ? `（${l.label}）` : ''}`
  return `攔截 ${l.n} 次 \`${l.api}\` 呼叫`
}

/** The calls each component makes into a shared one: component -> its call edges, by caller. */
function usesOf(ix: Index, shared: string) {
  const out = new Map<string, Edge[]>()
  for (const e of ix.g.edges) {
    const a = ix.funcs[e.s]?.comp, b = ix.funcs[e.d]?.comp
    if (e.src === 'compiler' && b === shared && a && a !== shared) out.set(a, [...(out.get(a) ?? []), e])
  }
  return out
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
        selectedEdge={p.edge || null} onSelectEdge={(id) => p.onEdge(id ?? '')} listLabels={{ nodes: '元件', edges: '關係' }}
        label="元件和它們之間的呼叫" sizeLabel="{n} 個函式" sharedLabel="共用元件" sharedMeta="{a} 個元件使用，共 {b} 次"
        inferredText="函式指標、環境變數、`LD_PRELOAD` 攔截等編譯器看不到的關係，由原始碼文字推得。" />
      </div>
    </UI.Card>
  )
}

/** External calls that create, map or remove shared memory: who owns a channel's buffer. */
const LIFECYCLE = new Set(['shm_open', 'shm_unlink', 'mmap', 'munmap', 'ftruncate', 'mbind', 'unlink', 'open', 'close'])

const SHOWN = 30   // call sites listed for one line; the rest are counted

/** What one line of the diagram stands for, each with its source line: who sets and who reads an
 *  environment variable, which calls an LD_PRELOAD library hooks, or where the calls are made.
 *  A file:line shows its code at the bottom of this panel, so the diagram stays in view. */
export function EdgeDetail(p: { ix: Index; id: string; isLive: boolean; sourceId: string; open: (fid: string, edge: Sel['edge']) => void }) {
  const [shown, setShown] = useState<{ id: string; fid: string | null; f: string; l: number } | null>(null)
  const codeRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (shown) codeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [shown])
  const l = p.ix.g.links.find((x) => edgeId(x) === p.id)
  if (!l) return null
  const cur = shown?.id === p.id ? shown : null
  // the component of a file: the longest component path it sits under (setters can be scripts, not functions)
  const ids = p.ix.g.comps.map((c) => c.id).sort((x, y) => y.length - x.length)
  const compOf = (file: string) => ids.find((c) => file === c || file.startsWith(c + '/'))
  const at = (fid: string | null, file: string, line: number) => (
    <LineLink ix={p.ix} file={file} line={line} onOpen={() => setShown({ id: p.id, fid: fid && p.ix.funcs[fid] ? fid : null, f: file, l: line })} />
  )
  const name = (fid: string) => p.ix.funcs[fid]?.name ?? fid.split(':').pop()!
  let about = '', body: ReactNode = null
  if (l.kind === 'env') {
    about = `${l.a} 設定環境變數，${l.b} 執行時讀取它。編譯器看不到這種傳遞，所以這是推測的關係。`
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
    const hooks = [...new Set((l.sites ?? []).map((s) => s.name))].filter((n) => Object.values(p.ix.funcs).some((f) => f.comp === l.b && f.name === n)).sort()
    about = `${l.b} 以 LD_PRELOAD 載入後，攔截 ${l.a} 對 ${l.api} 函式的呼叫，共 ${l.n} 次，所以箭頭由呼叫的一方指向攔截的一方。這是推測的關係。`
      + (hooks.length ? `攔截用的同名函式共 ${hooks.length} 個，定義在 ${l.b}：${hooks.slice(0, 8).join('、')}${hooks.length > 8 ? ' 等' : ''}。` : '')
    body = <UI.DetailList items={(l.sites ?? []).slice(0, SHOWN).map((s) => ({ label: `${name(s.s)} 呼叫 ${s.name}`, value: at(s.s, s.f, s.l) }))} />
  } else if (l.kind === 'channel') {
    about = `${l.a} 經由 ${l.via} 把資料交給 ${l.b}${l.label ? `（${l.label}）` : ''}。這是在 .codemap/rules.json 宣告的資料通道，下面是兩邊各自使用 ${l.via} 的地方。`
    const uses = usesOf(p.ix, l.via ?? '')
    // who calls a function of the shared component, by component
    const usedBy = (fid: string) => [...new Set(p.ix.callers(fid).map((e) => p.ix.funcs[e.s]?.comp).filter((c) => c && c !== l.via))].join('、') || '—'
    const viaFuncs = Object.entries(p.ix.funcs).filter(([, f]) => f.comp === l.via)
    const life = viaFuncs.map(([id, f]) => [id, f, [...new Set(p.ix.callees(id, true).map((e) => e.dn ?? '').filter((n) => LIFECYCLE.has(n)))]] as const).filter(([, , xs]) => xs.length)
    const sync = viaFuncs.filter(([, f]) => f.atomics?.length)
    const facts = (
      <>
        {life.length ? (
          <section className="edge-group">
            <h3 className="small">建立與清除</h3>
            <UI.DetailList items={life.map(([id, f, xs]) => ({ label: `${f.name}（${xs.join('、')}）`, value: `由 ${usedBy(id)} 呼叫` }))} />
          </section>
        ) : null}
        {sync.length ? (
          <section className="edge-group">
            <h3 className="small">同步（atomic 操作）</h3>
            <UI.DetailList items={sync.map(([id, f]) => ({ label: f.name, value: `${f.atomics!.join('、')}；由 ${usedBy(id)} 呼叫` }))} />
          </section>
        ) : null}
      </>
    )
    body = [<div key="facts">{facts}</div>, ...[l.a, l.b].map((c) => (
      <section key={c} className="edge-group">
        <h3 className="small">{`${c} 使用`}</h3>
        <UI.DetailList items={(uses.get(c) ?? []).slice(0, SHOWN).map((e) => ({ label: `${name(e.s)} → ${name(e.d)}`, value: at(e.s, e.f, e.l) }))} />
      </section>
    ))]
  } else {
    about = `${l.a} 的函式呼叫 ${l.b} 的函式，共 ${l.n} 次，由編譯器確認。`
    const es = p.ix.g.edges.filter((e) => e.src === 'compiler' && p.ix.funcs[e.s]?.comp === l.a && p.ix.funcs[e.d]?.comp === l.b)
    body = <UI.DetailList items={es.slice(0, SHOWN).map((e) => ({ label: `${name(e.s)} → ${name(e.d)}`, value: at(e.s, e.f, e.l) }))} />
  }
  const total = l.kind === 'interpose' ? l.sites?.length ?? 0 : l.kind === 'call' ? l.n : 0
  return (
    <UI.Card className="detail" title={`${l.a} → ${l.b}`}>
      <p className="small">{about}</p>
      {body}
      {total > SHOWN ? <p className="small muted">{`另有 ${total - SHOWN} 處未列出。`}</p> : null}
      {cur ? (
        <div ref={codeRef} className="edge-code">
          <CodeAt ix={p.ix} at={cur} isLive={p.isLive} sourceId={p.sourceId} focus />
          {cur.fid ? <UI.Button icon="share-network" onClick={() => p.open(cur.fid!, { f: cur.f, l: cur.l })}>{`追蹤 ${name(cur.fid)} 的流程`}</UI.Button> : null}
        </div>
      ) : null}
    </UI.Card>
  )
}

export function CompDetail(p: { ix: Index; comp: string; onPick: (id: string) => void; onComp: (id: string) => void }) {
  if (!p.comp) return <Overview ix={p.ix} onComp={p.onComp} onPick={p.onPick} />
  return <CompTree {...p} />
}

const short = (t: string, n = 140) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t)

/** Where a comment came from, so a reader can check it. */
function From(p: { doc: Doc }) {
  return <span className="small muted">{`取自 ${p.doc.file}:${p.doc.line} 的註解`}</span>
}

/** Nothing selected: what each component is for, how the code is entered and left, and what the
 *  environment controls - the parts the diagram's boxes and lines do not say. */
function Overview(p: { ix: Index; onComp: (id: string) => void; onPick: (id: string) => void }) {
  const g = p.ix.g
  const fname = (ref: string) => { const hit = p.ix.at(ref); return hit ? p.ix.funcs[hit.id].name : null }
  const lifecycle = g.edges.filter((e) => e.k === 'constructor' || e.k === 'destructor').filter((e) => p.ix.funcs[e.d])
  const apis = new Map<string, number>()
  for (const f of Object.values(p.ix.funcs)) if (f.api) apis.set(f.api, (apis.get(f.api) ?? 0) + 1)
  // variables a C file reads: the ones that steer the program; the rest belong to scripts and tests
  const env = Object.entries(g.env ?? {}).filter(([, v]) => v.get.some((r) => /\.[ch]:\d+$/.test(r) && fname(r)))
  const others = Object.keys(g.env ?? {}).length - env.length
  const where = (refs: string[]) => refs.filter((r) => /\.[ch]:\d+$/.test(r)).map((r) => (fname(r) ? `${fname(r)}（${r.split('/').pop()}）` : r))
  return (
    <UI.Card className="detail fit overview" title="概觀">
      <p className="small muted">點選方塊查看函式，點選線查看依據。</p>
      <section>
        <h3 className="small">元件</h3>
        <UI.DetailList items={g.comps.map((c) => ({
          label: c.id,
          value: <span>{c.doc ? <>{short(c.doc.text)}<br /><From doc={c.doc} /><br /></> : <span className="muted">沒有說明註解。</span>}<button type="button" className="linklike" onClick={() => p.onComp(c.id)}>{`查看 ${c.id} 的函式`}</button></span>,
        }))} />
      </section>
      {lifecycle.length || apis.size ? (
        <section>
          <h3 className="small">進入與結束</h3>
          <UI.DetailList items={[
            ...lifecycle.map((e) => ({
              label: e.k === 'constructor' ? '載入時自動執行' : '結束時自動執行',
              value: <span><button type="button" className="linklike" onClick={() => p.onPick(e.d)}>{p.ix.funcs[e.d].name}</button>{`（${p.ix.funcs[e.d].comp}）`}</span>,
            })),
            ...[...apis].sort().map(([api, n]) => ({
              label: '外部進入點',
              value: `${n} 個函式攔截 ${api} 的同名函式（LD_PRELOAD）`,
            })),
          ]} />
        </section>
      ) : null}
      {env.length ? (
        <section>
          <h3 className="small">執行期設定（環境變數）</h3>
          <UI.DetailList items={env.map(([name, v]) => ({
            label: name,
            value: <span>{`讀取：${where(v.get).join('、') || '—'}`}{where(v.set).length ? <><br />{`設定：${where(v.set).join('、')}`}</> : null}</span>,
          }))} />
          {others > 0 ? <p className="small muted">{`另有 ${others} 個變數只出現在 Python 工具、測試或腳本裡，可用搜尋找到。`}</p> : null}
        </section>
      ) : null}
    </UI.Card>
  )
}

function CompTree(p: { ix: Index; comp: string; onPick: (id: string) => void }) {
  const docs = p.ix.g.files ?? {}
  const items = useMemo(() => {
    const files = [...p.ix.byFile()].filter(([, ids]) => p.ix.funcs[ids[0]].comp === p.comp).sort(([a], [b]) => a.localeCompare(b))
    return files.map(([f, ids]) => ({
      id: 'file:' + f, name: f.split('/').pop()!, path: f, icon: 'file-text' as const,
      meta: docs[f] && docs[f].file === f ? short(docs[f].text, 70) : undefined,
      children: ids.map((id) => ({
        id, name: p.ix.funcs[id].name, meta: `${p.ix.callerCount(id)} 個 caller`,
      })),
    }))
  }, [p.ix, p.comp, docs])
  const comp = p.ix.g.comps.find((c) => c.id === p.comp)
  const uses = useMemo(() => (comp?.shared ? usesOf(p.ix, p.comp) : null), [p.ix, p.comp, comp])
  const tree = (
    <UI.TreeList key={p.comp} kind="plain" title={p.comp} subtitle={`${items.length} 個檔案`} height="100%"
      label={p.comp + ' 的函式'} items={items} defaultOpen={items.map((i) => i.id)}
      onSelect={(n) => { if (p.ix.funcs[n.id]) p.onPick(n.id) }} />
  )
  if (!comp?.doc && !uses?.size) return <div className="detail tree-panel">{tree}</div>
  return (
    <div className="detail split">
      <UI.Card title={comp?.doc ? '用途' : `誰使用 ${p.comp}`}>
        {comp?.doc ? <p className="small">{comp.doc.text}<br /><From doc={comp.doc} /></p> : null}
        {uses?.size ? (
          <>
            {comp?.doc ? <h3 className="small">{`誰使用 ${p.comp}`}</h3> : null}
            {/* which of its functions each user calls shows which way data goes */}
            <UI.DetailList items={[...uses].sort(([a], [b]) => a.localeCompare(b)).map(([c, es]) => {
              const names = [...new Set(es.map((e) => p.ix.funcs[e.d].name))].sort()
              return { label: c, value: <span>{names.slice(0, 8).map((n, i) => <span key={n}>{i ? '、' : ''}<UI.InlineCode>{n}</UI.InlineCode></span>)}{names.length > 8 ? ` 等 ${names.length} 個` : ''}</span> }
            })} />
          </>
        ) : null}
      </UI.Card>
      <div className="tree-panel grow-panel">{tree}</div>
    </div>
  )
}
