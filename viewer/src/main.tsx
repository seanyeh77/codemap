import { UI } from './ui'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { prefs } from './prefs'
import { setLang } from './i18n'
import { useSyncExternalStore } from 'react'
import './app.css'
import { listenEarly } from './early'

UI.initTheme()

listenEarly()
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
