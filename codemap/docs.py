"""What the source says about itself, for readers who do not open every file:
the comment at the top of a file, the comment and attributes right above a
function, and the atomic operations a function uses."""

import re
from pathlib import Path

from .source import lines

ATOMIC_RE = re.compile(r"\b(?:__atomic_|__sync_|atomic_)(\w+)\s*\((.*)")
ORDER_RE = re.compile(r"__ATOMIC_(\w+)|memory_order_(\w+)")
LEAD_RE = re.compile(r"^\s*(?:/\*|\*|//|__attribute__|\[\[)|\*/\s*$")


def _comment_text(block):
    """Comment lines without their markers, joined into paragraphs."""
    out, para = [], []
    for ln in block:
        t = re.sub(r"^\s*(?:/\*+|\*+/?|//+)\s?", "", ln)
        t = re.sub(r"\s*\*+/\s*$", "", t).rstrip()
        if not t.strip():
            if para:
                out.append(" ".join(para))
                para = []
            continue
        para.append(t.strip())
    if para:
        out.append(" ".join(para))
    return out


PY_DOC = re.compile(r"""\s*[rbuRBU]?(\"\"\"|'''|"|')(.*)""")


def _py_doc(src):
    """The first paragraph of a Python module's docstring, after any #! and # coding lines."""
    i = 0
    while i < len(src) and (not src[i].strip() or src[i].startswith("#")):
        i += 1
    m = PY_DOC.match(src[i]) if i < len(src) else None
    if not m:
        return None
    q, body, j = m.group(1), [m.group(2)], i
    while q not in body[-1] and j + 1 < len(src):
        j += 1
        body.append(src[j])
    body[-1] = body[-1].split(q)[0]
    paras = [" ".join(p.split()) for p in "\n".join(body).split("\n\n") if p.strip()]
    if not paras:
        return None
    text = paras[0] if len(paras[0]) >= 40 or len(paras) == 1 else paras[0] + " " + paras[1]
    return dict(text=text[:600], line=i + 1)


def file_doc(root, file):
    """(first paragraph, line) of the comment a file starts with, or None."""
    src = lines(Path(root) / file)
    if file.endswith(".py"):
        return _py_doc(src)
    i = 0
    while i < len(src) and not src[i].strip():
        i += 1
    if i >= len(src) or not src[i].lstrip().startswith(("/*", "//")):
        return None
    j, block = i, []
    if src[i].lstrip().startswith("/*"):
        while j < len(src):
            block.append(src[j])
            if "*/" in src[j]:
                break
            j += 1
    else:
        while j < len(src) and src[j].lstrip().startswith("//"):
            block.append(src[j])
            j += 1
    paras = _comment_text(block)
    if not paras:
        return None
    text = paras[0] if len(paras[0]) >= 40 or len(paras) == 1 else paras[0] + " " + paras[1]
    return dict(text=text[:600], line=i + 1)


def files_docs(root, files):
    """file -> {text, line, file}: the file's own top comment, or else that of the one header
    with the same name (src/common/ring.c -> include/ibtrace/ring.h)."""
    own = {f: d for f in files if (d := file_doc(root, f))}
    headers = {}
    for f in own:
        if f.endswith(".h"):
            headers.setdefault(Path(f).stem, []).append(f)
    out = {}
    for f in files:
        # "reader.c - described in reader.h.": the header's comment is the one that says something
        m = re.search(r"\b(?:described|documented|explained) in\s+([\w./-]+\.h)\b", own[f]["text"]) if f in own else None
        hs = [h for h in headers.get(Path(m.group(1)).stem, []) if Path(h).name == Path(m.group(1)).name] if m else []
        if len(hs) == 1 and hs[0] != f:
            out[f] = dict(own[hs[0]], file=hs[0])
        elif f in own:
            out[f] = dict(own[f], file=f)
        elif len(hs := headers.get(Path(f).stem, [])) == 1 and hs[0] != f:
            out[f] = dict(own[hs[0]], file=hs[0])
    return out


def lead_line(root, file, line):
    """First line of the comment and attributes directly above a definition (no blank line between)."""
    src = lines(Path(root) / file)
    k = line - 1                      # 0-based index of the definition line
    while k > 0 and src[k - 1].strip() and LEAD_RE.search(src[k - 1]):
        k -= 1
    return k + 1


def atomics(root, file, start, end):
    """['fetch_add relaxed', 'store_n release', ...] used in lines start..end."""
    out = []
    for ln in lines(Path(root) / file)[start - 1:end]:
        for m in ATOMIC_RE.finditer(ln):
            orders = [a or b for a, b in ORDER_RE.findall(m.group(2))]
            op = m.group(1) + (" " + "/".join(o.lower() for o in orders) if orders else "")
            if op not in out:
                out.append(op)
    return out


_PY_DOCS = {}


def _py_docstrings(root, file):
    """{def line: docstring} of the functions and classes in a Python file."""
    import ast
    key = (str(root), file)
    if key not in _PY_DOCS:
        found = {}
        try:
            for n in ast.walk(ast.parse("\n".join(lines(Path(root) / file)))):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    d = ast.get_docstring(n)
                    if d:
                        found[n.lineno] = d
                        for dec in n.decorator_list:             # the node's line is the def, a decorator can come first
                            found.setdefault(dec.lineno, d)
        except (SyntaxError, ValueError):
            pass
        _PY_DOCS[key] = found
    return _PY_DOCS[key]


_MARK = re.compile(r"^\s*(?:///?|/\*\*?|\*/?|#+|--|;+|%)\s?")


def first_sentence(text, limit=240):
    """The first sentence of a comment or docstring: up to the first blank line, then up to '. ' or '。'."""
    para = []
    for ln in text.strip().splitlines():
        if not ln.strip():
            if para:
                break
            continue
        para.append(ln.strip())
    s = " ".join(para)
    m = re.search(r"(?<=[.!?])\s+(?=[A-Z`(\"'])|(?<=[。！？])", s)
    s = s[: m.start()] if m else s
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def func_doc(root, file, line, lang):
    """The author's one-line description of a function: a Python docstring, else the comment directly above the
    definition (no blank line between); None when neither is there. Attributes and decorators are skipped."""
    if lang == "python":
        d = _py_docstrings(root, file).get(line)
        if d:
            return first_sentence(d)
    src = lines(Path(root) / file)
    k, block = line - 1, []
    while k > 0 and src[k - 1].strip():
        t = src[k - 1].strip()
        if t.startswith(("@", "#[", "[[", "[")) and not t.startswith(("#", "//")) or t.startswith("#[") or t.startswith("@"):
            k -= 1                                     # @decorator, #[attr], [[nodiscard]]: not the comment
            continue
        if not _MARK.match(src[k - 1]) or t.startswith(("#include", "#define", "#if", "#endif", "#pragma", "#!")):
            break
        block.insert(0, _MARK.sub("", src[k - 1]).rstrip(" */").rstrip())
        k -= 1
    text = "\n".join(block).strip()
    if not text or re.fullmatch(r"[-=*#/ ]+", text):
        return None
    return first_sentence(text)
