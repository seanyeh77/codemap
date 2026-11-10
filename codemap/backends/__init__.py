"""Backends: each turns one kind of source into the nodes and edges of codemap.schema.

A backend has a name, says which of the repository's files it reads, and
builds a partial index from them. The pipeline merges the parts and never
looks inside a backend, so a new language is a new module here.

  gcc      C/C++ through the compiler (needs compile_commands.json): source "compiler"
  syntax   every language with a tree-sitter grammar, calls matched by name: source "syntax"

The gcc backend takes the C/C++ files when it can; tree-sitter reads them only
when the repository has no compile_commands.json.
"""

import sys
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
    rest = [f for f in files if Path(f).suffix in syntax.EXT and not (has_db and f in set(c_files))]
    disabled = set((config or {}).get("languages", {}).get("disable", []))
    rest = [f for f in rest if syntax.LANG_NAME.get(syntax.EXT[Path(f).suffix], syntax.EXT[Path(f).suffix]) not in disabled]
    if rest:
        out.append(("syntax", rest))
    return out


def build(root, scope=None, jobs=None, cc=None, config=None):
    """The merged index of every backend that has files to read."""
    root = Path(root).resolve()
    parts = []
    for name, files in plan(root, config):
        if scope:
            files = [f for f in files if any(f.startswith(s.rstrip("/") + "/") for s in scope)]
        if name == "gcc":
            from .. import layer1
            part = layer1.build(root, scope, jobs, cc)
            for n in part["nodes"].values():
                if n.get("defined"):
                    n.setdefault("lang", "cpp" if Path(n.get("file") or "").suffix in (".cc", ".cpp", ".cxx", ".hpp", ".hh") else "c")
            part["stats"]["files"] = len(files)
            part["stats"]["languages"] = {"c": len(files)}
        else:
            from . import syntax
            missing = sorted({syntax.EXT[Path(f).suffix] for f in files if syntax.language(syntax.EXT[Path(f).suffix]) is None})
            if missing:
                sys.stderr.write("codemap: no tree-sitter grammar for " + ", ".join(missing)
                                 + "; install codemap again to get them (uv tool install codemap)\n")
            part = syntax.build(root, files)
        parts.append((name, part))
    return schema.merge(parts)
