"""Layer 2: relations the compiler cannot see, found by rules over the source text.

Each rule adds edges with source="rule" and the rule's name.  An endpoint that
is not a function (a Makefile line, a #define, a Python statement) is a "site"
node whose id is "file:line".

Rules:
  fnptr_assign   a function stored into a pointer: s.f = fn; p->f = fn; .f = fn,
  fnptr_pass     a function used as a value: an argument (pthread_create, a macro) or a table entry
  indirect       an __indirect_call whose called field matches a fnptr_assign
  ctor           __attribute__((constructor|destructor)): called by the loader
  env            setenv/putenv and getenv on the same name, C and Python, also through a wrapper
                 such as env_flag("NAME") that passes its argument to getenv
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
C_ENV_ARG = re.compile(r"\b(?:getenv|secure_getenv)\s*\(\s*[A-Za-z_]\w*\s*\)")
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


IDENT_RE = re.compile(r"(?<![\w.>])&?\s*([A-Za-z_]\w*)\b(?!\s*\()")
OPEN_CALL = re.compile(r"([A-Za-z_]\w*)\s*\($")
TABLE_RE = re.compile(r"([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*=\s*\{")


def rule_fnptr_pass(c):
    """A function used as a value without being called: passed to another call (pthread_create,
    sigaction, a macro such as STEAL(field, fn)) or listed in a table initializer. Something
    may call it through that pointer later; the compiler sees no call."""
    stored = {(e["file"], e["line"], e["dst"]) for e in c.edges if e["kind"] == "fnptr_assign"}
    for p in c.c_files:
        f = c.rel(p)
        code = code_lines(p)
        defs = {s for s, _ in c.funcs.by_file.get(f, [])}
        table, depth = None, 0
        for i, cl in enumerate(code, 1):
            if depth == 0:
                table = None
            if (m := TABLE_RE.search(cl)) and depth == 0:
                table = (m.group(1), i)
            if not cl.lstrip().startswith("#") and i not in defs:
                for m in IDENT_RE.finditer(cl):
                    name = m.group(1)
                    dst = c.fn(name, f)
                    if not dst or (f, i, dst) in stored or c.nodes[dst].get("file") == f and c.nodes[dst].get("line") == i:
                        continue
                    # the statement so far: a call's arguments often continue on the next lines
                    k, prev = i - 1, []
                    while k >= 1 and len(prev) < 6 and not code[k - 1].rstrip().endswith((";", "{", "}")) \
                            and not code[k - 1].lstrip().startswith("#"):
                        prev.insert(0, code[k - 1].strip())
                        k -= 1
                    before = " ".join(prev + [cl[:m.start()]])
                    # the innermost call still open before the name: its argument
                    opened, k = 0, len(before)
                    callee = None
                    while k > 0:
                        k -= 1
                        ch = before[k]
                        if ch == ")":
                            opened += 1
                        elif ch == "(":
                            if opened:
                                opened -= 1
                            else:
                                mm = OPEN_CALL.search(before[:k + 1])
                                callee = mm.group(1) if mm else None
                                break
                    src = c.where(f, i)
                    if src == dst:
                        continue                     # IBT_REAL(ibv_open_device) inside ibv_open_device names the real one
                    if callee and callee not in ("sizeof", "if", "while", "for", "switch", "return"):
                        c.add("fnptr_pass", "fnptr_pass", src, dst, f, i, slot=callee)
                        stored.add((f, i, dst))
                    elif table and depth > 0 or table and "{" in cl:
                        c.add("fnptr_pass", "fnptr_table", c.site(f, table[1], table[0]), dst, f, i, slot=table[0])
                        stored.add((f, i, dst))
            depth = max(0, depth + cl.count("{") - cl.count("}"))


STRUCT_RE = re.compile(r"\bstruct\s+([A-Za-z_]\w*)\s*\{")
FIELD_RE = re.compile(r"\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(|([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*;")
VAR_TYPE_RE = re.compile(r"\bstruct\s+([A-Za-z_]\w*)\s*(?:const\s*)?\**\s*(?:const\s+)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*[;=,)]")
INSTALL_RE = re.compile(r"(?:^|[;{(]|\bif\b|\belse\b)\s*((?:\*\s*)?[A-Za-z_][\w.\->\[\] ]*?)\s*(?<![=!<>+\-*/%&|^])=(?!=)\s*"
                        r"([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?:->|\.)\s*([A-Za-z_]\w*)\s*;")


def rule_table_install(c):
    """A function pointer copied out of a table entry into some other slot, as in
    `slot[i] = g_ops[op].wrapper;`. The functions it can install are the ones listed in that
    field of every table of the same struct type (found by rule_fnptr_pass)."""
    fields, var_type = {}, {}
    files = {c.rel(p): code_lines(p) for p in c.c_files}
    for f, code in files.items():
        text = "\n".join(code)
        for m in STRUCT_RE.finditer(text):
            depth, i = 1, m.end()
            while i < len(text) and depth:
                depth += {"{": 1, "}": -1}.get(text[i], 0)
                i += 1
            names = []
            for decl in text[m.end():i - 1].split(";"):
                fm = FIELD_RE.search(decl + ";")
                if fm:
                    names.append(fm.group(1) or fm.group(2))
            fields.setdefault(m.group(1), names)
        for i, cl in enumerate(code, 1):
            for m in VAR_TYPE_RE.finditer(cl):
                var_type[(f, m.group(2))] = m.group(1)
                var_type.setdefault((None, m.group(2)), m.group(1))
    # which function sits in which field of which table type
    in_field = {}
    for e in [e for e in c.edges if e["kind"] == "fnptr_table"]:
        table, f = c.nodes[e["src"]]["name"], e["file"]
        t = var_type.get((f, table)) or var_type.get((None, table))
        if not t or t not in fields:
            continue
        cl = files[f][e["line"] - 1]
        name = c.nodes[e["dst"]]["name"]
        dm = re.search(r"\.([A-Za-z_]\w*)\s*=\s*&?\s*" + re.escape(name) + r"\b", cl)
        if dm:
            field = dm.group(1)
        else:
            at = re.search(r"\b" + re.escape(name) + r"\b", cl)
            if not at:
                continue
            start = cl.rfind("{", 0, at.start())
            pos = cl[start + 1:at.start()].count(",") if start >= 0 else None
            if pos is None or pos >= len(fields[t]):
                continue
            field = fields[t][pos]
        in_field.setdefault((t, field), []).append((e["dst"], table))
    for f, code in files.items():
        for i, cl in enumerate(code, 1):
            for m in INSTALL_RE.finditer(cl):
                lhs, var, field = m.groups()
                if not re.search(r"\[|->|\.|^\*", lhs):
                    continue                          # a plain local variable, not a slot
                t = var_type.get((f, var)) or var_type.get((None, var))
                for dst, table in in_field.get((t, field), []):
                    c.add("table_install", "fnptr_assign", c.where(f, i), dst, f, i, slot=lhs.strip(), via=f"{var}.{field}",
                          table=table, key=slot_key(lhs))


def rule_param_call(c):
    """A function passed to another one that calls it through its parameter:
    `ibt_ring_open_placed(name, &made, numa_place, arg)` and, inside, `place(p, len, arg)`.
    The callee calls the passed function at that line; the compiler sees only a pointer call."""
    passed = [e for e in c.edges if e["kind"] == "fnptr_pass"]
    for e in passed:
        target = c.fn(e["slot"], e["file"])
        if not target or target == e["dst"]:
            continue
        tn = c.nodes[target]
        tf, tl = tn.get("file"), tn.get("line")
        if not tf or not tl or Path(tf).suffix not in C_EXT:
            continue
        # which argument the function was passed as
        code = code_lines(c.root / e["file"])
        text = " ".join(code[max(0, e["line"] - 6):e["line"] + 4])            # the call may open lines above
        m = None
        for m in re.finditer(r"\b" + re.escape(e["slot"]) + r"\s*\(", text):
            pass
        if not m:
            continue
        args, depth, cur = [], 0, ""
        for ch in text[m.end():]:
            if ch == "(":
                depth += 1
            elif ch == ")":
                if depth == 0:
                    break
                depth -= 1
            if ch == "," and depth == 0:
                args.append(cur); cur = ""
            else:
                cur += ch
        args.append(cur)
        name = c.nodes[e["dst"]]["name"]
        pos = next((i for i, a in enumerate(args) if re.search(r"(^|[^\w])&?\s*" + re.escape(name) + r"\s*$", a.strip())), None)
        if pos is None:
            continue
        # the parameter at that position, and where the body calls it
        tcode = code_lines(c.root / tf)
        head = " ".join(tcode[tl - 1:tl + 6])
        hm = re.search(re.escape(tn["name"]) + r"\s*\(", head)
        if not hm:
            continue
        params, depth, cur = [], 0, ""
        for ch in head[hm.end():]:
            if ch == "(":
                depth += 1
            elif ch == ")":
                if depth == 0:
                    break
                depth -= 1
            if ch == "," and depth == 0:
                params.append(cur); cur = ""
            else:
                cur += ch
        params.append(cur)
        if pos >= len(params):
            continue
        pm = re.search(r"\(\s*\*\s*([A-Za-z_]\w*)\s*\)", params[pos]) or re.search(r"([A-Za-z_]\w*)\s*$", params[pos].strip())
        if not pm:
            continue
        param = pm.group(1)
        end = c.funcs.enclosing_end(tf, tl) if hasattr(c.funcs, "enclosing_end") else None
        body = next((k for k in range(tl, min(len(tcode), tl + 12) + 1) if "{" in tcode[k - 1]), tl)   # past the parameter list
        for i in range(body, min(len(tcode), end or tl + 400) + 1):
            if re.search(r"(?<![\w.>])\(?\s*\*?\s*" + re.escape(param) + r"\s*\)?\s*\(", tcode[i - 1]):
                if c.funcs.enclosing(tf, i) != target:
                    break
                c.add("param_call", "indirect_candidate", target, e["dst"], tf, i, via=param)
                break


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
    # a wrapper that reads the variable named by its argument, env_flag("IBTRACE_X") -> getenv(name):
    # its calls with a literal name are reads too, attributed to the line of the call
    wrappers = set()
    for p in c.c_files:
        f = c.rel(p)
        for i, cl in enumerate(code_lines(p), 1):
            if C_ENV_ARG.search(cl) and (nid := c.funcs.enclosing(f, i)) and c.nodes.get(nid, {}).get("name"):
                wrappers.add(c.nodes[nid]["name"])
    if wrappers:
        call = re.compile(r"\b(" + "|".join(map(re.escape, sorted(wrappers))) + r")\s*\(\s*\"")
        for p in c.c_files:
            f = c.rel(p)
            raw_lines, code = lines(p), code_lines(p)
            for i, (raw, cl) in enumerate(zip(raw_lines, code), 1):
                for m in call.finditer(cl):
                    name = _literal_at(raw, cl, m)
                    if name:
                        getters.setdefault(name, []).append((f, i))
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
             ("fnptr_pass", lambda: rule_fnptr_pass(c)), ("table_install", lambda: rule_table_install(c)), ("param_call", lambda: rule_param_call(c)), ("ctor", lambda: rule_ctor(c)), ("env", lambda: rule_env(c)), ("exec", lambda: rule_exec(c)),
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
