"""Reading sources and finding which function a line belongs to."""

import ast
import os
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

C_EXT = {".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"}
SKIP_DIRS = {".git", ".codemap", "build", "graphify-out", ".cache", "node_modules", "__pycache__", ".venv"}


@lru_cache(maxsize=None)
def lines(path):
    try:
        return Path(path).read_text(errors="replace").splitlines()
    except OSError:
        return []


def git_files(root):
    """The repository's files as git sees them (tracked, plus new ones .gitignore lets in), or None
    outside a git repository. Data and build output that .gitignore leaves out are never touched."""
    try:
        p = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "-co", "--exclude-standard"],
                           capture_output=True, stdin=subprocess.DEVNULL, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0:
        return None
    return [Path(root, f) for f in p.stdout.decode(errors="replace").split("\0") if f]


def walk(root, exts=None):
    """Files under root (only those with a suffix in exts, if given), without build, dependency and
    hidden directories. In a git repository the list comes from git; otherwise the directory is walked,
    without following directory links."""
    root = Path(root)
    found = git_files(root)
    if found is None:
        found, n = [], 0
        for d, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
            found += [Path(d, f) for f in files]
            n += 1
            if n % 500 == 0 and sys.stderr.isatty():
                sys.stderr.write(f"\r\033[Kscanning {root}: {n} directories (not a git repository)")
                sys.stderr.flush()
    skip = lambda p: any(x in SKIP_DIRS or x.startswith(".") for x in p.relative_to(root).parts[:-1])
    return sorted(p for p in found if (exts is None or p.suffix in exts) and not skip(p) and p.is_file())


def strip_c_comments(text_lines):
    """Blank out comments and string contents, keeping line and column positions."""
    out, in_block = [], False
    for line in text_lines:
        res, i, n = [], 0, len(line)
        while i < n:
            if in_block:
                j = line.find("*/", i)
                if j < 0:
                    res.append(" " * (n - i))
                    i = n
                else:
                    res.append(" " * (j + 2 - i))
                    i, in_block = j + 2, False
            elif line.startswith("/*", i):
                in_block = True
            elif line.startswith("//", i):
                res.append(" " * (n - i))
                i = n
            elif line[i] in "\"'":
                q, j = line[i], i + 1
                while j < n and line[j] != q:
                    j += 2 if line[j] == "\\" else 1
                res.append(q + " " * (min(j, n) - i - 1) + (q if j < n else ""))
                i = j + 1
            else:
                res.append(line[i])
                i += 1
        out.append("".join(res))
    return out


@lru_cache(maxsize=None)
def code_lines(path):
    return strip_c_comments(lines(path))


def c_body_end(path, start_line):
    """Line (1-based) of the brace that closes the function starting at start_line."""
    code = code_lines(path)
    depth, opened = 0, False
    for i in range(start_line - 1, len(code)):
        for ch in code[i]:
            if ch == "{":
                depth, opened = depth + 1, True
            elif ch == "}":
                depth -= 1
                if opened and depth == 0:
                    return i + 1
        if not opened and code[i].rstrip().endswith(";"):
            return start_line          # a prototype, not a definition
    return len(code)


class Functions:
    """Map file:line to the enclosing function, for C (from the compiler's
    definitions) and Python (from the ast)."""

    def __init__(self, root, nodes):
        self.root = Path(root)
        self.by_file = {}
        for nid, n in nodes.items():
            if n.get("defined") and n.get("file") and n.get("line"):
                self.by_file.setdefault(n["file"], []).append((n["line"], nid))
        self.ranges = {}

    def _c_ranges(self, f):
        if f not in self.ranges:
            path = self.root / f
            self.ranges[f] = [(s, c_body_end(path, s), nid) for s, nid in sorted(self.by_file.get(f, []))]
        return self.ranges[f]

    def _py_ranges(self, f):
        if f not in self.ranges:
            rs = []
            try:
                tree = ast.parse("\n".join(lines(self.root / f)))
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        rs.append((node.lineno, node.end_lineno, f"{f}:{node.name}"))
            except SyntaxError:
                pass
            self.ranges[f] = sorted(rs)
        return self.ranges[f]

    def enclosing(self, f, line):
        rs = self._py_ranges(f) if f.endswith(".py") else self._c_ranges(f)
        best = None
        for s, e, nid in rs:
            if s <= line <= e and (best is None or s >= best[0]):
                best = (s, e, nid)
        return best[2] if best else None


IDENT = re.compile(r"[A-Za-z_]\w*")


def forget_files():
    """Drop cached file contents, so a long-running process (codemap serve) sees edits on disk."""
    lines.cache_clear()
    code_lines.cache_clear()
