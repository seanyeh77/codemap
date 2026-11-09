import { useMemo, useRef, useState, type ReactNode } from 'react'
import { UI } from '../ui'
import { list, t } from '../i18n'
import { revealTop } from '../scroll'
import { push, type Index } from '../data/graph'
import type { BuildInfo, Doc, Edge, FileWrite, Graph, Link, Sel } from '../data/types'
import { CodeAt, LineLink } from './CodeAt'

/** One line per link: a pair of components can have calls and an environment variable at once. */
export const edgeId = (l: Link) => `${l.kind}:${l.a}->${l.b}`

/** The label on an inferred relation; `backticks` are code. */
function labelOf(l: Link) {
  if (l.kind === 'env') {
    const names = (l.names ?? []).map((n) => `\`${n}\``)
    return names.length ? t('環境變數 {v1}{v2}', { v1: names.slice(0, 2).join(', '), v2: names.length > 2 ? t(' 等 {n} 個', { n: names.length }) : '' }) : t('環境變數')
  }
  if (l.kind === 'channel') return t('經由 `{v1}` 傳資料{v2}', { v1: l.via ?? '', v2: l.label ? t('（{v1}）', { v1: l.label }) : '' })
  if (l.kind === 'runs') return t('執行 {v1}', { v1: (l.names ?? []).map((n) => '`' + n + '`').join(', ') })
  if (l.kind === 'reads') return t('讀取 {v1} 的定義', { v1: (l.names ?? []).map((n) => '`' + n + '`').join(', ') })
  return t('攔截 {v1} 次 `{v2}` 呼叫', { v1: l.n, v2: l.api })
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
  const entries = useMemo(() => entryGroups(p.ix), [p.ix])
  const starts = useMemo(() => (entries.length ? launchers(p.ix) : []), [p.ix, entries])
  const nodes = useMemo(() => [
    ...(entries.length ? [{ id: TRACED, name: t('被追蹤的程式'), external: true }] : []),
    // Python tools start the C programs: a layer above them
    ...g.comps.map((c) => ({ id: c.id, name: c.lang ? t('{v1}（Python）', { v1: c.id }) : c.id,
      layer: c.lang ? 0 : (c.layer ?? 0) + (g.comps.some((x) => x.lang) ? 1 : 0), size: c.lang ? undefined : c.funcs, shared: c.shared }))], [g, entries])
  const edges = useMemo(() => [
    // what any program that loads the library with LD_PRELOAD reaches: one line per library interposed
    ...entries.map((x) => ({ id: x.id, from: TRACED, to: x.comp, inferred: true, label: t('攔截 `{api}`（{n} 個函式）', { api: x.api, n: x.ids.length }) })),
    // who starts the traced program: the order the whole system runs in
    ...starts.map((x) => ({ id: x.id, from: x.comp, to: TRACED, inferred: true,
      label: (x.preload ? t('啟動（{calls}），設定 LD_PRELOAD', { calls: [...x.calls].sort().join(', ') }) : t('啟動（{calls}）', { calls: [...x.calls].sort().join(', ') })) })),
    ...g.links.map((l) => (l.kind === 'call'
      ? { id: edgeId(l), from: l.a, to: l.b, count: l.n }
      : { id: edgeId(l), from: l.a, to: l.b, inferred: true, label: labelOf(l) }))], [g, entries, starts])
  return (
    <UI.Card className="pane fit">
      <UI.LayerGraph nodes={nodes} edges={edges} selected={p.sel || null} onSelect={(id) => p.onSel(id ?? '')}
        selectedEdge={p.edge || null} onSelectEdge={(id) => p.onEdge(id ?? '')} listLabels={{ nodes: t('元件'), edges: t('關係') }}
        externalLabel={t('repo 外')} label={t('元件和它們之間的呼叫')} sizeLabel={(n) => t('{n} 個函式', { n })} countLabel={(n) => t('{n} 次', { n })} sharedLabel={t('共用元件')} sharedMeta={t('{a} 個元件使用，共 {b} 次')}
        inferredText={t('函式指標、環境變數、`LD_PRELOAD` 攔截等編譯器看不到的關係，由原始碼文字推得。')} />
    </UI.Card>
  )
}

/** The box for programs outside the repo that load an interposing library (LD_PRELOAD). */
export const TRACED = 'ext:traced'

const SPAWN = new Set(['fork', 'vfork', 'execvp', 'execv', 'execve', 'execvpe', 'execl', 'execlp', 'execle', 'posix_spawn', 'posix_spawnp'])

/** Components that start another program (fork, exec): with an interposing library in the repo, the
 *  program they start is the traced one. [{ id, comp, calls: the exec-family names, sites }] */
export function launchers(ix: Index) {
  const m = new Map<string, { id: string; comp: string; calls: Set<string>; sites: Edge[]; preload: boolean }>()
  for (const e of ix.g.edges) {
    const f = ix.funcs[e.s], name = ix.bareName(e.d, e)
    if (!f || e.src !== 'compiler' || ix.funcs[e.d] || !SPAWN.has(name)) continue
    const id = `ext:launch->${f.comp}`
    if (!m.has(id)) m.set(id, { id, comp: f.comp, calls: new Set(), sites: [], preload: false })
    m.get(id)!.calls.add(name)
    m.get(id)!.sites.push(e)
  }
  // does it also set LD_PRELOAD (the library gets in that way)?
  const sets = ix.g.env?.LD_PRELOAD?.set ?? []
  for (const x of m.values()) x.preload = sets.some((r) => Object.values(ix.funcs).some((f) => f.comp === x.comp && r.startsWith(f.file + ':')))
  return [...m.values()]
}

/** Functions named like a library's (f.api), grouped by component and library: one line each from TRACED. */
export function entryGroups(ix: Index) {
  const m = new Map<string, { id: string; comp: string; api: string; ids: string[] }>()
  for (const [id, f] of Object.entries(ix.funcs)) {
    if (!f.api) continue
    const key = `ext:${f.api}->${f.comp}`
    if (!m.has(key)) m.set(key, { id: key, comp: f.comp, api: f.api, ids: [] })
    m.get(key)!.ids.push(id)
  }
  return [...m.values()].sort((a, b) => a.api.localeCompare(b.api))
}

/** A line from the traced program: the functions it reaches when it calls that library, or (the box) all of them. */
/** The line from a component to the traced program: where it forks and execs, and that it sets LD_PRELOAD. */
function LaunchDetail(p: { ix: Index; id: string; onPick: (id: string, at: Sel['edge']) => void; onBack: () => void }) {
  const x = launchers(p.ix).find((l) => l.id === p.id)
  if (!x) return null
  const sets = (p.ix.g.env?.LD_PRELOAD?.set ?? []).filter((r) => /\.[ch]:\d+$/.test(r))
  return (
    <UI.Card className="detail" title={t('{v1} → 被追蹤的程式', { v1: x.comp })} actions={<UI.Button icon="arrow-left" onClick={p.onBack}>{t('回到概觀')}</UI.Button>}>
      <p>{x.preload ? t('{v1} 以 {calls} 啟動被追蹤的程式，並設定 LD_PRELOAD 讓它載入 repo 裡的程式庫。這是推測的關係。', { v1: x.comp, calls: [...x.calls].sort().join(', ') })
        : t('{v1} 以 {calls} 啟動另一個程式，可能就是被追蹤的程式。這是推測的關係。', { v1: x.comp, calls: [...x.calls].sort().join(', ') })}</p>
      <UI.DetailList items={[
        ...x.sites.map((e) => ({ label: `${e.f.split('/').pop()}:${e.l}`, value: <span><button type="button" className="linklike" onClick={() => p.onPick(e.s, { f: e.f, l: e.l })}>{p.ix.funcs[e.s].name}</button>{t(' 呼叫 {v1}', { v1: p.ix.bareName(e.d, e) })}</span> })),
        ...sets.map((r) => ({ label: r.split('/').pop()!, value: t('設定 LD_PRELOAD') })),
      ]} />
    </UI.Card>
  )
}

function EntryDetail(p: { ix: Index; id: string; onPick: (id: string) => void; onBack: () => void }) {
  const groups = entryGroups(p.ix).filter((x) => p.id === TRACED || x.id === p.id)
  const fn = (id: string) => <button type="button" className="linklike" onClick={() => p.onPick(id)}>{p.ix.funcs[id].name}</button>
  return (
    <UI.Card className="detail" title={p.id === TRACED ? t('被追蹤的程式（repo 外）') : t('被追蹤的程式 → {v1}', { v1: groups[0]?.comp ?? '' })}
      actions={<UI.Button icon="arrow-left" onClick={p.onBack}>{t('回到概觀')}</UI.Button>}>
      <p>{t('以 LD_PRELOAD 載入 repo 程式庫的程式，呼叫下列同名函式時會先執行 repo 裡的版本。這是推測的關係。')}</p>
      {((xs) => xs.length ? <p className="small muted">{t('repo 裡的 {v1} 也會被這樣追蹤：見它連到 {v2} 的線。', { v1: list(xs.map((l) => l.a)), v2: list([...new Set(xs.map((l) => l.b))]) })}</p> : null)(p.ix.g.links.filter((l) => l.kind === 'interpose'))}
      {((xs) => xs.length ? <p className="small muted">{t('啟動它的是 {v1}。', { v1: list(xs.map((x) => x.comp)) })}</p> : null)(launchers(p.ix))}
      {((n) => n ? <p className="small muted">{t('另有 {n} 個函式被裝進函式指標或表格，由被追蹤的程式經由指標呼叫，不在這份清單裡。', { n })}</p> : null)(
        Object.keys(p.ix.funcs).filter((id) => !p.ix.funcs[id].api && p.ix.callers(id).some((e) => e.k === 'fnptr_assign' || e.k === 'fnptr_table')).length)}
      {groups.map((x) => (
        <section key={x.id}>
          <h3 className="small">{t('攔截 {api} 的 {n} 個函式（{comp}）', { api: x.api, n: x.ids.length, comp: x.comp })}</h3>
          <UI.DetailList items={x.ids.sort((a, b) => p.ix.funcs[a].name.localeCompare(p.ix.funcs[b].name)).map((id) => ({
            label: `${p.ix.funcs[id].file.split('/').pop()}:${p.ix.funcs[id].line}`,
            value: fn(id),
          }))} />
        </section>
      ))}
    </UI.Card>
  )
}

/** External calls that create, map or remove shared memory: who owns a channel's buffer. */
const LIFECYCLE = new Set(['shm_open', 'shm_unlink', 'mmap', 'munmap', 'ftruncate', 'mbind', 'unlink', 'open', 'close'])

const SHOWN = 30   // call sites listed for one line; the rest are counted

/** What one line of the diagram stands for, each with its source line: who sets and who reads an
 *  environment variable, which calls an LD_PRELOAD library hooks, or where the calls are made.
 *  A file:line shows its code right under its row, so on a phone it does not open out of sight. */
export function EdgeDetail(p: { ix: Index; id: string; isLive: boolean; sourceId: string; open: (fid: string, edge: Sel['edge']) => void; onBack: () => void }) {
  const [shown, setShown] = useState<{ id: string; key: string; fid: string | null; f: string; l: number } | null>(null)
  const codeRef = useRef<HTMLDivElement>(null)
  const l = p.ix.g.links.find((x) => edgeId(x) === p.id)
  if (p.id.startsWith('ext:launch->')) return <LaunchDetail ix={p.ix} id={p.id} onPick={(id, at) => p.open(id, at)} onBack={p.onBack} />
  if (p.id.startsWith('ext:')) return <EntryDetail ix={p.ix} id={p.id} onPick={(id) => p.open(id, null)} onBack={p.onBack} />
  if (!l) return null
  const cur = shown?.id === p.id ? shown : null
  // the component of a file: the longest component path it sits under (setters can be scripts, not functions)
  const ids = p.ix.g.comps.map((c) => c.id).sort((x, y) => y.length - x.length)
  const compOf = (file: string) => ids.find((c) => file === c || file.startsWith(c + '/'))
  const name = (fid: string) => p.ix.funcs[fid]?.name ?? fid.split(':').pop()!
  const at = (fid: string | null, file: string, line: number) => {
    const key = `${fid}@${file}:${line}`
    const open = cur?.key === key ? cur : null
    return (
      <>
        <LineLink ix={p.ix} file={file} line={line} onOpen={() => setShown(open ? null : { id: p.id, key, fid: fid && p.ix.funcs[fid] ? fid : null, f: file, l: line })} />
        {open ? (
          <div ref={codeRef} className="edge-code row-code">
            <CodeAt ix={p.ix} at={open} isLive={p.isLive} sourceId={p.sourceId} focus />
            {open.fid ? <UI.Button icon="share-network" onClick={() => p.open(open.fid!, { f: open.f, l: open.l })}>{t('追蹤 {v1} 的流程', { v1: name(open.fid) })}</UI.Button> : null}
          </div>
        ) : null}
      </>
    )
  }
  let about = '', body: ReactNode = null
  if (l.kind === 'env') {
    about = t('{v1} 設定環境變數，{v2} 執行時讀取它。這是推測的關係。', { v1: l.a, v2: l.b })
    const es = p.ix.g.edges.filter((e) => e.rule === 'env' && compOf(e.f) === l.a && e.read_at && compOf(e.read_at.split(':')[0]) === l.b)
    const vars = [...new Set(es.map((e) => e.name!))].sort()
    body = vars.map((v) => {
      const mine = es.filter((e) => e.name === v)
      return (
        <section key={v} className="edge-group">
          <h3 className="small"><UI.InlineCode>{v}</UI.InlineCode></h3>
          <UI.DetailList items={[
            ...[...new Map(mine.map((e) => [`${e.s}@${e.l}`, e])).values()].map((e) => ({ label: t('設定：{v1}', { v1: name(e.s) }), value: at(e.s, e.f, e.l) })),
            ...[...new Map(mine.map((e) => [`${e.d}@${e.read_at}`, e])).values()].map((e) => {
              const [f, ln] = [e.read_at!.slice(0, e.read_at!.lastIndexOf(':')), Number(e.read_at!.split(':').pop())]
              return { label: t('讀取：{v1}', { v1: name(e.d) }), value: at(e.d, f, ln) }
            }),
          ]} />
        </section>
      )
    })
  } else if (l.kind === 'interpose') {
    const hooks = [...new Set((l.sites ?? []).map((s) => s.name))].filter((n) => Object.values(p.ix.funcs).some((f) => f.comp === l.b && f.name === n)).sort()
    about = t('{v1} 以 LD_PRELOAD 載入後，攔截 {v2} 對 {v3} 函式的 {v4} 次呼叫，箭頭由呼叫方指向攔截方。這是推測的關係。', { v1: l.b, v2: l.a, v3: l.api, v4: l.n })
      + (hooks.length ? t('{v1} 呼叫到的同名函式有 {v2} 個，定義在 {v3}：{v4}{v5}。', { v1: l.a, v2: hooks.length, v3: l.b, v4: hooks.slice(0, 8).join(t('、')), v5: hooks.length > 8 ? t(' 等') : '' }) : '')
      + ((n) => n > hooks.length ? t('{v1} 一共定義了 {v2} 個 {v3} 同名函式，其餘的 {v4} 沒有呼叫。', { v1: l.b, v2: n, v3: l.api, v4: l.a }) : '')(Object.values(p.ix.funcs).filter((f) => f.comp === l.b && f.api === l.api).length)
    body = <UI.DetailList items={(l.sites ?? []).slice(0, SHOWN).map((s) => ({ label: t('{v1} 呼叫 {v2}', { v1: name(s.s), v2: s.name }), value: at(s.s, s.f, s.l) }))} />
  } else if (l.kind === 'runs' || l.kind === 'reads') {
    about = l.kind === 'runs'
      ? t('{v1} 的 Python 工具以 subprocess 啟動 {v3} 編出的 {v2}。這是推測的關係，下面列出啟動的地方。', { v1: l.a, v2: list(l.names ?? []), v3: l.b })
      : t('{v1} 的 Python 工具讀取 {v2} 裡的 {v3}，兩邊要一起改。這是推測的關係。', { v1: l.a, v2: l.b, v3: list(l.names ?? []) })
    body = <UI.DetailList items={(l.sites ?? []).slice(0, SHOWN).map((s) => ({ label: `${s.f.split('/').pop()}:${s.l}`, value: <span>{t('{v1} 使用 {v2}：', { v1: name(s.s), v2: s.name })}{at(null, s.f, s.l)}</span> }))} />
  } else if (l.kind === 'channel') {
    about = t('{v1} 經由 {v2} 把資料交給 {v3}{v4}', { v1: l.a, v2: l.via ?? '', v3: l.b, v4: l.label ? t('（{v1}）', { v1: l.label }) : '' })
      + t('。這是在 .codemap/rules.json 宣告的資料通道，下面是兩邊各自使用 {v1} 的地方。', { v1: l.via ?? '' })
    const uses = usesOf(p.ix, l.via ?? '')
    // who calls a function of the shared component, by component
    // who reaches a function of the shared component, also through its other functions (ibt_attach -> ibt_ring_map -> ibt_ring_open_placed)
    const usedBy = (fid: string) => {
      const comps = new Map<string, string>(), seen = new Set([fid]), todo = [fid]
      while (todo.length) {
        const cur = todo.pop()!
        for (const e of p.ix.callers(cur)) {
          const c = p.ix.funcs[e.s]?.comp
          if (!c) continue
          if (c === l.via) { if (!seen.has(e.s)) { seen.add(e.s); todo.push(e.s) } }
          else if (!comps.has(c)) comps.set(c, cur === fid ? '' : p.ix.funcs[cur].name)
        }
      }
      return comps.size ? t('由 {v1} 呼叫', { v1: [...comps].map(([c, via]) => via ? t('{v1}（經由 {v2}）', { v1: c, v2: via }) : c).join(t('、')) }) : t('沒有其他元件呼叫它')
    }
    const viaFuncs = Object.entries(p.ix.funcs).filter(([, f]) => f.comp === l.via)
    const life = viaFuncs.map(([id, f]) => [id, f, [...new Set(p.ix.callees(id, true).map((e) => e.dn ?? '').filter((n) => LIFECYCLE.has(n)))]] as const).filter(([, , xs]) => xs.length)
    // the atomics inside the channel, and those of each side's own functions that use it (the reader's acquire load)
    const touches = (id: string) => p.ix.callees(id, false).some((e) => p.ix.funcs[e.d]?.comp === l.via)
    const sync = [...viaFuncs, ...Object.entries(p.ix.funcs).filter(([id, f]) => (f.comp === l.a || f.comp === l.b) && touches(id))].filter(([, f]) => f.atomics?.length)
    // what the channel is made of, from the system calls that create it
    const made = new Set(life.flatMap(([, , xs]) => xs))
    const kind = made.has('shm_open') ? t('{v1} 是 POSIX shared memory：以 shm_open 建立，mmap 對應進兩個程序，兩邊讀寫同一塊記憶體。', { v1: l.label || l.via || '' })
      : made.has('mmap') ? t('{v1} 是以 mmap 對應的共享記憶體。', { v1: l.label || l.via || '' })
      : made.has('pipe') || made.has('socket') ? t('{v1} 經由 pipe 或 socket 傳送。', { v1: l.label || l.via || '' }) : ''
    const facts = (
      <>
        {kind ? <p className="small">{kind}</p> : null}
        {life.length ? (
          <section className="edge-group">
            <h3 className="small">{t('建立與清除')}</h3>
            <UI.DetailList items={life.map(([id, f, xs]) => ({ label: f.name, value: <span>{t('呼叫 {v1}；{v2}', { v1: xs.join(t('、')), v2: usedBy(id) })}<br /><UI.InlineCode>{`${f.file.split('/').pop()}:${f.line}`}</UI.InlineCode></span> }))} />
          </section>
        ) : null}
        {sync.length ? (
          <section className="edge-group">
            <h3 className="small">{t('同步（atomic 操作）')}</h3>
            <UI.DetailList items={sync.map(([id, f]) => ({ label: f.name, value: <span>{f.comp === l.via ? t('{v1}；{v2}', { v1: f.atomics!.join(t('、')), v2: usedBy(id) }) : t('{v1}；{v2} 自己的函式', { v1: f.atomics!.join(t('、')), v2: f.comp })}<br /><UI.InlineCode>{`${f.file.split('/').pop()}:${f.line}`}</UI.InlineCode></span> }))} />
          </section>
        ) : null}
      </>
    )
    body = [<div key="facts">{facts}</div>, ...[l.a, l.b].map((c) => (
      <section key={c} className="edge-group">
        <h3 className="small">{t('{v1} 使用', { v1: c })}</h3>
        <UI.DetailList items={(uses.get(c) ?? []).slice(0, SHOWN).map((e) => ({ label: `${name(e.s)} → ${name(e.d)}`, value: at(e.s, e.f, e.l) }))} />
      </section>
    ))]
  } else {
    about = t('{v1} 的函式呼叫 {v2} 的函式，共 {v3} 次，由編譯器確認。', { v1: l.a, v2: l.b, v3: l.n })
    const es = p.ix.g.edges.filter((e) => e.src === 'compiler' && p.ix.funcs[e.s]?.comp === l.a && p.ix.funcs[e.d]?.comp === l.b)
    body = <UI.DetailList items={es.slice(0, SHOWN).map((e) => ({ label: `${name(e.s)} → ${name(e.d)}`, value: at(e.s, e.f, e.l) }))} />
  }
  const total = l.kind === 'interpose' || l.kind === 'runs' || l.kind === 'reads' ? l.sites?.length ?? 0 : l.kind === 'call' ? l.n : 0
  return (
    <UI.Card className="detail" title={`${l.a} → ${l.b}`} actions={<UI.Button icon="arrow-left" onClick={p.onBack}>{t('回到概觀')}</UI.Button>}>
      <p className="small">{about}</p>
      {body}
      {total > SHOWN ? <p className="small muted">{t('另有 {v1} 處未列出。', { v1: total - SHOWN })}</p> : null}
    </UI.Card>
  )
}

export function CompDetail(p: { ix: Index; comp: string; isLive: boolean; sourceId: string; onPick: (id: string) => void; onComp: (id: string) => void }) {
  if (p.comp === TRACED) return <EntryDetail ix={p.ix} id={TRACED} onPick={p.onPick} onBack={() => p.onComp('')} />
  const c = p.ix.g.comps.find((x) => x.id === p.comp)
  if (c?.lang) return <ScriptsDetail ix={p.ix} comp={c.id} isLive={p.isLive} sourceId={p.sourceId} onBack={() => p.onComp('')} />
  if (!p.comp) return <Overview ix={p.ix} isLive={p.isLive} sourceId={p.sourceId} onComp={p.onComp} onPick={p.onPick} />
  return <CompTree {...p} onBack={() => p.onComp('')} />
}

/** A group of Python tools: each script with the first line of its docstring; click to read it. */
function ScriptsDetail(p: { ix: Index; comp: string; isLive: boolean; sourceId: string; onBack: () => void }) {
  const c = p.ix.g.comps.find((x) => x.id === p.comp)!
  const runs = p.ix.g.links.filter((l) => l.a === c.id)
  const [shown, setShown] = useState<string | null>(null)
  return (
    <UI.Card className="detail" title={t('{v1}（Python）', { v1: c.id })} actions={<UI.Button icon="arrow-left" onClick={p.onBack}>{t('回到概觀')}</UI.Button>}>
      <p className="small">{t('Python 工具，{v1} 個檔案。codemap 不索引 Python 的呼叫，只列出檔案、啟動的程式和讀取的標頭檔。', { v1: c.files })}</p>
      {runs.length ? <p className="small">{list(runs.map((l) => labelOf(l).replace(/`/g, '') + ' → ' + l.b))}</p> : null}
      <UI.DetailList items={(c.scripts ?? []).map((f) => ({
        label: f.slice(c.id.length + 1),
        value: <span>{c.docs?.[f] ?? t('沒有說明註解。')}{' '}
          <LineLink ix={p.ix} file={f} line={1} onOpen={() => setShown(shown === f ? null : f)} />
          {shown === f ? <div className="row-code"><CodeAt ix={p.ix} at={{ f, l: 1 }} isLive={p.isLive} sourceId={p.sourceId} focus /></div> : null}</span>,
      }))} />
    </UI.Card>
  )
}

const short = (t: string, n = 140) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t)

/** Where a comment came from, so a reader can check it. */
function From(p: { doc: Doc }) {
  return <span className="small muted">{p.doc.own ? t('專案在 .codemap/rules.json 寫的說明') : t('取自 {v1}:{v2} 的註解', { v1: p.doc.file, v2: p.doc.line })}</span>
}

/** Nothing selected: what each component is for, how the code is entered and left, and what the
 *  environment controls - the parts the diagram's boxes and lines do not say. */
function Overview(p: { ix: Index; isLive: boolean; sourceId: string; onComp: (id: string) => void; onPick: (id: string) => void }) {
  const g = p.ix.g
  // a file:line opens its code right under the row it is in, not at the end of the panel
  const [shown, setShown] = useState<string | null>(null)
  const [openApi, setOpenApi] = useState<string | null>(null)
  const at = (key: string, f: string, l: number) => (
    <>
      <LineLink ix={p.ix} file={f} line={l} onOpen={() => setShown(shown === key ? null : key)} />
      {shown === key ? <div className="row-code"><CodeAt ix={p.ix} at={{ f, l }} isLive={p.isLive} sourceId={p.sourceId} focus /></div> : null}
    </>
  )
  // a function's name opens the flow page: the arrow says so before the click
  const fn = (id: string) => p.ix.funcs[id]
    ? <button type="button" className="linklike to-flow" title={t('在流程頁開啟')} onClick={() => p.onPick(id)}>{p.ix.funcs[id].name}<UI.Icon name="arrow-right" size={14} /></button>
    : <UI.InlineCode>{id}</UI.InlineCode>
  const fname = (ref: string) => { const hit = p.ix.at(ref); return hit ? p.ix.funcs[hit.id].name : null }
  const lifecycle = g.edges.filter((e) => e.k === 'constructor' || e.k === 'destructor').filter((e) => p.ix.funcs[e.d])
  const apis = new Map<string, number>()
  for (const f of Object.values(p.ix.funcs)) if (f.api) apis.set(f.api, (apis.get(f.api) ?? 0) + 1)
  // functions nothing in the repo calls directly, put into a function pointer that code outside the repo calls
  // (an ops table, a UCT table, a signal handler): grouped by the function that installs them
  const installed = new Map<string, string[]>()
  for (const [id, f] of Object.entries(p.ix.funcs)) {
    if (f.api) continue
    const by = p.ix.callers(id)
    if (by.some((e) => e.src === 'compiler' && p.ix.funcs[e.s])) continue
    const put = by.find((e) => e.k === 'fnptr_assign' && p.ix.funcs[e.s])
    if (put) push(installed, put.s, id)
  }
  const line = (id: string, key: string) => <>{fn(id)}{' '}{at(key, p.ix.funcs[id].file, p.ix.funcs[id].line)}</>
  // variables a C file reads: the ones that steer the program; the rest belong to scripts and tests
  const env = Object.entries(g.env ?? {}).filter(([, v]) => v.get.some((r) => /\.[ch]:\d+$/.test(r) && fname(r)))
  const others = Object.keys(g.env ?? {}).length - env.length
  const where = (refs: string[]) => refs.filter((r) => /\.[ch]:\d+$/.test(r)).map((r) => (fname(r) ? t('{v1}（{v2}）', { v1: fname(r), v2: r.split('/').pop() }) : r))
  return (
    <UI.Card className="detail fit overview" title={t('概觀')}>
      <p className="small muted">{t('點選方塊查看函式，點選線查看依據。')}</p>
      <nav className="toc" aria-label={t('概觀的段落')} data-tour="arch">
        {TOC.filter(([id]) => id !== 'ov-entry' || lifecycle.length || apis.size).filter(([id]) => id !== 'ov-env' || env.length)
          .filter(([id]) => id !== 'ov-build' || g.build).filter(([id]) => id !== 'ov-writes' || g.writes).filter(([id]) => id !== 'ov-worth' || g.worth)
          .map(([id, label]) => <button key={id} type="button" className="linklike" onClick={() => jump(id)}>{t(label)}</button>)}
      </nav>
      <section>
        <h3 className="small" id="ov-comps" tabIndex={-1}>{t('元件')}</h3>
        <UI.DetailList items={g.comps.map((c) => ({
          label: c.id,
          value: <span>{c.doc ? <>{short(c.doc.text)}<br /><From doc={c.doc} /><br /></> : <span className="muted">{t('沒有說明註解。')}</span>}<button type="button" className="linklike" onClick={() => p.onComp(c.id)}>{c.lang ? t('查看 {v1} 的 Python 工具', { v1: c.id }) : t('查看 {v1} 的函式', { v1: c.id })}</button></span>,
        }))} />
        {g.comps.some((c) => !c.doc?.own) ? <p className="small muted">{t('沒有專案寫的說明時，顯示元件主要檔案的開頭註解。元件的用途可寫在 .codemap/rules.json 的 describe。')}</p> : null}
      </section>
      {lifecycle.length || apis.size || installed.size ? (
        <section>
          <h3 className="small" id="ov-entry" tabIndex={-1}>{t('進入與結束')}</h3>
          <UI.DetailList items={[
            ...lifecycle.map((e, i) => ({
              label: e.k === 'constructor' ? t('載入時自動執行') : t('結束時自動執行'),
              value: <span><button type="button" className="linklike" onClick={() => p.onPick(e.d)}>{p.ix.funcs[e.d].name}</button>{t('（{v1}）', { v1: p.ix.funcs[e.d].comp })}{' '}{at(`life${i}`, p.ix.funcs[e.d].file, p.ix.funcs[e.d].line)}</span>,
            })),
            ...[...apis].sort().map(([api, n]) => ({
              label: t('外部進入點'),
              value: <span>
                <button type="button" className="linklike" aria-expanded={openApi === api} onClick={() => setOpenApi(openApi === api ? null : api)}>{t('{v1} 個函式攔截 {v2} 的同名函式（LD_PRELOAD）', { v1: n, v2: api })}</button>
                {openApi === api ? <span className="entry-list">{Object.entries(p.ix.funcs).filter(([, f]) => f.api === api).sort(([, a], [, b]) => a.name.localeCompare(b.name)).map(([id]) => <span key={id} className="entry-row">{line(id, 'api' + id)}</span>)}</span> : null}
              </span>,
            })),
            ...(installed.size ? [{
              label: t('經由函式指標進入'),
              value: <span>
                <button type="button" className="linklike" aria-expanded={openApi === '*ptr'} onClick={() => setOpenApi(openApi === '*ptr' ? null : '*ptr')}>{t('{v1} 個函式只被裝進函式指標，由 repo 外呼叫（推測）', { v1: [...installed.values()].flat().length })}</button>
                {openApi === '*ptr' ? <span className="entry-list">{[...installed].sort(([, a], [, b]) => b.length - a.length).map(([by, ids]) => (
                  <span key={by} className="entry-row"><span className="muted">{t('{v1} 裝入：', { v1: p.ix.funcs[by].name })}</span>
                    {[...ids].sort((a, b) => p.ix.funcs[a].name.localeCompare(p.ix.funcs[b].name)).map((id) => <span key={id} className="entry-row indent">{line(id, 'ins' + id)}</span>)}</span>))}</span> : null}
              </span>,
            }] : []),
          ]} />
        </section>
      ) : null}
      {env.length ? (
        <section>
          <h3 className="small" id="ov-env" tabIndex={-1}>{t('執行期設定（環境變數）')}</h3>
          <UI.DetailList items={env.map(([name, v]) => ({
            label: name,
            value: <span>{((m) => m ? <>{meaning(m)}<br /></> : null)(g.env_info?.[name])}{t('讀取：{v1}', { v1: where(v.get).join(t('、')) || '—' })}{where(v.set).length ? <><br />{t('設定：{v1}', { v1: where(v.set).join(t('、')) })}</> : null}{((n) => n ? <><br /><span className="muted">{t('另有 {v1} 處在 Python 工具、測試或腳本裡，可用搜尋找到', { v1: n })}</span></> : null)([...v.get, ...v.set].filter((r) => !/\.[ch]:\d+$/.test(r)).length)}</span>,
          }))} />
          {others > 0 ? <p className="small muted">{t('另有 {v1} 個變數只出現在 Python 工具、測試或腳本裡，可用搜尋找到。', { v1: others })}</p> : null}
        </section>
      ) : null}
      {g.build ? <Products build={g.build} at={at} /> : null}
      {g.writes ? <Writes writes={g.writes} at={at} fn={fn} /> : null}
      {g.worth ? (
        <section>
          <h3 className="small" id="ov-worth" tabIndex={-1}>{t('值得檢查的地方')}</h3>
          <p className="small muted">{t('只列出程式碼裡的事實，是否有問題要看實際用法。')}</p>
          <h4 className="small" id="ov-stops" tabIndex={-1}>{t('結束程式的呼叫')}</h4>
          {g.worth.stops.length ? <UI.DetailList items={g.worth.stops.map((s, i) => ({
            label: `${s.name}()`,
            value: <span>{fn(s.fid)}{t(' 呼叫：')}{at(`stop${i}`, s.f, s.l)}</span>,
          }))} /> : <p className="small muted">{t('沒有呼叫 abort、exit 或 _exit 的地方。')}</p>}
          <h4 className="small" id="ov-arrays" tabIndex={-1}>{t('固定大小的全域陣列')}</h4>
          {g.worth.arrays.length ? <UI.DetailList items={g.worth.arrays.map((a, i) => ({
            label: a.name,
            value: <span>{a.value ? t('上限 {v1} 個（{v2}）：', { v1: a.value, v2: a.size.slice(1, -1).split('][').join(' × ') }) : /^(\[\d+\])+$/.test(a.size) ? t('上限 {v1} 個：', { v1: a.size.replace(/[[\]]/g, ' ').trim().split(/\s+/).join(' × ') }) : t('上限 {v1} 個：', { v1: a.size.slice(1, -1).split('][').join(' × ') })}{at(`arr${i}`, a.file, a.line)}</span>,
          }))} /> : <p className="small muted">{t('沒有以常數決定大小的全域陣列。')}</p>}
          {((n) => n ? <p className="small muted">{t('其中 {v1} 個的上限是 enum 或運算式，沒有算成數字。', { v1: n })}</p> : null)(g.worth.arrays.filter((a) => !a.value && !/^(\[\d+\])+$/.test(a.size)).length)}
          <h4 className="small" id="ov-unset" tabIndex={-1}>{t('只在未設定時才設定的環境變數')}</h4>
          {g.worth.env_if_unset?.length ? <UI.DetailList items={g.worth.env_if_unset.map((e, i) => ({
            label: e.name,
            // the link goes to the check: the set is a few lines below it, in view
            value: e.check !== e.l
              ? <span>{fn(e.fid)}{t(' 先檢查是否已設定：')}{at(`unset${i}`, e.f, e.check)}{t('；未設定時才設定：')}{at(`unset${i}s`, e.f, e.l)}</span>
              : <span>{fn(e.fid)}{t(' 以 setenv 的第三個參數 0 設定，已設定時就不改：')}{at(`unset${i}`, e.f, e.check)}</span>,
          }))} /> : <p className="small muted">{t('沒有找到。')}</p>}
          <h4 className="small" id="ov-errors" tabIndex={-1}>{t('回傳固定錯誤碼的地方')}</h4>
          {g.worth.errors?.length ? <UI.DetailList items={g.worth.errors.map((e, i) => ({
            label: e.code,
            value: <span>{fn(e.fid)}{p.ix.funcs[e.fid]?.api ? t('（外部進入點）') : p.ix.callers(e.fid).some((x) => x.k === 'fnptr_assign' || x.k === 'fnptr_table') ? t('（裝進函式指標）') : ''}{e.how === 'errno' ? t(' 設定 errno：') : t(' 回傳：')}{at(`err${i}`, e.f, e.l)}</span>,
          }))} /> : <p className="small muted">{t('沒有找到。')}</p>}
          <h4 className="small" id="ov-plain" tabIndex={-1}>{t('不經 atomic 操作就修改的全域變數')}</h4>
          {g.worth.plain_writes?.length ? <>
            <p className="small muted">{t('沒有判斷是否有鎖保護或只在單一執行緒執行。標「載入時」的寫入在 constructor 裡，通常早於其他執行緒。')}</p>
            <UI.DetailList items={[...g.worth.plain_writes].sort((a, b) => Number(a.writes.every((w) => p.ix.callerInfo(w.fid).load)) - Number(b.writes.every((w) => p.ix.callerInfo(w.fid).load))).map((v, i) => ({
              label: v.name,
              value: <span>{v.writes.map((w, j) => (
                <span key={j} className="write-row">{fn(w.fid)}{p.ix.callerInfo(w.fid).load === 'constructor' ? t('（載入時）') : p.ix.callerInfo(w.fid).load === 'destructor' ? t('（結束時）') : ''}{t('：')}<code className="small">{w.text}</code>{' '}{at(`pw${i}-${j}`, w.f, w.l)}</span>))}</span>,
            }))} />
          </> : <p className="small muted">{t('沒有找到。')}</p>}
          <h4 className="small" id="ov-nullenv" tabIndex={-1}>{t('沒有先檢查 NULL 就使用的 getenv 結果')}</h4>
          {g.worth.env.length ? <UI.DetailList items={g.worth.env.map((e, i) => ({
            label: e.name ?? t('（名稱執行時決定）'),
            value: <span>{fn(e.fid)}{e.use !== e.l ? t(' 在第 {v1} 行使用：', { v1: e.use }) : t(' 直接使用：')}{at(`env${i}`, e.f, e.l)}</span>,
          }))} /> : <p className="small muted">{t('沒有找到。每個 getenv 的結果在使用前都檢查過 NULL，或直接回傳給呼叫者。')}</p>}
        </section>
      ) : null}
    </UI.Card>
  )
}

/** What a variable does, from the code (or the project's own words in .codemap/rules.json). */
function meaning(m: NonNullable<Graph['env_info']>[string]): ReactNode {
  const kind = m.kind === 'flag' ? t('開關，0 為關閉、其他數字為開啟') : m.kind === 'number' ? t('數字') : m.kind === 'presence' ? t('只看是否已設定') : m.kind === 'text' ? t('文字') : ''
  const unset = !m.default ? '' : m.default === 'on' ? t('開啟') : m.default === 'off' ? t('關閉') : m.default === 'early-return' ? t('提早返回，不做後續的事') : m.default
  return <>
    {m.own && m.purpose ? <>{m.purpose}<br /></> : null}
    {[kind, unset ? t('未設定時：{v1}', { v1: unset }) + (m.own && m.default ? t('（專案寫的）') : '') : '', m.into ? t('存入 {v1}', { v1: m.into }) : ''].filter(Boolean).join(t('；'))}
  </>
}

const TOC = [['ov-comps', '元件'], ['ov-entry', '進入與結束'], ['ov-env', '環境變數'], ['ov-build', '建置產物'], ['ov-writes', '寫出的檔案'], ['ov-worth', '值得檢查的地方']] as const
/** Scrolls an overview section into view and puts the keyboard there. */
export function jump(id: string) {
  const h = document.getElementById(id)
  revealTop(h)
  h?.focus({ preventScroll: true })
}

const KIND: Record<string, string> = { exec: '執行檔', shared: '共享程式庫', static: '靜態程式庫', generated: '產生的檔案' }
const base = (path: string) => path.replace(/\/$/, '').split('/').pop()!
const dir = (path: string) => (path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1))

type At = (key: string, f: string, l: number) => ReactNode

/** What `make` builds, what each product is made of, and what `make install` puts where. */
function Products(p: { build: BuildInfo; at: At }) {
  const main = p.build.built.filter((b) => b.goal === p.build.goal)
  const goals = [...new Set(p.build.built.map((b) => b.goal))].filter((g) => g !== p.build.goal)
  const copies = p.build.install.filter((i) => !i.link)
  const links = new Map<string, string[]>()
  for (const i of p.build.install.filter((x) => x.link)) {
    const k = `${dir(i.to)}\u0000${dir(i.what[0])}`
    links.set(k, [...(links.get(k) ?? []), base(i.to)])
  }
  return (
    <section>
      <h3 className="small" id="ov-build" tabIndex={-1}>{t('建置產物')}</h3>
      <p className="small muted">{t('取自 Makefile（make -n 的結果）。make {v1} 建置 {v2} 個產物：', { v1: p.build.goal, v2: main.length })}</p>
      <UI.DetailList items={main.map((b, i) => ({
        label: b.name,
        value: <span>
          {t(KIND[b.kind])}
          {b.kind === 'generated' ? t('，由 {v1} 產生', { v1: b.files.join(t('、')) }) : b.files.length ? t('，由 {v1} 的 {v2} 個原始檔（.c）編成', { v1: b.comps.join(t('、')), v2: b.files.length }) : ''}
          {b.uses.length ? t('，連同 {v1}', { v1: b.uses.map(base).join(t('、')) }) : ''}
          {b.libs.length ? t('；連結 {v1}', { v1: b.libs.map((l) => '-l' + l).join(' ') }) : ''}
          {b.exports.length ? <>{t('；匯出的符號由 ')}{p.at(`exp${i}`, b.exports[0], 1)}{t(' 決定')}</> : null}
        </span>,
      }))} />
      {goals.length ? <UI.DetailList items={goals.map((g) => {
        const bs = p.build.built.filter((b) => b.goal === g)
        const named = (b: BuildInfo['built'][number]) => (main.some((m) => m.name === b.name) ? t('{v1}（另一個版本，{v2}）', { v1: b.name, v2: b.path }) : b.name)
        return { label: `make ${g}`, value: t('另外建置 {v1} 個：{v2}', { v1: bs.length, v2: bs.map(named).join(t('、')) }) }
      })} /> : null}
      {p.build.install.length ? (
        <>
          <h4 className="small">{t('make install 安裝的檔案')}</h4>
          <UI.DetailList items={[
            ...copies.map((c) => ({ label: c.to, value: c.what.map(base).join(t('、')) })),
            ...[...links].map(([k, names]) => ({ label: k.split('\u0000')[0], value: t('{v1}（符號連結，指向 {v2}）', { v1: names.join(t('、')), v2: k.split('\u0000')[1] }) })),
          ]} />
          <p className="small muted">{t('路徑是以 Makefile 的預設設定執行 make -n install 的結果。')}</p>
        </>
      ) : null}
    </section>
  )
}

/** Where the code creates or writes files, and the file names when the code spells them out. */
function Writes(p: { writes: FileWrite[]; at: At; fn: (id: string) => ReactNode }) {
  return (
    <section>
      <h3 className="small" id="ov-writes" tabIndex={-1}>{t('寫出的檔案')}</h3>
      {p.writes.length ? <UI.DetailList items={p.writes.map((w, i) => ({
        label: w.name ?? w.format ?? (w.param ? t('參數 {v1}', { v1: w.param }) : w.expr ?? t('（執行時決定）')),
        value: <span>
          {w.name ? null : w.format ? t('檔名在執行時依這個格式組成；') : w.param ? t('檔名在執行時由這個參數傳入；') : w.expr ? t('檔名在執行時取自這個運算式；') : t('檔名在執行時決定；')}
          {p.fn(w.fid)}{t(' 以 {v1} 開啟：', { v1: w.call })}{p.at(`w${i}`, w.f, w.l)}
        </span>,
      }))} /> : <p className="small muted">{t('沒有以寫入模式開啟檔案的地方（fopen 的 w、a 模式，open 的 O_CREAT、O_WRONLY 等）。')}</p>}
    </section>
  )
}

function CompTree(p: { ix: Index; comp: string; onPick: (id: string) => void; onBack: () => void }) {
  const docs = p.ix.g.files ?? {}
  const items = useMemo(() => {
    const files = [...p.ix.byFile()].filter(([, ids]) => p.ix.funcs[ids[0]].comp === p.comp).sort(([a], [b]) => a.localeCompare(b))
    return files.map(([f, ids]) => ({
      id: 'file:' + f, name: f.split('/').pop()!, path: f, icon: 'file-text' as const,
      // the file's own comment, or its header's when the file says it is described there
      meta: docs[f] ? (docs[f].file && docs[f].file !== f ? t('（取自 {v1}）', { v1: docs[f].file!.split('/').pop() }) : '') + short(docs[f].text, 110) : t('{v1} · 沒有說明註解', { v1: f }),
      children: ids.map((id) => ({
        id, name: p.ix.funcs[id].name, meta: p.ix.callerText(id),
      })),
    }))
  }, [p.ix, p.comp, docs])
  const comp = p.ix.g.comps.find((c) => c.id === p.comp)
  const uses = useMemo(() => (comp?.shared ? usesOf(p.ix, p.comp) : null), [p.ix, p.comp, comp])
  const tree = (
    <UI.TreeList key={p.comp} kind="plain" title={p.comp} subtitle={((h) => (h ? t('{v1} 個原始檔、{v2} 個標頭檔', { v1: items.length - h, v2: h }) : t('{v1} 個檔案', { v1: items.length })) + t('；點選函式會到流程頁'))(items.filter((i) => i.name.endsWith('.h')).length)} height="100%"
      actions={<UI.Button icon="arrow-left" onClick={p.onBack}>{t('回到概觀')}</UI.Button>}
      label={p.comp + t(' 的函式')} items={items} defaultOpen={items.map((i) => i.id)}
      onSelect={(n) => { if (p.ix.funcs[n.id]) p.onPick(n.id) }} />
  )
  if (!comp?.doc && !uses?.size) return <div className="detail tree-panel">{tree}</div>
  return (
    <div className="detail split">
      <UI.Card title={comp?.doc ? t('用途') : t('誰使用 {v1}', { v1: p.comp })}>
        {comp?.doc ? <p className="small">{comp.doc.text}<br /><From doc={comp.doc} /></p> : null}
        {uses?.size ? (
          <>
            {comp?.doc ? <h3 className="small">{t('誰使用 {v1}', { v1: p.comp })}</h3> : null}
            {/* which of its functions each user calls shows which way data goes */}
            <UI.DetailList items={[...uses].sort(([a], [b]) => a.localeCompare(b)).map(([c, es]) => {
              const names = [...new Set(es.map((e) => p.ix.funcs[e.d].name))].sort()
              return { label: c, value: <span>{names.slice(0, 8).map((n, i) => <span key={n}>{i ? t('、') : ''}<UI.InlineCode>{n}</UI.InlineCode></span>)}{names.length > 8 ? t(' 等 {v1} 個', { v1: names.length }) : ''}</span> }
            })} />
          </>
        ) : null}
      </UI.Card>
      <div className="tree-panel grow-panel">{tree}</div>
    </div>
  )
}
