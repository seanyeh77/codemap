// Ctrl K pressed while the project is still loading: the search box is not there yet, so the key
// is remembered and the box opens once it is (the palette's own shortcut takes over from then on)
export const early = { search: false }
const earlyKey = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !document.querySelector('[data-codemap-ready]')) {
    early.search = true
    e.preventDefault()
  }
}
export const listenEarly = () => document.addEventListener('keydown', earlyKey)
export const stopEarly = () => document.removeEventListener('keydown', earlyKey)
