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



class Msg:
    """A message for the viewer: the Traditional Chinese template and its values, so the viewer can
    show it in the reader's language (lists are joined there). str() gives the Chinese text."""
    def __init__(self, t, **v):
        self.t, self.v = t, v

    def __str__(self):
        return self.t.format(**{k: "、".join(x) if isinstance(x, list) else x for k, x in self.v.items()})

    def json(self):
        return dict(t=self.t, v=self.v)


def code(xs):
    return [f"`{x}`" for x in xs]


def check(root, md_path, index):
    """Problems as text for the command line, and one item per checked
    Markdown line for the viewer: status done, fail, or review (the claimed
    call exists only as a rule edge, so a person should confirm it)."""
    root = Path(root)
    nodes = index["nodes"]
    pairs, callees = {}, {}               # pairs: (a, b) -> compiler-confirmed?, and the first rule edge
    for e in index["edges"]:
        a = nodes.get(e["src"], {}).get("name", e["src"])
        b = nodes.get(e["dst"], {}).get("name", e["dst"])
        # the strongest way the call is known: the compiler, else a call tree-sitter read in the code
        ok, rule = pairs.get((a, b), (None, None))
        seen = e["source"] if e["source"] in ("compiler", "static", "syntax") else None
        best = min(filter(None, (ok, seen)), key=("compiler", "static", "syntax").index, default=None)
        pairs[(a, b)] = (best, rule or (e if e["source"] in ("rule", "framework") else None))
        if e["source"] in ("compiler", "static", "syntax") and e["kind"] == "call" and nodes.get(e["dst"], {}).get("defined"):
            callees.setdefault(a, set()).add(b)
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
            common = sorted(callees.get(a, set()) & callees.get(b, set()))
            if (a, b) not in pairs and common:
                # not a call, but both use the same functions: likely data passed through them
                review.append(Msg("`{a}` 沒有直接呼叫 `{b}`；兩者都呼叫 {common}，可能經由共用的資料相連。若筆記要說的是資料流向，請改寫成文字說明",
                                  a=a, b=b, common=code(common[:3])))
            elif (a, b) not in pairs:
                problems.append(f"{md_path}:{n}: no edge {a} -> {b} in the index")
                bad.append(Msg("程式碼中找不到 `{a}` 呼叫 `{b}`，請確認函式名稱與呼叫方向", a=a, b=b))
            elif not pairs[(a, b)][0]:
                e = pairs[(a, b)][1]
                at = f"`{e['file']}:{e['line']}`"
                if e.get("rule") == "fnptr_assign":
                    review.append(Msg("`{a}` 沒有直接呼叫 `{b}`：它在 {at} 把 `{b}` 存入 `{slot}`，之後經由該指標呼叫。可改寫成「`{a}` 註冊 `{b}`」",
                                      a=a, b=b, at=at, slot=e.get("slot") or "函式指標"))
                elif e["source"] == "framework":
                    review.append(Msg("`{a} -> {b}` 是框架規則「{rule}」推得的：程式碼裡沒有這個呼叫，由框架呼叫；請對照 {at} 確認", a=a, b=b, rule=e.get("rule"), at=at))
                else:
                    review.append(Msg("`{a} -> {b}` 由規則「{rule}」推得，編譯器無法確認；請對照 {at} 確認", a=a, b=b, rule=e.get("rule"), at=at))
            elif pairs[(a, b)][0] == "compiler":
                why.append(Msg("`{a} -> {b}` 經編譯器確認", a=a, b=b))
            else:
                why.append(Msg("`{a} -> {b}` 寫在程式碼裡（tree-sitter 依名稱對到）", a=a, b=b))
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
                short = None                     # `child.c:86` for the one src/ibmon/child.c: right, but incomplete
                if not src and (short := find_file(files(), f)):
                    src = lines(root / short)
                if not src:
                    problems.append(f"{md_path}:{n}: {f} does not exist")
                    new = fix_ref(root, f, lo, hi, want, defs, files)
                    bad.append(Msg("repo 中沒有 `{f}`，應為 `{new}`", f=f, new=new) if new else Msg("repo 中沒有 `{f}`，請改用從 repo 根目錄算起的路徑", f=f))
                    fixes.append((ref, new))
                    continue
                if hi < lo:
                    problems.append(f"{md_path}:{n}: {ref} ends before it starts")
                    bad.append(Msg("`{ref}` 的範圍起訖顛倒，請對調前後兩個行號", ref=ref))
                    continue
                if hi > len(src) or lo < 1:
                    problems.append(f"{md_path}:{n}: {f}:{lo} is past the end ({len(src)} lines)")
                    new = fix_ref(root, f, lo, hi, want, defs, files)
                    bad.append(Msg("`{ref}` 超出檔案範圍（共 {n} 行），應為 `{new}`", ref=ref, n=len(src), new=new) if new
                               else Msg("`{ref}` 超出檔案範圍（共 {n} 行），請確認行號", ref=ref, n=len(src)))
                    fixes.append((ref, new))
                    continue
                span = "\n".join(src[lo - 1:hi])
                if want and not mentions(span, whole):          # a clause's words are among the line's
                    problems.append(f"{md_path}:{n}: {ref} mentions none of {', '.join(sorted(want))}")
                    new = fix_ref(root, f, lo, hi, want, defs, files)
                    bad.append(Msg("`{ref}` 沒有出現 {words}，行號可能已移動，應為 `{new}`", ref=ref, words=code(sorted(want)), new=new) if new
                               else Msg("`{ref}` 沒有出現 {words}，請確認行號", ref=ref, words=code(sorted(want))))
                    fixes.append((ref, new))
                elif want:
                    hit = sorted(w for w in whole if mentions(span, [w]))
                    why.append(Msg("`{ref}` 提及 {words}", ref=ref, words=code(hit)))
                else:
                    why.append(Msg("`{ref}` 存在", ref=ref))
                if short and not (want and not mentions(span, whole)):
                    full = ref.replace(f, short, 1)
                    why.append(Msg("`{f}` 指 `{short}`，建議寫完整路徑", f=f, short=short))
                    fixes.append((ref, full))
        if bad or why or review:
            # a line that matches but has a better way to write it is not 「相符」: it gets a suggestion to act on
            status = "fail" if bad else "review" if review or any(new for _, new in fixes) else "done"
            fixed = md
            for old, new in fixes:
                if new:
                    fixed = fixed.replace(f"`{old}`", f"`{new}`", 1)
            # what a match rests on: every call confirmed by the compiler, or only names seen on the
            # referenced lines (the rest of the sentence, such as "set by", is not checked)
            basis = (None if status != "done" else
                     "calls" if why and all(m.t.endswith("經編譯器確認") for m in why) else
                     "syntax" if why and all(m.t.endswith(("經編譯器確認", "依名稱對到）")) for m in why) else
                     "names" if any("提及" in m.t for m in why) else "exists")
            items.append(dict(at=f"{rel}:{n}", line=n, text=plain(md),
                              status=status, basis=basis, why="；".join(map(str, bad or review or why)),
                              msgs=[m.json() for m in bad or review or why],
                              fix=dict(before=md, after=fixed) if fixed != md else None))
    return dict(file=rel, refs=refs, claims=claims, problems=problems, items=items)
