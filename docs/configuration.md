# Configuration

Optional `.codemap/rules.json`:

```json
{
  "scope": ["src/libibtrace", "src/ibmon"],
  "source_scope": {"production": ["tests/tools"], "test": ["examples/"]},
  "disable": ["exec"],
  "components": {"src/libibtrace/hooks": "hooks"},
  "describe": {"src/libibtrace": "Preloaded into the traced program; records each verbs, UCP and UCT call into the ring."},
  "roles": {"harness/controller.py": "editable", "harness/checks.py": "protected"},
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

`roles` marks which files people are meant to change (`editable`) and which
they must leave alone (`protected`), for a path or a whole folder; the longest
listed path wins. The file diagram shows the mark on each box. Without it the
viewer reads the first sentence of a file's top comment: one that starts by
calling the file editable, or protected, read-only, generated or not to be
edited, gets that mark.

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

Languages and framework adapters can be turned off in the same file:
`{"languages": {"disable": ["css"]}, "frameworks": {"disable": ["onos"]}}`, and the TypeScript
compiler with `{"backends": {"typescript": false}}` (tree-sitter then reads those files).
