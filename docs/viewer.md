# The viewer

The viewer shows the map laid out like a code editor. Its text follows the browser's language:
Traditional Chinese or English. This page gives the English names with the Chinese ones in
parentheses.

## Opening it

```sh
codemap serve                        # http://127.0.0.1:7300/, live view of the working tree
codemap serve --notes notes.md CODEMAP.md
codemap export                       # ibtrace-5977772.codemap, a snapshot to open elsewhere
codemap export --html                # one HTML file with the viewer and the snapshot inside
codemap viewer -o site/              # static viewer for a web server; open a .codemap file in it
```

`codemap serve` listens on localhost. From a laptop, forward the port
(`ssh -L 7300:localhost:7300 HOST`); VS Code Remote-SSH does this by itself. After `codemap index` or
`codemap describe --apply`, press Reload index (重新載入索引); the viewer does not rebuild the index
itself.

A snapshot has the same pages as the live view, without the live source, and keeps only the
descriptions that exist when it is written: describe first, then export.

### The hosted viewer

The static viewer is also on GitHub Pages: https://seanyeh77.github.io/codemap/. Open a `.codemap` file
there, or add `?snapshot=<URL>` for one on the web (the server must allow cross-origin requests;
GitHub's raw files do). The snapshot stays in the browser.

The page can be installed as an app from the browser (the install button on the page, or the browser's
own menu; in Safari, Share, then Add to Home Screen). It then opens from the desktop or home screen,
works offline, and opens `.codemap` files directly where the system supports it (Chrome and Edge on a
desktop).

## Layout

| Area | What it holds |
|---|---|
| Explorer, on the left | The project, its components, their files and each file's functions, then its documents (README and the like). A filter on top; a dot marks something worth a note. |
| The middle | What is open: the project as its overview, a component as its architecture diagram, a file or a function as its code. Blue names in the code are links. |
| Side bar, on the right | Explanation (說明) and Definition (定義), described below. |
| Panel, below | callee, caller, How it meets the world (對外介面) and Checks (檢查). |

Every border can be dragged, and every tab can be dragged between the side bar and the panel. The
layout is kept in the browser; Settings › Layout (設定 › 版面) puts it back.

| Keys | Action |
|---|---|
| Ctrl K or Ctrl P | Search names, or words in the code and documents |
| Ctrl B | Fold the explorer |
| Ctrl J | Fold the panel |
| Ctrl Alt B | Fold the side bar |

Narrower screens draw the side bar and then the explorer over the code, and phones pull the panel up
from below. The **?** in the top bar walks through the layout in five steps.

## Explanation

What the open thing is. For a file, also its functions in line order with what each does.

With the code inside a function, Explanation is that function, for reading it: Execution context, Shared
state, Parameters (each one's role, in, out or in-out, and how the language passes it), Return value,
Side effects, Declaration (static, async, virtual ...) and Contract. Only facts are there; what may be
wrong is under Checks.

- The declaration and how each parameter is passed are read from the code with tree-sitter, so they are
  certain.
- What the body does is read from it too, and marked as inferred: which parameters it writes through
  (following calls into the repository's functions, and into outside ones an AI described), and which
  globals, statics, module or package variables it reads or writes, on which lines, atomically or not.
- The rest is written by `codemap describe` and marked as the AI's.

The words it uses (Pass by Sharing, precondition) are explained where they first appear, and so are the
project's own terms, which the search also finds.

Clicking a line in the code marks what is about that line and brings it into view, except while the
pointer is in Explanation; pointing at an item in Explanation marks its line in the code.

### What a function says it does

Every function carries what is known about what it does, in up to three kinds:

1. the author's line: its docstring, or the comment right above the definition, cut to the first
   sentence;
2. a summary of facts codemap knows: the command that runs it, the commands it runs, the files it reads
   and writes, who calls it;
3. an AI's description, once that exists.

The panel lists every kind with where it comes from. A file's list of functions and a link's card show
one line: the first kind there is, in the order chosen in Settings.

Hovering a call to a function outside the repository (`accept`, `memcpy`) shows what it does and each
parameter's role, once the AI has described the outside functions the project calls.

## Definition

What the open file defines besides its functions, read with tree-sitter for C, C++, Python, Go,
TypeScript, JavaScript and Java:

- types (struct, union, enum, typedef, class, interface), with their fields on request;
- file-level variables;
- constants and macros, with their values;
- includes and imports (a project file opens on click);
- exports.

Each item gives its line and the functions that use it, found by name in the file and in the files that
include or import it, so marked as inferred. Under each item is what its author wrote about it (the
comment above it, or after it on its line; a Python docstring), and under each field the comment beside
it. Types and file-level variables also get an AI description; which one shows first follows the same
order setting as a function's. Files with more than 30 items get a filter.

It follows the code: the items a line defines or uses are marked, and pointing at one marks its lines,
scrolled so the whole definition is in view.

A click in the code turns the side bar to the view about it: Explanation inside a function, Definition
on a line that defines a type, variable, constant or import.

## The panel

- **callee:** what the open function calls, level by level. A name clicked there or in caller opens that
  function everywhere (code, Explanation and both trees), and the way there stays above the trees, each
  step a way back.
- **caller:** what calls it, with how far a change reaches, as a tree or a table.
- **How it meets the world (對外介面):** the entry points, commands, environment variables, build
  products and files read and written, of the whole project or only of the open component, file or
  function.
- **Checks (檢查):** for an open function, the language pitfalls and mismatches with its comment that the
  AI found and how far a change reaches; whether the notes still match the code; what the checks found
  worth checking; and what `codemap describe` still has to write.

With a file or a component open, callee and caller list files or components instead. The self-test
(guess each level before it opens) is in Settings.

An empty caller list can also mean that the caller lives in a file that is not in
`compile_commands.json` (tests often are not); `codemap callers` says so.

## The overview

The project opens as its overview: what it does, where to start reading, its components, and its
documents (the README, `docs/*.md` and any document the code names), each with its first heading and
sentence.

Under Worth checking (值得檢查的地方) it lists what outlives the process: shared memory, named semaphores
and FIFOs made with `O_CREAT`, who removes them, and the calls that end the program in the components
that make them.

For a Python program that reads its command line with `argparse`, Entry and exit (進入與結束) lists its
commands as a person types them (`python3 harness/lab3.py status [--json]`, or the `[project.scripts]`
name from `pyproject.toml`) and the function each runs: the one named in `set_defaults(func=...)`, or the
calls in the branch that tests the subparsers' `dest` (`if args.command == "status":`,
`match args.command:`). When all but one command have a branch, the code after the last branch runs the
remaining one. For an argument with a fixed set of values (`choices=SCENARIOS`) it shows where the list
is written and, for each value, the first place that names it in the command's functions and three
levels of their calls (`if name == "link-down":`). The panel of such a function shows the command that
runs it. Commands made in a loop (`add_parser(name)` with a variable) have no name codemap can read and
are left out.

## Descriptions not written yet

The project's Explanation and the Checks tab list how many items `codemap describe` still has to write
or rewrite, by kind (functions, files, definitions, components and so on); a file's Definition view says
how many of its definitions have no up-to-date description. With `codemap serve`, they also list the
prompts in `.codemap/prompts` that still wait for an AI's answer, and the answers that are not applied
yet (or were applied with items that were not kept). A snapshot leaves those two out, since its reader
has no repository to run `codemap describe` in.

## Checking notes

`--notes` takes any Markdown file, so design documents can be checked the same way:
`codemap serve --notes notes.md docs/*.md` lists every `file:line` in them that no longer matches the
code. A matching line says what it rests on: Call confirmed (呼叫已確認: the compiler saw the call) or
Names found (名稱出現: the cited line holds the note's names; the rest of the sentence, such as who sets
or reads a value, is not checked).
