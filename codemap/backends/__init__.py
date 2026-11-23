"""Backends: each turns one kind of source into the nodes and edges of codemap.schema.

A backend has a name, says which of the repository's files it reads, and
builds a partial index from them. The pipeline merges the parts and never
looks inside a backend, so a new language is a new module here.

  gcc      C/C++ through the compiler (needs compile_commands.json): source "compiler"
  python   Python through its own ast: names, imports and simple types: source "static"
  go       Go through go/types (a helper built with the local Go toolchain): source "static"
  typescript  TypeScript and JavaScript through the TypeScript compiler API (a Node helper): source "static"
  syntax   every other language with a tree-sitter grammar, calls matched by name: source "syntax"

The gcc backend takes the C/C++ files when it can; tree-sitter reads them when
the repository has no compile_commands.json, and reads the files of the units
GCC could not compile (no GCC: macOS's gcc is clang) as "syntax-c". Python goes to its own
analyzer; `"backends": {"python": false}` in .codemap/rules.json sends it to
tree-sitter instead.
"""

from pathlib import Path

from .. import schema
from ..source import walk


def _rel(paths, root):
    return [p.relative_to(root).as_posix() for p in paths]


def plan(root, config=None):
    """[(backend name, files)] for this repository, in the order they run."""
    from . import syntax
    root = Path(root)
    files = _rel(walk(root), root)
    c_files = [f for f in files if Path(f).suffix in (".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh")]
    out = []
    has_db = (root / "compile_commands.json").exists()
    if has_db:
        out.append(("gcc", c_files))
    # Python has an analyzer of its own; tree-sitter reads it only when that one is turned off
    py = [f for f in files if f.endswith(".py")] if (config or {}).get("backends", {}).get("python", True) else []
    if py:
        out.append(("python", py))
    # Go has go/types; tree-sitter reads it when there is no Go toolchain (decided when it runs)
    gof = [f for f in files if f.endswith(".go")] if (config or {}).get("backends", {}).get("go", True) else []
    if gof:
        out.append(("go", gof))
    # TypeScript and JavaScript: the TypeScript compiler; .d.ts files are types for it, never nodes
    from . import ts
    tsf = [f for f in files if f.endswith(ts.EXTS)] if (config or {}).get("backends", {}).get("typescript", True) else []
    if tsf and any(not syntax.is_dts(f) for f in tsf):
        out.append(("typescript", tsf))
    else:
        tsf = []
    rest = [f for f in files if Path(f).suffix in syntax.EXT and not (has_db and f in set(c_files)) and f not in set(py) | set(gof) | set(tsf)
            and not syntax.is_dts(f)]
    disabled = set((config or {}).get("languages", {}).get("disable", []))
    rest = [f for f in rest if syntax.LANG_NAME.get(syntax.EXT[Path(f).suffix], syntax.EXT[Path(f).suffix]) not in disabled]
    if rest:
        out.append(("syntax", rest))
    return out


def build(root, scope=None, jobs=None, cc=None, config=None):
    """The merged index of every backend that has files to read."""
    root = Path(root).resolve()
    parts = []
    from ..term import ui
    LABEL = {"gcc": "C/C++ through GCC", "python": "Python", "go": "Go", "typescript": "TypeScript/JavaScript"}
    for name, files in plan(root, config):
        if scope:
            files = [f for f in files if any(f.startswith(s.rstrip("/") + "/") for s in scope)]
        with ui().step(f"{LABEL.get(name, 'tree-sitter')} ({len(files)} file{'s' * (len(files) != 1)})") as st:
            name, part = _one(root, name, files, scope, jobs, cc, config, parts)
            st.done(_result(name, part), "warn" if _trouble(part) else "ok")
        parts.append((name, part))
        if name == "gcc":
            # what GCC did not read: the units it could not compile (no GCC: macOS's gcc is clang; a missing
            # header) and the files compile_commands.json does not list (bear records only what make rebuilt).
            # Tree-sitter reads them, so their functions are on the map, their calls matched by name
            done = {n.get("file") for n in part["nodes"].values() if n.get("defined")}
            listed = {u["file"] for u in part.get("units", []) if u.get("status") != "failed"}
            rest = [f for f in files if f not in done and f not in listed]
            if rest:
                from . import syntax
                with ui().step(f"tree-sitter, for the C/C++ files GCC did not read ({len(rest)} file{'s' * (len(rest) != 1)})") as st:
                    p2 = syntax.build(root, rest, others=[p for _, p in parts])
                    p2["stats"]["fallback"] = "tree-sitter"
                    st.done(_result("syntax-c", p2), "warn" if part["stats"].get("failed") or not part["stats"].get("units") else "ok")
                parts.append(("syntax-c", p2))
    from .. import scope
    idx = schema.merge(parts)
    scope.mark(idx["nodes"], config)
    return idx


def _one(root, name, files, scope, jobs, cc, config, parts):
    """Read one language's files: (backend name, part); the name changes when a fallback reads them."""
    from .. import scope as scope_mod
    if name == "gcc":
        from .. import layer1
        part = layer1.build(root, scope, jobs, cc)
        for n in part["nodes"].values():
            if n.get("defined"):
                n.setdefault("lang", "cpp" if Path(n.get("file") or "").suffix in (".cc", ".cpp", ".cxx", ".hpp", ".hh") else "c")
        part["stats"]["files"] = len(files)
        part["stats"]["languages"] = {"c": len(files)}
    elif name == "python":
        from . import python
        part = python.build(root, files, scope_mod.test_files(files, config))
    elif name == "go":
        from . import go, syntax
        part = go.build(root, files, scope_mod.test_files(files, config))
        if part is None:                      # no Go toolchain, or the helper failed
            part = syntax.build(root, files)
            part["stats"]["fallback"] = "tree-sitter"
            name = "syntax-go"
    elif name == "typescript":
        from . import syntax, ts
        part = ts.build(root, files, scope_mod.test_files(files, config))
        if part is None:                      # no Node, no TypeScript, or the helper failed
            part = syntax.build(root, [f for f in files if not syntax.is_dts(f)])
            part["stats"]["fallback"] = "tree-sitter"
            name = "syntax-typescript"
    else:
        from . import syntax
        missing = sorted({syntax.EXT[Path(f).suffix] for f in files if syntax.language(syntax.EXT[Path(f).suffix]) is None})
        if missing:
            from ..term import ui
            ui().say("no tree-sitter grammar for " + ", ".join(missing) + "; install codemap again to get them "
                     "(uv tool install --reinstall codemap)", "warn")
        part = syntax.build(root, files, others=[p for _, p in parts])
    return name, part


def _result(name, part):
    """The few numbers worth seeing on screen once a language is read; the rest goes to the log."""
    st = part.get("stats", {})
    defs = len([n for n in part.get("nodes", {}).values() if n.get("defined") and n.get("kind") != "site"])
    if name == "gcc":
        bits = [f'{st.get("units", 0)} units: {st.get("compiled", 0)} compiled', f'{st.get("cached", 0)} cached']
        if st.get("failed"):
            bits.append(f'{st["failed"]} failed')
        return f"{defs} functions ({', '.join(bits)})"
    if name == "syntax-c":
        return f"{defs} definitions, calls matched by name"
    if "fallback" in st:
        return f"{defs} definitions, read by tree-sitter (no {'Go toolchain' if name == 'syntax-go' else 'Node or TypeScript'})"
    return f"{defs} definitions"


def _trouble(part):
    st = part.get("stats", {})
    return bool(st.get("failed") or st.get("fallback") or part.get("errors"))
