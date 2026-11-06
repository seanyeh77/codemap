"""Validator for CODEMAP.md and tours.

Checks, for every bullet, table row or paragraph line of a Markdown file:
  - every `file:line` or `file:a-b` reference points at an existing line;
  - if the same line of Markdown names identifiers in backticks, at least one
    of them appears on the referenced line (or within the range);
  - every `caller -> callee` claim is an edge in the index (any source).

Exit status is the number of problems, capped at 1, so it can gate a commit.
"""

import re
from functools import cache
from pathlib import Path

from .source import lines, walk

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


def repo_files(root):
    """Every file in the repository, relative, skipping build and dependency trees."""
    return [str(p.relative_to(root)) for p in walk(root)]


def find_file(files, name):
    """The one file whose path is name or ends with /name, or None."""
    hits = [q for q in files if q == name or q.endswith("/" + name)]
    return hits[0] if len(hits) == 1 else None


def best_line(src, words, near):
    """The line mentioning the most of words, closest to near; None if no line mentions any."""
    best = None
    for i, t in enumerate(src, 1):
        n = sum(1 for w in words if mentions(t, [w]))
        if n and (best is None or (n, -abs(i - near)) > (best[0], -abs(best[1] - near))):
            best = (n, i)
    return best[1] if best else None


def fix_ref(root, f, lo, hi, want, defs, files):
    """A corrected `file:line` for a reference that is wrong, or None. A named
    function defined in that file wins: its definition in the default build."""
    path = f if (root / f).is_file() else find_file(files(), f)
    if not path or hi < lo:
        return None
    src = lines(root / path)
    # a range that only runs past the end keeps its start and is cut at the last line
    span = "\n".join(src[lo - 1:min(hi, len(src))]) if 1 <= lo <= len(src) else ""
    new_lo, new_hi = lo, min(hi, len(src))
    if want and not mentions(span, want):
        n = defs.get((path, next(iter(want)))) if len(want) == 1 else None
        if n is None:
            n = best_line(src, sorted(want), lo)
        if n is None:
            return None
        new_lo, new_hi = n, min(len(src), n + (hi - lo))
    elif not span:
        return None
    if path == f and (new_lo, new_hi) == (lo, hi):
        return None
    return f"{path}:{new_lo}" + (f"-{new_hi}" if new_hi != new_lo else "")


def plain(md):
    """A Markdown line as the viewer shows it: no list marker, table cells joined with a middle dot."""
    s = md.strip()
    if s.startswith("|"):
        return " · ".join(c.strip() for c in s.strip("|").split("|") if c.strip())
    return re.sub(r"^(?:[-*+]|\d+\.)\s+", "", s)


def check(root, md_path, index):
    """Problems as text for the command line, and one item per checked
    Markdown line for the viewer: status done, fail, or review (the claimed
    call exists only as a rule edge, so a person should confirm it)."""
    root = Path(root)
    nodes = index["nodes"]
    pairs = {}
    for e in index["edges"]:
        a = nodes.get(e["src"], {}).get("name", e["src"])
        b = nodes.get(e["dst"], {}).get("name", e["dst"])
        pairs[(a, b)] = pairs.get((a, b)) or e["source"] == "compiler"
    defs = {(n["file"], n["name"]): n["line"] for n in nodes.values()
            if n.get("defined") and n.get("file") and n.get("line")}
    problems, items, refs, claims = [], [], 0, 0
    files = cache(lambda: repo_files(root))          # walked once, and only when a file is missing
    try:
        rel = str(Path(md_path).resolve().relative_to(root.resolve()))
    except ValueError:
        rel = str(md_path)
    text = Path(md_path).read_text().splitlines()
    in_code = False
    for n, md in enumerate(text, 1):
        if md.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        bad, why, review, fixes = [], [], [], []
        for m in CLAIM.finditer(md):
            claims += 1
            a, b = m.group(1).split(".")[-1], m.group(2).split(".")[-1]
            if (a, b) not in pairs:
                problems.append(f"{md_path}:{n}: no edge {a} -> {b} in the index")
                bad.append(f"索引中沒有 `{a} -> {b}`")
            elif not pairs[(a, b)]:
                review.append(f"`{a} -> {b}` 由規則推得，編譯器無法確認")
            else:
                why.append(f"`{a} -> {b}` 經編譯器確認")
        whole = words_in(md)
        for clause in CLAUSE.split(md):
            local = words_in(clause)
            for m in REF.finditer(clause):
                refs += 1
                f, lo = m.group(1), int(m.group(2))
                hi = int(m.group(3) or lo)
                ref = m.group(0).strip("`")
                src = lines(root / f)
                want = local or whole
                if not src:
                    problems.append(f"{md_path}:{n}: {f} does not exist")
                    bad.append(f"`{f}` 不存在")
                    fixes.append((ref, fix_ref(root, f, lo, hi, want, defs, files)))
                    continue
                if hi < lo:
                    problems.append(f"{md_path}:{n}: {ref} ends before it starts")
                    bad.append(f"`{ref}` 的範圍起訖顛倒")
                    continue
                if hi > len(src) or lo < 1:
                    problems.append(f"{md_path}:{n}: {f}:{lo} is past the end ({len(src)} lines)")
                    bad.append(f"`{ref}` 超出檔案範圍（共 {len(src)} 行）")
                    fixes.append((ref, fix_ref(root, f, lo, hi, want, defs, files)))
                    continue
                span = "\n".join(src[lo - 1:hi])
                if want and not mentions(span, whole):          # a clause's words are among the line's
                    problems.append(f"{md_path}:{n}: {ref} mentions none of {', '.join(sorted(want))}")
                    bad.append(f"`{ref}` 未提及 " + "、".join(f"`{w}`" for w in sorted(want)))
                    fixes.append((ref, fix_ref(root, f, lo, hi, want, defs, files)))
                elif want:
                    hit = sorted(w for w in whole if mentions(span, [w]))
                    why.append(f"`{ref}` 提及 " + "、".join(f"`{w}`" for w in hit))
                else:
                    why.append(f"`{ref}` 存在")
        if bad or why or review:
            status = "fail" if bad else "review" if review else "done"
            fixed = md
            for old, new in fixes:
                if new:
                    fixed = fixed.replace(f"`{old}`", f"`{new}`", 1)
            items.append(dict(at=f"{rel}:{n}", line=n, text=plain(md),
                              status=status, why="；".join(bad or review or why),
                              fix=dict(before=md, after=fixed) if fixed != md else None))
    return dict(file=rel, refs=refs, claims=claims, problems=problems, items=items)
