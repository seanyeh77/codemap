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

WRITE_CALL = re.compile(r"(?<![\w.>])(fopen|fopen64|freopen|open|open64|openat|creat|creat64|shm_open)\s*\(")


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
    """[{fid, f, l, call, name? | runtime, format?, param?}]: calls that create or write a file, and
    POSIX shared memory objects created with shm_open(O_CREAT) (/dev/shm/ibtrace.<pid>).
    C and C++ by their calls and flags; Python, Go and JavaScript/TypeScript by theirs."""
    out = []
    for fid, f, text, at in _bodies(root, {k: v for k, v in funcs.items() if lang_of(v["file"]) == "c"}):
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
                # a shared memory object is made only with O_CREAT; opening one that exists writes nothing new
                if not re.search(r"\bO_CREAT\b" if call == "shm_open" else r"\bO_(CREAT|WRONLY|RDWR|APPEND|TRUNC)\b", flags):
                    continue
                path = args[1] if call == "openat" else args[0]
            if params is None:
                params = _params(root, f)
            out.append(dict(fid=fid, f=f["file"], l=at(m.start()), call=call, **_name_of(path, text, m.start(), params)))
    out += py_writes(root, funcs)
    out += _text_writes(root, funcs)
    return sorted(out, key=lambda w: (w["f"], w["l"]))


# file extension -> the language a check reads; JavaScript goes with TypeScript (one analyzer)
LANGS = {".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".cxx": "c", ".hpp": "c", ".hh": "c", ".py": "python",
         ".go": "go", ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
         ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript", ".cjs": "typescript"}


def lang_of(path):
    return LANGS.get(Path(path).suffix.lower())


def _innermost(funcs_in_file, line):
    """The function (id) whose definition encloses line, the innermost one."""
    best = None
    for fid, f in funcs_in_file:
        if f["line"] <= line <= (f.get("end") or f["line"]) and (best is None or f["line"] >= best[1]["line"]):
            best = (fid, f)
    return best[0] if best else None


PY_WRITE_MODE = re.compile(r"[wax+]")
PY_OS_FLAGS = re.compile(r"\bO_(CREAT|WRONLY|RDWR|APPEND|TRUNC)\b")


def _py_path(node, params):
    """What a Python path expression holds: a literal name, an f-string format, a parameter, else its text."""
    import ast
    while isinstance(node, ast.Call) and isinstance(node.func, (ast.Name, ast.Attribute)) \
            and ast.unparse(node.func) in ("str", "os.fspath", "Path", "pathlib.Path") and len(node.args) == 1:
        node = node.args[0]                                     # str(path), Path(name): the same file
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return dict(name=node.value)
    if isinstance(node, ast.JoinedStr):
        return dict(runtime=True, format="".join(v.value if isinstance(v, ast.Constant) else "{" + ast.unparse(v.value) + "}"
                                                for v in node.values))
    if isinstance(node, ast.Name) and node.id in params:
        return dict(runtime=True, param=node.id)
    return dict(runtime=True, expr=ast.unparse(node)[:80])


def py_writes(root, funcs):
    """Python: open() or Path.open() in a writing mode, Path.write_text/write_bytes, os.open with a
    creating or writing flag, and the target of os.replace/os.rename and shutil.copy/move."""
    import ast
    by_file = {}
    for fid, f in funcs.items():
        if lang_of(f["file"]) == "python" and f.get("end"):
            by_file.setdefault(f["file"], []).append((fid, f))
    out = []
    for file, fs in sorted(by_file.items()):
        try:
            tree = ast.parse(lines_text(Path(root) / file))
        except (SyntaxError, ValueError, OSError):
            continue
        for n in ast.walk(tree):
            if not isinstance(n, ast.Call):
                continue
            fn, args = n.func, n.args
            kw = {k.arg: k.value for k in n.keywords if k.arg}
            dotted = ast.unparse(fn)
            mode = None
            path = call = None
            if isinstance(fn, ast.Name) and fn.id == "open" or dotted in ("io.open", "codecs.open"):
                mode, path, call = (args[1] if len(args) > 1 else kw.get("mode")), (args[0] if args else kw.get("file")), dotted
            elif isinstance(fn, ast.Attribute) and fn.attr == "open" and dotted != "os.open" and not dotted.endswith(("gzip.open", "tarfile.open", "zipfile.open")):
                mode, path, call = (args[0] if args else kw.get("mode")), fn.value, "open"
            elif isinstance(fn, ast.Attribute) and fn.attr in ("write_text", "write_bytes"):
                path, call = fn.value, fn.attr
            elif dotted == "os.open":
                flags = ast.unparse(args[1]) if len(args) > 1 else ""
                if not PY_OS_FLAGS.search(flags):
                    continue
                path, call = (args[0] if args else None), "os.open"
            elif dotted in ("os.replace", "os.rename", "shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.move"):
                path, call = (args[1] if len(args) > 1 else kw.get("dst")), dotted
            else:
                continue
            if call in ("open", "io.open", "codecs.open") or call.endswith(".open") and call != "os.open":
                if not (isinstance(mode, ast.Constant) and isinstance(mode.value, str) and PY_WRITE_MODE.search(mode.value)):
                    continue                                        # read mode, or a mode only known at run time
            fid = _innermost(fs, n.lineno)
            if path is None or fid is None:
                continue
            f = funcs[fid]
            params = {a.arg for a in getattr(_def_node(tree, f), "args", ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], defaults=[])).args}
            out.append(dict(fid=fid, f=file, l=n.lineno, call=call, **_py_path(path, params)))
    return out


def py_reads(root, funcs):
    """Python: open() or Path.open() in a reading mode (no mode is reading), and Path.read_text/read_bytes.
    The same shape as py_writes: [{fid, f, l, call, name? | param? | expr?}]."""
    import ast
    by_file = {}
    for fid, f in funcs.items():
        if lang_of(f["file"]) == "python" and f.get("end"):
            by_file.setdefault(f["file"], []).append((fid, f))
    out = []
    for file, fs in sorted(by_file.items()):
        try:
            tree = ast.parse(lines_text(Path(root) / file))
        except (SyntaxError, ValueError, OSError):
            continue
        for n in ast.walk(tree):
            if not isinstance(n, ast.Call):
                continue
            fn, args = n.func, n.args
            kw = {k.arg: k.value for k in n.keywords if k.arg}
            dotted = ast.unparse(fn)
            if isinstance(fn, ast.Name) and fn.id == "open" or dotted in ("io.open", "codecs.open"):
                mode, path, call = (args[1] if len(args) > 1 else kw.get("mode")), (args[0] if args else kw.get("file")), dotted
            elif isinstance(fn, ast.Attribute) and fn.attr == "open" and dotted not in ("os.open", "webbrowser.open") and not dotted.endswith(("gzip.open", "tarfile.open", "zipfile.open")):
                mode, path, call = (args[0] if args else kw.get("mode")), fn.value, "open"
            elif isinstance(fn, ast.Attribute) and fn.attr in ("read_text", "read_bytes"):
                mode, path, call = None, fn.value, fn.attr
            else:
                continue
            if call not in ("read_text", "read_bytes"):
                if mode is not None and not (isinstance(mode, ast.Constant) and isinstance(mode.value, str) and not PY_WRITE_MODE.search(mode.value)):
                    continue                                        # a writing mode, or one only known at run time
            fid = _innermost(fs, n.lineno)
            if path is None or fid is None:
                continue
            f = funcs[fid]
            params = {a.arg for a in getattr(_def_node(tree, f), "args", ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], defaults=[])).args}
            out.append(dict(fid=fid, f=file, l=n.lineno, call=call, **_py_path(path, params)))
    return out


def _def_node(tree, f):
    import ast
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno <= f["line"] <= n.lineno + len(n.decorator_list) \
                and n.name == f["name"].rsplit(".", 1)[-1]:
            return n
    return None


GO_WRITE = re.compile(r"\b(os\.Create|os\.WriteFile|ioutil\.WriteFile|os\.OpenFile)\s*\(")
TS_WRITE = re.compile(r"(?<![\w$])((?:fs|fsp|fs\.promises)\.(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|renameSync|rename))\s*\(")


def _text_writes(root, funcs):
    """Go: os.Create, os.WriteFile, os.OpenFile with a creating or writing flag. JavaScript and
    TypeScript: fs.writeFile, appendFile, createWriteStream, and the target of copyFile and rename."""
    out = []
    for lang, rx in (("go", GO_WRITE), ("typescript", TS_WRITE)):
        for fid, f, text, at in _bodies(root, {k: v for k, v in funcs.items() if lang_of(v["file"]) == lang}):
            for m in rx.finditer(text):
                call = m.group(1)
                args, _ = _args(text, m.end() - 1)
                if call == "os.OpenFile" and not (len(args) > 1 and re.search(r"\bO_(CREATE|WRONLY|RDWR|APPEND|TRUNC)\b", args[1])):
                    continue
                path = args[1] if call.rsplit(".", 1)[-1].startswith(("copyFile", "rename")) and len(args) > 1 else args[0] if args else ""
                lit = re.fullmatch(r"([\"'`])((?:\\.|(?!\1).)*)\1", path)
                info = dict(name=lit.group(2)) if lit and not (lit.group(1) == "`" and "${" in lit.group(2)) \
                    else dict(runtime=True, format=lit.group(2)) if lit else dict(runtime=True, expr=path[:80])
                out.append(dict(fid=fid, f=f["file"], l=at(m.start()), call=call, **info))
    return out


# ---- places worth a look -------------------------------------------------

STOPS = ("abort", "exit", "_exit", "_Exit", "quick_exit")
# the same in the languages the static analyzers read: calls to the library that ends the process
STATIC_STOPS = {"python": ("sys.exit", "os._exit", "os.abort"),
                "go": ("os.Exit", "log.Fatal", "log.Fatalf", "log.Fatalln"),
                "typescript": ("process.exit", "process.abort")}


def stops(edges):
    """[{fid, f, l, name}]: calls that end the process, from the compiler's call graph, and for
    Python, Go and JavaScript/TypeScript from the analyzers' calls into the standard library."""
    static = {n for names in STATIC_STOPS.values() for n in names}
    return sorted(({"fid": e["s"], "f": e["f"], "l": e["l"], "name": e["dn"]} for e in edges
                   if e.get("src") == "compiler" and e.get("dn") in STOPS and e.get("ext")
                   or e.get("src") == "static" and e.get("k", "call") == "call" and str(e.get("d", "")).startswith("ext:")
                   and e.get("dn") in static),
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
                end = len(block)
            # when it is set already: an else branch that prints says so, otherwise nothing is said
            after = rest[end:].lstrip()
            els = re.match(r"else\b\s*(\{[^{}]*\}|[^;]*;)", after)
            says = bool(els and SAYS.search(els.group(1)))
            for s in SET_CALL.finditer(block):
                args, _ = _args(text, m.end() + s.end() - 1)
                target = STRING.match(args[0]).group(1) if args and STRING.match(args[0]) else None
                if s.group(1) == "setenv" and target == name or s.group(1) == "putenv":
                    out.append(dict(name=name, fid=fid, f=f["file"], l=at(m.end() + s.start()), check=at(m.start()), says=says))
                    break
        for s in SET_CALL.finditer(text):
            args, _ = _args(text, s.end() - 1)
            if s.group(1) == "setenv" and len(args) == 3 and args[2].strip() == "0" and STRING.match(args[0]):
                out.append(dict(name=STRING.match(args[0]).group(1), fid=fid, f=f["file"], l=at(s.start()), check=at(s.start()), says=False))
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


# what creates something that outlives the process, and what removes it
REMOVE = {"shm_open": "shm_unlink", "sem_open": "sem_unlink", "mq_open": "mq_unlink", "mkfifo": "unlink"}
CREATE_CALL = re.compile(r"(?<![\w.>])(shm_open|sem_open|mq_open|mkfifo)\s*\(")


def leftovers(root, funcs, edges):
    """Objects that stay after the process ends unless someone removes them: a shared memory
    segment, a named semaphore or queue made with O_CREAT, a FIFO. For each: who removes it
    (shm_unlink in ibt_ring_unlink, reached from ibmon_reader_close), and the calls that end the
    program in the components that create it, which skip the removal if they come before it.
    -> [{fid, f, l, call, remove, removed: [{fid, f, l, via: [fid]}], stops: [{fid, f, l, name}]}]"""
    out = []
    callers = {}
    for e in edges:
        if e.get("src", "compiler") == "compiler" and e.get("s") in funcs and e.get("d") in funcs:
            callers.setdefault(e["d"], set()).add(e["s"])
    for fid, f, text, at in _bodies(Path(root), funcs):
        for m in CREATE_CALL.finditer(text):
            call = m.group(1)
            args, _ = _args(text, m.end() - 1)
            if call != "mkfifo" and not (len(args) > 1 and re.search(r"\bO_CREAT\b", args[1])):
                continue
            rm = REMOVE[call]
            removed = [dict(fid=e["s"], f=e["f"], l=e["l"], via=sorted(callers.get(e["s"], ())))
                       for e in edges if e.get("src", "compiler") == "compiler" and e.get("dn") == rm and e.get("s") in funcs]
            # the components that make it: this function's, and those of its callers up to two levels
            up = {fid} | callers.get(fid, set())
            up |= {c for x in list(up) for c in callers.get(x, ())}
            comps = {funcs[x]["comp"] for x in up if x in funcs}
            ends = [s for s in stops(edges) if funcs.get(s["fid"], {}).get("comp") in comps]
            out.append(dict(fid=fid, f=f["file"], l=at(m.start()), call=call, remove=rm,
                            removed=sorted(removed, key=lambda r: (r["f"], r["l"])), stops=ends))
    return out


# the languages each check reads: where a repository has none of them, the check found nothing
# because it did not look, and the viewer says so instead of "none found"
COVERS = dict(writes=("c", "python", "go", "typescript"), stops=("c", "python", "go", "typescript"), broad=("python",),
              arrays=("c",), env=("c",), env_if_unset=("c", "python"), errors=("c",), plain_writes=("c",),
              limits=("c",), loss=("c",), leftovers=("c",))


def worth_checking(root, funcs, edges, files, symbols):
    c_funcs = {k: v for k, v in funcs.items() if lang_of(v["file"]) == "c"}
    return dict(stops=stops(edges), arrays=arrays(root, files, symbols), env=unchecked_env(root, c_funcs),
                env_if_unset=env_if_unset(root, c_funcs) + py_env_if_unset(root, funcs), errors=error_codes(root, c_funcs),
                plain_writes=plain_writes(root, funcs, files), limits=silent_limits(root, c_funcs),
                loss=data_loss(root, c_funcs, edges), leftovers=leftovers(root, c_funcs, edges),
                broad=broad_excepts(root, funcs), covers={k: list(v) for k, v in COVERS.items()})


def py_env_if_unset(root, funcs):
    """Python: os.environ.setdefault("X", ...) sets X only when it is not set already."""
    out = []
    for fid, f, text, at in _bodies(root, {k: v for k, v in funcs.items() if lang_of(v["file"]) == "python"}):
        for m in re.finditer(r"os\.environ\.setdefault\(\s*['\"](\w+)['\"]", text):
            out.append(dict(name=m.group(1), fid=fid, f=f["file"], l=at(m.start()), check=at(m.start()), says=False,
                            how="setdefault"))
    return out


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
    # what the project's comments say: the sentence that names the variable, best first
    # the indexed files, the headers next to them (trace.h has no function but documents the switches), and include/
    dirs = {Path(f["file"]).parent for f in funcs.values()}
    files = sorted({f["file"] for f in funcs.values()}
                   | {str(p.relative_to(root)) for d in dirs if (root / d).is_dir() for p in (root / d).glob("*.h")}
                   | {str(p.relative_to(root)) for p in (root / "include").rglob("*.h")} if (root / "include").is_dir() else set())
    for name, cs in env_comments(root, files, set(out) | set(env or {})).items():
        if cs:
            out.setdefault(name, {})["comments"] = cs[:3]
    for name, own in ((config or {}).get("env") or {}).items():
        if isinstance(own, dict):
            out.setdefault(name, {}).update({k: own[k] for k in ("purpose", "default") if own.get(k)}, own=True)
    return out


# ---- limits reached without a word ----------------------------------------------------------

NOT_LIMITS = {"NULL", "MAP_FAILED", "EOF", "SIG_ERR", "SEM_FAILED", "INVALID", "TRUE", "FALSE"}
SAYS = re.compile(r"\b\w*(print|puts|perror|syslog|warn|log|err|abort|assert|die|fail)\w*\s*\(", re.I)


def balanced(text, i, open_, close):
    """The index after the bracket that closes the one at text[i]."""
    depth = 0
    for j in range(i, len(text)):
        if text[j] == open_:
            depth += 1
        elif text[j] == close:
            depth -= 1
            if depth == 0:
                return j + 1
    return len(text)


def silent_limits(root, funcs):
    """Where a function gives up on reaching a fixed limit without saying so: an `if` comparing a
    count with an UPPER_CASE constant (g_nhooks >= IBT_MAX_CTX) whose body returns and prints
    nothing. The ones that do print are counted too, for contrast.
    -> {silent: [{fid, f, l, cond, limit}], said: [the same]}"""
    root = Path(root)
    out = dict(silent=[], said=[])
    for fid, f in sorted(funcs.items(), key=lambda kv: (kv[1]["file"], kv[1]["line"])):
        if not f["file"].endswith((".c", ".h")):
            continue
        src = lines_text(root / f["file"]).splitlines()
        text = "\n".join(src[f["line"] - 1:f["end"]])
        text = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
        text = re.sub(r"//[^\n]*", "", text)
        for m in re.finditer(r"\bif\s*\(", text):
            start = m.end() - 1
            end = balanced(text, start, "(", ")")
            cond = text[start + 1:end - 1]
            # a capacity: a count reaching a MAX_ / _MAX / LIMIT constant (g_nhooks >= IBT_MAX_CTX)
            lim = next((x for x in re.findall(r"(?:>=|==)\s*\(?\s*([A-Z][A-Z0-9_]{2,})\b", cond)
                        if x not in NOT_LIMITS and re.search(r"(^|_)(MAX|LIMIT|CAP)(_|$)", x)), None)
            if not lim:
                continue
            rest = text[end:].lstrip()
            body = rest[:balanced(rest, 0, "{", "}")] if rest.startswith("{") else rest.split(";", 1)[0] + ";"
            if not re.search(r"\breturn\b", body):
                continue
            hit = dict(fid=fid, f=f["file"], l=f["line"] + text[:m.start()].count("\n"),
                       cond=" ".join(cond.split()), limit=lim)
            out["said" if SAYS.search(body) else "silent"].append(hit)
    return out


# ---- calls the build leaves out ---------------------------------------------------------------

def uncompiled_calls(root, funcs, edges):
    """Calls written inside #if/#ifdef blocks that the compiler did not record: code the current
    build leaves out (reader.c:140 under #ifdef IBMON_FAULT_LEGACY_DRAIN). A plain text match for
    the names of indexed functions, so a call through a macro can show up too.
    -> {function id: [{f, l, cond, by}]}"""
    root = Path(root)
    ids = {}
    for fid, f in funcs.items():
        ids.setdefault(f["name"], []).append(fid)
    if not ids:
        return {}
    seen = {(e.get("f"), e.get("l"), e["d"]) for e in edges}
    pat = re.compile(r"\b(" + "|".join(sorted(map(re.escape, ids), key=len, reverse=True)) + r")\s*\(")
    files = sorted({f["file"] for f in funcs.values() if f["file"].endswith((".c", ".h"))})
    out = {}
    for rel in files:
        src = lines_text(root / rel).splitlines()
        stack, in_comment = [], False
        owner = sorted((f for f in funcs.values() if f["file"] == rel), key=lambda f: f["line"])
        for n, ln in enumerate(src, 1):
            code = ln
            if in_comment:
                if "*/" not in code:
                    continue
                code, in_comment = code.split("*/", 1)[1], False
            code = re.sub(r"/\*.*?\*/", " ", code)
            if "/*" in code:
                code, in_comment = code.split("/*", 1)[0], True
            code = re.sub(r"//.*", "", code)
            d = re.match(r"\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)", code)
            if d:
                kind, arg = d.group(1), " ".join(d.group(2).split())
                if kind in ("if", "ifdef", "ifndef"):
                    # include guards (#ifndef X_H) cover the whole header: not a condition on code
                    stack.append(None if kind == "ifndef" and re.fullmatch(r"\w+_H_?", arg) else f"#{kind} {arg}")
                elif kind in ("elif", "else") and stack and stack[-1]:
                    stack[-1] = f"#{kind} {arg}".strip() + f"（{stack[-1]}）"
                elif kind == "endif" and stack:
                    stack.pop()
                continue
            cond = next((c for c in reversed(stack) if c), None)
            if not cond:
                continue
            code = re.sub(r"\"(\\.|[^\"\\])*\"", "\"\"", code)
            for m in pat.finditer(code):
                if not ln[:1].isspace() and not ln.rstrip().endswith(";"):
                    continue                    # the line defines the name (a second definition under #ifdef)
                by = next((f["name"] for f in reversed(owner) if f["line"] <= n <= f["end"]), None)
                if by is None:
                    # a function the build leaves out entirely: the nearest definition above
                    head = next((re.search(r"\b(\w+)\s*\(", src[k]) for k in range(n - 2, -1, -1)
                                 if re.match(r"[A-Za-z_][^;]*\b\w+\s*\([^;]*$", src[k]) and not src[k].lstrip().startswith("#")), None)
                    if head is None:
                        continue
                    by = head.group(1)
                for fid in ids[m.group(1)]:
                    if (rel, n, fid) not in seen and funcs[fid]["line"] != n:
                        out.setdefault(fid, []).append(dict(f=rel, l=n, cond=cond, by=by))
    return out


# ---- what the project's comments say about an environment variable ---------------------------------

def comment_blocks(text):
    """(first line, joined text, raw text) of every comment block: /* ... */ and runs of // lines."""
    out = []
    for m in re.finditer(r"/\*.*?\*/|(?://[^\n]*\n?)+", text, re.S):
        body = m.group(0)
        body = re.sub(r"^/\*+|\*+/$", "", body.strip())
        body = re.sub(r"(?m)^\s*(\*|//+)\s?", "", body)
        out.append((text.count("\n", 0, m.start()) + 1, " ".join(body.split()), m.group(0)))
    return out


def env_comments(root, files, names):
    """name -> [{text, at, defines}]: the sentence of each comment that mentions an environment
    variable, from the C and header files; defines is true for one that starts by naming it
    (`IBTRACE_ALL_POLLS=1: record the empty calls one by one`), which says best what it is for."""
    root = Path(root)
    out = {n: [] for n in names}
    if not names:
        return out
    pat = re.compile(r"\b(" + "|".join(map(re.escape, sorted(names, key=len, reverse=True))) + r")\b")
    for rel in sorted(files):
        if not rel.endswith((".c", ".h")):
            continue
        for line, body, raw in comment_blocks(lines_text(root / rel)):
            seen = {}
            # sentences end at . ! ? before a capital or a parenthesis: not inside ./ibmon or /ibtrace.<pid>
            ends = [x.end() for x in re.finditer(r"[.!?](?=\s+[A-Z(])", body)]
            for m in pat.finditer(body):
                name = m.group(1)
                a = max([e for e in ends if e <= m.start()], default=0)
                b = min([e for e in ends if e > m.end()], default=len(body))
                sentence = body[a:b].strip()
                if len(sentence) > 260:
                    sentence = sentence[:257].rstrip() + "..."
                # IBTRACE_ALL_POLLS=1: record the empty calls... (an example such as LD_PRELOAD=./other.so is not)
                defines = bool(re.match(re.escape(name) + r"(=\S+)?(:\s+|\s+[a-z])", sentence)) and len(sentence) >= 25
                # the line the name is on, not the first line of the block: trace.h:73, not :66
                k = seen[name] = seen.get(name, -1) + 1
                hits = [x.start() for x in re.finditer(r"\b" + re.escape(name) + r"\b", raw)]
                own = line + raw.count("\n", 0, hits[k]) if k < len(hits) else line
                out[name].append(dict(text=sentence, at=f"{rel}:{own}", defines=defines))
    for name in out:
        out[name].sort(key=lambda c: (not c["defines"], not c["at"].split(":")[0].endswith(".h"), c["at"]))
    return out


def uncompiled_funcs(root, funcs):
    """Function definitions inside #if/#ifdef blocks that the build leaves out (a second take() under
    #ifdef IBMON_FAULT_LEGACY_DRAIN): [{name, f, line, end, cond}], so a line in one can be named."""
    root = Path(root)
    known = {(f["file"], f["line"]) for f in funcs.values()}
    out = []
    for rel in sorted({f["file"] for f in funcs.values() if f["file"].endswith(".c")}):
        src = lines_text(root / rel).splitlines()
        stack, n = [], 0
        while n < len(src):
            ln = src[n]
            d = re.match(r"\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)", ln)
            if d:
                kind, arg = d.group(1), " ".join(d.group(2).split())
                if kind in ("if", "ifdef", "ifndef"):
                    stack.append(f"#{kind} {arg}")
                elif kind in ("elif", "else") and stack:
                    stack[-1] = f"#{kind} {arg}".strip() + f"（{stack[-1]}）"
                elif kind == "endif" and stack:
                    stack.pop()
                n += 1
                continue
            m = re.match(r"[A-Za-z_][^;#=]*?\b([A-Za-z_]\w*)\s*\([^;]*$", ln)
            if stack and m and not ln[:1].isspace():
                # the body: from the first { to its match
                j = n
                while j < len(src) and "{" not in src[j] and ";" not in src[j]:
                    j += 1
                if j < len(src) and "{" in src[j] and (rel, n + 1) not in known:
                    depth, k = 0, j
                    for k in range(j, len(src)):
                        depth += src[k].count("{") - src[k].count("}")
                        if depth <= 0:
                            break
                    out.append(dict(name=m.group(1), f=rel, line=n + 1, end=k + 1, cond=stack[-1]))
                    n = k + 1
                    continue
            n += 1
    return out


# ---- where data is given up ---------------------------------------------------------------------

LOSS = re.compile(r"(?i)(lost|loss|drop(ped|s)?|discard(ed|s)?|skip(ped)?|overrun|missed|overflow(ed|s)?)")


def data_loss(root, funcs, edges):
    """Where the code counts what it gives up: a counter named lost, dropped, skipped, overrun...
    raised with += or ++ (rd->lost += n in skip_to). For each: the calls that lead there (take ->
    skip_to) and the prints that report the counter (stderr at the first loss, the summary at the end).
    -> [{fid, f, l, var, text, via: [{fid, f, l}], said: [{fid, f, l}]}]"""
    root = Path(root)
    out = []
    bodies = list(_bodies(root, funcs))
    for fid, f, text, at in bodies:
        for m in re.finditer(r"([A-Za-z_][\w.>\-\[\]]*?)\s*(\+=|\+\+)|\+\+\s*([A-Za-z_][\w.>\-\[\]]*)", text):
            var = m.group(1) or m.group(3)
            leaf = re.split(r"->|\.", var)[-1]
            if not LOSS.search(leaf):
                continue
            line = at(m.start())
            src_line = lines_text(root / f["file"]).splitlines()[line - 1].strip()
            via = sorted({(e["s"], e["f"], e["l"]) for e in edges if e.get("d") == fid and e.get("src", "compiler") == "compiler"
                          and e["s"] in funcs and e.get("f")}, key=lambda x: (x[1], x[2]))
            said = []
            for gid, g, gtext, gat in bodies:
                for p in re.finditer(r"\b\w*printf\w*\s*\(", gtext):
                    args = gtext[p.end():p.end() + 400].split(";", 1)[0]
                    if re.search(r"\b" + re.escape(leaf) + r"\b", args):
                        said.append(dict(fid=gid, f=g["file"], l=gat(p.start())))
            out.append(dict(fid=fid, f=f["file"], l=line, var=var, text=src_line,
                            via=[dict(fid=s, f=a, l=b) for s, a, b in via], said=said))
    # one row per counter and function
    seen, rows = set(), []
    for r in out:
        if (r["fid"], r["var"]) not in seen:
            seen.add((r["fid"], r["var"]))
            rows.append(r)
    return rows


# ---- commands a Python program runs ---------------------------------------

def _argv_text(node, subst=None):
    """An argument list as the command line it makes: literals as written, other parts as {expr};
    subst maps a parameter name to what a caller passed for it."""
    import ast
    subst = subst or {}
    if isinstance(node, (ast.List, ast.Tuple)):
        return " ".join(_argv_text(e, subst) for e in node.elts)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        listy = lambda x: isinstance(x, (ast.List, ast.Tuple)) or isinstance(x, ast.Call) and isinstance(x.func, ast.Name) and x.func.id in ("list", "tuple")
        sep = " " if listy(node.left) or listy(node.right) else ""          # a list joins words; strings join as one
        return (_argv_text(node.left, subst) + sep + _argv_text(node.right, subst)).strip()
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod) and isinstance(node.left, ast.Constant) and isinstance(node.left.value, str):
        vals = node.right.elts if isinstance(node.right, ast.Tuple) else [node.right]
        it = iter("{" + ast.unparse(v) + "}" for v in vals)
        return re.sub(r"%[-#0 +]*\d*(?:\.\d+)?[sdifr]", lambda m: next(it, m.group(0)), node.left.value)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("list", "tuple") and len(node.args) == 1:
        return _argv_text(node.args[0], subst)
    if isinstance(node, ast.Starred):
        return _argv_text(node.value, subst)
    if isinstance(node, ast.Name) and node.id in subst:
        return subst[node.id]
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) else "{" + ast.unparse(v.value) + "}" for v in node.values)
    return "{" + ast.unparse(node) + "}"


SUBPROCESS = ("subprocess.run", "subprocess.Popen", "subprocess.call", "subprocess.check_call", "subprocess.check_output",
              "os.system", "os.execvp", "os.execv", "os.spawnvp", "asyncio.create_subprocess_exec")


def _expander(root, funcs, edges):
    """The helpers py_commands and py_write_targets share: parse trees, find calls and parameters,
    and expand a text with {param} placeholders through the places that call the function."""
    import ast
    trees = {}

    def tree(f):
        if f not in trees:
            try:
                trees[f] = ast.parse(lines_text(Path(root) / f))
            except (SyntaxError, ValueError, OSError):
                trees[f] = None
        return trees[f]

    def call_at(f, line, names):
        t = tree(f)
        for n in ast.walk(t) if t else ():
            if isinstance(n, ast.Call) and n.lineno <= line <= (n.end_lineno or n.lineno) \
                    and (ast.unparse(n.func) in names or ast.unparse(n.func).split(".")[-1] in names):
                return n
        return None

    def defn(fid):
        f = funcs[fid]
        t = tree(f["file"])
        return _def_node(t, f) if t else None

    def params_of(fid):
        d = defn(fid)
        if not d:
            return []
        a = d.args
        return [x.arg for x in a.posonlyargs + a.args + ([a.vararg] if a.vararg else []) + a.kwonlyargs if x.arg not in ("self", "cls")]

    def local_value(fid, name, line):
        """command = [...] + list(argv) earlier in the function: the expression the name holds."""
        d = defn(fid)
        best = None
        for n in ast.walk(d) if d else ():
            if isinstance(n, ast.Assign) and n.lineno < line and len(n.targets) == 1 \
                    and isinstance(n.targets[0], ast.Name) and n.targets[0].id == name:
                best = n.value if best is None or n.lineno > best.lineno else best
        return best

    callers = {}
    for c in edges:
        if c.get("k", "call") == "call" and c.get("s") in funcs and c.get("d") in funcs:
            callers.setdefault(c["d"], []).append(c)

    def expand(fid, text, depth):
        """The places that call fid, each with fid's parameters in text replaced by what it passes."""
        params = params_of(fid)
        if depth > 3 or not any("{" + p + "}" in text for p in params):
            return []
        d = defn(fid)
        star = d.args.vararg.arg if d and d.args.vararg else None
        via, seen = [], set()
        for c in sorted(callers.get(fid, ()), key=lambda c: (c["f"], c["l"])):
            if (c["f"], c["l"]) in seen:
                continue
            seen.add((c["f"], c["l"]))
            cn = call_at(c["f"], c["l"], {funcs[fid]["name"].split(".")[-1]})
            if cn is None:
                continue
            pos = [p for p in params if p != star]

            def arg(a, c=c, cn=cn):
                if isinstance(a, ast.Constant) and isinstance(a.value, (int, float)) and not isinstance(a.value, bool):
                    return str(a.value)                     # vtysh(3, …) makes l3-r3, not l3-r{3}
                # a name the caller assigned just before (ns = f"l3-r{asn}"): what it holds, not {ns}
                if isinstance(a, ast.Name):
                    v = local_value(c["s"], a.id, cn.lineno)
                    if v is not None and not isinstance(v, ast.Call) or isinstance(v, ast.Call) and _argv_text(v) != "{" + ast.unparse(v) + "}":
                        return _argv_text(v)
                return _argv_text(a)
            subst = {p: arg(a) for p, a in zip(pos, cn.args)}
            if star:
                subst[star] = " ".join(arg(a) for a in cn.args[len(pos):])
            subst.update({k.arg: arg(k.value) for k in cn.keywords if k.arg in params})
            cmd = text
            for p, v in subst.items():
                cmd = cmd.replace("{" + p + "}", v).replace("{list(" + p + ")}", v).replace("{tuple(" + p + ")}", v)
            # a caller further up only helps when it fills something in (a loop variable leaves {as_id} as it was)
            deeper = [v for v in expand(c["s"], cmd, depth + 1) if v["cmd"] != cmd]
            via += deeper if deeper else [dict(fid=c["s"], f=c["f"], l=cn.lineno, cmd=cmd)]
        return via

    return dict(expand=expand, tree=tree, call_at=call_at, defn=defn, params_of=params_of, local_value=local_value)


def py_commands(root, funcs, edges):
    """[{fid, f, l, call, cmd, timeout?, shell?, via?: [{fid, f, l, cmd}]}]: the commands a Python program
    runs. A function that runs a command built from its own parameters (_run(namespace, argv)) is a
    wrapper: each place that calls it with literal arguments is listed under it, as the command it makes,
    through up to three wrappers (_ns(ns, *argv) -> _run(argv))."""
    import ast
    out = []
    h = _expander(root, funcs, edges)
    expand, call_at, params_of, local_value = h["expand"], h["call_at"], h["params_of"], h["local_value"]

    done = set()
    for e in edges:
        # an exec edge, or a plain call to subprocess.Popen and the like (the backend does not mark every one)
        run = e.get("k") == "exec" or e.get("d", "").removeprefix("ext:") in SUBPROCESS
        if not run or lang_of(e.get("f", "")) != "python" or e.get("s") not in funcs or (e["f"], e["l"]) in done:
            continue
        done.add((e["f"], e["l"]))
        n = call_at(e["f"], e["l"], SUBPROCESS)
        if n is None:
            continue
        argv = n.args[0] if n.args else next((k.value for k in n.keywords if k.arg in ("args", "command")), None)
        if isinstance(argv, ast.Name) and argv.id not in params_of(e["s"]):
            argv = local_value(e["s"], argv.id, n.lineno) or argv
        kw = {k.arg: k.value for k in n.keywords if k.arg}
        cmd = _argv_text(argv) if argv is not None else ""
        item = dict(fid=e["s"], f=e["f"], l=n.lineno, call=ast.unparse(n.func), cmd=cmd)
        if "timeout" in kw:
            item["timeout"] = ast.unparse(kw["timeout"])
        if "shell" in kw:
            item["shell"] = ast.unparse(kw["shell"])
        via = expand(e["s"], cmd, 1)
        if via:
            item["via"] = via
        out.append(item)
    return sorted(out, key=lambda x: (x["f"], x["l"]))


def broad_excepts(root, funcs):
    """Python: `except Exception` (or BaseException, or a bare except) whose handler does not raise again:
    the error is caught and the code goes on. [{fid, f, l, what, then}] with then the handler's first statements (up to three)."""
    import ast
    out, by_file = [], {}
    for fid, f in funcs.items():
        if lang_of(f["file"]) == "python" and f.get("end"):
            by_file.setdefault(f["file"], []).append((fid, f))
    for file, fs in sorted(by_file.items()):
        try:
            t = ast.parse(lines_text(Path(root) / file))
        except (SyntaxError, ValueError, OSError):
            continue
        for n in ast.walk(t):
            if not isinstance(n, ast.ExceptHandler):
                continue
            what = ast.unparse(n.type) if n.type is not None else ""
            if what not in ("", "Exception", "BaseException"):
                continue
            if any(isinstance(x, ast.Raise) for b in n.body for x in ast.walk(b)):
                continue
            fid = _innermost(fs, n.lineno)
            if fid:
                out.append(dict(fid=fid, f=file, l=n.lineno, what=what or "（全部）", then="; ".join(ast.unparse(b).split("\n")[0][:80] for b in n.body[:3]) + (" …" if len(n.body) > 3 else "")))
    return out


SPAWN = re.compile(r"(^|\.)(spawn\w*|Thread|Timer|start_new_thread|create_task|ensure_future|submit|call_later|call_soon|run_in_executor|Process|go)$")


def py_spawns(root, funcs, edges):
    """[{fid, f, l, call, target}]: a function handed to something that runs it in the background
    (hub.spawn(self._monitor_loop), threading.Thread(target=...), asyncio.create_task(...)).
    Read from the ref edges: the function passed on as a value, on a line that calls a spawner."""
    import ast
    trees, out = {}, []
    for e in edges:
        if e.get("k") != "ref" or e.get("s") not in funcs or e.get("d") not in funcs or lang_of(e.get("f", "")) != "python":
            continue
        if e["f"] not in trees:
            try:
                trees[e["f"]] = ast.parse(lines_text(Path(root) / e["f"]))
            except (SyntaxError, ValueError, OSError):
                trees[e["f"]] = None
        t = trees[e["f"]]
        for n in ast.walk(t) if t else ():
            if isinstance(n, ast.Call) and n.lineno <= e["l"] <= (n.end_lineno or n.lineno) and SPAWN.search(ast.unparse(n.func)):
                out.append(dict(fid=e["s"], f=e["f"], l=e["l"], call=ast.unparse(n.func), target=e["d"]))
                break
    return sorted({(o["f"], o["l"], o["target"]): o for o in out}.values(), key=lambda o: (o["f"], o["l"]))


def py_write_targets(root, funcs, edges, writes):
    """A file written through a parameter (_atomic_json(path, data) writes {path}): what each caller passes,
    as [{fid, f, l, name}] under the write's "via". Changes writes in place and returns them."""
    h = _expander(root, funcs, edges)
    for w in writes:
        if w.get("param") and w.get("fid") in funcs and lang_of(w.get("f", "")) == "python":
            via = h["expand"](w["fid"], "{" + w["param"] + "}", 0)
            if via:
                # {STATE_DIR / 'topology.json'}: the whole name is one expression; the braces add nothing
                bare = lambda t: t[1:-1] if t.startswith("{") and t.endswith("}") and t.count("{") == 1 else t
                w["via"] = [dict(fid=v["fid"], f=v["f"], l=v["l"], name=bare(v["cmd"])) for v in via[:20]]
    return writes
