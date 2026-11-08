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
from .source import code_lines, lines

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


def worth_checking(root, funcs, edges, files, symbols):
    return dict(stops=stops(edges), arrays=arrays(root, files, symbols), env=unchecked_env(root, funcs),
                env_if_unset=env_if_unset(root, funcs), errors=error_codes(root, funcs))
