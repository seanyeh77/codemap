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
pip install -e .            # Python 3.9+, no dependencies; Pillow for the diagram
```

`gcc` must be on the path. `rsvg-convert` is used to also write a PNG.

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
python3 -m unittest discover -s tests               # small fixture, needs cc
python3 tests/regress_ibtrace.py PATH_TO_IBTRACE    # after `codemap index` there
```

The ibtrace regression replays twelve questions that were used to design the
rules, so it guards against breaking them; it is not evidence that the map
helps a reader.

## Limits

- C and C++ only for Layer 1. Python files are read by the rules but get no
  call graph.
- Indirect calls through pointers filled at run time (for example `dlsym`
  results) stay unresolved; `codemap index` reports how many.
- CUDA device code and code outside the repo are not mapped.
