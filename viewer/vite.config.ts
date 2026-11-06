import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// One index.html with the code, styles and the Latin fonts inside: `codemap serve` returns it,
// `codemap export --html` embeds a snapshot in it, and it opens straight from disk (file://).
// The Chinese font (Noto Sans TC, about 10 MB in many unicode-range pieces) stays in assets/:
// served beside the page; a page opened on its own uses the system's Chinese font instead.
const inline = (file: string) => !file.endsWith('.woff2') || /(inter|geist-mono)-latin-\d/.test(file)

export default defineConfig({
  base: './',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), viteSingleFile({ useRecommendedBuildConfig: false })],
  build: {
    outDir: '../codemap/viewer_dist',
    emptyOutDir: true,
    target: 'es2023',
    assetsInlineLimit: (file) => inline(file),
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
  },
  // the styles end up inside index.html, so font paths are written from the page, not from a CSS file
  experimental: { renderBuiltUrl: (file) => './' + file },
  server: {
    // `npm run dev` talks to a running `codemap serve`
    proxy: { '/api': 'http://127.0.0.1:7300' },
  },
})
