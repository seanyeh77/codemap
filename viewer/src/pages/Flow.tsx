import { useEffect, useMemo, useState } from 'react'
import { UI } from '../ui'
import type { Index } from '../data/graph'
import type { Edge, Sel } from '../data/types'
import type { TreeNode } from '@seanyeh77/ui'

/** open: its next level can be shown (it has calls, and it is not already on the path). */
interface Entry { fid: string; edge: Edge | null; names: string[]; open: boolean; kids: Edge[]; path: string[] }

/** The call tree handed to TreeList. Only the start's level is built; TreeList loads a node's
 *  children when it is opened (loadChildren). Predict mode: a node opens only once revealed. */
function buildTree(ix: Index, start: string, dir: 'down' | 'up', showExt: boolean, predict: boolean, revealed: Record<string, boolean>,
  openLine: (fid: string, e: Edge, key: string) => void) {
  const index: Record<string, Entry> = {}
  const kidsOf = (fid: string) => (dir === 'down' ? ix.callees(fid, showExt) : ix.callers(fid))
  function node(nid: string, e: Edge | null, key: string, path: string[], parent: string): TreeNode {
    const f = ix.funcs[nid]
    const kids = f ? kidsOf(nid) : []
    const n: TreeNode = { id: key, name: ix.nameOf(nid, e), path: e ? `${e.f}:${e.l}` : f ? `${f.file}:${f.line}` : undefined }
    if (e) {
      // the call is in the parent (looking down) or in this node's function (looking up)
      const where = dir === 'down' ? parent : key
      // only inferred relations carry a tag; the note under the tree says the rest are the compiler's
      if (e.src === 'rule') n.tags = [<RelationTag key="r" ix={ix} e={e} open={() => openLine(e.s, e, where)} />]
      if (!f) n.muted = true
    }
    const open = kids.length > 0 && !path.includes(nid)
    index[key] = { fid: nid, edge: e, names: [...new Set(kids.map((k) => dir === 'down' ? ix.bareName(k.d, k) : ix.bareName(k.s, k)))], open, kids, path }
    if (open && (key === 'root' || (predict && revealed[key]))) n.children = children(key)     // shown open from the start
    else if (open && !predict) n.hasChildren = true
    return n
  }
  function children(key: string): TreeNode[] {
    const c = index[key]
    return c.kids.map((k) => {
      const cid = dir === 'down' ? k.d : k.s
      return node(cid, k, `${key}/${cid}@${k.l}`, [...c.path, c.fid], key)
    })
  }
  return { items: [node(start, null, 'root', [], 'root')], index, children }
}

/** The relation tag in a tree row. Its own clicks and keys stay inside, so opening the
 *  explanation does not also select the row. */
function RelationTag(p: { ix: Index; e: Edge; open: () => void }) {
  const x = p.ix.explain(p.e)
  const stop = (ev: { stopPropagation: () => void }) => ev.stopPropagation()
  return (
    <span className="rel-tag" onClick={stop} onKeyDown={stop}>
      <UI.Tag><UI.Term title={x.title} text={x.text} code={p.e.t ? `${String(p.e.l).padStart(4)} │ ${p.e.t}` : undefined}
        action={{ label: '看這一行', onClick: p.open }}>{x.label}</UI.Term></UI.Tag>
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
  const t = useMemo(() => buildTree(p.ix, p.start, p.dir, p.showExt, p.predict, revealed, p.onSel), [p.ix, p.start, p.dir, p.showExt, p.predict, revealed, p.onSel])
  const selKey = p.selKey && t.index[p.selKey] ? p.selKey : 'root'
  const { onSel, start } = p
  // a selection made on another page is not in this tree: select the start, so the tree and Detail agree
  useEffect(() => { if (selKey !== p.selKey) onSel(start, null, 'root') }, [selKey, p.selKey, onSel, start])
  const cur = t.index[selKey]
  const needGuess = p.predict && cur && cur.open && !revealed[selKey]
  const res = p.predict && revealed[selKey] && guesses[selKey] ? guessHits(guesses[selKey], cur.names) : null
  const openKeys = ['root', ...Object.keys(revealed)]
  const reveal = () => setRevealed({ ...revealed, [selKey]: true })

  return (
    <UI.Card className="pane">
      <div className="row">
        <UI.Tabs label="方向" items={[{ id: 'down', label: '往下：callee' }, { id: 'up', label: '往上：caller' }]} value={p.dir} onChange={(d) => p.setDir(d as 'down' | 'up')} />
      </div>
      <div className="row">
        <UI.Button icon="magnifying-glass" onClick={p.openSearch}>更換起點函式</UI.Button>
        <div className="grow" />
        <label className="row nowrap"><UI.Switch checked={p.predict} onChange={(v) => { setRevealed({}); p.setPredict(v) }} label="預測模式" /><span>預測模式</span></label>
        {p.dir === 'down' ? <label className="row nowrap"><UI.Switch checked={p.showExt} onChange={p.setShowExt} label="顯示外部函式" /><span>外部函式</span></label> : null}
      </div>
      {p.predict && cur ? (
        <div className="predict">
          {needGuess ? (
            <>
              <div><b>{p.ix.nameOf(cur.fid, cur.edge)}</b>{` 的下一層有 ${cur.names.length} 個函式。請先寫下預測再揭曉。`}</div>
              <UI.TextField label="預測" hint="函式名稱，以空白分隔" value={guesses[selKey] ?? ''}
                onChange={(e) => setGuesses({ ...guesses, [selKey]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') reveal() }} />
              <UI.ActionBar actions={[{ label: '揭曉', primary: true, onClick: reveal }]} />
            </>
          ) : res ? (
            <div>{`預測正確 ${res.hit.length} / ${cur.names.length} 個${res.hit.length ? '：' + res.hit.join('、') : ''}${res.miss.length ? '。不在此層：' + res.miss.join('、') : ''}`}</div>
          ) : (
            <div className="muted">{cur.open ? '選擇未展開的函式繼續預測。' : '此函式沒有下一層。'}</div>
          )}
        </div>
      ) : null}
      <div data-tour="tree">
        <UI.TreeList key={`${p.predict}${p.showExt}${openKeys.length}`} kind="plain" label="呼叫流程"
          items={t.items} defaultOpen={openKeys} loadChildren={(n) => t.children(n.id)}
          selectedId={selKey} onSelect={(n) => { const c = t.index[n.id]; p.onSel(c.fid, c.edge, n.id) }} />
      </div>
      <p className="small muted">沒有標示的關係都由編譯器確認。</p>
    </UI.Card>
  )
}
