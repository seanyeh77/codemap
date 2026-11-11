import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { OpenFile, useCodeRefs } from '../components/DocRefs'
import { UI } from '../ui'
import { countUnit, list, t } from '../i18n'
import { revealTop } from '../scroll'
import { entryText, push, type Index } from '../data/graph'
import { fileGraph, fileView, roleOf, type Role } from '../data/files'
import { written, type BuildInfo, type Doc, type DocSummary, type Edge, type FileWrite, type Graph, type Link, type Sel } from '../data/types'
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
  return t('{v1} 處 `{v2}` 呼叫被攔截', { v1: l.n, v2: l.api })
}

/** The calls each component makes into a shared one: component -> its call edges, by caller. */
function usesOf(ix: Index, shared: string) {
  const out = new Map<string, Edge[]>()
  for (const e of ix.g.edges) {
    const a = ix.funcs[e.s]?.comp, b = ix.funcs[e.d]?.comp
    if (written(e) && b === shared && a && a !== shared) out.set(a, [...(out.get(a) ?? []), e])
  }
  return out
}

/** Components in layers with the calls between them, drawn by UI.LayerGraph; shared ones are listed under it. */
/** The words after a file's name on its box. */
export const roleText = (r: Role | null) => (r === 'editable' ? t('（可修改）') : r === 'protected' ? t('（受保護）') : '')

/** A file's name as short as the diagram can tell it apart: its base name, or its path when two share one. */
function fileLabels(files: string[]) {
  const base = (f: string) => f.split('/').pop()!
  return new Map(files.map((f) => [f, files.filter((x) => base(x) === base(f)).length > 1 ? f : base(f)]))
}

/** Boxes per component, or per file when the components are few: the 元件／檔案 tabs above the diagram. */
export function Arch(p: { ix: Index; sel: string; onSel: (id: string) => void; edge: string; onEdge: (id: string) => void }) {
  const view = useMemo(() => fileView(p.ix), [p.ix])
  const key = `codemap:level:${p.ix.g.repo}`
  const [level, setLevel] = useState<'comp' | 'file'>(() => {
    try { const v = localStorage.getItem(key); if (v === 'comp' || v === 'file') return v } catch { /* storage off */ }
    return view.first ? 'file' : 'comp'
  })
  const shown = view.offered ? level : 'comp'
  const pick = (v: 'comp' | 'file') => {
    setLevel(v)
    try { localStorage.setItem(key, v) } catch { /* storage off */ }
    p.onSel(''); p.onEdge('')
  }
  return (
    <UI.Card className="pane fit">
      {view.offered ? <div className="level-tabs"><UI.Tabs label={t('架構圖的方塊')} items={[{ id: 'comp', label: t('依元件') }, { id: 'file', label: t('依檔案') }]} value={shown} onChange={(v) => pick(v as 'comp' | 'file')} /></div> : null}
      {shown === 'file' ? <FileArch {...p} /> : <CompArch {...p} />}
    </UI.Card>
  )
}

/** One box per production file, with the calls between files; each box says whether the project lets people change it. */
function FileArch(p: { ix: Index; sel: string; onSel: (id: string) => void; edge: string; onEdge: (id: string) => void }) {
  const fg = useMemo(() => fileGraph(p.ix), [p.ix])
  const labels = useMemo(() => fileLabels([...fg.files.keys()]), [fg])
  // the mark is the box's tag, never cut off on a narrow box (受保護 in the warning colors, with a lock)
  const nodes = useMemo(() => [...fg.files].map(([f, x]) => ((r) => ({ id: 'file:' + f, name: labels.get(f)!,
    ...(r ? { tag: r === 'editable' ? t('可修改') : t('受保護'), tagTone: r === 'protected' ? 'warning' as const : 'neutral' as const } : {}),
    layer: fg.layer.get(f), size: x.funcs, shared: fg.shared.has(f) }))(roleOf(p.ix.g, f))), [fg, labels, p.ix])
  const edges = useMemo(() => fg.links.map((l) => ({ id: `file:${l.a}->${l.b}`, from: 'file:' + l.a, to: 'file:' + l.b, count: l.es.length })), [fg])
  return (
    <>
    <UI.LayerGraph nodes={nodes} edges={edges} selected={p.sel || null} onSelect={(id) => p.onSel(id ?? '')}
      selectedEdge={p.edge || null} onSelectEdge={(id) => p.onEdge(id ?? '')} listLabels={{ nodes: t('檔案'), edges: t('關係') }}
      label={t('檔案和它們之間的呼叫')} nodeWidth={232} sizeLabel={(n) => t('{n} 個函式', { n })} countLabel={(n) => t('{n} 次', { n })} sharedLabel={t('共用檔案')} sharedMeta={t('{a} 個檔案使用，共 {b} 次')} scrollKey="files" />
    </>
  )
}

function CompArch(p: { ix: Index; sel: string; onSel: (id: string) => void; edge: string; onEdge: (id: string) => void }) {
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
      // a channel is declared in .codemap/rules.json: it has a basis, so it is not drawn as a guess
      : { id: edgeId(l), from: l.a, to: l.b, inferred: l.kind !== 'channel', declared: l.kind === 'channel', label: labelOf(l) }))], [g, entries, starts])
  return (
    <>
      <UI.LayerGraph nodes={nodes} edges={edges} selected={p.sel || null} onSelect={(id) => p.onSel(id ?? '')}
        selectedEdge={p.edge || null} onSelectEdge={(id) => p.onEdge(id ?? '')} listLabels={{ nodes: t('元件'), edges: t('關係') }}
        externalLabel={t('repo 外')} label={t('元件和它們之間的呼叫')} sizeLabel={(n) => t('{n} 個函式', { n })} countLabel={(n) => t('{n} 次', { n })} sharedLabel={t('共用元件')} sharedMeta={t('{a} 個元件使用，共 {b} 次')}
        inferredText={t('函式指標、環境變數、`LD_PRELOAD` 攔截等編譯器看不到的關係，由原始碼文字推得。')}
        inferredLabel={t('推測')} declaredLabel={t('專案宣告')} declaredLegend={t('專案宣告的關係')} declaredText={t('寫在 .codemap/rules.json 的 channels，例如兩個程式共用的 ring。')} />
    </>
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
    if (!f || !written(e) || ix.funcs[e.d] || !SPAWN.has(name)) continue
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
      <p>{x.preload ? t('{v1} 以 {calls} 啟動被追蹤的程式，並設定 LD_PRELOAD 載入 repo 中的程式庫。此為推測的關係。', { v1: x.comp, calls: [...x.calls].sort().join(', ') })
        : t('{v1} 以 {calls} 啟動另一個程式，可能即為被追蹤的程式。此為推測的關係。', { v1: x.comp, calls: [...x.calls].sort().join(', ') })}</p>
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
      <p>{t('以 LD_PRELOAD 載入 repo 程式庫的程式，呼叫下列同名函式時會優先執行 repo 中的版本。此為推測的關係。')}</p>
      {((xs) => xs.length ? <p className="small muted">{t('repo 中的 {v1} 也以此方式被追蹤，見其連到 {v2} 的線。', { v1: list(xs.map((l) => l.a)), v2: list([...new Set(xs.map((l) => l.b))]) })}</p> : null)(p.ix.g.links.filter((l) => l.kind === 'interpose'))}
      {((xs) => xs.length ? <p className="small muted">{t('啟動它的是 {v1}。', { v1: list(xs.map((x) => x.comp)) })}</p> : null)(launchers(p.ix))}
      {((n) => n ? <p className="small muted">{t('另有 {n} 個函式裝入函式指標或表格，由被追蹤的程式經由指標呼叫，未列於此清單。', { n })}</p> : null)(
        [...pointerEntries(p.ix).values()].flat().length)}
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
  if (!l && !p.id.startsWith('file:')) return null
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
  if (p.id.startsWith('file:')) {
    // file:harness/controller.py->harness/routing.py: the calls from one file's functions into the other's
    const [a, b] = p.id.slice(5).split('->')
    const es = p.ix.g.edges.filter((e) => written(e) && p.ix.funcs[e.s]?.file === a && p.ix.funcs[e.d]?.file === b
      && p.ix.funcs[e.s]?.scope !== 'test' && p.ix.funcs[e.d]?.scope !== 'test')
    const base = (f: string) => f.split('/').pop()
    return (
      <UI.Card className="detail" title={`${base(a)} → ${base(b)}`} actions={<UI.Button icon="arrow-left" onClick={p.onBack}>{t('回到概觀')}</UI.Button>}>
        <p className="small">{t('{v1} 的函式呼叫 {v2} 的函式，共 {v3} 次。', { v1: a, v2: b, v3: es.length })}</p>
        <UI.DetailList items={es.slice(0, SHOWN).map((e) => ({ label: `${name(e.s)} → ${name(e.d)}`, value: at(e.s, e.f, e.l) }))} />
        {es.length > SHOWN ? <p className="small muted">{t('另有 {v1} 處未列出。', { v1: es.length - SHOWN })}</p> : null}
      </UI.Card>
    )
  }
  if (!l) return null
  let about = '', body: ReactNode = null
  if (l.kind === 'env') {
    about = t('{v1} 設定環境變數，{v2} 執行時讀取它。此為推測的關係。', { v1: l.a, v2: l.b })
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
    about = t('{v1} 以 LD_PRELOAD 載入後，攔截 {v2} 對 {v3} 函式的 {v4} 次呼叫。箭頭由呼叫方指向攔截方，此為推測的關係。', { v1: l.b, v2: l.a, v3: l.api, v4: l.n })
      + (hooks.length ? t('{v1} 呼叫到的同名函式有 {v2} 個，定義在 {v3}：{v4}{v5}。', { v1: l.a, v2: hooks.length, v3: l.b, v4: hooks.slice(0, 8).join(t('、')), v5: hooks.length > 8 ? t(' 等') : '' }) : '')
      + ((n) => n > hooks.length ? t('{v1} 共定義 {v2} 個 {v3} 同名函式，{v4} 未呼叫其餘函式。', { v1: l.b, v2: n, v3: l.api, v4: l.a }) : '')(Object.values(p.ix.funcs).filter((f) => f.comp === l.b && f.api === l.api).length)
    body = <UI.DetailList items={(l.sites ?? []).slice(0, SHOWN).map((s) => ({ label: t('{v1} 呼叫 {v2}', { v1: name(s.s), v2: s.name }), value: at(s.s, s.f, s.l) }))} />
  } else if (l.kind === 'runs' || l.kind === 'reads') {
    about = l.kind === 'runs'
      ? t('{v1} 的 Python 工具以 subprocess 啟動 {v3} 編譯出的 {v2}。此為推測的關係，以下列出啟動位置。', { v1: l.a, v2: list(l.names ?? []), v3: l.b })
      : t('{v1} 的 Python 工具讀取 {v2} 中的 {v3}，修改時須兩邊一致。此為推測的關係。', { v1: l.a, v2: l.b, v3: list(l.names ?? []) })
    body = <UI.DetailList items={(l.sites ?? []).slice(0, SHOWN).map((s) => ({ label: `${s.f.split('/').pop()}:${s.l}`, value: <span>{t('{v1} 使用 {v2}：', { v1: name(s.s), v2: s.name })}{at(null, s.f, s.l)}</span> }))} />
  } else if (l.kind === 'channel') {
    about = t('{v1} 經由 {v2} 把資料交給 {v3}{v4}', { v1: l.a, v2: l.via ?? '', v3: l.b, v4: l.label ? t('（{v1}）', { v1: l.label }) : '' })
      + t('。此為 .codemap/rules.json 宣告的資料通道，以下列出兩端使用 {v1} 的位置。', { v1: l.via ?? '' })
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
      const left = p.ix.g.uncompiled?.[fid]?.length ?? 0
      const more = left ? t('；另有 {v1} 處在條件編譯中，本次 build 未編入', { v1: left }) : ''
      return (comps.size ? t('由 {v1} 呼叫', { v1: [...comps].map(([c, via]) => via ? t('{v1}（經由 {v2}）', { v1: c, v2: via }) : c).join(t('、')) }) : t('沒有其他元件呼叫它')) + more
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
    const es = p.ix.g.edges.filter((e) => written(e) && p.ix.funcs[e.s]?.comp === l.a && p.ix.funcs[e.d]?.comp === l.b)
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
  if (p.comp.startsWith('file:')) return <FileDetail ix={p.ix} file={p.comp.slice(5)} onPick={p.onPick} onComp={p.onComp} />
  return <CompTree {...p} onBack={() => p.onComp('')} />
}

/** A file's box: what it is for, whether people may change it, which files it calls and is called by, and its functions. */
function FileDetail(p: { ix: Index; file: string; onPick: (id: string) => void; onComp: (id: string) => void }) {
  const fg = useMemo(() => fileGraph(p.ix), [p.ix])
  const ids = useMemo(() => (p.ix.byFile().get(p.file) ?? []).filter((id) => p.ix.funcs[id].scope !== 'test'), [p.ix, p.file])
  const doc = p.ix.g.files?.[p.file]
  const role = roleOf(p.ix.g, p.file)
  const byRules = Object.keys(p.ix.g.roles ?? {}).some((x) => p.file === x || p.file.startsWith(x.replace(/\/$/, '') + '/'))
  const base = (f: string) => f.split('/').pop()!
  const other = (xs: { a: string; b: string; es: unknown[] }[], end: 'a' | 'b') => xs.sort((x, y) => y.es.length - x.es.length).map((l) => (
    <span key={l[end]} className="entry-row"><button type="button" className="linklike" onClick={() => p.onComp('file:' + l[end])}>{base(l[end])}</button>{' '}{t('{n} 次', { n: l.es.length })}</span>))
  const inn = fg.links.filter((l) => l.b === p.file), out = fg.links.filter((l) => l.a === p.file)
  return (
    <div className="detail split">
      <UI.Card title={p.file} actions={<UI.Button icon="arrow-left" onClick={() => p.onComp('')}>{t('回到概觀')}</UI.Button>}>
        {role ? <p className="small"><UI.Tag>{role === 'editable' ? t('可修改') : t('受保護')}</UI.Tag>{' '}
          {byRules ? t('依據：.codemap/rules.json 的 roles') : t('依據：檔案開頭註解的第一個詞')}</p> : null}
        {doc ? <p className="small">{short(doc.text, 400)}<br /><From doc={doc} /></p> : <p className="small muted">{t('沒有說明註解。')}</p>}
        <UI.DetailList items={[
          // a controller's event handlers have no caller in the repo: the framework calls them
          ...[...new Set(ids.map((id) => p.ix.funcs[id].entry?.framework).filter(Boolean))].map((fw) => ({ label: t('由框架呼叫'),
            value: t('{v1} 呼叫其中 {v2} 個函式', { v1: fw!, v2: ids.filter((id) => p.ix.funcs[id].entry?.framework === fw).length }) })),
          { label: t('呼叫它的檔案'), value: inn.length ? <span className="entry-list">{other(inn, 'a')}</span> : t('（無）') },
          { label: t('它呼叫的檔案'), value: out.length ? <span className="entry-list">{other(out, 'b')}</span> : t('（無）') },
        ]} />
      </UI.Card>
      <div className="tree-panel grow-panel">
        <UI.TreeList key={p.file} kind="plain" title={base(p.file)} subtitle={t('{v1} 個函式；點選函式會到流程頁', { v1: ids.length })} height="100%"
          label={t('{v1} 的函式', { v1: base(p.file) })} items={ids.map((id) => ({ id, name: p.ix.funcs[id].name, meta: `${base(p.ix.funcs[id].file)}:${p.ix.funcs[id].line} · ${p.ix.callerText(id)}` }))}
          onSelect={(n) => { if (p.ix.funcs[n.id]) p.onPick(n.id) }} />
      </div>
    </div>
  )
}

/** A group of Python tools: each script with the first line of its docstring; click to read it. */
function ScriptsDetail(p: { ix: Index; comp: string; isLive: boolean; sourceId: string; onBack: () => void }) {
  const c = p.ix.g.comps.find((x) => x.id === p.comp)!
  const runs = p.ix.g.links.filter((l) => l.a === c.id)
  const [shown, setShown] = useState<string | null>(null)
  return (
    <UI.Card className="detail" title={t('{v1}（Python）', { v1: c.id })} actions={<UI.Button icon="arrow-left" onClick={p.onBack}>{t('回到概觀')}</UI.Button>}>
      <p className="small">{t('Python 工具，{v1} 個檔案。codemap 不索引 Python 的呼叫，只列出檔案、啟動的程式與讀取的標頭檔。', { v1: c.files })}</p>
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

/** The network namespace a command line runs in, when it says so: ip netns exec l3-r{as_id} … */
const netns = (cmd: string) => /\bip netns exec (\S+)/.exec(cmd)?.[1] ?? null

/** Languages as the checks name them; JavaScript is read with TypeScript. */
const LANG_NAME: Record<string, string> = { c: 'C/C++', python: 'Python', go: 'Go', typescript: 'TypeScript/JavaScript' }
function presentLangs(g: Graph): Set<string> {
  const out = new Set<string>()
  for (const l of Object.keys(g.stats.languages ?? {})) out.add(l === 'javascript' ? 'typescript' : l === 'cpp' ? 'c' : l)
  if (!g.stats.backends || g.stats.backends.includes('gcc')) out.add('c')       // a graph from before the field: C
  return out
}
const STOP_CALLS: Record<string, string> = { c: 'abort、exit、_exit', python: 'sys.exit、os._exit、os.abort', go: 'os.Exit、log.Fatal', typescript: 'process.exit' }
const WRITE_CALLS: Record<string, string> = { c: 'fopen 的 w、a 模式，open 的 O_CREAT、O_WRONLY 等', python: 'open 的寫入模式、Path.write_text、os.replace 等',
  go: 'os.Create、os.WriteFile、os.OpenFile 的寫入旗標', typescript: 'fs.writeFile、appendFile、createWriteStream 等' }
const WORTH = [['broad', '捕捉所有例外後繼續執行'], ['stops', '結束程式的呼叫'], ['arrays', '固定大小的全域陣列'], ['env_if_unset', '只在未設定時才設定的環境變數'], ['errors', '回傳固定錯誤碼的地方'],
  ['loss', '會丟掉資料的地方'], ['leftovers', '程式結束後會留下的東西'], ['limits', '到達上限時直接返回、不印訊息'], ['plain_writes', '不經 atomic 操作就修改的全域變數'],
  ['env', '未檢查 NULL 就使用的 getenv 結果']] as const
const short = (t: string, n = 140) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t)
/** The first sentence of a comment: enough to tell a file's role (Protected ..., Editable ...). */
const firstSentence = (t: string) => ((m) => (m ? m[0] : t))(t.match(/^[\s\S]*?[.。](?=\s|$)/))

/** A function as a Markdown link to the flow page; a name the index does not have stays code. */
const fnLink = (ix: Index, id: string) => (ix.funcs[id] ? `[${esc(ix.funcs[id].name)}](fn:${encodeURIComponent(id)})` : code(id))
const loc = (f: string, l: number, inTable = false) => code(`${f}:${l}`, inTable)

/** The project's documents: the top-level ones and those the code points to first, each with its
 *  title and first sentence; the rest in a closed block. The fullest explanation of a design is
 *  often a document, and nothing on the diagram leads to it. */
function docsPart(docs: DocSummary[]): PartMd {
  // the README and docs/*.md, then documents the code names at least twice, most named first
  const main = docs.filter((d) => d.file.split('/').length <= 2 && !/^(CODEMAP|notes)\.md$/i.test(d.file) || d.cited >= 2)
    .sort((a, b) => Number(b.file === 'README.md') - Number(a.file === 'README.md') || b.cited - a.cited || a.file.localeCompare(b.file)).slice(0, 8)
  const rest = docs.filter((d) => !main.includes(d))
  const row = (d: DocSummary) => `- [${esc(d.title)}](${d.file}) ${code(d.file)}`
    + (d.text ? BR + oneLine(d.text) : '') + (d.cited ? BR + t('{v1} 個程式碼或腳本檔提到它', { v1: d.cited, v2: countUnit('', 'source file', 'source files')(d.cited) }) : '')
  return {
    id: 'ov-docs', title: t('專案文件'), summary: t('{v1} 份', { v1: docs.length }),
    md: [main.map(row).join('\n'), rest.length ? details(t('其餘 {v1} 份文件', { v1: rest.length }), rest.map(row).join('\n')) : ''].filter(Boolean).join('\n\n'),
  }
}

/** Where a comment came from, so a reader can check it. */
function From(p: { doc: Doc }) {
  return <span className="small muted">{p.doc.own ? t('專案在 .codemap/rules.json 寫的說明') : t('取自 {v1}:{v2} 的註解', { v1: p.doc.file, v2: p.doc.line })}</span>
}

/** Nothing selected: what each component is for, how the code is entered and left, and what the
 *  environment controls - the parts the diagram's boxes and lines do not say. */
function Overview(p: { ix: Index; isLive: boolean; sourceId: string; onComp: (id: string) => void; onPick: (id: string) => void }) {
  const g = p.ix.g
  const refs = useCodeRefs(p.ix)
  const openFile = useContext(OpenFile)
  const [copied, setCopied] = useState(false)
  const links = useMemo(() => ({ refs, openFile, onFn: p.onPick }), [refs, openFile, p.onPick])
  const fname = (ref: string) => { const hit = p.ix.at(ref); return hit ? p.ix.funcs[hit.id].name : null }
  const lifecycle = g.edges.filter((e) => e.k === 'constructor' || e.k === 'destructor').filter((e) => p.ix.funcs[e.d])
  const apis = new Map<string, number>()
  for (const f of Object.values(p.ix.funcs)) if (f.api) apis.set(f.api, (apis.get(f.api) ?? 0) + 1)
  // functions nothing in the repo calls directly, put into a function pointer that code outside the repo calls
  // (an ops table, a UCT table, a signal handler): grouped by the function that installs them
  const installed = pointerEntries(p.ix)
  const fwEntries = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const [id, f] of Object.entries(p.ix.funcs)) if (f.entry) m.set(`${f.entry.framework}.${f.entry.kind}`, [...(m.get(`${f.entry.framework}.${f.entry.kind}`) ?? []), id])
    for (const ids of m.values()) ids.sort((a, b) => p.ix.funcs[a].file.localeCompare(p.ix.funcs[b].file) || p.ix.funcs[a].line - p.ix.funcs[b].line)
    return new Map([...m].sort(([a], [b]) => a.localeCompare(b)))
  }, [p.ix])
  // variables the program reads: in a C repository, a C file's reads (Python there is tools and tests);
  // in a repository of Python, Go or TypeScript, a read inside any of its functions that is not a test
  const cRepo = g.stats.backends ? g.stats.backends.includes('gcc') : true
  const inProgram = (r: string) => (cRepo ? /\.[ch]:\d+$/.test(r) && !!fname(r) : ((hit) => !!hit && p.ix.funcs[hit.id].scope !== 'test')(p.ix.at(r)))
  // the checks read some languages only: one the repository does not have is left out, and said so
  const langs = presentLangs(g)
  const covers = (k: string) => g.worth?.covers?.[k] ?? ['c']
  // production code: also while the tests setting hides test functions (tests/grade.py:<module>), which are then not in ix
  const hidden = new Set((g.hidden_tests ?? []).flatMap((h) => [h.id, h.file]))
  const prod = (fid: string) => (p.ix.funcs[fid] ? p.ix.funcs[fid].scope !== 'test' : !hidden.has(fid) && !hidden.has(fid.slice(0, fid.lastIndexOf(':'))))
  const applies = (k: string) => covers(k).some((l) => langs.has(l))
  const inLangs = (k: string, by: Record<string, string>) => covers(k).filter((l) => langs.has(l) && by[l]).map((l) => t(by[l])).join(t('；'))
  const skipped = WORTH.filter(([k]) => !applies(k))
  // the commands the program runs (outside C): tests and grading scripts are left to the search
  // test code's commands (tests/grade.py's docker exec) stay out, also while the tests setting hides its functions
  const cmds = cRepo ? [] : (g.commands ?? []).filter((c) => prod(c.fid))
  // by file, the files people may change first (the controller before the grader's checks.py)
  const rank = (f: string) => ((r) => (r === 'editable' ? 0 : r === 'protected' ? 2 : 1))(roleOf(g, f))
  const cmdGroups = [...cmds.map((c, i) => [c, i] as const).reduce((m, x) => {
    const comp = x[0].f
    return m.set(comp, [...(m.get(comp) ?? []), x])
  }, new Map<string, (readonly [typeof cmds[number], number])[]>())].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  // a file whose commands and call sites fill several screens starts closed: the controller's are not lost under the grader's
  const rows = (xs: (readonly [typeof cmds[number], number])[]) => xs.reduce((n, [c]) => n + 1 + (c.via?.length ?? 0), 0)
  const broad = (g.worth?.broad ?? []).filter((x) => prod(x.fid))
  // one name defined in two files (routing.flow_priority and oracle.flow_priority): a change to one leaves the other
  // as it was, and a reader can take a call to one for a call to the other. Methods and __init__ are left out.
  const twins = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const [id, f] of Object.entries(p.ix.funcs)) {
      if (f.scope === 'test' || f.kind === 'module' || f.kind === 'class' || f.name.includes('.') || /^__\w+__$/.test(f.name)) continue
      m.set(f.name, [...(m.get(f.name) ?? []), id])
    }
    return [...m].filter(([, ids]) => new Set(ids.map((id) => p.ix.funcs[id].file)).size > 1).sort(([a], [b]) => a.localeCompare(b))
  }, [p.ix])
  // outside C, a function named main that is not a test: the command line's entry
  const mains = cRepo ? [] : Object.entries(p.ix.funcs).filter(([, f]) => f.name === 'main' && f.scope !== 'test' && f.kind !== 'module').map(([id]) => id)
  // in a C repository the program is its C code: Python there is tools and tests, as with the variables above
  const cFile = (f: string) => /\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(f)
  const stops = (g.worth?.stops ?? []).filter((x) => (cRepo ? cFile(x.f) : prod(x.fid)))
  const writes = (g.writes ?? []).filter((x) => (cRepo ? cFile(x.f) : prod(x.fid)))
  // test and grading code: left out of the diagram, but a reader needs to know it is there
  const testComps = useMemo(() => {
    const all = g.hidden_tests ?? Object.entries(p.ix.funcs).filter(([, f]) => f.scope === 'test').map(([id, f]) => ({ id, name: f.name, file: f.file, line: f.line, comp: f.comp }))
    const m = new Map<string, typeof all>()
    for (const f of all) if (!g.comps.some((c) => c.id === f.comp)) m.set(f.comp, [...(m.get(f.comp) ?? []), f])
    return [...m].sort(([a], [b]) => a.localeCompare(b))
  }, [p.ix, g])
  const spawns = (g.spawns ?? []).filter((x) => p.ix.funcs[x.target] && p.ix.funcs[x.fid]?.scope !== 'test')
  const reads = cRepo ? [] : (g.reads ?? []).filter((x) => prod(x.fid))
  const unsetEnv = (g.worth?.env_if_unset ?? []).filter((x) => (cRepo ? cFile(x.f) : prod(x.fid)))
  // a variable the program only sets (PYTHONPATH for a child process) belongs here too, outside a C repository
  const env = Object.entries(g.env ?? {}).filter(([, v]) => v.get.some(inProgram) || (!cRepo && v.set.some(inProgram)))
  const others = Object.keys(g.env ?? {}).length - env.length
  // the line beside each part's title: the numbers that say whether it is worth opening
  const join = (xs: (string | false | 0 | undefined)[]) => xs.filter(Boolean).join(t('、'))
  const fewNames = (xs: string[]) => (xs.length > 2 ? t('{v1} 等 {v2} 個', { v1: xs.slice(0, 2).join(t('、')), v2: xs.length }) : xs.join(t('、')))
  const spacesAll = [...new Set((g.commands ?? []).filter((c) => prod(c.fid)).flatMap((c) => [c.cmd, ...(c.via ?? []).map((v) => v.cmd)]).map(netns).filter((x) => x && !/^\{[^}]*\}$/.test(x)))]
  const sums = {
    comps: t('{v1} 個元件、{v2} 個函式', { v1: g.comps.length, v2: Object.values(p.ix.funcs).filter((f) => f.scope !== 'test' && f.kind !== 'module').length }),
    entry: join([mains.length && t('程式入口 {v1} 個', { v1: mains.length }), fwEntries.size && t('框架呼叫 {v1} 個', { v1: [...fwEntries.values()].flat().length }),
      spawns.length && t('背景工作 {v1} 個', { v1: spawns.length }), apis.size && t('外部進入點 {v1} 個', { v1: apis.size }), lifecycle.length && t('自動執行 {v1} 個', { v1: lifecycle.length })]),
    cmds: join([t('{v1} 個指令', { v1: (g.commands ?? []).filter((c) => prod(c.fid)).length }), spacesAll.length && t('{v1} 個 network namespace', { v1: spacesAll.length }),
      ((n) => n && t('{v1} 個沒有逾時', { v1: n }))((g.commands ?? []).filter((c) => prod(c.fid) && !c.timeout).length)]),
    env: fewNames(env.map(([n]) => n)),
    reads: t('{v1} 處', { v1: reads.length }),
    worth: '',
  }
  const found = ([['broad', broad.length, '捕捉所有例外後繼續執行'], ['twins', twins.length, '不同檔案中的同名函式'], ['stops', stops.length, '結束程式的呼叫'],
    ['arrays', g.worth?.arrays.length ?? 0, '固定大小的全域陣列'], ['env_if_unset', unsetEnv.length, '只在未設定時才設定的環境變數'], ['errors', g.worth?.errors?.length ?? 0, '回傳固定錯誤碼的地方'],
    ['loss', g.worth?.loss?.length ?? 0, '會丟掉資料的地方'], ['leftovers', g.worth?.leftovers?.length ?? 0, '程式結束後會留下的東西'], ['limits', g.worth?.limits?.silent.length ?? 0, '到達上限時直接返回、不印訊息'],
    ['plain_writes', g.worth?.plain_writes?.length ?? 0, '不經 atomic 操作就修改的全域變數'], ['env', g.worth?.env.length ?? 0, '未檢查 NULL 就使用的 getenv 結果']] as const)
    .filter(([k, n]) => n > 0 && (k === 'twins' || applies(k)))
  sums.worth = found.length ? t('有發現：{v1}', { v1: found.map(([, , l]) => t(l)).join(t('、')) }) : t('沒有發現')
  const fnL = (id: string) => fnLink(p.ix, id)
  const fnLoc = (id: string) => `${fnL(id)} ${loc(p.ix.funcs[id].file, p.ix.funcs[id].line)}`
  // a list that fills more than a few lines goes into a closed block
  const longList = (label: string, lines: string[]) => (lines.length > 5 ? details(label, lines.join('\n')) : `${esc(label)}\n\n${lines.join('\n')}`)
  const parts: PartMd[] = []

  // 元件: what each one is for, in its own words; test code apart
  parts.push({ id: 'ov-comps', title: t('元件'), summary: sums.comps, open: true, md: [
    g.comps.map((c) => `- **${esc(c.id)}**：` + (c.doc
      ? oneLine(short(c.doc.text)) + BR + (c.doc.own ? t('專案在 .codemap/rules.json 寫的說明') : t('取自 {v1}:{v2} 的註解', { v1: c.doc.file, v2: c.doc.line }))
      : c.file_docs?.length ? t('元件沒有整體說明，以下為各檔案的開頭註解：') + c.file_docs.map((d) => `\n  - ${code(d.file.split('/').pop()!)} ${oneLine(short(firstSentence(d.text), 90))}`).join('')
      : t('沒有說明註解。'))).join('\n'),
    testComps.length ? [`### ${t('測試與評分程式（不畫在圖上）')}`, testComps.map(([comp, fs]) => {
      const files = [...new Set(fs.map((f) => f.file))].sort()
      const entry = fs.filter((f) => f.name === 'main')
      return `- **${esc(comp)}**：${t('{v1} 個檔案、{v2} 個函式', { v1: files.length, v2: fs.length })}` + (entry.length ? t('，入口 ') + entry.map((f) => loc(f.file, f.line)).join(t('、')) : '')
        + files.slice(0, 8).map((f) => `\n  - ${code(f)}${g.files?.[f] ? ' ' + oneLine(short(firstSentence(g.files[f].text), 90)) : ''}`).join('')
    }).join('\n'), g.hidden_tests ? note(t('流程、影響範圍與搜尋預設不含測試程式碼，可在設定頁開啟「包含測試程式碼」。')) : ''].filter(Boolean).join('\n\n') : '',
    g.comps.some((c) => !c.doc?.own) ? note(t('說明取自主要檔案（main.c、__init__.py 或唯一的檔案）的開頭註解。元件用途可寫在 .codemap/rules.json 的 describe。')) : '',
  ].filter(Boolean).join('\n\n') })

  if (g.docs?.length) parts.push(docsPart(g.docs))

  // 進入與結束: where control comes in from outside the repository, and what runs on its own
  if (lifecycle.length || apis.size || installed.size || fwEntries.size || mains.length || spawns.length) {
    const simple = [
      ...spawns.map((x) => `- **${t('背景工作')}**：${fnL(x.target)}${t('（由 {v1} 以 {v2} 啟動，', { v1: esc(p.ix.funcs[x.fid]?.name ?? x.fid), v2: x.call })}${loc(x.f, x.l)}${t('）')}`),
      ...mains.map((id) => `- **${t('程式入口')}**：${fnLoc(id)}${p.ix.callerInfo(id).sure ? t('（由 {v1} 呼叫）', { v1: esc(list(p.ix.callerInfo(id).names.slice(0, 2))) }) : ''}`),
      ...lifecycle.map((e) => `- **${e.k === 'constructor' ? t('載入時自動執行') : t('結束時自動執行')}**：${fnL(e.d)}${t('（{v1}）', { v1: p.ix.funcs[e.d].comp })} ${loc(p.ix.funcs[e.d].file, p.ix.funcs[e.d].line)}`
        // two constructors in one component (one .so): the loader does not promise an order
        + (e.k === 'constructor' && lifecycle.filter((x) => x.k === 'constructor' && p.ix.funcs[x.d].comp === p.ix.funcs[e.d].comp).length > 1
          && lifecycle.find((x) => x.k === 'constructor' && p.ix.funcs[x.d].comp === p.ix.funcs[e.d].comp) === e ? BR + t('{v1} 有多個 constructor，同一程式庫中的執行順序沒有保證。', { v1: p.ix.funcs[e.d].comp }) : '')),
    ]
    const groups = [
      // functions a framework calls by itself: routes, tests, event handlers, grouped by framework and kind
      ...[...fwEntries].map(([, ids]) => {
        const e0 = p.ix.funcs[ids[0]].entry!
        return `### ${t('{v1}：{v2}', { v1: e0.framework, v2: entryText({ kind: e0.kind, text: '' }) })}\n\n`
          + longList(t('{v1} 個函式由 {v2} 呼叫', { v1: ids.length, v2: e0.framework, v3: countUnit('', 'function', 'functions')(ids.length) }),
            ids.map((id) => `- ${fnLoc(id)}${p.ix.funcs[id].entry!.text ? ' ' + esc(p.ix.funcs[id].entry!.text) : ''}`))
      }),
      ...[...apis].sort().map(([api, n]) => `### ${t('外部進入點')}\n\n` + longList(t('{v1} 個函式攔截 {v2} 的同名函式（LD_PRELOAD）', { v1: n, v2: api }),
        Object.entries(p.ix.funcs).filter(([, f]) => f.api === api).sort(([, a], [, b]) => a.name.localeCompare(b.name)).map(([id]) => `- ${fnLoc(id)}`))),
      ...(installed.size ? [`### ${t('經由函式指標進入')}\n\n` + longList(t('{v1} 個函式只裝入函式指標，由 repo 外呼叫（推測）', { v1: [...installed.values()].flat().length }),
        [...installed].sort(([, a], [, b]) => b.length - a.length).map(([by, ids]) => `- ${t('{v1} 裝入：', { v1: esc(p.ix.funcs[by].name) })}`
          + [...ids].sort((a, b) => p.ix.funcs[a].name.localeCompare(p.ix.funcs[b].name)).map((id) => `\n  - ${fnLoc(id)}`).join('')))] : []),
    ]
    parts.push({ id: 'ov-entry', title: t('進入與結束'), summary: sums.entry, open: true, md: [simple.join('\n'), ...groups].filter(Boolean).join('\n\n') })
  }

  // 執行的外部指令: by file, the files people may change first; where each runs and whether it can hang
  if (cmds.length) {
    const group = ([comp, xs]: (typeof cmdGroups)[number]) => {
      const all = xs.flatMap(([c]) => [c.cmd, ...(c.via ?? []).map((v) => v.cmd)])
      const spaces = [...new Set(all.map(netns).filter((x) => x && !/^\{[^}]*\}$/.test(x)))] as string[]     // {namespace}: known only when it runs
      const untimed = xs.filter(([c]) => !c.timeout).length
      const head = [t('{v1} 個指令', { v1: xs.length }), rows(xs) > xs.length ? t('{v1} 個呼叫處', { v1: rows(xs) - xs.length }) : '',
        spaces.length ? t('network namespace：{v1}', { v1: spaces.slice(0, 3).join(t('、')) + (spaces.length > 3 ? t('，共 {n} 個', { n: spaces.length }) : '') }) : '',
        untimed ? t('{v1} 個沒有逾時', { v1: untimed }) : ''].filter(Boolean).join(t('，'))
      // where it runs: the namespace an ip netns exec names; a launcher without one runs where its caller does
      const wraps = (c: (typeof cmds)[number]) => !!c.via?.some((v) => v.cmd !== c.cmd)
      const where = (c: (typeof cmds)[number]) => (wraps(c) ? t('依呼叫處') : netns(c.cmd) ?? t('與呼叫者相同'))
      const rowsMd = mdTable([t('函式'), t('指令'), t('位置'), t('network namespace'), t('執行方式')], xs.map(([c]) => [
        fnLink(p.ix, c.fid) + (wraps(c) ? t('（包裝函式）') : ''),
        code(c.cmd || c.call, true), loc(c.f, c.l, true), esc(where(c)),
        c.call + (c.timeout ? t('，逾時 {v1}', { v1: c.timeout }) : t('，沒有逾時')) + (c.shell ? t('，shell={v1}', { v1: c.shell }) : ''),
      ]))
      // a wrapper's call sites, each with the command it makes: in a closed block (a plain command's one caller adds nothing)
      const sites = xs.filter(([c]) => wraps(c)).map(([c]) => details(t('{v1} 的 {v2} 個呼叫處', { v1: p.ix.funcs[c.fid]?.name ?? c.fid, v2: c.via!.length }),
        mdTable([t('呼叫者'), t('組成的指令'), t('位置')], c.via!.map((v) => [fnLink(p.ix, v.fid), code(v.cmd, true), loc(v.f, v.l, true)]))))
      const body = [rowsMd, ...sites].join('\n\n')
      return [`### ${esc(comp)}${roleText(roleOf(g, comp))}`, head,
        // a file whose call sites fill several screens is closed: the controller's are not lost under the grader's
        rows(xs) > 30 ? details(t('展開 {v1} 的指令', { v1: comp.split('/').pop() }), body) : body].join('\n\n')
    }
    parts.push({ id: 'ov-cmds', title: t('執行的外部指令'), summary: sums.cmds, md: [
      noteMd(t('{v1}：執行時才決定的值。經由包裝函式執行的指令，逐一列出各呼叫處組成的指令。', { v1: code('{…}') })),
      ...cmdGroups.map(group)].join('\n\n') })
  }

  // 執行期設定: what each variable does, and where it is read and set
  if (env.length) {
    const at = (refs: string[]) => refs.filter(inProgram).map((r) => (fname(r) ? `${esc(fname(r)!)} ${code(r)}` : code(r))).join(t('、'))
    parts.push({ id: 'ov-env', title: t('執行期設定（環境變數）'), summary: sums.env, md: [
      env.map(([name, v]) => `- **${code(name)}**：` + [
        name === 'LD_PRELOAD' ? t('由 dynamic loader 在程式啟動時讀取，先載入其中的程式庫。') : '',
        ...(g.env_info?.[name] ? meaning(g.env_info[name]) : []),
        t('讀取：{v1}', { v1: at(v.get) || '—' }),
        at(v.set) ? t('設定：{v1}', { v1: at(v.set) }) : '',
        ((n) => (n ? (cRepo ? t('另有 {v1} 處在 Python 工具、測試或腳本中，可用搜尋查看', { v1: n }) : t('另有 {v1} 處在測試或腳本中，可用搜尋查看', { v1: n })) : ''))([...v.get, ...v.set].filter((r) => !inProgram(r)).length),
      ].filter(Boolean).join(BR)).join('\n'),
      others > 0 ? details(cRepo ? t('另有 {v1} 個變數只出現在 Python 工具、測試或腳本中', { v1: others }) : t('另有 {v1} 個變數只在測試或腳本中讀取，或只有設定', { v1: others }),
        Object.entries(g.env ?? {}).filter(([name]) => !env.some(([n]) => n === name)).sort(([a], [b]) => a.localeCompare(b))
          .map(([name, v]) => `- ${code(name)} ${[...v.get, ...v.set].slice(0, 3).map((r) => code(r)).join(t('、'))}${[...v.get, ...v.set].length > 3 ? t('，共 {v1} 處', { v1: [...v.get, ...v.set].length }) : ''}`).join('\n')) : '',
    ].filter(Boolean).join('\n\n') })
  }

  if (g.build && (g.build.built.length || g.build.install.length)) parts.push(buildPart(g.build))
  if (g.writes) parts.push(writesPart(p.ix, writes, inLangs('writes', cRepo ? { c: WRITE_CALLS.c } : WRITE_CALLS)))
  if (reads.length) parts.push({ id: 'ov-reads', title: t('讀取的檔案'), summary: sums.reads, md: mdTable([t('檔案'), t('函式'), t('方式'), t('位置')], reads.map((r) => [
    r.name ? code(r.name, true) : r.param ? t('參數 {v1}', { v1: r.param }) : r.expr ? code(r.expr, true) : t('（執行時決定）'), fnLink(p.ix, r.fid), code(r.call, true), loc(r.f, r.l, true)])) })

  // 值得檢查的地方: one ### per check, its findings or 沒有找到
  if (g.worth) {
    const w = g.worth
    const none = note(t('沒有找到。'))
    const check = (k: string, title: string, body: string) => (k === 'twins' || applies(k) ? `### ${title}\n\n${body}` : '')
    const kept = <T,>(xs: T[], f: (x: T) => string) => xs.map(f).join('\n')
    parts.push({ id: 'ov-worth', title: t('值得檢查的地方'), summary: sums.worth, md: [
      note(t('僅列出程式碼中的事實，是否有問題須視實際用法而定。')),
      check('broad', t('捕捉所有例外後繼續執行'), [note(t('範圍：except Exception、except BaseException 與未寫型別的 except，且處理區塊未再 raise。指定型別的 except 不列入。')),
        broad.length ? kept(broad, (x) => `- **except ${esc(x.what)}**：${fnL(x.fid)} ${loc(x.f, x.l)}${t('：接著執行 {v1}，未再拋出', { v1: code(x.then) })}`) : none].join('\n\n')),
      check('twins', t('不同檔案中的同名函式'), twins.length ? kept(twins, ([name, ids]) => `- **${esc(name)}**` + ids.map((id) => `\n  - ${loc(p.ix.funcs[id].file, p.ix.funcs[id].line)} ${esc(p.ix.callerText(id))}`).join('')) : none),
      check('stops', t('結束程式的呼叫'), stops.length ? kept(stops, (x) => `- **${esc(x.name)}()**：${fnL(x.fid)}${t(' 呼叫：')}${loc(x.f, x.l)}`)
        : note(t('沒有結束程式的呼叫（{v1}）。', { v1: inLangs('stops', cRepo ? { c: STOP_CALLS.c } : STOP_CALLS) }))),
      check('arrays', t('固定大小的全域陣列'), w.arrays.length ? [kept(w.arrays, (a) => `- **${esc(a.name)}**：` + (a.value ? t('上限 {v1} 個（{v2}）：', { v1: a.value, v2: a.size.slice(1, -1).split('][').join(' × ') })
        : /^(\[\d+\])+$/.test(a.size) ? t('上限 {v1} 個：', { v1: a.size.replace(/[[\]]/g, ' ').trim().split(/\s+/).join(' × ') }) : t('上限 {v1} 個：', { v1: a.size.slice(1, -1).split('][').join(' × ') })) + loc(a.file, a.line)),
        ((n) => (n ? note(t('其中 {v1} 個的上限為 enum 或運算式，未換算成數字。', { v1: n })) : ''))(w.arrays.filter((a) => !a.value && !/^(\[\d+\])+$/.test(a.size)).length)].filter(Boolean).join('\n\n')
        : note(t('沒有以常數決定大小的全域陣列。'))),
      check('env_if_unset', t('只在未設定時才設定的環境變數'), unsetEnv.length ? kept(unsetEnv, (e) => `- **${code(e.name)}**：${fnL(e.fid)}` + (e.check !== e.l
        ? t(' 先檢查是否已設定：') + loc(e.f, e.check) + t('；未設定時才設定：') + loc(e.f, e.l) + (e.says === false ? t('。已設定時沿用原值，不印訊息。') : '')
        : e.how === 'setdefault' ? t(' 以 os.environ.setdefault 設定，已設定時不覆寫：') + loc(e.f, e.check) : t(' 以 setenv 第三個參數為 0 設定，已設定時不覆寫：') + loc(e.f, e.check))) : none),
      check('errors', t('回傳固定錯誤碼的地方'), w.errors?.length ? kept(w.errors, (e) => `- **${code(e.code)}**：${fnL(e.fid)}`
        + (p.ix.funcs[e.fid]?.api ? t('（外部進入點）') : p.ix.callers(e.fid).some((x) => x.k === 'fnptr_assign' || x.k === 'fnptr_table') ? t('（裝進函式指標）') : '')
        + (e.how === 'errno' ? t(' 設定 errno：') : t(' 回傳：')) + loc(e.f, e.l)) : none),
      check('loss', t('會丟掉資料的地方'), w.loss?.length ? [note(t('名稱如 lost、dropped、overrun 的計數器遞增處：程式在此捨棄部分資料。')), kept(w.loss, (x) => `- **${code(x.var)}**：${fnL(x.fid)}：${code(x.text)} ${loc(x.f, x.l)}`
        + (x.via.length ? BR + t('經由：') + [...new Set(x.via.map((v) => v.fid))].map((v) => `${fnL(v)} ${x.via.filter((y) => y.fid === v).map((y) => loc(y.f, y.l)).join(t('、'))}`).join(t('、')) : '')
        + BR + (x.said.length ? t('回報：') + x.said.map((y) => loc(y.f, y.l)).join(t('、')) : t('沒有找到印出這個計數的地方。')))].join('\n\n') : none),
      check('leftovers', t('程式結束後會留下的東西'), w.leftovers?.length ? [note(t('以 O_CREAT 建立的 shared memory、具名 semaphore 或 FIFO 會留在系統中，直到被刪除。程式若在刪除前結束（exit、abort、被 signal 終止），就會殘留。')),
        kept(w.leftovers, (x) => `- **${code(x.call)}**：${fnL(x.fid)}${t(' 建立：')}${loc(x.f, x.l)}`
          + BR + (x.removed.length ? t('以 {v1} 刪除：', { v1: x.remove }) + x.removed.map((r) => `${fnL(r.fid)} ${loc(r.f, r.l)}${r.via.length ? t('（經由 ') + r.via.map(fnL).join(t('、')) + t('）') : ''}`).join(t('；'))
            : t('未找到呼叫 {v1} 的位置，每次執行都會殘留一個。', { v1: x.remove }))
          + (x.stops.length ? BR + t('同一元件另有 {v1} 處直接結束程式，須確認其位於建立之前或刪除之後：', { v1: x.stops.length }) + x.stops.map((y) => `${esc(y.name)} ${loc(y.f, y.l)}`).join(t('、')) : ''))].join('\n\n') : none),
      check('limits', t('到達上限時直接返回、不印訊息'), w.limits?.silent.length ? [note(t('計數達到 MAX 常數時直接 return，使用者不會得知有資料未處理。')),
        kept(w.limits.silent, (x) => `- **${code(x.limit)}**：${fnL(x.fid)}：${code(x.cond)} ${loc(x.f, x.l)}`),
        w.limits.said.length ? noteMd(t('另有 {v1} 處到達上限時會先印出訊息：', { v1: w.limits.said.length }) + w.limits.said.map((x) => `${fnL(x.fid)} ${loc(x.f, x.l)}`).join(t('、'))) : ''].filter(Boolean).join('\n\n') : none),
      check('plain_writes', t('不經 atomic 操作就修改的全域變數'), w.plain_writes?.length ? [note(t('未判斷是否有鎖保護或只在單一執行緒執行。標示「載入時」的寫入位於 constructor，通常早於其他執行緒啟動。')),
        kept([...w.plain_writes].sort((a, b) => Number(a.writes.every((x) => p.ix.callerInfo(x.fid).load)) - Number(b.writes.every((x) => p.ix.callerInfo(x.fid).load))), (v) => `- **${code(v.name)}**`
          + v.writes.map((x) => `\n  - ${fnL(x.fid)}${p.ix.callerInfo(x.fid).load === 'constructor' ? t('（載入時）') : p.ix.callerInfo(x.fid).load === 'destructor' ? t('（結束時）') : ''}${t('：')}${code(x.text)} ${loc(x.f, x.l)}`).join(''))].join('\n\n') : none),
      check('env', t('未檢查 NULL 就使用的 getenv 結果'), w.env.length ? kept(w.env, (e) => `- **${e.name ? code(e.name) : t('（名稱執行時決定）')}**：${fnL(e.fid)}${e.use !== e.l ? t(' 在第 {v1} 行使用：', { v1: e.use }) : t(' 直接使用：')}${loc(e.f, e.l)}`)
        : note(t('未找到。每個 getenv 結果在使用前皆已檢查 NULL，或直接回傳給呼叫者。'))),
      skipped.length ? note(t('另有 {v1} 項只適用於 {v2} 的檢查，本專案不適用，未列出。', { v1: skipped.length, v2: [...new Set(skipped.flatMap(([k]) => covers(k)))].map((l) => LANG_NAME[l] ?? l).join(t('、')) })) : '',
    ].filter(Boolean).join('\n\n') })
  }

  // the whole overview, the same text the page shows
  const all = [`# ${t('{v1} 的概觀', { v1: g.repo })}`, ...parts.map(partText)].join('\n\n') + '\n'
  const copy = () => navigator.clipboard.writeText(all).then(() => { setCopied(true); UI.announce(t('已複製概觀的 Markdown')); setTimeout(() => setCopied(false), 2000) },
    () => UI.announce(t('瀏覽器不允許寫入剪貼簿，請改用選取後複製。')))
  return (
    <UI.Card className="detail fit overview" title={t('概觀')} actions={<UI.Button icon={copied ? 'check' : 'copy'} onClick={() => { void copy() }}>{copied ? t('已複製') : t('複製成 Markdown')}</UI.Button>}>
      <p className="small muted">{t('點選方塊查看函式，點選線查看依據。')}</p>
      <div data-tour="arch"><RepoKey.Provider value={g.repo}><MdLinksCtx.Provider value={links}><UI.SectionGroup>
        {parts.map((x) => <Part key={x.id} {...x} />)}
      </UI.SectionGroup></MdLinksCtx.Provider></RepoKey.Provider></div>
    </UI.Card>
  )

}

/** What a variable does, from the code (or the project's own words in .codemap/rules.json), as Markdown lines. */
function meaning(m: NonNullable<Graph['env_info']>[string]): string[] {
  const kind = m.kind === 'flag' ? t('開關，0 為關閉、其他數字為開啟') : m.kind === 'number' ? t('數字') : m.kind === 'presence' ? t('只看是否已設定') : m.kind === 'text' ? t('文字') : ''
  const unset = !m.default ? '' : m.default === 'on' ? t('開啟') : m.default === 'off' ? t('關閉') : m.default === 'early-return' ? t('提早返回，不執行後續動作') : m.default
  // the project's own words: rules.json first, else the comment that names the variable (trace.h: IBTRACE_X=1: ...)
  const said = m.comments?.find((c) => c.defines)
  const near = !said && !(m.own && m.purpose) ? m.comments?.[0] : undefined
  return [
    m.own && m.purpose ? esc(m.purpose) : said ? `${oneLine(said.text)} ${t('（取自 {v1} 的註解）', { v1: said.at.split('/').pop() })}` : '',
    near ? `${t('相關註解（{v1}）：', { v1: near.at.split('/').pop() })}${oneLine(near.text)}` : '',
    [kind, unset ? t('未設定時：{v1}', { v1: unset }) + (m.own && m.default ? t('（專案寫的）') : '') : '', m.into ? t('存入 {v1}', { v1: m.into }) : ''].filter(Boolean).join(t('；')),
  ].filter(Boolean)
}

/** Functions nothing in the repo calls directly, put into a function pointer that code outside the repo calls
 *  (an ops table, a UCT table, a signal handler), by the function that installs them. One count for every page. */
export function pointerEntries(ix: Index): Map<string, string[]> {
  const installed = new Map<string, string[]>()
  for (const [id, f] of Object.entries(ix.funcs)) {
    if (f.api) continue
    const by = ix.callers(id)
    if (by.some((e) => written(e) && ix.funcs[e.s])) continue
    const put = by.find((e) => e.k === 'fnptr_assign' && ix.funcs[e.s])
    if (put) push(installed, put.s, id)
  }
  return installed
}

const PARTS = new Set(['ov-comps', 'ov-docs', 'ov-entry', 'ov-cmds', 'ov-env', 'ov-build', 'ov-writes', 'ov-reads', 'ov-worth'])

/** Opens an overview part (a check inside 值得檢查的地方 opens that part), scrolls to it and puts the keyboard on its title. */
export function jump(id: string) {
  dispatchEvent(new CustomEvent('codemap:part', { detail: PARTS.has(id) ? id : 'ov-worth' }))
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const h = document.getElementById(id) ?? document.getElementById(PARTS.has(id) ? id : 'ov-worth')
    revealTop(h)
    const at = (PARTS.has(id) ? h?.querySelector<HTMLElement>('.ui-sec-btn') : h) ?? h
    at?.focus({ preventScroll: true })
  }))
}

/** The repository whose parts are open or closed: each repository remembers its own. */
const RepoKey = createContext('')

// The overview is Markdown: each part's content is text made from the index and shown by UI.Markdown, so the page and
// 複製成 Markdown are the same text. A function is a fn: link (opens the flow page), a file:line a path in code
// (opens in the side panel), a long list a <details> block.
const esc = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1')
const code = (s: string, inTable = false) => {
  const ticks = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(ticks + 1), pad = ticks ? ' ' : ''
  return fence + pad + (inTable ? s.replace(/\|/g, '\\|') : s) + pad + fence
}
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()
const mdTable = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map((c) => c.replace(/\n/g, ' ')).join(' | ')} |`)].join('\n')
const details = (summary: string, body: string) => `<details><summary>${esc(summary)}</summary>\n\n${body}\n\n</details>`
/** A note in the muted quote style; plain text (`__init__.py` is not bold). noteMd keeps marks already written. */
const note = (s: string) => '> ' + esc(s)
const noteMd = (s: string) => '> ' + s
/** A line break inside a list item. */
const BR = '\\\n  '

interface MdLinks { onFn: (id: string) => void; openFile: (f: string, l: number) => void; refs: ReturnType<typeof useCodeRefs> }
const MdLinksCtx = createContext<MdLinks | null>(null)

/** The overview's Markdown: ### is an h4 under the part's h3 title; fn: links open the flow page. */
function OvMd(p: { children: string }) {
  const c = useContext(MdLinksCtx)!
  const web = (h: string) => /^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('fn:')
  return (
    <UI.Markdown topLevel={2} schemes={['fn']} {...c.refs}
      linkHref={(h) => (h.startsWith('fn:') ? '#flow?s=' + h.slice(3) : web(h) ? h : '#' + h)}
      onLink={(h) => { if (h.startsWith('fn:')) c.onFn(decodeURIComponent(h.slice(3))); else if (web(h)) window.open(h, '_blank', 'noopener'); else c.openFile(h, 1) }}>
      {p.children}
    </UI.Markdown>
  )
}

interface PartMd { id: string; title: string; summary?: string; open?: boolean; md: string }
const partText = (x: PartMd) => [`## ${x.title}`, x.summary, x.md].filter(Boolean).join('\n\n')

/** One part of the overview: a Section with its title, its line of numbers and a copy button; open or closed is
 *  kept per repository. 元件 and 進入與結束 start open, the rest closed. */
function Part(p: PartMd) {
  const key = `codemap:part:${useContext(RepoKey)}:${p.id}`
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem(key); if (v === '1' || v === '0') return v === '1' } catch { /* storage off */ }
    return !!p.open
  })
  const set = (v: boolean) => {
    setOpen(v)
    try { localStorage.setItem(key, v ? '1' : '0') } catch { /* storage off: works, does not remember */ }
  }
  useEffect(() => {
    const f = (e: Event) => { if ((e as CustomEvent<string>).detail === p.id) setOpen(true) }
    addEventListener('codemap:part', f)
    return () => removeEventListener('codemap:part', f)
  }, [p.id])
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(partText(p)).then(() => { setCopied(true); UI.announce(t('已複製 {v1}', { v1: p.title })); setTimeout(() => setCopied(false), 2000) },
    () => UI.announce(t('瀏覽器不允許寫入剪貼簿，請改用選取後複製。')))
  return (
    <UI.Section id={p.id} title={p.title} summary={p.summary || undefined} open={open} onOpenChange={set}
      actions={<UI.IconButton icon={copied ? 'check' : 'copy'} label={copied ? t('已複製') : t('複製這一段')} onClick={() => { void copy() }} />}>
      <OvMd>{p.md}</OvMd>
    </UI.Section>
  )
}


const KIND: Record<string, string> = { exec: '執行檔', shared: '共享程式庫', static: '靜態程式庫', generated: '產生的檔案' }
const base = (path: string) => path.replace(/\/$/, '').split('/').pop()!
const dir = (path: string) => (path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1))

/** What `make` builds, what each product is made of, and what `make install` puts where. */
function buildPart(build: BuildInfo): PartMd {
  const main = build.built.filter((b) => b.goal === build.goal)
  const goals = [...new Set(build.built.map((b) => b.goal))].filter((g) => g !== build.goal)
  const copies = build.install.filter((i) => !i.link)
  const links = new Map<string, string[]>()
  for (const i of build.install.filter((x) => x.link)) {
    const k = `${dir(i.to)}\u0000${dir(i.what[0])}`
    links.set(k, [...(links.get(k) ?? []), base(i.to)])
  }
  const what = (b: BuildInfo['built'][number]) => t(KIND[b.kind])
    + (b.kind === 'generated' ? t('，由 {v1} 產生', { v1: b.files.join(t('、')) }) : b.files.length ? t('，由 {v1} 的 {v2} 個原始檔（.c）編成', { v1: b.comps.join(t('、')), v2: b.files.length }) : '')
    + (b.uses.length ? t('，連同 {v1}', { v1: b.uses.map(base).join(t('、')) }) : '')
    + (b.libs.length ? t('；連結 {v1}', { v1: b.libs.map((l) => '-l' + l).join(' ') }) : '')
    + (b.exports.length ? t('；匯出的符號由 ') + loc(b.exports[0], 1) + t(' 決定') : '')
  const named = (b: BuildInfo['built'][number]) => (main.some((m) => m.name === b.name) ? t('{v1}（另一個版本，{v2}）', { v1: b.name, v2: b.path }) : b.name)
  return {
    id: 'ov-build', title: t('建置產物'), summary: t('{v1} 個產物', { v1: main.length }),
    md: [
      note(t('取自 Makefile（make -n 的結果）。make {v1} 建置 {v2} 個產物：', { v1: build.goal, v2: main.length })),
      main.map((b) => `- **${esc(b.name)}**：${what(b)}`).join('\n'),
      goals.map((g) => ((bs) => `- **make ${esc(g)}**：${t('另外建置 {v1} 個：{v2}', { v1: bs.length, v2: bs.map(named).join(t('、')) })}`)(build.built.filter((b) => b.goal === g))).join('\n'),
      build.install.length ? [`### ${t('make install 安裝的檔案')}`,
        [...copies.map((c) => `- ${code(c.to)}：${c.what.map(base).join(t('、'))}`),
          ...[...links].map(([k, names]) => `- ${code(k.split('\u0000')[0])}：${t('{v1}（符號連結，指向 {v2}）', { v1: names.join(t('、')), v2: k.split('\u0000')[1] })}`)].join('\n'),
        note(t('路徑為以 Makefile 預設設定執行 make -n install 的結果。'))].join('\n\n') : '',
    ].filter(Boolean).join('\n\n'),
  }
}

/** Where the code creates or writes files, and the file names when the code spells them out. */
function writesPart(ix: Index, writes: FileWrite[], none: string): PartMd {
  const how = (w: FileWrite) => w.call === 'shm_open' ? t('以 shm_open（O_CREAT）建立')
    : /^(write_text|write_bytes)$/.test(w.call) ? t('以 {v1} 寫入', { v1: w.call })
    : /(replace|rename)$/i.test(w.call) ? t('以 {v1} 換成這個檔案', { v1: w.call })
    : /(copy\w*|move|copyFile\w*)$/.test(w.call) ? t('以 {v1} 寫到這裡', { v1: w.call })
    : /^(os\.Create|os\.WriteFile|ioutil\.WriteFile)$|^fs/.test(w.call) ? t('以 {v1} 寫入', { v1: w.call })
    : t('以 {v1} 開啟', { v1: w.call })
  const name = (w: FileWrite) => w.name ? code(w.name) : w.format ? code(w.format) : w.param ? t('參數 {v1}', { v1: w.param }) : w.expr ? code(w.expr) : t('（執行時決定）')
  // where the name comes from when the code does not spell it out
  const said = (w: FileWrite) => [w.call === 'shm_open' ? t('POSIX shared memory 物件，位於 /dev/shm，須呼叫 shm_unlink 才會刪除') : '',
    w.name ? '' : w.format ? t('檔名在執行時依這個格式組成') : w.param && w.via?.length ? t('檔名由呼叫者傳入') : w.param ? t('檔名在執行時由這個參數傳入') : w.expr ? t('檔名在執行時取自這個運算式') : t('檔名在執行時決定')].filter(Boolean).join(t('；'))
  return {
    id: 'ov-writes', title: t('寫出的檔案'), summary: t('{v1} 處', { v1: writes.length }),
    md: writes.length ? writes.map((w) => `- **${name(w)}**：${fnLink(ix, w.fid)} ${how(w)}，${loc(w.f, w.l)}`
      + (said(w) ? BR + said(w) : '')
      // the names the callers pass in: _atomic_json(STATE_DIR / 'controller.json', …)
      + (w.via?.length ? w.via.map((v) => `\n  - ${code(v.name)} ${fnLink(ix, v.fid)} ${loc(v.f, v.l)}`).join('') : '')).join('\n')
      : note(none ? t('沒有寫入檔案的地方（{v1}）。', { v1: none }) : t('本專案的語言沒有寫入檔案的檢查。')),
  }
}

function CompTree(p: { ix: Index; comp: string; onPick: (id: string) => void; onBack: () => void }) {
  const docs = p.ix.g.files ?? {}
  const items = useMemo(() => {
    const files = [...p.ix.byFile()].filter(([, ids]) => p.ix.funcs[ids[0]].comp === p.comp).sort(([a], [b]) => a.localeCompare(b))
    return files.map(([f, ids]) => ({
      id: 'file:' + f, name: f.split('/').pop()!, path: f, icon: 'file-text' as const,
      // read out as the name and its function count; the comment stays on screen
      ariaLabel: t('{v1}，{v2} 個函式', { v1: f.split('/').pop(), v2: ids.length }),
      // the file's own comment, or its header's when the file says it is described there
      meta: docs[f] ? (docs[f].file && docs[f].file !== f ? t('（取自 {v1}）', { v1: docs[f].file!.split('/').pop() }) : '') + short(docs[f].text, 110) : t('{v1} · 沒有說明註解', { v1: f }),
      children: ids.map((id) => ({
        // the line it is defined on, so a name in the list is a place to cite without opening it
        id, name: p.ix.funcs[id].name, meta: `${p.ix.funcs[id].file.split('/').pop()}:${p.ix.funcs[id].line} · ${p.ix.callerText(id)}`,
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
  // Python tools that parse its headers: counted among its users on the diagram, so listed here too
  const readers = p.ix.g.links.filter((l) => l.kind === 'reads' && l.b === p.comp)
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
            }).concat(readers.map((l) => ({ label: l.a, value: <span>{t('Python 工具讀取 {v1}（推測，非呼叫）', { v1: list(l.names ?? []) })}</span> })))} />
          </>
        ) : null}
      </UI.Card>
      <div className="tree-panel grow-panel">{tree}</div>
    </div>
  )
}
