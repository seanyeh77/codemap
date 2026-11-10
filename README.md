# codemap

A static map of a codebase for people and AI agents: C and C++ through the
compiler; Python, Go and TypeScript/JavaScript through their own analyzers;
Java and HTML/CSS (and the others, when their analyzer cannot run) through
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
     and instance attributes (`self.client = Client()`) infer one, and so do
     containers: `list[User]`, `dict[str, User]`, literals, comprehensions,
     `append`/`add`/`extend`/`d[k] = v`, then `for`, `enumerate`, `.items()`,
     `[i]`, `.pop()`, `.get()`, `list()`/`sorted()`; the edge records where
     the element type came from (`element:annotation`, `element:append`, ...).
     An object made by a constructor is exactly its class; `self`, `cls`, an
     annotation or a parameter only bound it, so a method a subclass
     overrides makes the call `ambiguous`. Each edge says `resolution`:
     `exact`, `inferred`, or `ambiguous` (a union, an override, a dispatch
     table: every target gets an edge; a container that also holds values
     of unknown type marks its targets `partial`). A call nothing
     decides gets no edge and is counted as unresolved; it is never matched
     on its name across the repository. Edges: `static`.
   - `go`: Go's own `go/types`, through a small helper (standard library
     only) that codemap builds with the local Go toolchain into
     `~/.cache/codemap` the first time. Packages come from `go.mod` files
     and directories, not `go list`, so nothing is downloaded: a module that
     is not in the module cache, or a newer Go than the local one, only
     leaves the calls into it named by import path. Package functions,
     methods of concrete types, promoted methods (`embedding`), method values
     and method expressions are `exact`. A call through an interface goes to
     the repository's types that implement it, checked with
     `types.Implements` and never by method name; values a variable or field
     was given (`&Server{}`, a constructor's return) narrow it first. A call
     through an interface from outside the repository (`err.Error()`) goes to
     the interface method itself, and so does a call through a repository
     interface that nothing in the repository implements. Calls
     through function values, struct fields and closures follow what was
     stored in them. `go` and `defer` calls carry `mode`; a function handed on
     as a value (`m.HandleFunc("GET /x", s.page)`) is an edge of kind `ref`,
     and the `net/http` adapter turns those into routes. Without a Go
     toolchain the Go files go to tree-sitter. Edges: `static`.
   - `typescript`: the TypeScript compiler API (TypeScript 5 or 6), through a
     small Node helper, reads TypeScript and JavaScript. Each `tsconfig.json`
     or `jsconfig.json` is one program (files no config lists get default
     options with `allowJs`), so the compiler resolves imports, exports,
     aliases, re-exports, namespaces, classes, constructors, inheritance and
     `super`. A call decided by a name or by the receiver's static type (an
     annotation, a return type, an assignment, generics, `this`) is `exact`
     when no subclass overrides the method; unions, overrides and several
     implementations of an interface are `ambiguous`; values decide calls
     through variables, fields, props and callbacks (`let cb = save`,
     `new Button(save)`, `<Editor onSave={save}/>`, `useCallback(fn)`, a
     function that returns a closure) and are `inferred`, or `ambiguous` when
     a parameter may be given anything else. JSX elements are calls to their
     components; a function passed as a value is a `ref`. A function with no
     name of its own is a node named after the nearest named one
     (`Page.fn1`); the methods of an object literal keep their names
     (`tipFor.show`), and so does a function React wraps
     (`const Card = forwardRef(...)`, `memo`, `useCallback`: `Card`). A
     decorator is a call from its class (`infer.how: "decorator"`): it runs
     when the class is defined, not when the method it marks is called.
     Configs that differ only in what they emit (`outDir`, `rootDir`,
     `declaration`, `composite`, ...) share one program, so a monorepo's
     packages are checked once and values flow between them; an import of
     one of the repository's own packages (`@scope/core`, found by the
     `package.json` files) goes to its source even when `node_modules` does
     not link it or its `exports` name a build that does not exist. `.d.ts` files and `node_modules` are read for types
     only: what they declare is an `ext:` node, named by its import
     (`react.useState`) or its type (`Array.map`). Without `node_modules`, a
     package's names are known by their imports only (placeholders, listed on
     the settings page) and the calls on its values stay unresolved; nothing
     is guessed in their place. TypeScript comes from the repository's
     `node_modules`, or from codemap's cache (`~/.cache/codemap/typescript`,
     installed there once with npm); without Node or TypeScript the files go
     to tree-sitter. `"backends": {"typescript": false}` in
     `.codemap/rules.json` sends them there too. Edges: `static`.
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
     pytest, Ryu/os-ken, Mininet, ONOS and Go net/http.
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
inside the package. Node.js is needed only to read TypeScript and JavaScript
with the TypeScript compiler (tree-sitter reads them otherwise).

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
  "source_scope": {"production": ["tests/tools"], "test": ["examples/"]},
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

`source_scope` overrides which files are test code (see Limits) for some paths:
a file or directory listed under `production` or `test` gets that scope whatever
its name, and the longest listed path wins. Test files are still indexed; only
the production graph and the type inference of production code leave them out.
(`scope`, above, is different: it limits what is indexed at all.)

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
  assignments, attributes and containers, not through arguments without
  annotations, `**kwargs`, `getattr`, or rows read from files (`for row in
  csv.DictReader(...)`); those calls stay unresolved.
- Go: a call through an interface from outside the repository (`error`,
  `io.Writer`) goes to the interface method itself (`error.Error`), unless
  the values the receiver holds name its type; the repository's methods that
  implement such an interface are linked to it by `implements` relations,
  which are not calls. Build tags are judged by file name only, vendor
  directories get no special handling, packages that cannot be read are
  placeholders known by name, and a file that does not type-check fully is
  marked; the settings page lists all of this. Values read through channels,
  maps and slices are not followed.
- TypeScript/JavaScript: values are followed through variables, fields,
  parameters, props, `bind`, `useCallback` and functions that return
  functions, not through arrays, maps or promises (calls on `any` stay
  unresolved too); React state setters are the library's functions (below). A call through a parameter is `ambiguous` with `partial`: the
  repository's call sites are known, other callers are not. An interface of a
  library is dispatched only when a class of the repository says it
  implements it; otherwise its methods are named by their type
  (`Array.map`, `Document.getElementById`). TypeScript is structurally typed,
  so a class can fit a library's interface without saying so: such implicit
  implementations are not found (looking for them would make every class with
  a `length` or a `get` a candidate). Interfaces of the repository are matched
  by `implements` and by shape. A file that does not type-check fully (often:
  no `node_modules`) is marked like a Go file.
- TypeScript cost: the compiler type-checks every file, so indexing takes
  about twice as long as `tsc --noEmit`. Each program that differs in its
  options (an example app with its own tsconfig) is checked on its own,
  with the packages and library types it imports. `benchmarks/typescript.md`
  has the baseline: excalidraw (710 files) 56 s and 1.4 GB with its
  dependencies installed, TanStack Query (2,153 files, 54 programs) 209 s
  and 1.9 to 4.8 GB.
- A function a library hands back (`const [x, setX] = useState()`, a
  solid-js setter) is a call to that library, `inferred`, named by its
  declared type (`react.Dispatch`) or by the function that returned it
  (`@testing-library/react.render()`). This needs the library's types;
  without `node_modules` those calls stay unresolved. `new C()` of a class
  whose constructor comes from a library (`extends LitElement`) goes to `C`.
- TypeScript version: a repository on TypeScript 5 or 6 is read by its own
  compiler (TypeScript 6 is never downgraded). Otherwise codemap uses one
  exact version (5.9.3, `codemap/backends/ts.py`) installed once into its
  cache, not whatever `typescript@5` means on the day of the install. The
  index and the settings page record the version and where it came from.
- `exact` means the edge's target is certain from the types and overrides
  codemap can see in what it analyzed, not that one piece of code runs.
  `obj.run()` with `obj: Base` is `exact` to `Base.run` when no class in the
  repository overrides `run`; code outside the repository (a library user,
  a plugin) may still subclass `Base`, and a runtime trick (`as any`,
  monkey-patching, reflection) can call something else. If a subclass in the
  repository does override it, the call is `ambiguous` to both. When the
  target is an interface or abstract method (`error.Error`,
  `Handler.Handle` in a repository with no implementation of `Handler`, a
  TypeScript interface member), the call certainly goes through that method,
  but which implementation runs is decided at run time. codemap shows the
  known implementations as `implements` relations, and when it can see them
  (the repository's implementations, or the values the receiver holds) it
  writes `ambiguous` edges to each of them instead.
- Test code (`_test.go`, `test_*.py`, `tests/`, `*.test.ts`, Java
  `src/test/`, or as `source_scope` says) has `scope: "test"`. The architecture diagram and the type
  inference of production code leave it out: a closure a test stores in a
  field, a fake that implements an interface, or a subclass a test defines
  never becomes a target of a production call. The viewer shows test code in
  flows, impact and search only when "Include test code" is on.
- Edges are per function, not per call site: inside `Base.run`, `self.execute()`
  stays ambiguous when a subclass overrides `execute`, even if every caller
  happens to pass a `Base`.
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
