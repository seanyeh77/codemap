import { useState } from 'react'
import { UI } from '../ui'
import { DocRefs, langLabel, useCodeRefs } from '../components/DocRefs'
import { noun, t } from '../i18n'
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
  const ext = new Set(p.ix.callees(p.sel.id, true).filter((x) => !p.ix.funcs[x.d] && x.src !== 'rule').map((x) => x.d)).size
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
    <UI.Card className="detail" title={<span title={f.name}>{f.name}</span>}>
      <UI.DetailList items={[
        { label: t('定義'), value: link(f.file, f.line) },
        { label: t('元件'), value: f.comp },
        // two rows, each number right after its own word: 「1 個 caller · 0 個 callee」 was read as caller · 0
        { label: t('被誰呼叫'),
          value: <span>{t('{v1} 個 ', { v1: nCallers })}<UI.Term text={t('呼叫此函式的 repo 內函式，同一個函式只算一次，推測的另外註明。')}>{noun(nCallers, 'caller')}</UI.Term>{who.guessed ? (who.guessed === nCallers ? t('（推測）') : t('（其中 {v1} 個是推測）', { v1: who.guessed })) : ''}{who.others.length ? t('。另有推測的來源：{v1}', { v1: who.others.slice(0, 2).join(t('、')) }) : ''}{who.load === 'constructor' ? t('。程式載入時自動執行（constructor）') : who.load === 'destructor' ? t('。程式結束時自動執行（destructor）') : ''}</span> },
        { label: t('呼叫誰'),
          value: <span>{t('{v1} 個 ', { v1: nCallees })}<UI.Term text={t('此函式呼叫的 repo 內函式，同一個函式只算一次。流程樹的 ×N 是呼叫次數。')}>{noun(nCallees, 'callee')}</UI.Term>{ext ? t('（另呼叫 {v1} 個 repo 外的函式）', { v1: ext }) : ''}</span> },
        // calls the compiler never saw: inside #if/#ifdef blocks this build leaves out
        ...((u) => u?.length ? [{ label: t('條件編譯'), value: <span>{t('另有 {v1} 處呼叫在條件編譯裡，這次的 build 沒有編進去，所以不算在上面：', { v1: u.length })}{u.map((x, i) => (
          <span key={i} className="write-row">{x.by}{t('（{v1}）', { v1: x.cond })}{' '}{link(x.f, x.l)}</span>))}</span> }] : [])(p.ix.g.uncompiled?.[p.sel.id]),
        ...(f.api ? [{ label: t('進入方式'), value: <span><UI.Term text={t('和 {v1} 程式庫的函式同名，以 LD_PRELOAD 載入後會先執行這裡的版本。呼叫者在 repo 外，所以 caller 可能是 0 個。', { v1: f.api })}>{t('外部進入點')}</UI.Term>{t('：攔截 {v1} 的同名函式', { v1: f.api })}</span> }] : []),
        ...(e && !inside ? [{ label: t('呼叫位置'), value: sites.length > 1
          ? <span>{sites.map((s, i) => <span key={s.l}>{i ? t('、') : ''}{link(s.f, s.l)}</span>)}</span> : link(e.f, e.l) }] : []),
        ...(sameLine.length ? [{ label: t('同一行'), value: t('這一行還呼叫 {v1}，兩個呼叫寫在同一個運算式裡。', { v1: sameLine.join(t('、')) }) }] : []),
        ...macros.map((m) => ({ label: t('巨集'), value: <span>{t('這一行使用巨集 {v1}，定義在 ', { v1: m.name })}{link(m.file, m.line)}{t('。呼叫在巨集展開後才發生，所以記在這一行。')}</span> })),
        ...(e && (e.via || e.slot) ? [{ label: t('經由'), value: <UI.InlineCode>{e.via || e.slot}</UI.InlineCode> }] : []),
      ]} />
      <UI.ActionBar actions={[
        ...(p.view === 'flow' && here ? [] : [{ label: p.view === 'flow' ? t('從這裡追蹤流程') : t('追蹤流程'), primary: true, onClick: () => p.goFlow(p.sel.id) }]),
        ...(p.view === 'impact' && here ? [] : [{ label: t('查看影響範圍'), primary: p.view === 'flow' && here, onClick: () => p.goImpact(p.sel.id) }]),
      ]} />
      {whole ? (
        file.isPending ? <UI.Skeleton width="80%" height={16} />
          : file.error || !file.data ? <UI.Alert tone="danger" title={t('無法讀取檔案')}>{file.error ? (file.error as Error).message : t('這個檔案不在索引裡。')}</UI.Alert>
          : <><UI.CodeView file={file.data.file} code={file.data.lines.join('\n')} start={1} target={focus} maxHeight="60vh" {...refs} languageLabel={langLabel(file.data.file)} /><DocRefs ix={p.ix} lines={file.data.lines} /></>
      ) : at ? <CodeAt ix={p.ix} at={at} isLive={p.isLive} sourceId={p.sourceId} maxHeight="60vh" focus />
        : src.isPending ? <div><UI.Skeleton width="80%" height={16} /><UI.Skeleton width="60%" height={16} /><UI.Skeleton width="70%" height={16} /></div>
        : src.error ? <UI.Alert tone="danger" title={t('無法讀取原始碼')}>{(src.error as Error).message}</UI.Alert>
        : !src.data ? <p className="small muted">{t('匯出快照時讀不到這個檔案。請在 build 環境重新執行 codemap export。')}</p>
        : <UI.CodeView {...refs} languageLabel={langLabel(src.data.file)} file={src.data.file} fileHref={vscodeURL(f.file, focus, p.ix.g.root, p.ix.g.host) ?? undefined}
            code={src.data.lines.join('\n')} start={src.data.start} target={focus} maxHeight="60vh" />}
      {!whole && src.data ? <DocRefs ix={p.ix} lines={src.data.lines} /> : null}
      {p.isLive ? <div className="keep"><UI.Button onClick={() => setWhole(whole ? null : selKey)}>{whole ? t('只顯示這個函式') : t('顯示整個檔案')}</UI.Button></div> : null}
    </UI.Card>
  )
}
