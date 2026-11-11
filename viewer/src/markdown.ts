// The overview as Markdown (closed parts and lists too: they stay on the page, hidden), to paste into notes or a question to an AI: read from what the page shows, so the
// two never disagree. Parts become ## headings with their line of numbers, checks ### headings, lists of
// label and value become bullets, code stays code. Buttons that only open or close a list are left out.

// left out: icons, toggles, the editor button, and what only moves around the page (.md-skip: 查看 harness 的函式)
const SKIP = 'svg, [aria-hidden="true"], .ui-sec-bar, .ui-cv-sr, .sr-only, .ui-cv-num, .md-skip, .editor-btn'

const squeeze = (s: string) => s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim()

/** One element's text with Markdown's inline marks: `code`, line breaks where the page breaks lines. */
function inline(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').replace(/\s+/g, ' ')
  if (!(n instanceof HTMLElement) || n.matches(SKIP)) return ''
  // a button that opens or closes a list says nothing; one that is a heading's text (the file of a command group) does
  if (n.matches('button[aria-expanded]') && !n.closest('h1, h2, h3, h4, h5, h6')) return ''
  if (n.tagName === 'BR') return '\n'
  if (n.tagName === 'CODE' || n.classList.contains('ui-code')) {
    const s = (n.textContent ?? '').trim()
    return s ? '`' + s.replace(/`/g, 'ˋ') + '`' : ''
  }
  const inner = [...n.childNodes].map(inline).join('')
  if (n.tagName === 'STRONG' || n.tagName === 'B') return inner.trim() ? `**${inner.trim()}**` : ''
  // a row of a list inside a value (the call sites under a command): a line of its own
  return n.classList.contains('entry-row') ? '\n' + inner.trim() : inner
}

/** The blocks under an element, each one paragraph, heading, list or code block. */
function blocks(n: Node, out: string[]) {
  if (!(n instanceof HTMLElement) || n.matches(SKIP)) {
    if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) out.push(squeeze(n.textContent))
    return
  }
  if (n.classList.contains('ui-sec')) {
    const title = n.querySelector('.ui-sec-title')?.textContent?.trim() ?? ''
    const sum = n.querySelector('.ui-sec-sum')?.textContent?.trim()
    out.push(`## ${title}`)
    if (sum) out.push(sum)
    const body = n.querySelector('.ui-sec-content')
    if (body) blocks(body, out)
    return
  }
  if (/^H[1-6]$/.test(n.tagName)) { const s = squeeze(inline(n)); if (s) out.push(`### ${s}`); return }
  if (n.tagName === 'PRE') { out.push('```\n' + (n.textContent ?? '').replace(/\n$/, '') + '\n```'); return }
  if (n.tagName === 'DL') {
    const items = [...n.querySelectorAll(':scope > .ui-dl-item, :scope > div')].map((it) => {
      const label = squeeze(inline(it.querySelector('dt') ?? it))
      const value = squeeze(inline(it.querySelector('dd') ?? it)).replace(/\n/g, '\n  ')
      return `- **${label}**：${value}`
    })
    if (items.length) out.push(items.join('\n'))
    return
  }
  if (n.tagName === 'UL' || n.tagName === 'OL') {
    const items = [...n.children].map((li, i) => `${n.tagName === 'OL' ? `${i + 1}.` : '-'} ${squeeze(inline(li)).replace(/\n/g, '\n  ')}`)
    if (items.length) out.push(items.join('\n'))
    return
  }
  // a paragraph: an element holding only text and inline marks
  const kids = [...n.childNodes]
  const isBlock = (k: Node) => k instanceof HTMLElement && !k.matches(SKIP) && /^(DIV|P|SECTION|DL|UL|OL|PRE|H[1-6]|TABLE|NAV)$/.test(k.tagName)
  if (!kids.some(isBlock)) { const s = squeeze(inline(n)); if (s) out.push(s); return }
  // mixed: runs of inline content become paragraphs between the blocks
  let run = ''
  const flush = () => { const s = squeeze(run); if (s) out.push(s); run = '' }
  for (const k of kids) {
    if (isBlock(k)) { flush(); blocks(k, out) } else run += inline(k)
  }
  flush()
}

/** The element's content as Markdown under a # title. */
export function toMarkdown(root: HTMLElement, title: string): string {
  const out: string[] = [`# ${title}`]
  blocks(root, out)
  return out.join('\n\n') + '\n'
}
