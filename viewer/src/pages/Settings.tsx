import { useRef, useState } from 'react'
import { UI } from '../ui'
import { dateTime, noun, setLang, t } from '../i18n'
import { usePrefs } from '../data/hooks'
import { live } from '../data/load'
import type { Graph, Meta } from '../data/types'
import { prefs, type Prefs } from '../prefs'

interface Props {
  graph: Graph
  meta: Meta | null
  cat: string
  setCat: (c: string) => void
  snapName: string | null
  hasLive: boolean
  backLive: () => void
  openSnapshot: () => void
  openError: string | null
  onShowExtDefault: (v: boolean) => void
  refresh: () => void
}

function when(sec: number) {
  const d = new Date(sec * 1000)
  // within a week the relative time reads first, with the exact time after it to compare with other pages
  const exact = dateTime(d)
  return Date.now() - d.getTime() < 7 * 864e5 ? t('{v1}（{v2}）', { v1: UI.format.relative(d), v2: exact }) : exact
}

// a backend reads more than one language: typescript reads JavaScript too
const BACKEND: Record<string, string> = { typescript: 'TypeScript / JavaScript' }
const LANG: Record<string, string> = { python: 'Python', java: 'Java', go: 'Go', typescript: 'TypeScript', javascript: 'JavaScript', html: 'HTML', css: 'CSS', cpp: 'C++' }

export function Settings(p: Props) {
  const pr = usePrefs()
  const [toast, setToast] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const g = p.graph, st = g.stats, isLive = !!p.meta
  function save<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    prefs.set(k, v)
    if (k === 'theme') UI.setTheme(v as Prefs['theme'])
    if (k === 'lang') setLang(v as Prefs['lang'])
    if (k === 'showExtDefault') p.onShowExtDefault(v as boolean)
    setToast('已儲存')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 3000)
  }
  const radios = <K extends keyof Prefs>(label: string, k: K, opts: [Prefs[K] & string, string][]) => (
    <UI.RadioGroup label={label} value={pr[k] as string} onChange={(v) => save(k, v as Prefs[K])} options={opts.map(([value, l]) => ({ value, label: l }))} />
  )
  const dirty = isLive ? p.meta!.dirty : g.dirty
  const commit = isLive ? p.meta!.commit : g.commit        // meta is fresh; the graph only changes with the index
  const download = () => { location.href = live.snapshotURL }

  const source = (
    <>
      <UI.SettingsSection title={t('目前的資料來源')}>
        <UI.DetailList items={[
          { label: t('模式'), value: isLive ? <span><UI.Term text={t('由 codemap serve 提供，讀的是目前磁碟上的程式碼，可以重新檢查筆記。')}>{t('即時')}</UI.Term>{t('（codemap serve）')}</span> : <span><UI.Term text={t('匯出當時的索引與原始碼，只能瀏覽。')}>{t('快照')}</UI.Term>{t('（.codemap 檔）')}</span> },
          isLive ? { label: t('主機'), value: <UI.InlineCode>{p.meta!.host}</UI.InlineCode> } : { label: t('檔案'), value: <UI.InlineCode>{p.snapName ?? t('此頁面')}</UI.InlineCode> },
          { label: t('路徑'), value: <UI.InlineCode>{isLive ? p.meta!.root : g.root}</UI.InlineCode> },
          { label: 'commit', value: <span>{commit ? <UI.InlineCode>{commit}</UI.InlineCode> : t('無')}{dirty.length ? t('（另有 {v1} 個檔案未 commit）', { v1: dirty.length }) : ''}</span> },
          { label: t('索引'), value: <span><UI.Term text={t('codemap index 從原始碼整理出的函式與呼叫關係，各頁面都依它顯示。')}>{t('索引')}</UI.Term>{t('：')}{!st.units ? t('{v1} 個函式、方法、類別與模組', { v1: st.funcs }) : <>{t('{v1} 個 ', { v1: st.units ?? 0 })}<UI.Term text={t('一個 `.c` 檔加上它 include 的標頭檔，編譯器一次處理的單位。')}>{noun(st.units ?? 0, 'translation unit')}</UI.Term>{t(' · {v1} 個函式 · {v2} 條編譯器確認的呼叫', { v1: st.funcs, v2: st.edges ?? 0 })}</>}</span> },
          // one row per language analyzer: how many calls each resolved, and how
          ...Object.entries(st.resolution ?? {}).map(([b, r]) => ({ label: BACKEND[b] ?? LANG[b] ?? b, value: <span><UI.Term text={b === 'go'
            ? t('以 Go 的 go/types 解析套件、方法、interface 與函式值；interface 只連到真的實作它的型別。找不到目標的呼叫不會畫線。')
            : b === 'typescript' ? t('以 TypeScript 官方編譯器解析 import、類別、繼承、型別、interface、函式值與 JSX；.d.ts 與 node_modules 只提供型別。找不到目標的呼叫不會畫線。')
            : t('以 Python 的 ast 解析 import、類別與簡單的型別，不靠名稱猜。找不到目標的呼叫不會畫線。')}>{t('靜態分析')}</UI.Term>{t('：')}{t('{v1} 條確定、{v2} 條型別推論、{v3} 條有多個可能目標、{v4} 處無法解析', { v1: r.exact ?? 0, v2: r.inferred ?? 0, v3: r.ambiguous ?? 0, v4: r.unresolved ?? 0 })}</span> })),
          // what an analyzer could not do fully: its results are not to be read as complete
          ...Object.entries(st.limits ?? {}).map(([b, l]) => ({ label: t('{v1} 分析限制', { v1: BACKEND[b] ?? LANG[b] ?? b }), value: <span>
            {b === 'go' ? <>{t('build tag 只依檔名判斷，vendor 目錄沒有特別處理。')}<br /></> : null}
            {l.placeholders.length ? <>{(b === 'typescript'
              ? t('{v1} 個套件找不到（沒有安裝 node_modules），呼叫它們的地方只知道 import 的名稱：{v2}', { v1: l.placeholders.length, v2: l.placeholders.slice(0, 4).join(t('、')) + (l.placeholders.length > 4 ? t(' 等') : '') })
              : t('{v1} 個套件沒有載入（不在 module 快取或需要下載），呼叫它們的地方只知道名稱：{v2}', { v1: l.placeholders.length, v2: l.placeholders.slice(0, 4).join(t('、')) + (l.placeholders.length > 4 ? t(' 等') : '') }))}<br /></> : null}
            {l.incomplete ? <>{t('{v1} 個檔案的型別檢查不完整，裡面可能漏掉一些呼叫；這些函式的詳細資料會註明。', { v1: l.incomplete })}<br /></> : null}
            {l.messages ? <span className="muted">{t('型別檢查訊息 {v1} 則，不代表分析失敗：其餘的呼叫照常解析。', { v1: l.messages })}</span> : null}
          </span> })),
          ...(st.syntax ? [{ label: t('其他語言'), value: <span><UI.Term text={t('以 tree-sitter 讀出定義與呼叫，依名稱對到定義，沒有經過編譯器確認。')}>{t('tree-sitter')}</UI.Term>{t('：')}{Object.entries(st.languages ?? {}).filter(([l]) => l !== 'c' && !st.resolution?.[l] && !(l === 'javascript' && st.resolution?.typescript)).map(([l, n]) => t('{v1} {v2} 個檔案', { v1: LANG[l] ?? l, v2: n })).join(t('、'))}{t(' · {v1} 條依名稱對到的呼叫', { v1: st.syntax })}{st.frameworks?.length ? t(' · 框架：{v1}', { v1: st.frameworks.join(t('、')) }) : ''}</span> }] : []),
          isLive ? { label: t('索引建立時間'), value: when(p.meta!.indexed) } : { label: t('匯出時間'), value: when(g.generated) },
        ]} />
        <UI.ActionBar actions={isLive ? [
          { label: t('匯出快照'), primary: true, icon: 'download-simple', onClick: download },
          { label: t('開啟快照'), onClick: p.openSnapshot },
          { label: t('重新載入索引'), onClick: p.refresh },
        ] : [
          ...(p.hasLive ? [{ label: t('回到即時'), primary: true, onClick: p.backLive }] : []),
          { label: t('開啟其他快照'), primary: !p.hasLive, onClick: p.openSnapshot },
        ]} />
        {isLive ? <p className="small muted">{t('重建索引：在 build 環境執行')} <UI.InlineCode>codemap index</UI.InlineCode> {t('後重新載入。')}</p> : null}
        {p.openError ? <UI.Alert tone="danger" title={t('無法開啟此檔案')}>{p.openError}</UI.Alert> : null}
      </UI.SettingsSection>
      <UI.SettingsSection title={t('建立索引')} description={t('設定檔：.codemap/rules.json')}>
        <UI.DetailList items={[
          { label: t('編譯資料庫'), value: <UI.InlineCode>compile_commands.json</UI.InlineCode> },
          { label: t('編譯器'), value: g.config.cc ? <UI.InlineCode>{g.config.cc}</UI.InlineCode> : t('依 compile_commands.json（gcc 或 g++）') },
          { label: t('範圍'), value: g.config.scope?.length ? <span className="chips">{g.config.scope.map((s) => <UI.InlineCode key={s}>{s}</UI.InlineCode>)}</span> : t('整個 repo') },
          { label: t('失敗的檔案'), value: t('{v1} 個', { v1: st.failed ?? 0 }) },
        ]} />
      </UI.SettingsSection>
    </>
  )
  const open = (
    <UI.SettingsSection title={t('在 VS Code 開啟')}>
      {radios(t('開啟方式'), 'editor', [['ssh', t('Remote-SSH（build 環境的檔案）')], ['local', t('本機 clone')], ['none', t('不使用 VS Code')]])}
      {pr.editor === 'ssh' ? <UI.TextField label={t('Remote-SSH 主機名稱')} value={pr.sshHost} placeholder={g.host} hint={t('與 ~/.ssh/config 的 Host 相同。留空時使用伺服器主機名稱。')} onChange={(e) => save('sshHost', e.target.value)} /> : null}
      {pr.editor === 'local' ? <UI.TextField label={t('本機 clone 路徑')} value={pr.clone} placeholder={'/Users/you/src/' + g.repo} hint={t('commit 須與索引相同，行號才會一致。')} onChange={(e) => save('clone', e.target.value)} /> : null}
    </UI.SettingsSection>
  )
  const display = (
    <>
      <UI.SettingsSection title={t('架構圖與流程')}>
        <div className="set-row">
          <div className="grow"><div>{t('流程預設顯示外部函式')}</div><div className="small muted">{t('例如 libc、UCX 的函式。')}</div></div>
          <UI.Switch label={t('流程預設顯示外部函式')} checked={pr.showExtDefault} onChange={(v) => save('showExtDefault', v)} />
        </div>
        {g.stats.tests ? <div className="set-row">
          <div className="grow"><div>{t('包含測試程式碼')}</div><div className="small muted">{t('在流程、影響範圍與搜尋裡列出測試檔裡的 {v1} 個函式，以及測試對正式程式碼的呼叫。架構圖一律只畫正式程式碼，正式程式碼的型別推論也不採用測試放進去的替身。', { v1: g.stats.tests })}</div></div>
          <UI.Switch label={t('包含測試程式碼')} checked={pr.tests} onChange={(v) => save('tests', v)} />
        </div> : null}
      </UI.SettingsSection>
      <UI.SettingsSection title={t('版面')}>{radios(t('原始碼面板'), 'panel', [['right', t('右側')], ['below', t('下方')]])}</UI.SettingsSection>
    </>
  )
  const look = (
    <>
      <UI.SettingsSection title={t('主題')}>
        <UI.ThemePicker value={pr.theme} onChange={(v) => save('theme', v)} />
      </UI.SettingsSection>
      {/* each option in its own language, so it can be found whichever is on screen */}
      <UI.SettingsSection title={t('語言')}>{radios(t('介面語言'), 'lang', [['zh-TW', '繁體中文'], ['en', 'English']])}</UI.SettingsSection>
    </>
  )
  return (
    <div className="settings-wrap">
      <UI.SettingsLayout value={p.cat} onChange={p.setCat} toast={toast} categories={[
        { id: 'source', label: t('資料來源'), content: source },
        { id: 'open', label: t('開啟原始碼'), content: open },
        { id: 'display', label: t('顯示'), content: display },
        { id: 'look', label: t('外觀'), content: look },
      ]} />
    </div>
  )
}
