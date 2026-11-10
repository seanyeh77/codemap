import { useEffect, useMemo, useRef, useState } from 'react'
import { UI } from '../ui'
import { local, t } from '../i18n'
import type { Index } from '../data/graph'
import { uncertain, type Edge, type Sel } from '../data/types'
import type { TreeNode } from '@seanyeh77/ui'

/** open: its next level can be shown (it has calls, and it is not already on the path). */
interface Entry { fid: string; edge: Edge | null; names: string[]; open: boolean; kids: Edge[]; path: string[] }

/** The call tree handed to TreeList. Only the start's level is built; TreeList loads a node's
 *  children when it is opened (loadChildren). Guess mode: a node, the start included, opens only once revealed. */
function buildTree(ix: Index, start: string, dir: 'down' | 'up', showExt: boolean, predict: boolean, revealed: Record<string, boolean>,
  openLine: (fid: string, e: Edge, key: string) => void) {
  const index: Record<string, Entry> = {}
  const stageIds: string[] = []
  const kidsOf = (fid: string) => (dir === 'down' ? ix.callees(fid, showExt) : ix.callers(fid))
  function node(nid: string, e: Edge | null, key: string, path: string[], parent: string, sites: Edge[] = []): TreeNode {
    const f = ix.funcs[nid]
    const kids = f ? kidsOf(nid) : []
    // called from several lines of the parent: one row, its lines listed ("main.c:183、205、214")
    const at = e ? (sites.length > 1 ? t('{v1}:{v2}', { v1: e.f, v2: sites.map((s) => s.l).join(t('、')) }) : `${e.f}:${e.l}`) : f ? `${f.file}:${f.line}` : undefined
    const n: TreeNode = { id: key, name: ix.nameOf(nid, e), path: at }
    if (sites.length > 1) n.tags = [<UI.Tag key="n">{`×${sites.length}`}</UI.Tag>]
    if (e) {
      // the call is in the parent (looking down) or in this node's function (looking up)
      const where = dir === 'down' ? parent : key
      // only inferred relations carry a tag; the note under the tree says the rest are the compiler's
      if (uncertain(e) || e.resolution === 'inferred' || e.mode || e.k === 'ref' || e.infer?.how === 'embedding') n.tags = [...(n.tags ?? []), <RelationTag key="r" ix={ix} e={e} open={() => openLine(e.s, e, where)} />]
      if (!f) n.muted = true
    }
    // read aloud as 「name，推測（規則），called 3 times，file:lines」: the tags are elements, so say them in words
    if (n.tags?.length) n.ariaLabel = [n.name, e && (uncertain(e) || e.resolution === 'inferred' || e.mode || e.k === 'ref' || e.infer?.how === 'embedding') ? ix.explain(e).label : '', sites.length > 1 ? t('呼叫 {n} 次', { n: sites.length }) : '', at ?? ''].filter(Boolean).join(t('，'))
    const open = kids.length > 0 && !path.includes(nid)
    index[key] = { fid: nid, edge: e, names: [...new Set(kids.map((k) => dir === 'down' ? ix.bareName(k.d, k) : ix.bareName(k.s, k)))], open, kids, path }
    if (open && (predict ? revealed[key] : key === 'root')) n.children = children(key)     // shown open from the start
    else if (open && !predict) n.hasChildren = true
    return n
  }
  function children(key: string): TreeNode[] {
    const c = index[key]
    // one row per function, at its first call; the other calls of the same function are listed on it
    const groups = new Map<string, Edge[]>()
    for (const k of c.kids) {
      const cid = dir === 'down' ? k.d : k.s
      const g = groups.get(cid)
      if (g) g.push(k)
      else groups.set(cid, [k])
    }
    let rows = [...groups].map(([cid, ks]) => ({ name: ix.bareName(cid, ks[0]), l: ks[0].l, n: node(cid, ks[0], `${key}/${cid}@${ks[0].l}`, [...c.path, c.fid], key, ks) }))
    // one call whose candidates are all outside methods of one name (String.toString, Number.toString):
    // one row, opened to show each candidate with its own edge
    const sites = new Map<string, typeof rows>()
    for (const r of rows) {
      const e = index[r.n.id]?.edge
      if (dir === 'down' && e?.eg) {
        const k = `${e.f}:${e.l}:${e.c ?? ''}`
        sites.set(k, [...(sites.get(k) ?? []), r])
      }
    }
    for (const [k, rs] of sites) {
      if (rs.length < 2) continue
      const e = index[rs[0].n.id].edge!
      const method = (e.dn ?? e.d).split('.').pop() ?? ''
      const types = rs.map((r) => { const x = index[r.n.id].edge!; return (x.dn ?? x.d).replace(/^ext:/, '').split('.').slice(0, -1).join('.') })
      const g: TreeNode = { id: `${key}/eg:${k}`, name: method, meta: t('（外部：{v1}）', { v1: types.join(t('、')) }), path: `${e.f}:${e.l}`, muted: true,
        tags: [<UI.Tag key="eg">{t('外部候選 ×{n}', { n: rs.length })}</UI.Tag>], children: rs.map((r) => r.n) }
      g.ariaLabel = [method, t('（外部：{v1}）', { v1: types.join(t('、')) }), t('外部候選 ×{n}', { n: rs.length }), g.path].join(t('，'))
      const first = rows.indexOf(rs[0])
      rows = rows.filter((r) => !rs.includes(r))
      rows.splice(Math.min(first, rows.length), 0, { name: method, l: e.l, n: g })
    }
    // stages the project named in .codemap/rules.json (phases): each starts at its `from` call
    const stages = dir === 'down' && ix.funcs[c.fid] ? ix.g.phases?.[ix.funcs[c.fid].name] ?? [] : []
    // a stage starts at the line of its `from` call: a call written inside it (its argument) goes with it
    const first = (name: string) => { const r = rows.find((x) => x.name === name); return r ? rows.findIndex((x) => x.l === r.l) : -1 }
    const at = stages.map((s) => ({ s, i: first(s.from) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)
    if (!at.length) return rows.map((r) => r.n)
    const out: TreeNode[] = rows.slice(0, at[0].i).map((r) => r.n)
    at.forEach((x, k) => {
      const id = `${key}#${k}`
      stageIds.push(id)
      out.push({ id, name: local(x.s.name), icon: 'stack', meta: t('專案定義的階段'), children: rows.slice(x.i, k + 1 < at.length ? at[k + 1].i : rows.length).map((r) => r.n) })
    })
    return out
  }
  const items = [node(start, null, 'root', [], 'root')]
  return { items, index, children, stageIds }
}

/** The relation tag in a tree row. Its own clicks and keys stay inside, so opening the
 *  explanation does not also select the row. */
function RelationTag(p: { ix: Index; e: Edge; open: () => void }) {
  const x = p.ix.explain(p.e)
  const stop = (ev: { stopPropagation: () => void }) => ev.stopPropagation()
  return (
    <span className="rel-tag" onClick={stop} onKeyDown={stop}>
      <UI.Tag><UI.Term title={x.title} text={x.text} code={p.e.t ? `${String(p.e.l).padStart(4)} │ ${p.e.t}` : undefined}
        action={{ label: t('看這一行'), onClick: p.open }}>{x.label}</UI.Term></UI.Tag>
    </span>
  )
}

function guessHits(text: string, names: string[]) {
  const words = text.split(/[\s,，、]+/).filter(Boolean)
  return { hit: names.filter((n) => words.includes(n)), miss: words.filter((w) => !names.includes(w)) }
}

interface FlowProps {
  ix: Index
  start: string
  dir: 'down' | 'up'
  setDir: (d: 'down' | 'up') => void
  /** set when the direction was just changed: focus returns to the tabs */
  dirMoved: { current: boolean }
  predict: boolean
  setPredict: (v: boolean) => void
  showExt: boolean
  setShowExt: (v: boolean) => void
  selKey: string | null
  onSel: (id: string, edge: Sel['edge'], key: string) => void
  openSearch: () => void
}

export function Flow(p: FlowProps) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [guesses, setGuesses] = useState<Record<string, string>>({})
  const tree = useMemo(() => buildTree(p.ix, p.start, p.dir, p.showExt, p.predict, revealed, p.onSel), [p.ix, p.start, p.dir, p.showExt, p.predict, revealed, p.onSel])
  const selKey = p.selKey && tree.index[p.selKey] ? p.selKey : 'root'
  const { onSel, start } = p
  // a selection made on another page is not in this tree: select the start, so the tree and Detail agree
  useEffect(() => { if (selKey !== p.selKey) onSel(start, null, 'root') }, [selKey, p.selKey, onSel, start])
  const cur = tree.index[selKey]
  const needGuess = p.predict && cur && cur.open && !revealed[selKey]
  const res = p.predict && revealed[selKey] && guesses[selKey] ? guessHits(guesses[selKey], cur.names) : null
  const resultRef = useRef<HTMLDivElement>(null)
  // guesses that are functions outside the repo, left out of the tree while 外部函式 is off
  const hidden = res && cur && p.dir === 'down' && !p.showExt
    ? res.miss.filter((m) => p.ix.callees(cur.fid, true).some((e) => !p.ix.funcs[e.d] && p.ix.bareName(e.d, e) === m)) : []
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!p.dirMoved.current) return
    p.dirMoved.current = false
    cardRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [p.dirMoved])
  // guess mode keeps even the start closed until its level is revealed
  const openKeys = [...(p.predict ? [] : ['root']), ...Object.keys(revealed)]
  const reveal = () => {
    setRevealed({ ...revealed, [selKey]: true })
    requestAnimationFrame(() => resultRef.current?.focus())       // the field and button are gone: keep the keyboard here
    // the result is on screen at once; screen readers hear it too
    const r = guesses[selKey] ? guessHits(guesses[selKey], cur.names) : null
    // read as 「3 個中的 2 個」, not 「2 斜線 3」
    UI.announce(r ? t('預測正確 {v1}', { v1: UI.format.fractionLabel(r.hit.length, cur.names.length, t('個')) }) : t('已揭曉：{v1} 個函式', { v1: cur.names.length }))
  }

  return (
    <UI.Card className="pane">
      <div className="row" ref={cardRef}>
        <UI.Tabs label={t('方向')} items={[{ id: 'down', label: t('往下：callee') }, { id: 'up', label: t('往上：caller') }]} value={p.dir} onChange={(d) => p.setDir(d as 'down' | 'up')} />
      </div>
      <div className="row">
        <UI.Button icon="magnifying-glass" onClick={p.openSearch}>{t('更換起點函式')}</UI.Button>
        <div className="grow" />
        {/* self-test last, so its field follows it in the Tab order */}
        <label className="row nowrap"><UI.Switch checked={p.showExt} onChange={p.setShowExt} label={t('顯示外部函式')} disabled={p.dir !== 'down'} /><span>{t('外部函式')}</span></label>
        <label className="row nowrap"><UI.Switch checked={p.predict} onChange={(v) => { setRevealed({}); p.setPredict(v) }} label={t('自我測驗')} /><UI.Term text={t('先寫下下一層的函式，再按「揭曉」比對。用來練習讀程式，不是工具的推測。')}>{t('自我測驗')}</UI.Term></label>
      </div>
      {p.predict && cur ? (
        <div className="predict">
          {needGuess ? (
            <>
              <div><b>{p.ix.nameOf(cur.fid, cur.edge)}</b>{(p.dir === 'down' ? t(' 呼叫的函式有 {v1} 個（往下一層）。請先寫下預測再揭曉。', { v1: cur.names.length }) : t(' 的 caller 有 {v1} 個（往上一層）。請先寫下預測再揭曉。', { v1: cur.names.length }))}</div>
              <UI.TextField label={t('預測')} hint={t('函式名稱，以空白分隔')} value={guesses[selKey] ?? ''}
                onChange={(e) => setGuesses({ ...guesses, [selKey]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') reveal() }} />
              <UI.ActionBar actions={[{ label: t('揭曉'), primary: true, onClick: reveal }]} />
            </>
          ) : res ? (
            <div ref={resultRef} tabIndex={-1}>{t('預測正確')} <span aria-hidden="true">{UI.format.fraction(res.hit.length, cur.names.length, t('個'))}</span><span className="ui-visually-hidden">{UI.format.fractionLabel(res.hit.length, cur.names.length, t('個'))}</span>{res.hit.length ? t('：') + res.hit.join(t('、')) : ''}
              {hidden.length ? t('。{v1} 是 repo 外的函式，目前沒有顯示，所以不計入', { v1: hidden.join(t('、')) }) : ''}
              {res.miss.filter((m) => !hidden.includes(m)).length ? t('。不在這一層：{v1}', { v1: res.miss.filter((m) => !hidden.includes(m)).join(t('、')) }) : ''}</div>
          ) : (
            <div className="muted" ref={resultRef} tabIndex={-1}>{cur.open ? t('選擇未展開的函式繼續預測。') : t('此函式沒有下一層。')}</div>
          )}
        </div>
      ) : null}
      <div>
        <UI.TreeList key={`${p.predict}${p.showExt}${openKeys.length}`} kind="plain" label={t('呼叫流程')}
          items={tree.items} defaultOpen={[...openKeys, ...tree.stageIds]} loadChildren={(n) => (p.predict && !revealed[n.id] ? [] : tree.children(n.id))}
          selectedId={selKey} onSelect={(n) => { const c = tree.index[n.id]; if (c) p.onSel(c.fid, c.edge, n.id) }} />
      </div>
      {p.dir === 'up' && !tree.index.root?.kids.length ? (
        <p className="small">{p.ix.funcs[p.start]?.api
          ? t('找不到 caller：它是外部進入點，呼叫者是呼叫 {v1} 同名函式的程式，不在 repo 內。', { v1: p.ix.funcs[p.start].api })
          : t('找不到 caller。可能從 repo 外呼叫、經由沒偵測到的函式指標呼叫，或沒有被使用。')}</p>
      ) : null}
      <p className="small muted" data-tour="tree">{
        // what an untagged line rests on depends on which backends read the repository
        !p.ix.g.stats.syntax && !p.ix.g.stats.static ? t('沒有標示的關係由編譯器確認，標示「推測（規則：…）」的由括號裡那條 codemap 規則從原始碼推得。')
          : t('沒有標示的關係：{v1}。標示「推測（規則：…）」或框架名稱的，程式碼裡沒有直接的呼叫。', { v1: [
            p.ix.g.stats.edges ? t('C/C++ 由編譯器確認') : '',
            p.ix.g.stats.resolution?.python ? t('Python 由 import 與類別確定目標；標示「型別推論」的靠推得的型別，「可能目標之一」的有不只一個目標') : '',
            p.ix.g.stats.resolution?.go ? t('Go 由 go/types 確定目標，經 interface 的呼叫只連到實作它的型別；go、defer 和當作函式值傳遞的另有標示') : '',
            p.ix.g.stats.resolution?.typescript ? t('TypeScript 與 JavaScript 由 TypeScript 編譯器依名稱與型別確定目標；經覆寫、interface 或函式值的呼叫另有標示') : '',
            p.ix.g.stats.syntax ? t('其他語言由 tree-sitter 依名稱對到定義，「依名稱推測」的只憑方法名稱') : ''].filter(Boolean).join(t('；')) })}</p>
    </UI.Card>
  )
}
