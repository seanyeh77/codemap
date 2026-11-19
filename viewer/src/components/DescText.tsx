// A description as text: `names` in code font; an AI's says what state it is in and which language it fell back to
import * as UI from '@seanyeh77/ui'
import { KIND_LABEL, codeSpans, type Desc } from '../data/describe'
import { t } from '../i18n'
import { TermText } from './Terms'

export function DescText(p: { d: Desc; tag?: boolean; full?: boolean }) {
  const { d } = p
  // the project's words are explained at their first appearance, in the full text (not the one-line summaries)
  const seen = new Set<string>()
  return (
    <span className={'desc-' + d.kind + (d.state && d.state !== 'ok' ? ' desc-' + d.state : '')}>
      {/* AI writing starts with the design system's AI mark; the author's comment keeps its word tag */}
      {p.tag && d.kind === 'ai' ? <><UI.AiMark label={t('AI 說明')} /> </> : p.tag && d.kind !== 'facts' ? <><UI.Tag>{t(KIND_LABEL[d.kind])}</UI.Tag> </> : null}
      {codeSpans(d.text).map((x, i) => (typeof x === 'string' ? (p.full ? <TermText key={i} text={x} seen={seen} /> : x) : <code key={i} className="desc-code">{x.code}</code>))}
      {d.lang ? <span className="small muted">{' '}{t('（{v1}）', { v1: d.lang === 'en' ? 'English' : '中文' })}</span> : null}
      {p.full && d.state === 'stale' ? <span className="block small muted">{t('說明撰寫後函式已修改，內容可能過時；執行 codemap describe 以重新撰寫。')}</span> : null}
      {p.full && d.state === 'wrong' ? <span className="block small desc-wrong-note">{t('說明提到的位置或名稱與程式碼不符，codemap check 會列出。')}</span> : null}
    </span>
  )
}
