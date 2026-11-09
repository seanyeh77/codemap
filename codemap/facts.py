"""Facts for the overview that the call graph does not hold: what the build
produces, which files the code writes, and places worth a look (where the
program stops, fixed-size global arrays, environment values used unchecked).

Everything here is read from the repository as it is; nothing is judged. A
name that is only known when the program runs is reported as such."""

import os
import re
import shlex
import subprocess
from pathlib import Path

from . import arch, state
from .source import code_lines, lines, walk

# ---- build products --------------------------------------------------------


def _make(root, *args, timeout=30):
    """`make -n` output with continuation lines joined; '' when there is no make or it fails."""
    if not (Path(root) / "Makefile").is_file() and not (Path(root) / "GNUmakefile").is_file():
        return ""
    try:
        r = subprocess.run(["make", "-C", str(root), "--no-print-directory", *args], capture_output=True,
                           text=True, timeout=timeout, env=dict(os.environ, LC_ALL="C"))
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return re.sub(r"\\\n\s*", " ", r.stdout)


def _database(root):
    """(default goal, {target: [prerequisites]}, phony targets) from `make -pq`."""
    text = _make(root, "-pq")
    goal, rules, phony, skip = None, {}, set(), False
    for ln in text.splitlines():
        if ln.startswith("# Not a target"):
            skip = True
            continue
        m = re.match(r"\.DEFAULT_GOAL\s*:?=\s*(\S+)", ln)
        if m:
            goal = m.group(1)
            continue
        if not ln or ln.startswith(("#", "\t", " ")):
            if not ln:
                skip = False
            continue
        m = re.match(r"^([^:=#\s][^:=#]*?):(?!=)\s*(.*)$", ln)
        if m and not skip:
            deps = m.group(2).split("|")[0].split()
            for t in m.group(1).split():
                if t == ".PHONY":
                    phony |= set(deps)
                elif not t.startswith(".") and "%" not in t:
                    rules.setdefault(t, deps)
    return goal, rules, phony


def _tokens(cmd):
    try:
        return shlex.split(cmd)
    except ValueError:
        return cmd.split()


def _commands(root, goal):
    """The commands `make -nB goal` would run, split into words."""
    return [_tokens(c) for c in _make(root, "-nB", goal).splitlines() if c.strip()]


def _made_by(cmd):
    """(product, kind) a command writes, or None."""
    if not cmd:
        return None
    tool = Path(cmd[0]).name
    if tool in ("ar", "llvm-ar", "gcc-ar") and len(cmd) > 2:
        return cmd[2], "static"
    if "-c" in cmd or "-E" in cmd or "-S" in cmd:
        return None
    if "-o" in cmd and re.search(r"(cc|gcc|clang|g\+\+|c\+\+|ld|mpicc|mpicxx)(-[\d.]+)?$", tool):
        out = cmd[cmd.index("-o") + 1]
        return out, "shared" if "-shared" in cmd else "exec"
    if ">" in cmd and cmd.index(">") + 1 < len(cmd):
        return cmd[cmd.index(">") + 1], "generated"
    return None


def products(root, config=None):
    """{goal, built: [{name, path, kind, goal, comps, files, libs, exports, uses}], install: [...]}
    or None when the repository has no Makefile make can read."""
    root = Path(root)
    config = config or {}
    default, rules, phony = _database(root)
    if not default:
        return None
    goals = [default] + sorted(t for t in phony if t != default and t not in ("clean", "help", "install", "uninstall",
                                                                          "distclean", "mostlyclean"))
    built, seen = [], set()
    for goal in goals:
        cmds = _commands(root, goal)
        objs = {}                                    # object file -> its source
        for c in cmds:
            if "-c" in c and "-o" in c:
                src = [w for w in c if re.search(r"\.(c|cc|cpp|cxx|S|s)$", w)]
                if src:
                    objs[c[c.index("-o") + 1]] = src[-1]
        for c in cmds:
            made = _made_by(c)
            if not made or made[0] in seen:
                continue
            path, kind = made
            seen.add(path)
            files, uses, libs, exports = set(), [], [], []
            for w in c[1:]:
                if w == path:
                    continue
                if w.startswith("-l"):
                    libs.append(w[2:])
                elif "--version-script=" in w:
                    exports.append(w.split("--version-script=", 1)[1])
                elif w in objs:
                    files.add(objs[w])
                elif re.search(r"\.(c|cc|cpp|cxx)$", w):
                    files.add(w)
                elif re.search(r"\.(a|so)$", w) or w in seen:
                    uses.append(w)
                elif kind == "generated" and (root / w).is_file():
                    files.add(w)
            comps = sorted({arch.component(f, config) for f in files if not f.startswith("/")})
            built.append(dict(name=Path(path).name, path=path, kind=kind, goal=goal, comps=comps,
                              files=sorted(files), libs=libs, exports=exports, uses=uses))
    return dict(goal=default, built=built, install=install(root) if "install" in rules else [])


def install(root):
    """[{what: [paths], to, link?}] from `make -n install`: copies and symbolic links."""
    out = []
    for c in (_tokens(x) for x in _make(root, "-n", "install").splitlines()):
        if not c:
            continue
        tool = Path(c[0]).name
        if tool == "install" and "-d" not in c and "-D" not in c:
            args, skip = [], False
            for w in c[1:]:
                if skip:
                    skip = False
                elif w in ("-m", "-o", "-g", "-t", "--mode", "--owner", "--group"):
                    skip = True
                elif not w.startswith("-"):
                    args.append(w)
            if len(args) >= 2:
                out.append(dict(what=args[:-1], to=args[-1]))
        elif tool == "ln" and any(w.startswith("-") and "s" in w for w in c[1:]):
            args = [w for w in c[1:] if not w.startswith("-")]
            if len(args) == 2:
                out.append(dict(what=[args[0]], to=args[1], link=True))
        elif tool == "cp":
            args = [w for w in c[1:] if not w.startswith("-")]
            if len(args) >= 2:
                out.append(dict(what=args[:-1], to=args[-1]))
    return out


# ---- Python tools ----------------------------------------------------------

PY_TEST = re.compile(r"(^|/)(tests?|testing|docs?|examples?)(/|$)|(^|/)test_[^/]*\.py$|_test\.py$")   # tests, and scripts kept with the docs
DOCSTRING = re.compile(r'^\s*(?:#[^\n]*\n|\s)*[rRbBuU]?("""|\'\'\')\s*(.*?)(?:\1|\n)', re.S)


def scripts(root, index, config, built, shared=()):
    """Python tools of the repository, as components next to the C ones: [{id, files, docs}] and the
    lines from them: runs (a file that starts a program by subprocess and names a product the
    Makefile builds) and reads (it parses a C header for its definitions). Tests are left out."""
    root = Path(root)
    files = [str(p.relative_to(root)) for p in walk(root, {".py"})]
    files = [f for f in files if not PY_TEST.search(f)]
    if not files:
        return [], []
    by_comp = {}
    for f in files:
        by_comp.setdefault(arch.component(f, config), []).append(f)
    nodes = index.get("nodes", {})
    execs = {}
    for e in index.get("edges", []):
        if e.get("rule") == "exec" and e["file"].endswith(".py"):
            execs.setdefault(e["file"], []).append(e)
    products = {}
    for b in (built or {}).get("built", []):
        products.setdefault(b["name"], set()).update(c for c in b["comps"] if c not in shared)   # its own code, not the library it links
    comps, links = [], {}
    for cid, fs in sorted(by_comp.items()):
        docs = {}
        for f in fs:
            m = DOCSTRING.match(lines_text(root / f))
            if m and m.group(2).strip():
                docs[f] = m.group(2).strip().splitlines()[0][:160]
        comps.append(dict(id=cid, files=len(fs), funcs=0, shared=False, layer=None, callers=0, lang="python",
                          scripts=sorted(fs), docs=docs))
        for f in fs:
            src = lines_text(root / f).splitlines()
            for e in execs.get(f, []):
                # the strings the call's arguments are built from: the call itself, and what the names in it
                # were assigned (cmd = [ibmon_path(d), ...]; def ibmon_path: ... / "ibmon")
                near = " ".join(arg_strings(src, e["line"]))
                for name, targets in products.items():
                    if not re.search(r"(?<![\w.-])" + re.escape(name) + r"(?![\w-])", near):
                        continue
                    for t in targets:
                        k = (cid, t, "runs")
                        links.setdefault(k, dict(a=cid, b=t, n=0, kind="runs", names=set(), sites=[]))
                        links[k]["names"].add(name)
                        links[k]["sites"].append(dict(s=e["src"], f=e["file"], l=e["line"], name=nodes.get(e["dst"], {}).get("name", "subprocess")))
    for e in index.get("edges", []):
        if e.get("rule") != "cross_lang" or e["file"] not in files:
            continue
        cid = arch.component(e["file"], config)
        dst = nodes.get(e["dst"], {})
        target = dst.get("file") or dst.get("name", "")
        if target.startswith("#define "):
            continue
        b = arch.component(target, config)
        k = (cid, b, "reads")
        links.setdefault(k, dict(a=cid, b=b, n=0, kind="reads", names=set(), sites=[]))
        links[k]["names"].add(Path(target).name)
        links[k]["sites"].append(dict(s=e["src"], f=e["file"], l=e["line"], name=Path(target).name))
    out = []
    for l in links.values():
        uniq = {(s["f"], s["l"]): s for s in l["sites"]}
        out.append(dict(l, names=sorted(l["names"]), n=len(uniq), sites=sorted(uniq.values(), key=lambda s: (s["f"], s["l"]))))
    return comps, out


PY_WORDS = {"subprocess", "run", "Popen", "call", "check_call", "check_output", "os", "str", "list", "True", "False", "None",
            "capture_output", "text", "check", "timeout", "stdout", "stderr", "env", "cwd", "shell", "PIPE", "STDOUT", "Path"}


def statement(src, i):
    """The Python statement that starts on line i (1-based): through the line where its brackets close."""
    out, depth = [], 0
    for ln in src[i - 1:i + 15]:
        out.append(ln)
        code = re.sub(r"\"[^\"\n]*\"|\'[^\'\n]*\'|#.*", "", ln)
        depth += sum(code.count(c) for c in "([{") - sum(code.count(c) for c in ")]}")
        if depth <= 0:
            break
    return "\n".join(out)


def arg_strings(src, line, depth=3):
    """The string literals a call on this line is built from: in the call, then in every statement of
    the same function (or module level) that assigns a name it uses, then in the bodies of the
    functions it calls in this file, to depth levels."""
    indent = lambda ln: len(ln) - len(ln.lstrip())
    strs, seen, todo = [], set(), [(statement(src, line), line, 0)]
    while todo:
        text, at, d = todo.pop()
        strs += re.findall(r"\"[^\"\n]*\"|\'[^\'\n]*\'", text)
        if d >= depth:
            continue
        # the function the statement is in: from its def to the line before
        top = next((j for j in range(at - 1, 0, -1) if re.match(r"^\s*def\s", src[j - 1]) and indent(src[j - 1]) < indent(src[at - 1] or "x")), 1)
        for name in set(re.findall(r"\b([A-Za-z_]\w*)\b", re.sub(r"\"[^\"\n]*\"|\'[^\'\n]*\'", "", text))):
            if name in PY_WORDS or name in seen:
                continue
            seen.add(name)
            assign = re.compile(r"^\s*" + re.escape(name) + r"\s*(:[^=]*)?[+]?=[^=]")
            for j in range(1, len(src) + 1):
                ln = src[j - 1]
                if assign.match(ln) and (top <= j < at or not ln[:1].isspace()):
                    todo.append((statement(src, j), j, d + 1))
                elif re.match(r"^\s*def\s+" + re.escape(name) + r"\b", ln):
                    end = next((k for k in range(j + 1, len(src) + 1) if src[k - 1].strip() and indent(src[k - 1]) <= indent(ln)), len(src) + 1)
                    todo.append(("\n".join(src[j:end - 1]), j + 1, d + 1))
    return strs


def lines_text(path):
    try:
        return Path(path).read_text(errors="replace")
    except OSError:
        return ""


# ---- reading function bodies ---------------------------------------------


def _with_strings(code, raw):
    """Comment-free code lines with the text of string literals put back."""
    out = []
    for c, r in zip(code, raw + [""] * (len(code) - len(raw))):
        if len(c) != len(r):
            out.append(c)
            continue
        chars, quote = [], None
        for a, b in zip(c, r):
            if quote:
                chars.append(b)
                if a == quote:
                    quote = None
            else:
                chars.append(a)
                if a in "\"'":
                    quote = a
        out.append("".join(chars))
    return out


def _bodies(root, funcs):
    """(fid, function, text of its body, offset -> line) for each function, comments removed."""
    cache = {}
    for fid, f in sorted(funcs.items(), key=lambda x: (x[1]["file"], x[1]["line"])):
        if not f.get("end"):
            continue
        if f["file"] not in cache:
            cache[f["file"]] = _with_strings(code_lines(Path(root) / f["file"]), lines(Path(root) / f["file"]))
        body = cache[f["file"]][f["line"] - 1:f["end"]]
        starts, pos = [], 0
        for ln in body:
            starts.append(pos)
            pos += len(ln) + 1
        text = "\n".join(body)

        def at(off, starts=starts, first=f["line"]):
            lo, hi = 0, len(starts) - 1
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if starts[mid] <= off:
                    lo = mid
                else:
                    hi = mid - 1
            return first + lo
        yield fid, f, text, at


def _args(text, start):
    """The arguments of the call whose '(' is at text[start], and the offset after ')'."""
    depth, args, cur, i, quote = 0, [], [], start, None
    while i < len(text):
        ch = text[i]
        if quote:
            cur.append(ch)
            if ch == "\\":
                cur.append(text[i + 1:i + 2])
                i += 1
            elif ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            cur.append(ch)
        elif ch == "(":
            depth += 1
            if depth > 1:
                cur.append(ch)
        elif ch == ")":
            depth -= 1
            if depth == 0:
                args.append("".join(cur).strip())
                return args, i + 1
            cur.append(ch)
        elif ch == "," and depth == 1:
            args.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    return args, i


STRING = re.compile(r'^"((?:\\.|[^"\\])*)"$')
PARAMS = re.compile(r"\(([^)]*)\)\s*$")


def _params(root, f):
    head = " ".join(ln.strip() for ln in lines(Path(root) / f["file"])[f["line"] - 1:f["line"] + 4])
    m = re.search(re.escape(f["name"]) + r"\s*\(([^)]*)\)", head)
    return [re.findall(r"[A-Za-z_]\w*", p)[-1] for p in m.group(1).split(",") if re.findall(r"[A-Za-z_]\w*", p)] \
        if m else []


# ---- files the code writes ----------------------------------------------

WRITE_CALL = re.compile(r"(?<![\w.>])(fopen|fopen64|freopen|open|open64|openat|creat|creat64)\s*\(")


def _name_of(arg, text, before, params):
    """What a path argument holds: its text if it is a literal, the format it is built
    from if the function builds it with snprintf/sprintf/asprintf, else nothing."""
    m = STRING.match(arg)
    if m:
        return dict(name=m.group(1))
    var = re.fullmatch(r"[A-Za-z_]\w*", arg)
    if var:
        built = None
        for b in re.finditer(r"(?<!\w)(snprintf|sprintf|asprintf)\s*\(", text[:before]):
            a, _ = _args(text, b.end() - 1)
            dst = a[0].lstrip("&").strip() if a else ""
            fmt = next((x for x in a[1:] if STRING.match(x)), None)
            if dst == arg and fmt:
                built = STRING.match(fmt).group(1)
        if built:
            return dict(runtime=True, format=built)
        if arg in params:
            return dict(runtime=True, param=arg)
    return dict(runtime=True, expr=arg[:80])


def writes(root, funcs):
    """[{fid, f, l, call, name? | runtime, format?, param?}]: calls that create or write a file."""
    out = []
    for fid, f, text, at in _bodies(root, funcs):
        params = None
        for m in WRITE_CALL.finditer(text):
            call = m.group(1)
            args, _ = _args(text, m.end() - 1)
            if call in ("fopen", "fopen64", "freopen"):
                if len(args) < 2 or not STRING.match(args[1]) or not re.search(r"[wa+]", args[1]):
                    continue
                path = args[0]
            elif call.startswith("creat"):
                path = args[0] if args else ""
            else:
                flags = args[2] if call == "openat" and len(args) > 2 else args[1] if len(args) > 1 else ""
                if not re.search(r"\bO_(CREAT|WRONLY|RDWR|APPEND|TRUNC)\b", flags):
                    continue
                path = args[1] if call == "openat" else args[0]
            if params is None:
                params = _params(root, f)
            out.append(dict(fid=fid, f=f["file"], l=at(m.start()), call=call, **_name_of(path, text, m.start(), params)))
    return out


# ---- places worth a look -------------------------------------------------

STOPS = ("abort", "exit", "_exit", "_Exit", "quick_exit")


def stops(edges):
    """[{fid, f, l, name}]: calls that end the process, from the compiler's call graph."""
    return sorted(({"fid": e["s"], "f": e["f"], "l": e["l"], "name": e["dn"]} for e in edges
                   if e.get("src") == "compiler" and e.get("dn") in STOPS and e.get("ext")),
                  key=lambda x: (x["f"], x["l"]))


NUMBER = re.compile(r"^\(?\s*(0[xX][0-9a-fA-F]+|\d+)[uUlL]*\s*\)?$")


def _value(expr, macros, depth=0):
    """The number a size expression comes to, if it is made of numbers, macros and + - * / << >>."""
    if depth > 6:
        return None
    expr = expr.strip()
    m = NUMBER.match(expr)
    if m:
        return int(m.group(1), 0)
    words = set(re.findall(r"[A-Za-z_]\w*", expr))
    if not words:
        e = re.sub(r"(0[xX][0-9a-fA-F]+|\d+)[uUlL]+", r"\1", expr)
        if re.fullmatch(r"[\d\sxXa-fA-F+\-*/()<>]+", e):
            try:
                v = eval(e.replace("/", "//"), {"__builtins__": {}})      # numbers and operators only
                return v if isinstance(v, int) else None
            except Exception:
                return None
        return None
    for w in words:
        if w not in macros:
            return None
        v = _value(macros[w], macros, depth + 1)
        if v is None:
            return None
        expr = re.sub(r"\b" + w + r"\b", str(v), expr)
    return _value(expr, macros, depth + 1)


def arrays(root, files, symbols):
    """[{name, file, line, size, value?}]: file-scope arrays whose size is written in the code."""
    macros = {}
    for s in symbols:
        if s["kind"] == "macro" and "(" not in s["text"].split(" ")[0]:
            macros.setdefault(s["name"], s["text"].split(" ", 1)[1] if " " in s["text"] else "")
    out = []
    for file in sorted(files):
        if not file.endswith(".c"):
            continue
        raw = lines(Path(root) / file)
        code = [state.STRINGS.sub('""', ln) for ln in code_lines(Path(root) / file)]
        for i, name, static in state._file_scope(code):
            m = re.search(r"\b" + re.escape(name) + r"\s*((?:\[[^\]]*\]\s*)+)", code[i - 1])
            if not m:
                continue
            dims = re.findall(r"\[([^\]]*)\]", m.group(1))
            if not all(d.strip() for d in dims):
                continue                              # size taken from the initializer
            vals = [_value(d, macros) for d in dims]
            x = dict(name=name, file=file, line=i, size="".join(f"[{d.strip()}]" for d in dims),
                     text=raw[i - 1].strip()[:120])
            if all(v is not None for v in vals) and any(not NUMBER.match(d.strip()) for d in dims):
                x["value"] = " × ".join(str(v) for v in vals)
            out.append(x)
    return out


GETENV = re.compile(r"(?<![\w.>])(secure_getenv|getenv)\s*\(")


def _checked(var, text):
    return re.search(r"!\s*" + var + r"\b|\b" + var + r"\s*[!=]=|[!=]=\s*" + var + r"\b|\b" + var
                     + r"\s*(&&|\|\||\?)|(&&|\|\|)\s*" + var + r"\s*[)&|;]|\b(if|while)\s*\(\s*" + var + r"\s*\)", text)


def unchecked_env(root, funcs):
    """[{fid, f, l, use, name?}]: a getenv result used before any NULL check in the same function."""
    out = []
    for fid, f, text, at in _bodies(root, funcs):
        for m in GETENV.finditer(text):
            args, end = _args(text, m.end() - 1)
            name = STRING.match(args[0]).group(1) if args and STRING.match(args[0]) else None
            before = text[:m.start()].rstrip()
            after = text[end:].lstrip()
            assign = re.search(r"(?:^|[\s(*,;{}])([A-Za-z_]\w*)\s*=$", before)
            if assign and not before.endswith(("==", "!=", "<=", ">=")):
                var = assign.group(1)
                rest = text[end:]
                use = next((u for u in re.finditer(r"\b" + var + r"\b", rest)), None)
                if not use:
                    continue
                stmt_start = max(rest.rfind(";", 0, use.start()), rest.rfind("{", 0, use.start()),
                                 rest.rfind("}", 0, use.start())) + 1
                stmt_end = min([x for x in (rest.find(";", use.end()), rest.find("{", use.end())) if x >= 0] or [len(rest)])
                stmt = rest[stmt_start:stmt_end]
                if _checked(var, stmt) or re.fullmatch(r"\s*return\s*\(?\s*" + var + r"\s*\)?\s*", stmt) or re.search(r"\b" + var + r"\s*=[^=]", stmt):
                    continue
                out.append(dict(fid=fid, f=f["file"], l=at(m.start()), use=at(end + use.start()), name=name))
            else:
                if re.search(r"(!|==|!=|\breturn|\bif\s*\(|\bwhile\s*\(|&&|\|\||\?)\s*$", before) \
                        or re.match(r"(==|!=|&&|\|\||\?)", after):
                    continue
                out.append(dict(fid=fid, f=f["file"], l=at(m.start()), use=at(m.start()), name=name))
    return out


IF_UNSET = re.compile(r"\bif\s*\(\s*(?:!\s*(?:secure_)?getenv\s*\(\s*\"(\w+)\"\s*\)|(?:secure_)?getenv\s*\(\s*\"(\w+)\"\s*\)\s*==\s*(?:NULL|0))\s*\)")
SET_CALL = re.compile(r"\b(setenv|putenv)\s*\(")


def env_if_unset(root, funcs):
    """[{name, fid, f, l, check}]: an environment variable the code sets only when it is not set
    already: `if (getenv("X") == NULL) setenv("X", ...)`, or setenv with overwrite 0."""
    out = []
    for fid, f, text, at in _bodies(root, funcs):
        for m in IF_UNSET.finditer(text):
            name = m.group(1) or m.group(2)
            rest = text[m.end():]
            body = rest.lstrip()
            if body.startswith("{"):
                depth, i = 0, len(rest) - len(body)
                for j, ch in enumerate(rest[i:], i):
                    depth += {"{": 1, "}": -1}.get(ch, 0)
                    if depth == 0:
                        block, end = rest[:j + 1], j + 1
                        break
                else:
                    block, end = rest, len(rest)
            else:
                block = rest[:rest.find(";") + 1] if ";" in rest else rest
            for s in SET_CALL.finditer(block):
                args, _ = _args(text, m.end() + s.end() - 1)
                target = STRING.match(args[0]).group(1) if args and STRING.match(args[0]) else None
                if s.group(1) == "setenv" and target == name or s.group(1) == "putenv":
                    out.append(dict(name=name, fid=fid, f=f["file"], l=at(m.end() + s.start()), check=at(m.start())))
                    break
        for s in SET_CALL.finditer(text):
            args, _ = _args(text, s.end() - 1)
            if s.group(1) == "setenv" and len(args) == 3 and args[2].strip() == "0" and STRING.match(args[0]):
                out.append(dict(name=STRING.match(args[0]).group(1), fid=fid, f=f["file"], l=at(s.start()), check=at(s.start())))
    return out


ERRCODE = re.compile(r"\breturn\s+\(?\s*(-?\s*E[A-Z][A-Z0-9]+)\s*\)?\s*;|\berrno\s*=\s*(E[A-Z][A-Z0-9]+)\s*;")


def error_codes(root, funcs):
    """[{code, fid, f, l, how}]: functions that hand back a fixed error code (return ENOSYS,
    return -EINVAL, errno = EAGAIN)."""
    out = []
    for fid, f, text, at in _bodies(root, funcs):
        for m in ERRCODE.finditer(text):
            code = (m.group(1) or m.group(2)).replace(" ", "")
            out.append(dict(code=code, fid=fid, f=f["file"], l=at(m.start()), how="errno" if m.group(2) else "return"))
    return out


THREAD_LOCAL = re.compile(r"\b(__thread|_Thread_local|thread_local)\b")
CONST = re.compile(r"^\s*(static\s+)?const\b|\bconst\s+[A-Za-z_]\w*\s*\[|\*\s*const\b")


def plain_writes(root, funcs, files):
    """[{name, file, line, writes: [{fid, f, l, text}]}]: file-scope variables, not thread-local and
    not const, that a function changes with a plain store (x = ..., x++, x += ..., x[i] = ...)
    rather than an __atomic_*/atomic_* call. Whether two threads ever run those lines is not known."""
    root = Path(root)
    decls = {}
    for file in sorted(files):
        if not file.endswith(".c"):
            continue
        raw = lines(root / file)
        code = [state.STRINGS.sub('""', ln) for ln in code_lines(root / file)]
        for i, name, static in state._file_scope(code):
            if THREAD_LOCAL.search(code[i - 1]) or CONST.search(code[i - 1]) or re.search(r"_Atomic|\bsig_atomic_t\b|\batomic_\w+_t\b", code[i - 1]):
                continue
            decls.setdefault(name, dict(name=name, file=file, line=i, static=static, writes=[]))
    if not decls:
        return []
    names = "|".join(map(re.escape, sorted(decls, key=len, reverse=True)))
    store = re.compile(r"(?<![\w.>])(?:\+\+|--)\s*(" + names + r")\b|(?<![\w.>])(" + names + r")\s*(?:\[[^\]]*\]\s*)*"
                       r"(?:\+\+|--|(?:[-+*/%&|^]|<<|>>)?=(?!=))")
    for fid, f, text, at in _bodies(root, funcs):
        if not f["file"].endswith(".c"):
            continue
        for m in store.finditer(text):
            name = m.group(1) or m.group(2)
            d = decls[name]
            if d["static"] and d["file"] != f["file"]:
                continue                                  # another file's static of the same name
            start = text.rfind("\n", 0, m.start()) + 1
            end = text.find("\n", m.end())
            ln = text[start:end if end >= 0 else None].strip()
            if re.search(r"\b(__atomic_\w+|__sync_\w+|atomic_\w+)\s*\(", ln):
                continue
            d["writes"].append(dict(fid=fid, f=f["file"], l=at(m.start()), text=ln[:120]))
    return [d for d in sorted(decls.values(), key=lambda d: (d["file"], d["line"])) if d["writes"]]


def at_load(edges):
    """Functions the loader runs (constructor, destructor): their stores happen before or after the
    program's own threads, which the viewer says next to them."""
    return sorted({e["d"] for e in edges if e.get("k") in ("constructor", "destructor")})


def worth_checking(root, funcs, edges, files, symbols):
    return dict(stops=stops(edges), arrays=arrays(root, files, symbols), env=unchecked_env(root, funcs),
                env_if_unset=env_if_unset(root, funcs), errors=error_codes(root, funcs),
                plain_writes=plain_writes(root, funcs, files))


def macro_value(root, funcs, name):
    """The value a #define gives name, from the headers next to the indexed files and include/."""
    root = Path(root)
    dirs = {str(Path(f["file"]).parent) for f in funcs.values()} | {"include"}
    for d in sorted(dirs):
        for p in sorted((root / d).rglob("*.h")) if (root / d).is_dir() else []:
            m = re.search(r"^\s*#\s*define\s+" + re.escape(name) + r"\s+(.+?)\s*(?:/[*/].*)?$", lines_text(p), re.M)
            if m:
                return m.group(1)
    return None


def env_meaning(root, funcs, env, config=None):
    """name -> {kind, default, into, at, purpose?}: how the C code reads each environment variable.
    kind: flag (non-zero is on), number, text, or presence (only whether it is set);
    default: on, off, early-return, or the value written in the code, when it is unset;
    into: the variable the result is stored in. Read from the line of each read and, when the name
    goes through a helper (env_flag("X")), the helper's body. config["env"][name] {purpose, default}
    replaces what the code says."""
    root = Path(root)
    by_name = {}
    for fid, f in funcs.items():
        by_name.setdefault(f["name"], (fid, f))
    def body(f):
        return lines_text(root / f["file"]).splitlines()[f.get("top", f["line"]) - 1:f["end"]]
    def classify(text, var):
        """kind and default from the code that uses var (or the expression, when var is None)."""
        v = re.escape(var) if var else r"getenv\s*\([^)]*\)"
        kind = "number" if re.search(r"\b(atoi|atol|strtol|strtoul|strtoull|atof|strtod)\s*\(\s*" + v, text) else "text"
        default = None
        if re.search(v + r"\s*==\s*NULL\s*\|\|", text) or re.search(r"!\s*" + v + r"\s*\|\|", text):
            default = "on"
        elif re.search(v + r"\s*!=\s*NULL\s*&&", text) or re.search(r"\b" + v + r"\s*&&", text):
            default = "off"
        if default and kind == "number" and re.search(r"!=\s*0|\)\s*;", text):
            kind = "flag"
        m = re.search(v + r"\s*(?:!=\s*NULL\s*)?\?[^:;]+:\s*([^;)]+)", text)
        if m and not default:
            default = m.group(1).strip()
        if not default and re.search(r"if\s*\(\s*(!\s*" + v + r"|" + v + r"\s*==\s*NULL)\s*\)\s*\{?\s*return\b", text):
            default = "early-return"
        return kind, default
    out = {}
    for name, v in (env or {}).items():
        for ref in v.get("get", []):
            f, _, l = ref.rpartition(":")
            if not f.endswith((".c", ".h")) or not l.isdigit():
                continue
            src = lines_text(root / f).splitlines()
            line = src[int(l) - 1] if int(l) <= len(src) else ""
            m = re.search(r"([A-Za-z_]\w*)\s*\(\s*\"" + re.escape(name) + r"\"", line)
            if not m:
                continue
            call = m.group(1)
            lhs = re.search(r"([A-Za-z_][\w.>-]*)\s*=\s*" + re.escape(call) + r"\s*\(", line)
            into = lhs.group(1) if lhs else None
            if call == "getenv":
                if re.search(r"getenv\s*\([^)]*\)\s*(==|!=)\s*NULL", line) and not into:
                    info = dict(kind="presence", default=None)
                else:
                    owner = next((fn for fn in funcs.values() if fn["file"] == f and fn["line"] <= int(l) <= fn["end"]), None)
                    rest = "\n".join(src[int(l) - 1:owner["end"]] if owner else src[int(l) - 1:int(l) + 8])
                    kind, default = classify(rest, into)
                    info = dict(kind=kind, default=default)
            elif call in by_name:
                text = "\n".join(body(by_name[call][1]))
                var = re.search(r"([A-Za-z_]\w*)\s*=\s*getenv\s*\(", text)
                kind, default = classify(text, var.group(1) if var else None)
                info = dict(kind=kind, default=default, via=call)
            else:
                continue
            d = info.get("default")
            if d and re.fullmatch(r"[A-Z_][A-Z0-9_]*", d):        # a macro: its value too
                info["default"] = d + (f" ({val})" if (val := macro_value(root, funcs, d)) else "")
            out[name] = dict(info, into=into, at=ref)
            break
    for name, own in ((config or {}).get("env") or {}).items():
        if isinstance(own, dict):
            out.setdefault(name, {}).update({k: own[k] for k in ("purpose", "default") if own.get(k)}, own=True)
    return out
