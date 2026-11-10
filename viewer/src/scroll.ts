/** Scrolls the nearest scrolling ancestor so that el's top is in view. Element.scrollIntoView also
 *  scrolls ancestors with overflow: hidden, which shifts the whole app shell (the bottom tab bar
 *  ends up in the middle of a phone screen). */
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
