import { useRef, useState } from 'react'
import { UI } from '../ui'
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
  return Date.now() - d.getTime() < 7 * 864e5 ? UI.format.relative(d) : UI.format.dateTime(d, { weekday: true })
}

export function Settings(p: Props) {
  const pr = usePrefs()
  const [toast, setToast] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const g = p.graph, st = g.stats, isLive = !!p.meta
  function save<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    prefs.set(k, v)
    if (k === 'theme') UI.setTheme(v as Prefs['theme'])
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
      <UI.SettingsSection title="目前的資料來源">
        <UI.DetailList items={[
          { label: '模式', value: isLive ? <span><UI.Term text="由 codemap serve 提供，讀的是目前磁碟上的程式碼，可以重新檢查筆記。">即時</UI.Term>（codemap serve）</span> : <span><UI.Term text="匯出當時的索引與原始碼，只能瀏覽。">快照</UI.Term>（.codemap 檔）</span> },
          isLive ? { label: '主機', value: <UI.InlineCode>{p.meta!.host}</UI.InlineCode> } : { label: '檔案', value: <UI.InlineCode>{p.snapName ?? '此頁面'}</UI.InlineCode> },
          { label: '路徑', value: <UI.InlineCode>{isLive ? p.meta!.root : g.root}</UI.InlineCode> },
          { label: 'commit', value: <span>{commit ? <UI.InlineCode>{commit}</UI.InlineCode> : '無'}{dirty.length ? `（另有 ${dirty.length} 個檔案未 commit）` : ''}</span> },
          { label: '索引', value: <span><UI.Term text="codemap index 從原始碼整理出的函式與呼叫關係，各頁面都依它顯示。">索引</UI.Term>{'：'}{`${st.units ?? 0} 個 `}<UI.Term text="一個 `.c` 檔加上它 include 的標頭檔，編譯器一次處理的單位。">translation unit</UI.Term>{` · ${st.funcs} 個函式 · ${(st.edges ?? 0).toLocaleString()} 條編譯器確認的呼叫`}</span> },
          isLive ? { label: '索引建立時間', value: when(p.meta!.indexed) } : { label: '匯出時間', value: when(g.generated) },
        ]} />
        <UI.ActionBar actions={isLive ? [
          { label: '匯出快照', primary: true, icon: 'download-simple', onClick: download },
          { label: '開啟快照', onClick: p.openSnapshot },
          { label: '重新載入索引', onClick: p.refresh },
        ] : [
          ...(p.hasLive ? [{ label: '回到即時', primary: true, onClick: p.backLive }] : []),
          { label: '開啟其他快照', primary: !p.hasLive, onClick: p.openSnapshot },
        ]} />
        {isLive ? <p className="small muted">重建索引：在 build 環境執行 <UI.InlineCode>codemap index</UI.InlineCode> 後重新載入。</p> : null}
        {p.openError ? <UI.Alert tone="danger" title="無法開啟此檔案">{p.openError}</UI.Alert> : null}
      </UI.SettingsSection>
      <UI.SettingsSection title="建立索引" description="設定檔：.codemap/rules.json">
        <UI.DetailList items={[
          { label: '編譯資料庫', value: <UI.InlineCode>compile_commands.json</UI.InlineCode> },
          { label: '編譯器', value: g.config.cc ? <UI.InlineCode>{g.config.cc}</UI.InlineCode> : '依 compile_commands.json（gcc 或 g++）' },
          { label: '範圍', value: g.config.scope?.length ? <span className="chips">{g.config.scope.map((s) => <UI.InlineCode key={s}>{s}</UI.InlineCode>)}</span> : '整個 repo' },
          { label: '失敗的檔案', value: `${st.failed ?? 0} 個` },
        ]} />
      </UI.SettingsSection>
    </>
  )
  const open = (
    <UI.SettingsSection title="在 VS Code 開啟">
      {radios('開啟方式', 'editor', [['ssh', 'Remote-SSH（build 環境的檔案）'], ['local', '本機 clone'], ['none', '不使用 VS Code']])}
      {pr.editor === 'ssh' ? <UI.TextField label="Remote-SSH 主機名稱" value={pr.sshHost} placeholder={g.host} hint="與 ~/.ssh/config 的 Host 相同。留空時使用伺服器主機名稱。" onChange={(e) => save('sshHost', e.target.value)} /> : null}
      {pr.editor === 'local' ? <UI.TextField label="本機 clone 路徑" value={pr.clone} placeholder={'/Users/you/src/' + g.repo} hint="commit 須與索引相同，行號才會一致。" onChange={(e) => save('clone', e.target.value)} /> : null}
    </UI.SettingsSection>
  )
  const display = (
    <>
      <UI.SettingsSection title="架構圖與流程">
        <div className="set-row">
          <div className="grow"><div>流程預設顯示外部函式</div><div className="small muted">例如 libc、UCX 的函式。</div></div>
          <UI.Switch label="流程預設顯示外部函式" checked={pr.showExtDefault} onChange={(v) => save('showExtDefault', v)} />
        </div>
      </UI.SettingsSection>
      <UI.SettingsSection title="版面">{radios('原始碼面板', 'panel', [['right', '右側'], ['below', '下方']])}</UI.SettingsSection>
    </>
  )
  const look = (
    <UI.SettingsSection title="主題">
      <UI.ThemePicker value={pr.theme} onChange={(v) => save('theme', v)} />
    </UI.SettingsSection>
  )
  return (
    <div className="settings-wrap">
      <UI.SettingsLayout value={p.cat} onChange={p.setCat} toast={toast} categories={[
        { id: 'source', label: '資料來源', content: source },
        { id: 'open', label: '開啟原始碼', content: open },
        { id: 'display', label: '顯示', content: display },
        { id: 'look', label: '外觀', content: look },
      ]} />
    </div>
  )
}
