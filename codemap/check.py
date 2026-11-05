"""Validator for CODEMAP.md and tours.

Checks, for every bullet, table row or paragraph line of a Markdown file:
  - every `file:line` or `file:a-b` reference points at an existing line;
  - if the same line of Markdown names identifiers in backticks, at least one
    of them appears on the referenced line (or within the range);
  - every `caller -> callee` claim is an edge in the index (any source).

Exit status is the number of problems, capped at 1, so it can gate a commit.
"""

import re
from pathlib import Path

from .source import lines

REF = re.compile(r"`([\w./+-]+\.[\w]+|Makefile|CMakeLists\.txt):(\d+)(?:-(\d+))?`")
CLAIM = re.compile(r"`([A-Za-z_][\w.]*)\s+->\s+([A-Za-z_][\w.]*)`")
CLAUSE = re.compile(r";|,\s|\sand\s|\swhich\s")
FILEISH = re.compile(r"\.(c|h|cc|cpp|hpp|py|md|json|txt|mk|so|sh|yaml)$")
IDENT = re.compile(r"`([A-Za-z_][\w/]*(?:(?:->|\.)[A-Za-z_]\w*)*)(?:\(\))?`")


def words_in(text):
    """Identifiers and file paths named in backticks, except the references themselves."""
    out = set()
    for m in IDENT.finditer(text):
        i = m.group(1)
        if REF.fullmatch(f"`{i}`"):
            continue
        out |= {i} if FILEISH.search(i) else {w for w in re.split(r"->|\.", i) if len(w) > 1}
    for m in CLAIM.finditer(text):
        out |= {x.split(".")[-1] for x in m.groups()}
    return out


def mentions(span, words):
    return any(w in span if (len(w) >= 4 or "/" in w) else re.search(r"\b" + re.escape(w) + r"\b", span)
               for w in words)


def check(root, md_path, index):
    root = Path(root)
    nodes = index["nodes"]
    pairs = set()
    for e in index["edges"]:
        a = nodes.get(e["src"], {}).get("name", e["src"])
        b = nodes.get(e["dst"], {}).get("name", e["dst"])
        pairs.add((a, b))
    problems, refs, claims = [], 0, 0
    text = Path(md_path).read_text().splitlines()
    in_code = False
    for n, md in enumerate(text, 1):
        if md.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        for m in CLAIM.finditer(md):
            claims += 1
            a, b = m.group(1).split(".")[-1], m.group(2).split(".")[-1]
            if (a, b) not in pairs:
                problems.append(f"{md_path}:{n}: no edge {a} -> {b} in the index")
        whole = words_in(md)
        pos = 0
        for clause in CLAUSE.split(md):
            local = words_in(clause)
            for m in REF.finditer(clause):
                refs += 1
                f, lo = m.group(1), int(m.group(2))
                hi = int(m.group(3) or lo)
                src = lines(root / f)
                if not src:
                    problems.append(f"{md_path}:{n}: {f} does not exist")
                    continue
                if hi > len(src) or lo < 1 or hi < lo:
                    problems.append(f"{md_path}:{n}: {f}:{lo} is past the end ({len(src)} lines)")
                    continue
                span = "\n".join(src[lo - 1:hi])
                if (local or whole) and not (mentions(span, local) or mentions(span, whole)):
                    problems.append(f"{md_path}:{n}: {m.group(0).strip('`')} mentions none of "
                                    f"{', '.join(sorted(local or whole))}")
    return dict(refs=refs, claims=claims, problems=problems)
