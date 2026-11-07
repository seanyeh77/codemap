# codemap

A static map of a C codebase for people and AI agents. It never runs the
program, so it works on code that takes too long to run, and on code that is
half rewritten as long as most files still compile on their own.

The map has four layers:

1. **Precise calls.** Every translation unit in `compile_commands.json` is
   recompiled with `-O0 -fcallgraph-info` (no linking). Macros are expanded,
   only the `#ifdef` branches that are really built appear, and calls through
   function pointers are kept as `__indirect_call`.
2. **Rule scan.** Text rules add what the compiler cannot see: functions stored
   in pointers, indirect calls through those pointers, constructors,
   `setenv`/`getenv` pairs, `exec`, `-D` flags in Makefiles, and C names that
   Python files mention. Every rule edge is tagged with its rule and should be
   read as a candidate.
3. **Guides.** `codemap arch` writes a generated Architecture section into
   `CODEMAP.md` and a diagram. Text written around the markers is kept.
4. **Shared use.** `CODEMAP.md` and `.codemap/index.json` live in the repo, so
   a person and an agent start from the same map. `codemap check` validates
   every `file:line` reference and every `` `caller -> callee` `` claim in a
   Markdown file against the source and the index.

## Install

```bash
uv tool install 'codemap[diagram,viewer] @ git+https://github.com/seanyeh77/codemap'
```

Python 3.10+. The core has no runtime dependencies; the `diagram` extra adds
Pillow for measuring text in the architecture diagram, and the `viewer` extra
adds FastAPI and uvicorn for `codemap serve`. The viewer itself ships prebuilt
inside the package, so Node.js is not needed where codemap runs.

GCC must be installed: `-fcallgraph-info` is a GCC option, so units are
compiled with `gcc` (or `g++`) even when `compile_commands.json` says `cc` or
`clang`; use `--cc` to name another GCC. On macOS, where `gcc` is clang, run
codemap in Linux or a container. `rsvg-convert` is used to also write a PNG.

## Use

Produce `compile_commands.json` first, without a full build if possible:
CMake configure with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, or
`compiledb -n make`, or `bear -- make`.

```bash
codemap index                        # .codemap/index.json, cached per unit
codemap index --scope src/libibtrace src/ibmon
codemap callers ibt_span_begin       # also finds calls hidden in macros
codemap callees emit
codemap where take                   # the definition the default build uses
codemap relations IBTRACE_SHM        # rule edges about a name or symbol
codemap arch                         # CODEMAP.md Architecture section + diagram
codemap check CODEMAP.md docs/tour.md
```

### Viewer

```bash
codemap serve                        # http://127.0.0.1:7300/, live view of the working tree
codemap serve --notes notes.md CODEMAP.md
codemap export                       # ibtrace-5977772.codemap, a snapshot to open elsewhere
codemap export --html                # one HTML file with the viewer and the snapshot inside
codemap viewer -o site/              # static viewer for a web server; open a .codemap file in it
```

`codemap serve` listens on localhost. From a laptop, forward the port
(`ssh -L 7300:localhost:7300 HOST`); VS Code Remote-SSH does this by itself.
The viewer shows the architecture, call trees (with a predict-then-reveal
mode), who is affected by a change, the check results of the notes, and the
source of every function. A snapshot has the same pages, without the live
source. Rebuilding the index and expanding macros from the viewer are not
wired up yet; run `codemap index` and press 「重新載入索引」.

An empty `callers` result can also mean that the caller lives in a file that is
not in `compile_commands.json` (tests often are not); the command says so.

Commit `CODEMAP.md`, `.codemap/index.json` and the diagram; add `.codemap/cache/`
to `.gitignore`.

## Configuration

Optional `.codemap/rules.json`:

```json
{
  "scope": ["src/libibtrace", "src/ibmon"],
  "disable": ["exec"],
  "components": {"src/libibtrace/hooks": "hooks"},
  "custom": [
    {"name": "real_symbol", "pattern": "IBT_REAL\\(", "files": ["src/**/*.c"], "kind": "dlsym"}
  ]
}
```

Custom rules are where project-specific patterns go once someone has agreed
they are worth tracking.

## Tests

```bash
python3 -m unittest discover -s tests               # small fixture, needs cc; API tests need the viewer extra
python3 tests/regress_ibtrace.py PATH_TO_IBTRACE    # after `codemap index` there
```

The ibtrace regression replays twelve questions that were used to design the
rules, so it guards against breaking them; it is not evidence that the map
helps a reader.

## Developing the viewer

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
```

The build is one self-contained `index.html`, so it can be served by
`codemap serve`, embedded by `codemap export --html`, and opened from disk.

## Limits

- C and C++ only for Layer 1. Python files are read by the rules but get no
  call graph.
- Indirect calls through pointers filled at run time (for example `dlsym`
  results) stay unresolved; `codemap index` reports how many.
- CUDA device code and code outside the repo are not mapped.
