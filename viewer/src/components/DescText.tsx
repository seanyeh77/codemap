// A description as text: `names` in code font; an AI's says what state it is in and which language it fell back to
import * as UI from '@seanyeh77/ui'
import { KIND_LABEL, codeSpans, type Desc } from '../data/describe'
import { t } from '../i18n'

export function DescText(p: { d: Desc; tag?: boolean; full?: boolean }) {
  const { d } = p
  return (
    <span className={'desc-' + d.kind + (d.state && d.state !== 'ok' ? ' desc-' + d.state : '')}>
      {p.tag && d.kind !== 'facts' ? <><UI.Tag>{t(KIND_LABEL[d.kind])}</UI.Tag> </> : null}
      {codeSpans(d.text).map((x, i) => (typeof x === 'string' ? x : <code key={i} className="desc-code">{x.code}</code>))}
      {d.lang ? <span className="small muted">{' '}{t('（{v1}）', { v1: d.lang === 'en' ? 'English' : '中文' })}</span> : null}
      {p.full && d.state === 'stale' ? <span className="block small muted">{t('函式在說明寫好之後改過，說明可能過時。用 codemap describe --missing 重寫。')}</span> : null}
      {p.full && d.state === 'wrong' ? <span className="block small desc-wrong-note">{t('說明提到的位置或名稱與程式碼不符，codemap check 會列出。')}</span> : null}
    </span>
  )
}
