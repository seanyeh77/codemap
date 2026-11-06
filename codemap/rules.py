"""Layer 2: relations the compiler cannot see, found by rules over the source text.

Each rule adds edges with source="rule" and the rule's name.  An endpoint that
is not a function (a Makefile line, a #define, a Python statement) is a "site"
node whose id is "file:line".

Rules:
  fnptr_assign   a function stored into a pointer: s.f = fn; p->f = fn; .f = fn,
  indirect       an __indirect_call whose called field matches a fnptr_assign
  ctor           __attribute__((constructor|destructor)): called by the loader
  env            setenv/putenv and getenv on the same name, C and Python
  exec           execvp/posix_spawn in C, subprocess/os.exec in Python
  build_define   -DNAME in a Makefile or CMake file, linked to #define/#ifndef NAME
  cross_lang     a C macro or header path mentioned in a Python file
  custom         regex rules from .codemap/rules.json
"""

import json
import re
from pathlib import Path

from .source import C_EXT, Functions, code_lines, lines, walk

MEMBER = r"(?:[A-Za-z_]\w*(?:\[[^\]]*\])?(?:->|\.))+[A-Za-z_]\w*"
ASSIGN_RE = re.compile(r"(" + MEMBER + r")\s*(?<![=!<>+\-*/%&|^])=(?!=)\s*&?\s*([A-Za-z_]\w*)\s*;")
COPY_RE = re.compile(r"(" + MEMBER + r")\s*(?<![=!<>+\-*/%&|^])=(?!=)\s*(" + MEMBER + r")\s*;")
DESIG_RE = re.compile(r"(?<![\w\]])\.([A-Za-z_]\w*)\s*=\s*&?\s*([A-Za-z_]\w*)\s*[,}]")
CALLEXPR_RE = re.compile(r"\(?\s*\*?\s*((?:[A-Za-z_]\w*(?:\[[^\]]*\])?(?:->|\.))*([A-Za-z_]\w*))\s*\)?\s*\(")
ATTR_RE = re.compile(r"__attribute__\s*\(\(\s*(constructor|destructor)")
C_ENV_SET = re.compile(r"\b(setenv|putenv)\s*\(\s*\"")
C_ENV_GET = re.compile(r"\b(getenv|secure_getenv)\s*\(\s*\"")
PY_ENV_GET = [re.compile(r"os\.environ\[\s*['\"](\w+)['\"]\s*\](?!\s*=[^=])"),
              re.compile(r"os\.environ\.get\(\s*['\"](\w+)['\"]"),
              re.compile(r"os\.getenv\(\s*['\"](\w+)['\"]")]
PY_ENV_SET = [re.compile(r"os\.environ\[\s*['\"](\w+)['\"]\s*\]\s*=[^=]"),
              re.compile(r"\benv(?:iron)?\s*\[\s*['\"](\w+)['\"]\s*\]\s*=[^=]"),
              re.compile(r"dict\(\s*os\.environ\s*,(.*)")]
C_EXEC = re.compile(r"\b(execvp|execv|execve|execvpe|execl|execlp|execle|posix_spawnp?|system|popen)\s*\(")
PY_EXEC = re.compile(r"\b(subprocess\.(?:run|Popen|call|check_call|check_output)|os\.exec\w+|os\.spawn\w+|os\.system)\s*\(")
DEFINE_RE = re.compile(r"^\s*#\s*(define|ifndef|ifdef|if\s+!?\s*defined\s*\(?)\s*([A-Za-z_]\w*)")
MAKE_D_RE = re.compile(r"(?<![\w-])-D([A-Za-z_]\w*)(?:=(\S+))?")
MACRO_NAME = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")


class Ctx:
    def __init__(self, root, index, config):
        self.root = Path(root)
        self.index = index
        self.nodes = index["nodes"]
        self.funcs = Functions(root, self.nodes)
        self.config = config
        self.edges = []
        self.copies = []
        names = {}
        for nid, n in self.nodes.items():
            if n.get("defined"):
                names.setdefault(n["name"], []).append(nid)
        self.by_name = names
        files = walk(root)                                   # one pass over the tree
        self.c_files = [p for p in files if p.suffix in C_EXT]
        self.py_files = [p for p in files if p.suffix == ".py"]
        self.build_files = [p for p in files
                            if p.name in ("Makefile", "GNUmakefile", "CMakeLists.txt") or p.suffix in (".mk", ".cmake")]

    def rel(self, p):
        return str(Path(p).relative_to(self.root))

    def site(self, f, line, label=None):
        nid = f"{f}:{line}"
        if nid not in self.nodes:
            self.nodes[nid] = dict(name=label or nid, file=f, line=line, defined=True, kind="site")
        return nid

    def where(self, f, line, label=None):
        return self.funcs.enclosing(f, line) or self.site(f, line, label)

    def fn(self, name, f):
        """Resolve a function name used in file f: a static of that file first, then a global."""
        cands = self.by_name.get(name, [])
        local = [c for c in cands if self.nodes[c]["file"] == f]
        return (local or cands or [None])[0]

    def add(self, rule, kind, src, dst, f, line, **extra):
        self.edges.append(dict(src=src, dst=dst, file=f, line=line, kind=kind, source="rule", rule=rule, **extra))


def rule_fnptr_assign(c):
    for p in c.c_files:
        f = c.rel(p)
        for i, code in enumerate(code_lines(p), 1):
            hits = [(m.group(1), m.group(2)) for m in ASSIGN_RE.finditer(code)]
            hits += [("." + m.group(1), m.group(2)) for m in DESIG_RE.finditer(code)]
            for slot, rhs in hits:
                dst = c.fn(rhs, f)
                if dst:
                    c.add("fnptr_assign", "fnptr_assign", c.where(f, i), dst, f, i, slot=slot, key=slot_key(slot))
            for m in COPY_RE.finditer(code):
                c.copies.append(dict(dst=m.group(1), src=m.group(2), file=f, line=i))


def slot_key(expr):
    """Compare pointer slots without the base variable when the path is long
    enough: ctx->ops.post_send and dev->ops.post_send are the same slot, while
    h->post_send (a copy kept by the hook) is a different one."""
    parts = re.split(r"->|\.", re.sub(r"\[[^\]]*\]", "", expr).lstrip("."))
    return ".".join(parts[1:] if len(parts) >= 3 else parts)


def rule_indirect(c):
    by_key, copies = {}, {}
    for e in c.edges:
        if e["kind"] == "fnptr_assign":
            by_key.setdefault(e["key"], []).append(e)
    for cp in c.copies:
        if slot_key(cp["src"]) in by_key:
            copies.setdefault(slot_key(cp["dst"]), []).append(cp)
    unresolved = 0
    for e in c.index["edges"]:
        if e["kind"] != "indirect":
            continue
        code = code_lines(c.root / e["file"])
        text = code[e["line"] - 1] if e["line"] - 1 < len(code) else ""
        exprs = [m.group(1) for m in CALLEXPR_RE.finditer(text[max(e.get("col", 1) - 1, 0):])][:1] \
            or [m.group(1) for m in CALLEXPR_RE.finditer(text)]
        keys = [slot_key(x) for x in exprs]
        targets = [a for k in keys for a in by_key.get(k, [])]
        saved = [cp for k in keys for cp in copies.get(k, [])]
        if not targets and not saved:
            unresolved += 1
        for a in {t["dst"]: t for t in targets}.values():
            c.add("indirect", "indirect_candidate", e["src"], a["dst"], e["file"], e["line"],
                  via=a["slot"], assigned_at=f'{a["file"]}:{a["line"]}')
        for cp in saved:
            dst = c.site(cp["file"], cp["line"], f'previous value of {cp["src"]}')
            c.add("indirect", "indirect_saved", e["src"], dst, e["file"], e["line"],
                  via=cp["dst"], saved_from=cp["src"])
    c.index["stats"]["indirect_unresolved"] = unresolved


def rule_ctor(c):
    for p in c.c_files:
        f = c.rel(p)
        defs = sorted(c.funcs.by_file.get(f, []))
        for i, code in enumerate(code_lines(p), 1):
            m = ATTR_RE.search(code)
            if not m:
                continue
            nxt = [(s, nid) for s, nid in defs if i <= s <= i + 3]
            if nxt:
                src = c.site(f, i, "loader " + m.group(1))
                c.add("ctor", m.group(1), src, nxt[0][1], f, i, defined_at=nxt[0][0])


def _literal_at(raw, code, m):
    """The string literal that starts where the regex match ended."""
    j = m.end() - 1
    k = raw.find('"', j + 1)
    return raw[j + 1:k] if k > j else None


def rule_env(c):
    setters, getters = {}, {}
    for p in c.c_files:
        f = c.rel(p)
        raw_lines, code = lines(p), code_lines(p)
        for i, (raw, cl) in enumerate(zip(raw_lines, code), 1):
            for rx, table in ((C_ENV_SET, setters), (C_ENV_GET, getters)):
                for m in rx.finditer(cl):
                    name = _literal_at(raw, cl, m)
                    if name:
                        name = name.split("=")[0]
                        table.setdefault(name, []).append((f, i))
    for p in c.py_files:
        f = c.rel(p)
        for i, raw in enumerate(lines(p), 1):
            if raw.lstrip().startswith("#"):
                continue
            for rx in PY_ENV_GET:
                for m in rx.finditer(raw):
                    getters.setdefault(m.group(1), []).append((f, i))
            for rx in PY_ENV_SET:
                for m in rx.finditer(raw):
                    if rx.pattern.startswith("dict"):
                        for k in re.findall(r"([A-Za-z_]\w*)\s*=", m.group(1)):
                            setters.setdefault(k, []).append((f, i))
                    else:
                        setters.setdefault(m.group(1), []).append((f, i))
    for name in sorted(set(setters) & set(getters)):
        for sf, sl in setters[name]:
            for gf, gl in getters[name]:
                c.add("env", "env", c.where(sf, sl), c.where(gf, gl), sf, sl, name=name, read_at=f"{gf}:{gl}")
    c.index["env"] = {n: dict(set=[f"{f}:{l}" for f, l in setters.get(n, [])],
                              get=[f"{f}:{l}" for f, l in getters.get(n, [])])
                      for n in sorted(set(setters) | set(getters))}


def rule_exec(c):
    for p in c.c_files:
        f = c.rel(p)
        for i, cl in enumerate(code_lines(p), 1):
            for m in C_EXEC.finditer(cl):
                c.add("exec", "exec", c.where(f, i), c.site(f, i, m.group(1)), f, i, call=m.group(1))
    for p in c.py_files:
        f = c.rel(p)
        for i, raw in enumerate(lines(p), 1):
            if raw.lstrip().startswith("#"):
                continue
            for m in PY_EXEC.finditer(raw):
                c.add("exec", "exec", c.where(f, i), c.site(f, i, m.group(1)), f, i, call=m.group(1))


def _macro_sites(c):
    sites = {}
    for p in c.c_files:
        f = c.rel(p)
        for i, raw in enumerate(lines(p), 1):
            m = DEFINE_RE.match(raw)
            if m:
                sites.setdefault(m.group(2), []).append((f, i, m.group(1).split()[0]))
    return sites


def rule_build_define(c, macros):
    for p in c.build_files:
        f = c.rel(p)
        for i, raw in enumerate(lines(p), 1):
            if raw.lstrip().startswith("#"):
                continue
            for m in MAKE_D_RE.finditer(raw):
                name, value = m.group(1), m.group(2)
                src = c.site(f, i, f"-D{name}")
                for df, dl, how in macros.get(name, []):
                    c.add("build_define", "build_define", src, c.site(df, dl, f"#{how} {name}"), f, i,
                          name=name, value=value)


def rule_cross_lang(c, macros):
    names = {n for n in macros if MACRO_NAME.match(n) and len(n) >= 6}
    headers = {c.rel(p) for p in c.c_files if p.suffix in (".h", ".hpp", ".hh")}
    word = re.compile(r"\b(" + "|".join(sorted(map(re.escape, names), key=len, reverse=True)) + r")\b") if names else None
    for p in c.py_files:
        f = c.rel(p)
        src_lines = lines(p)
        for i, raw in enumerate(src_lines, 1):
            found = []
            if word:
                found += [("macro", m.group(1)) for m in word.finditer(raw)]
            found += [("header", h) for h in headers if h in raw]
            for what, name in found:
                near = _next_assignment(src_lines, i)
                src = c.where(f, i)
                if what == "macro":
                    for df, dl, how in macros[name][:1]:
                        c.add("cross_lang", "cross_lang", src, c.site(df, dl, f"#{how} {name}"), f, i,
                              name=name, near=near)
                else:
                    c.add("cross_lang", "cross_lang", src, c.site(name, 1, name), f, i, name=name, near=near)


def _next_assignment(src_lines, i):
    """For a mention in a comment or docstring, the module-level name assigned next."""
    for j in range(i - 1, min(i + 8, len(src_lines))):
        m = re.match(r"^([A-Za-z_]\w*)\s*(?::[^=]*)?=", src_lines[j])
        if m:
            return f"{m.group(1)}:{j + 1}"
    return None


def rule_custom(c):
    for r in c.config.get("custom", []):
        rx = re.compile(r["pattern"])
        globs = r.get("files", ["**/*"])
        for g in globs:
            for p in sorted(c.root.glob(g)):
                if not p.is_file() or ".codemap" in p.parts:
                    continue
                f = c.rel(p)
                for i, raw in enumerate(lines(p), 1):
                    if rx.search(raw):
                        c.add(r["name"], r.get("kind", "custom"), c.where(f, i), c.site(f, i, r["name"]), f, i)


def run(root, index, config=None):
    config = config or {}
    disabled = set(config.get("disable", []))
    c = Ctx(root, index, config)
    macros = _macro_sites(c)
    steps = [("fnptr_assign", lambda: rule_fnptr_assign(c)), ("indirect", lambda: rule_indirect(c)),
             ("ctor", lambda: rule_ctor(c)), ("env", lambda: rule_env(c)), ("exec", lambda: rule_exec(c)),
             ("build_define", lambda: rule_build_define(c, macros)), ("cross_lang", lambda: rule_cross_lang(c, macros)),
             ("custom", lambda: rule_custom(c))]
    for name, fn in steps:
        if name not in disabled:
            fn()
    seen, uniq = set(), []
    for e in c.edges:
        k = (e["rule"], e["src"], e["dst"], e["file"], e["line"])
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    c.edges = uniq
    index["edges"] = index["edges"] + c.edges
    counts = {}
    for e in c.edges:
        counts[e["rule"]] = counts.get(e["rule"], 0) + 1
    index["stats"]["rule_edges"] = counts
    return index


def load_config(root):
    p = Path(root) / ".codemap" / "rules.json"
    return json.loads(p.read_text()) if p.exists() else {}
