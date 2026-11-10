# codemap

A static map of a codebase for people and AI agents: C and C++ through the
compiler, Python, Java, Go, TypeScript, JavaScript and HTML/CSS through
tree-sitter. It never runs the program, so it works on code that takes too long
to run, and on code that is half rewritten.

The map has four layers:

1. **Calls.** Each language is read by a backend, and every backend writes the
   same graph (`codemap/schema.py`); the rest of codemap reads only that graph.
   - `gcc`: every translation unit in `compile_commands.json` is recompiled
     with `-O0 -fcallgraph-info` (no linking). Macros are expanded, only the
     `#ifdef` branches that are really built appear, and calls through
     function pointers are kept as `__indirect_call`. Edges: `compiler`.
   - `python`: Python's own `ast` resolves names and simple types. Imports
     (aliases, relative, cycles), module functions, classes, `self`/`cls`,
     the MRO and `super()` decide a target exactly; constructors,
     annotations (`X | Y`, `Optional`, `Union`), return values, assignments
     and instance attributes (`self.client = Client()`) infer one. Each edge
     says `resolution`: `exact`, `inferred`, or `ambiguous` (a union, or a
     method a subclass overrides: every target gets an edge). A call nothing
     decides gets no edge and is counted as unresolved; it is never matched
     on its name across the repository. Edges: `static`.
   - `syntax`: for the other languages, tree-sitter reads definitions, calls and imports, and joins a
     call to a definition when the name decides it (the same file, an import,
     `self`/`this`, the package in Go, a name defined once). Edges: `syntax`;
     a call on an object of unknown type joined by a method name defined once
     carries `by: "name"`. C/C++ is read this way only when there is no
     `compile_commands.json`.
   - **Framework adapters** add what a framework calls by itself (source
     `framework`): entry points (routes, tests, event handlers), injection
     (pytest fixtures, FastAPI `Depends`), and callbacks (Ryu/os-ken
     `set_ev_cls`, ONOS `addProcessor`). Adapters exist for Flask, FastAPI,
     pytest, Ryu/os-ken, Mininet and ONOS.
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

Python 3.10+. The tree-sitter grammars are wheels with the parser inside, so
nothing is downloaded when codemap runs. The `diagram` extra adds
Pillow for measuring text in the architecture diagram, and the `viewer` extra
adds FastAPI and uvicorn for `codemap serve`. The viewer itself ships prebuilt
inside the package, so Node.js is not needed where codemap runs.

GCC must be installed: `-fcallgraph-info` is a GCC option, so units are
compiled with `gcc` (or `g++`) even when `compile_commands.json` says `cc` or
`clang`; use `--cc` to name another GCC. On macOS, where `gcc` is clang, run
codemap in Linux or a container. `rsvg-convert` is used to also write a PNG.

## Use

For C/C++, produce `compile_commands.json` first, without a full build if
possible: CMake configure with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, or
`compiledb -n make`, or `bear -- make`. Other languages need nothing: `codemap
index` reads every file git lists (or the tree, outside git) with a known
extension. `.pyi` stubs are not read; they describe outside libraries.

Languages and adapters can be turned off in `.codemap/rules.json`:
`{"languages": {"disable": ["css"]}, "frameworks": {"disable": ["onos"]}}`.

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

`--notes` takes any Markdown file, so design documents can be checked the same way:
`codemap serve --notes notes.md docs/*.md` lists every file:line in them that no
longer matches the code.

A matching line says what it rests on: 「呼叫已確認」 (the compiler saw the call)
or 「名稱出現」 (the cited line holds the note's names; the rest of the sentence,
such as who sets or reads a value, is not checked).

The overview lists the project's documents (the README, `docs/*.md` and any
document the code names), each with its first heading and sentence. Under
「值得檢查的地方」 it also lists what outlives the process: shared memory,
named semaphores and FIFOs made with `O_CREAT`, who removes them, and the calls
that end the program in the components that make them.

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
  "describe": {"src/libibtrace": "Preloaded into the traced program; records each verbs, UCP and UCT call into the ring."},
  "phases": {"main": [{"name": "start-up", "from": "ibmon_parse_args"}, {"name": "collect", "from": "ibmon_sched_start"},
                      {"name": "wind-up", "from": "ibmon_stats_print"}]},
  "channels": [
    {"from": "src/libibtrace", "to": "src/ibmon", "via": "src/common", "label": "ring"}
  ],
  "custom": [
    {"name": "real_symbol", "pattern": "IBT_REAL\\(", "files": ["src/**/*.c"], "kind": "dlsym"}
  ]
}
```

Custom rules are where project-specific patterns go once someone has agreed
they are worth tracking.

`describe` says what a component is for, in the project's own words. Without
it the overview shows the top comment of the component's main file and says
which file it came from.

`phases` splits the calls of a long function into stages in the flow tree. A
stage's `name` is one string, or one per language for readers in another one:
`{"zh-TW": "啟動", "en": "start-up"}` (the viewer's language, else English). Each
stage starts at the first call of the function named in `from` and runs until
the next stage; calls before the first stage stay at the top. The split is the
project's reading of its code, so codemap never guesses it.

`env` adds what the code cannot say about an environment variable:
`{"IBTRACE_RECORD": {"purpose": "0 measures the wrappers' cost without recording", "default": "1"}}`.
Without it the overview still shows what the C code reads it as (a flag, a number,
text, or only whether it is set), its value when unset, and where it is stored.

Without `purpose`, the overview shows the sentence of a comment that names the
variable (`IBTRACE_ALL_POLLS=1: record the empty calls one by one`), from the C
files and the headers next to them.

`channels` declares data that one component hands to another through a shared
one (a shared-memory ring, a queue) without any call between them. The
architecture diagram draws each as a dashed line labelled 「經由 `src/common`
傳資料」, and clicking it lists where each side uses the shared component.

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

- Python types are followed through constructors, annotations, returns,
  assignments and attributes, not through loops, containers (`for row in
  rows`), or arguments without annotations; those calls stay unresolved.
- In the other tree-sitter languages the calls come from names, not types: a method called on an
  object whose type codemap cannot see is joined only when one definition in
  the repository has that name (and never for names every container has, such
  as `get` or `append`). Dynamic calls (`getattr`, reflection, callbacks passed
  around as values) are missed unless an adapter knows the framework.
- The text rules of layer 2 read C only.
- Inline `<script>` in HTML is not read; `<script src>` and `on…` handlers are.
- Indirect calls through pointers filled at run time (for example `dlsym`
  results) stay unresolved; `codemap index` reports how many.
- CUDA device code and code outside the repo are not mapped.
