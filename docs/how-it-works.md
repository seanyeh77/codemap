# How it works

## What `codemap index` reads

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

## What each backend needs

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

## The four layers

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
     on its name across the repository. A function handed on as a value
     (`hub.spawn(self._monitor_loop)`, `Thread(target=run)`, `{"x": handler}`,
     `self.cb = f`) is an edge of kind `ref` from where it is handed on. An
     annotation of `Any` or `object` names no type, so calls on it stay
     unresolved. Edges: `static`.
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
