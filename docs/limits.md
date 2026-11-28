# Limits

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
  and 1.9 to 4.8 GB. `CODEMAP_TS_PROFILE=1 CODEMAP_TS_DEBUG=1` reports, per
  program, what it loaded and where the time went.
- TypeScript program cache: each program's nodes, edges and counts are kept
  in `.codemap/cache/typescript/` (ignored by git) with every question the
  program asked while it was built and analyzed: the files it read and their
  content, the files and directories module resolution looked for, and which
  files are the repository's and which are tests. The next index replays a
  program whose answers are all unchanged and builds the others, so the
  graph is the same as without the cache. On TanStack Query a run with
  nothing changed takes 1.7 s instead of 213 s, and an edit in one example
  app 9.8 s; an edit in a package most programs import rebuilds those
  programs. `CODEMAP_TS_CACHE=0` turns it off. `benchmarks/typescript.md`
  has the scenarios. Maintenance:
  - `codemap index` and the settings page report how many programs were
    replayed and rebuilt, why (no entry, a file's content, a module lookup,
    the repository's or tests' files, a damaged entry, another format), how
    many entries are kept, their size and how many were removed.
  - An entry is written to a temporary file and renamed into place, so a
    stopped run or two runs at once never leave half an entry; temporary
    files older than an hour are removed.
  - An entry that cannot be read, does not have the expected shape, or
    whose checksum does not match is removed and its program analyzed in
    full: no part of it is replayed. The checksum covers the whole entry:
    the questions and answers that decide whether it is used, and the
    results it would replay.
  - The key includes the helper's code, codemap's version, TypeScript and
    Node, and each entry records its format: entries of another version are
    never used, and are replaced.
  - A program's new entry replaces its old one; an entry no run has used
    for 14 days is removed, and beyond 2 GB
    (`CODEMAP_TS_CACHE_MB`) the least recently used go; an entry the
    current run used is never removed.
  - Each run adds one line to `.codemap/cache/typescript/log.jsonl` (the
    last 1,000 runs): programs replayed and rebuilt, why, entries, size and
    time, to see the hit rate and the invalidation reasons in real use.
  - `benchmarks/ts_cache_regression.py` replays a repository's last commits
    with and without the cache and compares the graphs at every commit.
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
