/** Scrolls the nearest scrolling ancestor so that el's top is in view. Element.scrollIntoView also
 *  scrolls ancestors with overflow: hidden, which shifts the whole app shell (the bottom tab bar
 *  ends up in the middle of a phone screen). */
/** Scrolls the nearest scrolling ancestor of first so that first to last are all in view, moving as little as
 *  needed; when they are taller than the area, first goes to the top. */
export function revealRange(first: Element, last: Element, gap = 8) {
  let s = first.parentElement
  while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement
  if (!s) return
  const view = s.getBoundingClientRect()
  const top = first.getBoundingClientRect().top - view.top
  const bottom = last.getBoundingClientRect().bottom - view.top
  const by = bottom - top + 2 * gap > s.clientHeight || top < gap ? top - gap : bottom > s.clientHeight - gap ? bottom - s.clientHeight + gap : 0
  if (by) s.scrollBy({ top: by, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

export function revealTop(el: Element | null, gap = 8) {
  if (!el) return
  let s = el.parentElement
  while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement
  const box = s ?? document.scrollingElement ?? document.documentElement
  const top = el.getBoundingClientRect().top - (s ? s.getBoundingClientRect().top : 0) - gap
  // a long way (the overview is several screens tall) goes there at once: a smooth scroll over 8000 px
  // took over two seconds, and a reader who looks after one second sees some other section
  box.scrollBy({ top, behavior: Math.abs(top) > 1200 ? 'instant' : 'smooth' })
}
