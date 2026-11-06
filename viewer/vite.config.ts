import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// One self-contained index.html: `codemap serve` returns it, `codemap export --html`
// embeds a snapshot in it, and it opens straight from disk (file://).
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), viteSingleFile()],
  build: {
    outDir: '../codemap/viewer_dist',
    emptyOutDir: true,
    target: 'es2023',
  },
  server: {
    // `npm run dev` talks to a running `codemap serve`
    proxy: { '/api': 'http://127.0.0.1:7300' },
  },
})
