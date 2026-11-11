import type { ReactNode } from 'react'
import { useState } from 'react'
import { UI } from '../ui'
import { DocRefs, langLabel, useCodeRefs } from '../components/DocRefs'
import { noun, t } from '../i18n'
import { entryText, type Index } from '../data/graph'
import { useFileSource, useFuncSource } from '../data/hooks'
import { inferred, type Edge, type Sel } from '../data/types'
import { vscodeURL } from '../prefs'
import { CodeAt, LineLink } from './CodeAt'

interface Props {
  ix: Index
  sel: Sel
  isLive: boolean
  sourceId: string
  canMacro: boolean
  goFlow: (id: string) => void
  /** opens the flow at ids[0] with the rows down to the last one open */
  goChain: (ids: string[]) => void
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
  const refs = useCodeRefs(p.ix)
  // a file:line clicked in this panel, shown in place of the function until another selection
  const [shown, setShown] = useState<{ key: string; f: string; l: number } | null>(null)
  const selKey = `${p.sel.id}@${e?.f}:${e?.l}`
  const at = shown?.key === selKey ? shown : null
  // the whole file instead of the function, until another selection
  const [wholeKey, setWhole] = useState<string | null>(null)
  const whole = wholeKey === selKey
  const file = useFileSource(whole && f ? f.file : null, p.isLive, p.sourceId)
  if (!f) {
    if (!e) return <UI.Card className="detail"><p className="muted">{t('選擇函式以查看原始碼。')}</p></UI.Card>
    const name = p.ix.nameOf(p.sel.id, e)
    return (
      <UI.Card className="detail" title={name}>
        <UI.DetailList items={[
          { label: t('種類'), value: p.ix.explain(e as Edge).title },   // only the flow tree selects a non-function, with its full edge
          ...(e.ext ? [{ label: t('宣告'), value: <UI.InlineCode>{e.ext}</UI.InlineCode> }] : []),
          { label: t('呼叫位置'), value: link(e.f, e.l) },
        ]} />
        <CodeAt ix={p.ix} at={{ f: e.f, l: e.l }} isLive={p.isLive} sourceId={p.sourceId} maxHeight="60vh" />
      </UI.Card>
    )
  }
  // the edge's line is inside this function only when looking up (it is this function's call)
  const inside = !!e && e.f === f.file && f.line <= e.l && e.l <= f.end
  const focus = inside ? e!.l : f.line
  const who = p.ix.callerInfo(p.sel.id), nCallees = p.ix.calleeCount(p.sel.id)
  const nCallers = who.sure + who.guessed
  const ext = new Set(p.ix.callees(p.sel.id, true).filter((x) => !p.ix.funcs[x.d] && !inferred(x)).map((x) => x.d)).size
  // outside functions it calls, by name, with the first line of each
  const extNames = [...new Map(p.ix.callees(p.sel.id, true).filter((x) => !p.ix.funcs[x.d] && !inferred(x)).map((x) => [p.ix.bareName(x.d, x), x] as const)).entries()]
  // the shortest chain of calls from the flow's start (breadth first, up to 12 calls deep)
  const chain = p.view === 'flow' && p.start && p.start !== p.sel.id ? pathTo(p.ix, p.start, p.sel.id) : null
  // the nearest place the program comes in (a function nothing in the repository calls: an event handler,
  // __init__, main) down to this one, whatever the flow's start is: one view of a whole path
  const fromEntry = entryPath(p.ix, p.sel.id)
  // where each caller calls it from: one row per caller and line, repository functions only
  // one row per caller, as counted above, with every line it calls from
  const bySite = new Map<string, Edge[]>()
  for (const x of p.ix.callers(p.sel.id)) {
    if (!p.ix.funcs[x.s] || x.k === 'constructor' || x.k === 'destructor') continue
    const g = bySite.get(x.s) ?? []
    if (!g.some((y) => y.f === x.f && y.l === x.l)) g.push(x)
    bySite.set(x.s, g)
  }
  const callSites = [...bySite.values()].map((g) => g.sort((a, b) => a.l - b.l)).sort((a, b) => a[0].f.localeCompare(b[0].f) || a[0].l - b[0].l)
  // the repository functions it calls, each with every line it calls from: a count alone sends people elsewhere for names
  const outSites = new Map<string, Edge[]>()
  for (const x of p.ix.callees(p.sel.id, true)) {
    if (!p.ix.funcs[x.d] || x.k === 'exec') continue
    const g = outSites.get(x.d) ?? []
    if (!g.some((y) => y.f === x.f && y.l === x.l)) g.push(x)
    outSites.set(x.d, g)
  }
  const calleeSites = [...outSites.values()].map((g) => g.sort((a, b) => a.l - b.l)).sort((a, b) => a[0].l - b[0].l)
  const twins = Object.entries(p.ix.funcs).filter(([id, g]) => id !== p.sel.id && g.name === f.name).sort(([, a], [, b]) => a.file.localeCompare(b.file))
  // the same caller calling it on several lines (one merged row in the flow tree)
  const sites = e ? p.ix.callers(p.sel.id).filter((x) => x.s === e.s && x.src === e.src && x.f === e.f).sort((a, b) => a.l - b.l) : []
  const here = p.sel.id === p.start
  // other calls written on the same line (ibmon_spawn(..., ibmon_default_preload())), and the macros the line uses:
  // a call made inside a macro is recorded on the line that uses the macro
  const sameLine = e ? [...new Set(p.ix.callees(e.s ?? "", true).filter((x) => x.f === e.f && x.l === e.l && x.d !== e.d).map((x) => p.ix.bareName(x.d, x)))] : []
  const macros = e?.t ? (p.ix.g.symbols ?? []).filter((s) => s.kind === 'macro' && new RegExp(`\\b${s.name}\\s*\\(`).test(e.t!)) : []
  function link(file: string, line: number) {
    const own = !!f && file === f.file && f.line <= line && line <= f.end
    return <LineLink ix={p.ix} file={file} line={line} onOpen={() => setShown(own ? null : { key: selKey, f: file, l: line })} />
  }
  return (
    // where to go next sits at the top: under a long list of callers it fell below the window (1440 x 900)
    <UI.Card className="detail" title={<span id="detail-title" tabIndex={-1} title={f.name}>{f.name}</span>} actions={<>
      {p.view === 'flow' && here ? null : <UI.Button icon="share-network" onClick={() => p.goFlow(p.sel.id)}>{p.view === 'flow' ? t('從這裡追蹤流程') : t('追蹤流程')}</UI.Button>}
      {p.view === 'impact' && here ? null : <UI.Button icon="pulse" onClick={() => p.goImpact(p.sel.id)}>{t('查看影響範圍')}</UI.Button>}
    </>}>
      {/* the panel is read first after a search; from here the tree is many Tab stops away */}
      {p.view === 'flow' ? <p className="small"><button type="button" className="linklike" onClick={() => {
        const el = document.querySelector<HTMLElement>('#flow-tree [role=treeitem][aria-selected=true], #flow-tree [role=treeitem]')
        el?.focus()
      }}>{t('跳到呼叫流程樹')}</button></p> : null}
      <UI.DetailList items={[
        { label: t('定義'), value: link(f.file, f.line) },
        { label: t('元件'), value: f.comp },
        // a framework calls it by itself: no line of the repository does
        // the outside interfaces it implements: what may run it behind err.Error(), without a call edge per site
        ...(p.ix.impls.get(p.sel.id)?.length ? [{ label: t('實作'), value: <span>{p.ix.impls.get(p.sel.id)!.map((e, i) => <span key={e.d}>{i ? t('、') : ''}<UI.InlineCode>{p.ix.bareName(e.d, e)}</UI.InlineCode></span>)}<span className="muted">{t('（經由這些 interface 的呼叫可能執行到它）')}</span></span> }] : []),
        ...(f.types_incomplete ? [{ label: t('分析限制'), value: <span className="muted">{(f.lang === 'go' ? t('此檔案的型別檢查不完整（缺少 module 或需要較新的 Go），可能漏掉部分呼叫。')
          : t('此檔案的型別檢查不完整（常見原因是未安裝 node_modules），可能漏掉部分呼叫。'))}</span> }] : []),
        ...(f.scope === 'test' ? [{ label: t('範圍'), value: t('測試程式碼') }] : []),
        ...(f.entry ? [{ label: t('由框架呼叫'), value: <span>{t('{v1}：{v2}', { v1: f.entry.framework, v2: entryText(f.entry) })}</span> }] : []),
        // two rows, each number right after its own word: 「1 個 caller · 0 個 callee」 was read as caller · 0
        { label: t('被誰呼叫'),
          value: <span>{t('{v1} 個 ', { v1: nCallers })}<UI.Term text={t('呼叫此函式的 repo 內函式，同一函式只算一次，推測的關係另外註明。')}>{noun(nCallers, 'caller')}</UI.Term>{who.guessed ? (who.guessed === nCallers ? t('（推測）') : t('（其中 {v1} 個是推測）', { v1: who.guessed })) : ''}
            {/* the callers by name, compiler-seen first: a count alone sends people to the flow page to learn who */}
            {/* each caller with the line it calls from, so a file:line needs no detour through the impact page */}
            {nCallers ? <span className="entry-list">{callSites.slice(0, 6).map((g) => (
              <span key={g[0].s} className="entry-row"><FnLink id={g[0].s} go={p.goFlow}>{p.ix.funcs[g[0].s].name}</FnLink>{' '}
                {g.map((c, i) => <span key={c.f + c.l}>{i ? t('、') : ''}{link(c.f, c.l)}</span>)}{g.every((c) => c.k === 'ref') ? <span className="muted">{t('（當作值傳出）')}</span> : null}</span>))}
              {callSites.length > 6 ? <span className="entry-row muted">{t('另有 {v1} 個，見流程頁的「往上」', { v1: callSites.length - 6 })}</span> : null}</span> : null}
            {p.ix.g.hidden_callers?.[p.sel.id] ? <span className="entry-row muted">{t('另有 {v1} 個測試函式呼叫它，未列出；可在設定頁開啟「包含測試程式碼」。', { v1: p.ix.g.hidden_callers[p.sel.id] })}</span> : null}
            {who.main ? t('。程式的起點，由 C 執行環境在程式啟動時呼叫') : ''}{who.others.length ? t('。另有推測的來源：{v1}', { v1: who.others.slice(0, 2).join(t('、')) }) : ''}{who.load === 'constructor' ? t('。程式載入時自動執行（constructor）') : who.load === 'destructor' ? t('。程式結束時自動執行（destructor）') : ''}</span> },
        // other definitions of the same name: which one a reader landed on is not obvious from the name
        ...(twins.length ? [{ label: t('同名'), value: <span className="entry-list">{twins.map(([id, g]) => (
          <span key={id} className="entry-row"><FnLink id={id} go={p.goFlow}>{g.name}</FnLink>{' '}{link(g.file, g.line)}{t('（{v1}）', { v1: g.comp })}</span>))}</span> }] : []),
        { label: t('呼叫誰'),
          value: <span>{t('{v1} 個 ', { v1: nCallees })}<UI.Term text={t('此函式呼叫的 repo 內函式，同一函式只算一次。流程樹的 ×N 為呼叫次數。')}>{noun(nCallees, 'callee')}</UI.Term>{ext ? t('（另呼叫 {v1} 個 repo 外的函式）', { v1: ext }) : ''}
            {calleeSites.length ? <span className="entry-list">{calleeSites.slice(0, 12).map((g) => (
              <span key={g[0].d} className="entry-row"><FnLink id={g[0].d} go={p.goFlow}>{p.ix.funcs[g[0].d].name}</FnLink>{' '}
                {g.map((c, i) => <span key={c.f + c.l}>{i ? t('、') : ''}{link(c.f, c.l)}</span>)}{inferred(g[0]) ? <span className="muted">{t('（推測）')}</span> : g.every((c) => c.k === 'ref') ? <span className="muted">{t('（當作值傳出）')}</span> : null}</span>))}
              {calleeSites.length > 12 ? <span className="entry-row muted">{t('另有 {v1} 個，見流程頁的「往下」', { v1: calleeSites.length - 12 })}</span> : null}</span> : null}
            {extNames.length ? <span className="entry-row muted">{t('repo 外：')}</span> : null}
            {/* the outside calls by name: subprocess.run, os.replace and the like say what the function does to the system */}
            {extNames.length ? <span className="entry-list">{extNames.slice(0, 10).map(([n, e]) => <span key={n} className="entry-row"><UI.InlineCode>{n}</UI.InlineCode>{' '}{link(e.f, e.l)}</span>)}
              {extNames.length > 10 ? <span className="entry-row muted">{t('另有 {v1} 個', { v1: extNames.length - 10 })}</span> : null}</span> : null}</span> },
        ...(fromEntry && fromEntry.length > 1 && !(chain && chain[0].id === fromEntry[0].id) ? [{ label: t('從進入點到這裡'), value: <span className="entry-list">
          <span className="entry-row muted">{t('{v1}：repo 內沒有呼叫者的進入點。以下是從它到這裡最短的呼叫鏈。', { v1: p.ix.funcs[fromEntry[0].id].name })}</span>
          <span className="entry-row"><button type="button" className="linklike" onClick={() => p.goChain(fromEntry.map((c) => c.id))}>{t('在流程樹展開這條呼叫鏈')}</button></span>
          {fromEntry.map((c, i) => (
          <span key={i} className="entry-row">{i ? '→ ' : ''}<FnLink id={c.id} go={p.goFlow}>{p.ix.funcs[c.id]?.name ?? c.id}</FnLink>{c.e ? <>{' '}{link(c.e.f, c.e.l)}{c.e.k === 'ref' ? <span className="muted">{t('（當作值傳出）')}</span> : null}</> : null}</span>))}</span> }] : []),
        // how the flow's start reaches this function: one chain of calls, each with its line
        ...(chain && chain.length > 1 ? [{ label: t('從起點到這裡'), value: <span className="entry-list">{chain.map((c, i) => (
          <span key={i} className="entry-row">{i ? '→ ' : ''}<FnLink id={c.id} go={p.goFlow}>{p.ix.funcs[c.id]?.name ?? c.id}</FnLink>{c.e ? <>{' '}{link(c.e.f, c.e.l)}</> : null}</span>))}</span> }] : []),
        // calls the compiler never saw: inside #if/#ifdef blocks this build leaves out
        ...((u) => u?.length ? [{ label: t('條件編譯'), value: <span>{t('另有 {v1} 處呼叫在條件編譯中，本次 build 未編入，因此未計入上方：', { v1: u.length })}{u.map((x, i) => (
          <span key={i} className="write-row">{x.by}{t('（{v1}）', { v1: x.cond })}{' '}{link(x.f, x.l)}</span>))}</span> }] : [])(p.ix.g.uncompiled?.[p.sel.id]),
        ...(f.api ? [{ label: t('進入方式'), value: <span><UI.Term text={t('與 {v1} 程式庫的函式同名，以 LD_PRELOAD 載入後會優先執行此版本。呼叫者在 repo 外，因此 caller 可能為 0 個。', { v1: f.api })}>{t('外部進入點')}</UI.Term>{t('：攔截 {v1} 的同名函式', { v1: f.api })}</span> }] : []),
        ...(e && !inside ? [{ label: t('呼叫位置'), value: sites.length > 1
          ? <span>{sites.map((s, i) => <span key={s.l}>{i ? t('、') : ''}{link(s.f, s.l)}</span>)}</span> : link(e.f, e.l) }] : []),
        ...(sameLine.length ? [{ label: t('同一行'), value: t('這一行另呼叫 {v1}，兩個呼叫位於同一個運算式。', { v1: sameLine.join(t('、')) }) }] : []),
        ...macros.map((m) => ({ label: t('巨集'), value: <span>{t('這一行使用巨集 {v1}，定義在 ', { v1: m.name })}{link(m.file, m.line)}{t('。呼叫在巨集展開後才發生，因此記在這一行。')}</span> })),
        ...(e && (e.via || e.slot) ? [{ label: t('經由'), value: <UI.InlineCode>{e.via || e.slot}</UI.InlineCode> }] : []),
      ]} />
      {/* the whole file above the code: at the bottom of a long function it was missed */}
      {p.isLive ? <UI.ActionBar actions={[{ label: whole ? t('只顯示這個函式') : t('顯示整個檔案'), onClick: () => setWhole(whole ? null : selKey) }]} /> : null}
      {whole ? (
        file.isPending ? <UI.Skeleton width="80%" height={16} />
          : file.error || !file.data ? <UI.Alert tone="danger" title={t('無法讀取檔案')}>{file.error ? (file.error as Error).message : t('此檔案不在索引中。')}</UI.Alert>
          : <><UI.CodeView file={file.data.file} code={file.data.lines.join('\n')} start={1} target={focus} maxHeight="60vh" {...refs} languageLabel={langLabel(file.data.file)} /><DocRefs ix={p.ix} lines={file.data.lines} /></>
      ) : at ? <CodeAt ix={p.ix} at={at} isLive={p.isLive} sourceId={p.sourceId} maxHeight="60vh" focus />
        : src.isPending ? <div><UI.Skeleton width="80%" height={16} /><UI.Skeleton width="60%" height={16} /><UI.Skeleton width="70%" height={16} /></div>
        : src.error ? <UI.Alert tone="danger" title={t('無法讀取原始碼')}>{(src.error as Error).message}</UI.Alert>
        : !src.data ? <p className="small muted">{t('匯出快照時無法讀取此檔案。請在 build 環境重新執行 codemap export。')}</p>
        : <UI.CodeView {...refs} languageLabel={langLabel(src.data.file)} file={src.data.file} fileHref={vscodeURL(f.file, focus, p.ix.g.root, p.ix.g.host) ?? undefined}
            code={src.data.lines.join('\n')} start={src.data.start} target={focus} maxHeight="60vh" />}
      {!whole && src.data ? <DocRefs ix={p.ix} lines={src.data.lines} /> : null}

    </UI.Card>
  )
}

/** The shortest chain of repository calls from one function to another: [{id, e}], where e is the call
 *  this function makes into the next one (null on the last). */
function pathTo(ix: Index, from: string, to: string): { id: string; e: Edge | null }[] | null {
  const prev = new Map<string, { id: string; e: Edge } | null>([[from, null]])
  let level = [from]
  for (let depth = 0; depth < 12 && level.length && !prev.has(to); depth++) {
    const next: string[] = []
    for (const id of level) {
      for (const e of ix.callees(id, false)) {
        if (!ix.funcs[e.d] || prev.has(e.d)) continue
        prev.set(e.d, { id, e })
        next.push(e.d)
      }
    }
    level = next
  }
  if (!prev.has(to)) return null
  const nodes: string[] = []
  for (let cur: string | null = to; cur !== null; cur = prev.get(cur)?.id ?? null) nodes.unshift(cur)
  return nodes.map((id, i) => ({ id, e: i + 1 < nodes.length ? prev.get(nodes[i + 1])!.e : null }))
}

/** The shortest chain from a function nothing in the repository calls down to `to`, found by walking
 *  callers upward; each step carries the call (or hand-off) to the next one. Null when `to` is itself one. */
function entryPath(ix: Index, to: string): { id: string; e: Edge | null }[] | null {
  const next = new Map<string, Edge | null>([[to, null]])
  let level = [to]
  for (let depth = 0; depth < 15 && level.length; depth++) {
    const up: string[] = []
    for (const id of level) {
      const callers = ix.callers(id).filter((e) => ix.funcs[e.s] && e.s !== id)
      if (!callers.length) {
        if (id === to) return null
        const nodes: { id: string; e: Edge | null }[] = []
        for (let cur: string | null = id; cur !== null;) {
          const e: Edge | null = next.get(cur) ?? null
          nodes.push({ id: cur, e })
          cur = e ? e.d : null
        }
        return nodes
      }
      for (const e of callers) {
        if (next.has(e.s)) continue
        next.set(e.s, e)
        up.push(e.s)
      }
    }
    level = up
  }
  return null
}

/** A function's name as a link to its flow: a real link (it opens in a new tab, and is read and found as
 *  a link), with a plain click staying in the page. Agents and people alike looked for links here. */
function FnLink(p: { id: string; go: (id: string) => void; children: ReactNode }) {
  return (
    <a className="linklike" href={'#flow?s=' + encodeURIComponent(p.id)}
      onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); p.go(p.id) } }}>
      {p.children}
    </a>
  )
}
