import { UI } from './ui'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { prefs } from './prefs'
import { setLang } from './i18n'
import { useSyncExternalStore } from 'react'
import './app.css'
import { listenEarly } from './early'
import { startApp } from './pwa'

UI.initTheme()

// Until the design system reads 3-digit colours: the build shortens #ffffff to #fff in tokens.css, the design system's
// accent-text check cannot read #fff and darkens the link colour all the way to black. Drop that wrong value so the
// theme's own accent-text applies (codemap keeps the default accent).
const fixAccentText = () => {
  const v = document.documentElement.style.getPropertyValue('--accent-text').trim().toLowerCase()
  if (v === '#000000' || v === '#ffffff') document.documentElement.style.removeProperty('--accent-text')
}
new MutationObserver(fixAccentText).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] })
fixAccentText()

listenEarly()
startApp()
UI.setTheme(prefs.get().theme)
setLang(prefs.get().lang)

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } })

/** The whole interface, drawn again when the language changes (every text is read through t()). */
function Root() {
  const lang = useSyncExternalStore(prefs.subscribe, () => prefs.get().lang)
  return <App key={lang} />
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Root />
  </QueryClientProvider>,
)
