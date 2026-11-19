import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Blocks of different heights in columns with no hole under a short one: each block, in order, goes where a column
 *  ends first (a grid of 8 px rows, each block spanning as many as its height needs, kept up to date as it changes).
 *  Under the container's breakpoint the blocks are one column, in order. */
export function Masonry(p: { children: ReactNode[]; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => {
      const gap = parseFloat(getComputedStyle(el).getPropertyValue('--masonry-gap')) || 0
      for (const cell of Array.from(el.children) as HTMLElement[]) {
        const inner = cell.firstElementChild as HTMLElement | null
        if (!inner) continue
        cell.style.gridRowEnd = `span ${Math.max(1, Math.ceil((inner.getBoundingClientRect().height + gap) / 8))}`
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    for (const cell of Array.from(el.children)) if (cell.firstElementChild) ro.observe(cell.firstElementChild)
    ro.observe(el)
    return () => ro.disconnect()
  })
  return <div ref={box} className={'masonry ' + (p.className ?? '')}>
    {p.children.filter(Boolean).map((c, i) => <div key={i} className="masonry-cell"><div>{c}</div></div>)}
  </div>
}
