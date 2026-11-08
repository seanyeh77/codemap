"""Shared state the compiler's call graph does not show: file-scope variables that
several functions read or write. Changing one of those functions can affect the
others through the variable even when none of them calls another.

Only .c files are scanned. A `static` variable is visible in its own file; any
other file-scope variable can be used from every .c file of the repo."""

import re
from collections import defaultdict
from pathlib import Path

from .source import code_lines

QUAL = r"(?:(?:const|volatile|unsigned|signed|long|short|struct|enum|union|_Thread_local|__thread)\s+)*"
DECL_RE = re.compile(r"^\s*(static\s+)?" + QUAL + r"[A-Za-z_]\w*[\s\*]+(?:const\s+)?\**\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=|;)")
SKIP = re.compile(r"^\s*(typedef|extern|return|#)\b|^\s*(struct|union|enum)\s+\w+\s*;")   # a forward declaration names a type
STRINGS = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'')


def _file_scope(code):
    """(line, name, static) for each variable declared outside every brace."""
    out, depth = [], 0
    for i, ln in enumerate(code, 1):
        text = STRINGS.sub('""', ln)
        if depth == 0 and "(" not in text.split("=")[0] and not SKIP.match(text):
            m = DECL_RE.match(text)
            if m:
                out.append((i, m.group(2), bool(m.group(1))))
        depth = max(0, depth + text.count("{") - text.count("}"))
    return out


def shared_state(root, funcs):
    """[{name, file, line, static, users: [[fid, line], ...]}] for each file-scope variable
    used by at least two functions, users in file and line order."""
    root = Path(root)
    by_file = defaultdict(list)
    for fid, f in funcs.items():
        if f["file"].endswith(".c"):
            by_file[f["file"]].append(fid)
    code = {file: [STRINGS.sub('""', ln) for ln in code_lines(root / file)] for file in by_file}
    decls = [(file, ln, name, static) for file in sorted(code) for ln, name, static in _file_scope(code[file])]
    out = []
    for file, line, name, static in decls:
        word = re.compile(r"(?<![\w.>])" + re.escape(name) + r"\b")
        users = []
        for f2 in ([file] if static else sorted(code)):
            for fid in sorted(by_file[f2], key=lambda x: funcs[x]["line"]):
                fn = funcs[fid]
                body = code[f2][fn["line"] - 1:fn["end"]]
                hit = next((fn["line"] + k for k, t in enumerate(body) if word.search(t)), None)
                if hit:
                    users.append([fid, hit])
        if len(users) >= 2:
            out.append(dict(name=name, file=file, line=line, static=static, users=users))
    return out
