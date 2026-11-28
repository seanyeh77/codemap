# Development

## Tests

```sh
uv run --all-extras pytest   # needs gcc; Go and TypeScript tests skip without Go or Node
uv run python tests/regress_ibtrace.py PATH_TO_IBTRACE   # after `codemap index` there
```

The ibtrace regression replays twelve questions that were used to design the
rules, so it guards against breaking them; it is not evidence that the map
helps a reader.

## The viewer

The viewer lives in `viewer/`: React 19.3, Vite 8 (Rolldown), TypeScript 7
(the native compiler), TanStack Query 5, the React Compiler 1.0 through Babel,
and Vitest 5. It uses SeanYeh's design system, the npm package `@seanyeh77/ui` at a pinned version
(`npm i @seanyeh77/ui@<version>` updates it). `npx @seanyeh77/ui-cli check <URL>` checks a page
at 390 px and 1280 px in light and dark; it needs Chromium (`npx playwright install chromium`).
The build puts the code, styles and Latin fonts inside `codemap/viewer_dist/index.html`; the
Chinese font stays in `codemap/viewer_dist/assets/`, which `codemap serve` serves and
`codemap viewer` copies.

```bash
cd viewer
npm install
npm run dev          # with `codemap serve` running on port 7300
npm test
npm run build        # writes codemap/viewer_dist/index.html; commit it
npm run build:pages  # the GitHub Pages app in viewer/dist-pages (CI publishes it from main)
```

`build:pages` adds what makes the page an installable app: `viewer/pwa/` holds the manifest,
the service worker (network first, so a new build is used at once; the kept copy answers
offline) and the icons. The page `codemap serve` returns has none of them.

The build is one self-contained `index.html`, so it can be served by
`codemap serve`, embedded by `codemap export --html`, and opened from disk.
