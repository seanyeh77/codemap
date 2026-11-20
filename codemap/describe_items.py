"""AI descriptions beyond functions: files, components, the project, commands and their allowed values, environment
variables, the data files the code reads and writes, the types and file-level variables a file defines, a glossary
of the project's terms, and a reading route.

They are written in rounds, each resting on the one below it (describe.py has round 1, the functions):
  2  files, commands, argument values, environment variables, data files, functions outside the repository,
     types and file-level variables (def:FILE:NAME, from defs.py)
  3  components (from their files)
  4  the project, the reading route and the glossary (from the components and the commands)

Every item is kept under a key in descriptions.json "items" with the same fields as a function's (text in each
language, evidence, a hash, who, when). The hash is of what the item rests on (a file's text, the functions a
command runs, ...), so an item turns stale when that changes. What an item cites is checked against the code
before it is kept, as for functions: evidence must be where the item lives, `names` must be in that code.
"""
import datetime
import hashlib
import json
import re
from pathlib import Path

from . import describe

LEVELS = {1: "functions", 2: "files, commands, values, environment variables, data files, outside functions, types and variables", 3: "components",
          4: "the project, its reading route and glossary"}
KIND_LEVEL = {"file": 2, "cmd": 2, "value": 2, "env": 2, "data": 2, "ext": 2, "def": 2, "comp": 3, "project": 4, "route": 4, "term": 4}
# info an outside function's description may carry (it has no body here: no lines, no checks)
EXT_INFO = ("context", "params", "returns", "effects", "contract")


def kind(key):
    return key.split(":", 1)[0] if ":" in key else key


def _text(root, file):
    try:
        return (Path(root) / file).read_text(errors="replace")
    except OSError:
        return ""


def _h(*parts):
    return hashlib.sha1("\x00".join(map(str, parts)).encode("utf-8")).hexdigest()[:16]


def _line(root, file, line):
    src = _text(root, file).splitlines()
    return src[line - 1].strip() if 0 < line <= len(src) else ""


def _at(ref):
    f, _, l = ref.rpartition(":")
    return f, int(l) if l.isdigit() else 0


# ---- what there is to describe, and what each item rests on ----

def items(root, idx, g, tests=False):
    """{key: info} for every item of rounds 2 to 4. info: level, title, files (where its evidence may be), funcs
    (ids it rests on), lines (file:line it is about), and what its prompt shows."""
    out = {}
    nodes = idx["nodes"]
    test = lambda f: not tests and any(nodes[n].get("scope") == "test" for n in describe.funcs_in(idx, f))
    for f in describe.project_files(idx, tests):
        if test(f):
            continue
        out["file:" + f] = dict(level=2, title=f, files=[f], funcs=describe.funcs_in(idx, f))
    for p in g.get("cli") or []:
        common = None
        for c in p["cmds"] or [None]:
            name = f'{p["prog"]} {c["name"]}' if c else p["prog"]
            run = (c or {}).get("run") or [x for x in (p.get("dispatch"), p.get("main")) if x]
            at = [f'{p["f"]}:{(c or p)["l"]}'] + ([f'{g["funcs"][p["dispatch"]]["file"]}:{c["at"][0]}'] if c and c.get("at") and p.get("dispatch") in g["funcs"] else [])
            out["cmd:" + name] = dict(level=2, title=name, files=sorted({p["f"], *(nodes[x]["file"] for x in run if x in nodes)}),
                                      funcs=[x for x in run if x in nodes], lines=at)
            for a in (c or {}).get("args", []) + ([] if c else p.get("args", [])):
                for v, h in (a.get("handled") or {}).items():
                    fid, line = h
                    if fid in nodes:
                        out[f'value:{name} {a["name"]}={v}'] = dict(level=2, title=f'{name} {a["name"]} {v}',
                                                                     files=[nodes[fid]["file"]], funcs=[fid], lines=[f'{nodes[fid]["file"]}:{line}'])
    for name, e in (g.get("env") or {}).items():
        refs = [*e.get("set", []), *e.get("get", [])]
        if refs:
            out["env:" + name] = dict(level=2, title=name, files=sorted({_at(r)[0] for r in refs}), funcs=[], lines=refs)
    data = {}
    for kind_, rows in (("writes", g.get("writes") or []), ("reads", g.get("reads") or [])):
        for r in rows:
            name = r.get("name") or r.get("expr")
            if name and r.get("fid") in nodes:
                d = data.setdefault(name, dict(level=2, title=name, files=set(), funcs=set(), lines=[], ways=set()))
                d["files"].add(r["f"]); d["funcs"].add(r["fid"]); d["lines"].append(f'{r["f"]}:{r["l"]}'); d["ways"].add(kind_)
    for name, d in data.items():
        out["data:" + name] = dict(d, files=sorted(d["files"]), funcs=sorted(d["funcs"]), ways=sorted(d["ways"]))
    # the functions outside the repository it calls (libc, a library): what they do and what their parameters are
    # for, from the AI's knowledge of them, with the lines that call them
    calls = {}
    for e in idx["edges"]:
        d = e.get("dst", "")
        if d.startswith("ext:") and e.get("src") in nodes and nodes[e["src"]].get("line") and e.get("file") and e.get("line") \
                and (tests or nodes[e["src"]].get("scope") != "test"):
            calls.setdefault(d, []).append((e["src"], f'{e["file"]}:{e["line"]}'))
    for d, cs in calls.items():
        lines = sorted({r for _, r in cs}, key=lambda r: (_at(r)[0], _at(r)[1]))
        out[d] = dict(level=2, title=d[4:], files=sorted({_at(r)[0] for r in lines}), funcs=sorted({s for s, _ in cs}), lines=lines[:6])
    # the types and file-level variables each file defines; constants and macros only where their author wrote a
    # comment (most are plain, but a comment is in its author's language and the reader's may be another)
    for f, d in sorted((g.get("defs") or {}).items()):
        if test(f):
            continue
        for x in d.get("types", []) + [v for v in d.get("vars", []) if v.get("scope") != "extern"] \
                + [c for c in d.get("consts", []) if c.get("doc")]:
            key = f"def:{f}:{x['name']}"
            if key in out:
                continue                                    # a second definition of the name (#ifdef branches)
            end = min(x.get("end", x["line"]), x["line"] + 39)
            out[key] = dict(level=2, title=x["name"], files=[f], funcs=[u for u in x.get("users", []) if u in nodes][:6],
                            lines=[f"{f}:{ln}" for ln in range(x["line"], end + 1)], define=x)
    for c in g.get("comps") or []:
        if c["id"].endswith("(tests)"):
            continue
        files = sorted({f["file"] for f in g["funcs"].values() if f["comp"] == c["id"]})
        if files:
            out["comp:" + c["id"]] = dict(level=3, title=c["id"], files=files, funcs=[])
    if out:
        out["project"] = dict(level=4, title="project", files=None, funcs=[])
        out["route"] = dict(level=4, title="reading route", files=None, funcs=[])
    return out


def basis(root, idx, info, key, entry=None):
    """The hash of what an item rests on: it changes when that does, and the item turns stale."""
    k = kind(key)
    if k in ("file", "comp"):
        return _h(*(f + _text(root, f) for f in info["files"]))
    if k == "project":
        return _h(*sorted(info.get("parts", [])))
    if k == "route":
        steps = [s["id"] for s in (entry or {}).get("steps", [])]
        return _h(*(describe.digest(root, idx["nodes"][s]) for s in steps if s in idx["nodes"]))
    if k == "term":
        return _h(*(_line(root, *_at(r)) for r in (entry or {}).get("evidence", [])))
    if k == "ext":
        return _h(key)
    if k == "def":                                          # its definition: not the functions that use it
        return _h(*(_line(root, *_at(r)) for r in info.get("lines", [])))
    lines = [_line(root, *_at(r)) for r in info.get("lines", [])]
    return _h(*lines, *(describe.digest(root, idx["nodes"][x]) for x in info.get("funcs", []) if x in idx["nodes"]))


def problems(root, idx, info, key, entry):
    """What an item's text cites that the code does not have."""
    out = []
    text = entry.get("text") or {}
    for lang in describe.LANGS:
        if not str(text.get(lang, "")).strip():
            out.append(f"no {lang} text")
    k = kind(key)
    nodes = idx["nodes"]
    if k == "route":
        steps = entry.get("steps") or []
        if len(steps) < 2:
            out.append("a route needs at least two steps")
        for s in steps:
            if s.get("id") not in nodes:
                out.append(f"step {s.get('id')!r} is not a function in the index")
            for lang in describe.LANGS:
                if not str(s.get(lang, "")).strip():
                    out.append(f"step {s.get('id')}: no {lang} text")
        pairs = {(e["src"], e["dst"]) for e in idx["edges"]}

        def entry(fid):
            """A place the program starts again: nothing in the repository calls it, or only a framework or a
            rule does (a controller's handlers, a program another one starts)."""
            ins = [e for e in idx["edges"] if e["dst"] == fid and nodes.get(e["src"], {}).get("line") and e["src"] != fid]
            return not ins or all(e.get("source") not in ("compiler", "static", "syntax") for e in ins)

        for a, b in zip(steps, steps[1:]):
            if (a.get("id"), b.get("id")) not in pairs and (b.get("id"), a.get("id")) not in pairs and not entry(b.get("id")):
                out.append(f"{a.get('id')} and {b.get('id')}: neither calls the other, and {b.get('id')} is not where the program starts")
        return out
    if k == "ext":
        info_ = entry.get("info") or {}
        params = {str(p.get("name", "")) for p in info_.get("params") or [] if isinstance(p, dict)}
        for part, its_ in info_.items() if isinstance(info_, dict) else []:
            if part not in EXT_INFO:
                out.append(f"info: unknown part {part!r} for an outside function (one of {', '.join(EXT_INFO)})")
                continue
            for i, it in enumerate(its_ if isinstance(its_, list) else []):
                where = f"info.{part}[{i}] "
                if not isinstance(it, dict):
                    out.append(where + "is not an object")
                    continue
                for lang in describe.LANGS:
                    if not str(it.get(lang, "")).strip():
                        out.append(where + f"has no {lang} text")
                if part == "params" and it.get("role") not in describe.ROLES:
                    out.append(where + f"role must be one of {', '.join(describe.ROLES)}")
                if part == "params" and not str(it.get("name", "")).strip():
                    out.append(where + "has no name")
                if part == "contract" and it.get("kind") not in describe.CONTRACT:
                    out.append(where + f"kind must be one of {', '.join(describe.CONTRACT)}")
        return out
    if k == "def":
        fields = {f["name"] for f in (info.get("define") or {}).get("fields", [])}
        info_ = entry.get("info") or {}
        for i, it in enumerate(info_.get("fields") or [] if isinstance(info_, dict) else []):
            where = f"info.fields[{i}] "
            if not isinstance(it, dict):
                out.append(where + "is not an object")
            elif str(it.get("name", "")) not in fields:
                out.append(where + f"{it.get('name')!r} is not a field of {info['title']}")
            else:
                out += [where + f"has no {lang} text" for lang in describe.LANGS if not str(it.get(lang, "")).strip()]
    # where the evidence may be: the item's files (the project: any file of the repository)
    files = info.get("files")
    code_files = {n["file"] for n in nodes.values() if n.get("file") and n.get("line")}
    # the project and a term may cite any file of the repository, its documents too (README.md:1)
    inside = lambda f: not files and ".." not in Path(f).parts and not Path(f).is_absolute() and (Path(root) / f).is_file()
    allowed = set(files) if files else code_files
    ev = entry.get("evidence") or []
    if k == "term" and not ev:
        out.append("a term needs the lines it appears on")
    for ref in ev:
        f, line = _at(str(ref))
        if not f or not line:
            out.append(f"evidence {ref!r} is not file:line")
        elif f not in allowed and not inside(f):
            out.append(f"evidence {ref} is not in {', '.join(sorted(allowed)) if files else 'the repository'}")
        elif not _line(root, f, line) and line > len(_text(root, f).splitlines()):
            out.append(f"evidence {ref}: the file has no line {line}")
        elif k == "term" and str(entry.get("term", "")).lower() not in _line(root, f, line).lower():
            out.append(f"evidence {ref} does not have the term {entry.get('term')!r}")
    # `names`: in the item's files (the project's: anywhere), or a function's name
    body = "\n".join(_text(root, f) for f in sorted(allowed | {_at(str(r))[0] for r in ev if inside(_at(str(r))[0])}))
    names = {n["name"] for n in nodes.values()} | {n["name"].rsplit(".", 1)[-1] for n in nodes.values()}
    for lang in describe.LANGS:
        for word in describe.CODE.findall(str(text.get(lang, ""))):
            w = word.strip().rstrip("()")
            if w and w not in names and w not in body:
                out.append(f"{lang}: `{word}` is not in the code it describes")
    return out


def state(root, idx, info, key, entry):
    if info is None or problems(root, idx, info, key, entry):
        return "wrong"
    return "ok" if entry.get("hash") == basis(root, idx, info, key, entry) else "stale"


# ---- the rounds ----

def all_items(root, idx, g, tests=False):
    """The items, with the project's basis (its components and commands) and each term's info."""
    its = items(root, idx, g, tests)
    if "project" in its:
        its["project"]["parts"] = [k for k in its if kind(k) in ("comp", "cmd")]
    for key, entry in describe.load_all(root)["items"].items():
        if kind(key) == "term" and its:
            its[key] = dict(level=4, title=key[5:], files=None, funcs=[])
    return its


def pending(root, idx, g, level=None, tests=False, rewrite=False):
    """(level, [keys]) to write next: the lowest round with an item that is missing or stale (or the round asked
    for). Round 1 is the functions (describe.py); a round waits for every round below it."""
    have = describe.load_all(root)
    if level in (None, 1):
        ids = describe.pending(root, idx, describe.project_files(idx, tests), only_missing=not rewrite)
        if ids or level == 1:
            return 1, ids
    its = all_items(root, idx, g, tests)
    for lv in ([level] if level else [2, 3, 4]):
        keys = [k for k, v in its.items() if v["level"] == lv and kind(k) != "term"
                and (rewrite or k not in have["items"] or state(root, idx, v, k, have["items"][k]) != "ok")]
        # the glossary is written with the project: a term gone stale or wrong asks for the round again
        if lv == 4 and not keys and any(state(root, idx, v, k, have["items"].get(k, {})) != "ok" for k, v in its.items() if kind(k) == "term"):
            keys = ["project"]
        if keys:
            return lv, keys
    return None, []


def _desc(root, idx, have, nid):
    """A function's line for a prompt: its AI description, else its author's, else nothing."""
    e = have["funcs"].get(nid)
    if e and e.get("text", {}).get("en"):
        return e["text"]["en"]
    n = idx["nodes"][nid]
    from . import docs
    return docs.func_doc(root, n["file"], n["line"], n.get("lang", "c")) or ""


def _item_text(have, key):
    e = have["items"].get(key)
    return (e or {}).get("text", {}).get("en", "")


def prompt(root, idx, g, level, keys):
    """The prompt for one round's items."""
    have = describe.load_all(root)
    its = all_items(root, idx, g)
    nodes = idx["nodes"]
    fn = lambda x: f'{nodes[x]["name"]} ({nodes[x]["file"]}:{nodes[x]["line"]})' + (f': {_desc(root, idx, have, x)}' if _desc(root, idx, have, x) else "")
    parts = []
    for key in keys:
        info = its[key]
        k = kind(key)
        head = f"### id: {key}\n"
        if k == "file":
            f = info["files"][0]
            top = (g.get("files") or {}).get(f, {}).get("text")
            callers = sorted({nodes[e["src"]]["file"] for e in idx["edges"] if e["dst"] in nodes and nodes[e["dst"]].get("file") == f
                              and e["src"] in nodes and nodes[e["src"]].get("file") not in (None, f)})
            callees = sorted({nodes[e["dst"]]["file"] for e in idx["edges"] if e["src"] in nodes and nodes[e["src"]].get("file") == f
                              and e["dst"] in nodes and nodes[e["dst"]].get("line") and nodes[e["dst"]].get("file") not in (None, f)})
            parts.append(head + f"- file: {f}\n" + (f"- the author wrote at its top: {top}\n" if top else "")
                         + f"- called from: {', '.join(callers) or 'no other file'}\n- calls into: {', '.join(callees) or 'no other file'}\n"
                         + "- its functions:\n" + "".join(f"  - {fn(x)}\n" for x in info["funcs"]))
        elif k == "comp":
            parts.append(head + f"- component: {info['title']}\n- its files:\n"
                         + "".join(f"  - {f}: {_item_text(have, 'file:' + f) or (g.get('files') or {}).get(f, {}).get('text', '')}\n" for f in info["files"]))
        elif k in ("cmd", "value"):
            show = "".join(f"  {r}: {_line(root, *_at(r))}\n" for r in info.get("lines", []))
            parts.append(head + f"- {'command' if k == 'cmd' else 'value of an argument'}: {info['title']}\n"
                         + (f"- the lines that handle it:\n{show}" if show else "")
                         + "- the functions it runs:\n" + "".join(f"  - {fn(x)}\n" for x in info["funcs"]))
        elif k == "env":
            parts.append(head + f"- environment variable: {info['title']}\n- where it is set and read:\n"
                         + "".join(f"  {r}: {_line(root, *_at(r))}\n" for r in info["lines"]))
        elif k == "data":
            parts.append(head + f"- a file the program {' and '.join(info.get('ways', []))}: {info['title']}\n- where:\n"
                         + "".join(f"  {r}: {_line(root, *_at(r))}\n" for r in info["lines"])
                         + "- by:\n" + "".join(f"  - {fn(x)}\n" for x in info["funcs"]))
        elif k == "def":
            x = info["define"]
            what = {"macro": "macro", "const": "constant", "enum": "enum value"}.get(x.get("kind"), x.get("kind")) or f'{x.get("scope")} variable'
            src = "".join(f"  {r}: {_line(root, *_at(r))}\n" for r in info["lines"])
            # every field with its author's comment: a long struct's definition is cut above
            fields = x.get("fields") or []
            noted = [fl for fl in fields if fl.get("doc")]
            flist = "".join(f"  - {fl['name']}" + (f": {fl['doc']}" if fl.get("doc") else "") + "\n" for fl in fields[:120])
            parts.append(head + f"- {what} {x['name']} in {info['files'][0]}" + (f" (type {x['type']})" if x.get("type") else "")
                         + (f" = {x['value']}" if x.get("value") else "") + "\n"
                         + (f"- the author wrote: {x['doc']}\n" if x.get("doc") else "")
                         + f"- its definition{' (the first 40 lines)' if len(info['lines']) >= 40 else ''}:\n{src}"
                         + (f"- its fields ({len(fields)}, {len(noted)} with the author's comment){', the first 120' if len(fields) > 120 else ''}:\n{flist}" if fields else "")
                         + ("- functions that use it (found by name):\n" + "".join(f"  - {fn(u)}\n" for u in info["funcs"]) if info["funcs"] else ""))
        elif k == "ext":
            lang = nodes[info["funcs"][0]].get("lang", "c") if info["funcs"] else "c"
            parts.append(head + f"- a function outside the repository ({lang}): {info['title']}\n- where the project calls it:\n"
                         + "".join(f"  {r}: {_line(root, *_at(r))}\n" for r in info["lines"]))
        elif k == "project":
            comps = [x for x in its if kind(x) == "comp"]
            cmds = [x for x in its if kind(x) == "cmd"]
            entries = sorted({x for p in g.get("cli") or [] for x in (p.get("dispatch"), p.get("main")) if x in nodes}
                             | {nid for nid, f in g["funcs"].items() if f.get("entry")})
            readme = next((p for p in (Path(root) / n for n in ("README.md", "README.rst", "README")) if p.is_file()), None)
            near = sorted({*entries, *(e["dst"] for e in idx["edges"] if e["src"] in entries and e["dst"] in nodes and nodes[e["dst"]].get("line"))})
            parts.append(head + "- components:\n" + "".join(f"  - {c[5:]}: {_item_text(have, c)}\n" for c in comps)
                         + ("- commands:\n" + "".join(f"  - {c[4:]}: {_item_text(have, c)}\n" for c in cmds) if cmds else "")
                         + "- functions a route may use (entries and what they call):\n" + "".join(f"  - id {x}: {fn(x)}\n" for x in near[:80])
                         + (f"- the README begins:\n" + "\n".join("  " + ln for ln in _text(root, readme.relative_to(root)).splitlines()[:30]) + "\n" if readme else ""))
    if not parts:
        return None
    return (HEAD[level] + HEAD_ALL + "\n".join(parts)).replace("{FORM}", FORM[level])


HEAD_ALL = """Write for a reader who opens this code for the first time. Every text comes in Traditional Chinese (zh-TW) and
in English (en). Use only what is shown here. Put a name from the code in backticks; every such name must be in
the code of the item or be a function's name. Give as evidence the one to three lines (file:line) that show it
most directly, in the item's own files.

Answer with JSON only, in this form, every id below copied exactly:

{FORM}

Then save it to a file and run: codemap describe --apply <that file>

"""

HEAD = {
    2: "Describe, in one sentence each (zh-TW at most 60 characters, en at most 30 words): what each file is "
       "responsible for; what each command does for the person who types it; what each allowed value of an argument "
       "does; what each environment variable controls; what each data file holds and why it is read or written.\n"
       "For a function outside the repository (ids ext:...), say what it does from what you know of it (its manual, "
       "its library's documentation), and add \"info\" as in the form below: every parameter with its name and type "
       "as declared, its role (in, out, in-out) and what it holds; what its return values mean; its side effects; "
       "whether it blocks or which thread it needs (context); its contract (kind pre, post, error, ownership). Its "
       "evidence is the lines that call it. Leave a part out when you are not sure of it; do not describe a "
       "function you do not know.\n"
       "For a type, a file-level variable or a commented constant or macro (ids def:...), say what it holds and what "
       "it is for in this program, from its definition, its author's comment and the functions that use it; for a "
       "variable, who writes it and who reads it when the functions show that. For a type with fields, add "
       "\"info\": {\"fields\": [...]} with a short phrase for every field the author commented (the comment in both "
       "languages, as a reader of either needs it, keeping to what it says) and for each other field whose meaning, "
       "unit or allowed values are not plain from its name (skip the plain ones). Its evidence is lines of its "
       "definition.\n\n",
    3: "Describe each component in one or two sentences: what it is responsible for in the program, "
       "from what its files do.\n\n",
    4: "Describe the project as a whole, then give a reading route and a glossary.\n"
       "- project: two or three sentences: what the program is for, what its parts are, where it starts.\n"
       "- route: three to eight functions (ids from the list below) in the order a newcomer should read them; each "
       "must call the next or be called by it, unless the next is where the program starts again (an entry: nothing "
       "in the repository calls it); one sentence each on why to read it there.\n"
       "- terms: five to fifteen words of this project's domain a newcomer may not know (protocols, data structures, "
       "names of its own); for each, a short definition and the lines (file:line) where the word itself appears.\n\n",
}

FORM = {
    2: '{"descriptions": [{"id": "...", "zh-TW": "...", "en": "...", "evidence": ["file:line"]},\n'
       ' {"id": "ext:...", "zh-TW": "...", "en": "...", "evidence": ["file:line"],\n'
       '  "info": {"params": [{"name": "addrlen", "type": "socklen_t *", "role": "in-out", "zh-TW": "...", "en": "..."}],\n'
       '           "returns": [{"zh-TW": "...", "en": "..."}], "contract": [{"kind": "ownership", "zh-TW": "...", "en": "..."}]}},\n'
       ' {"id": "def:...", "zh-TW": "...", "en": "...", "evidence": ["file:line"],\n'
       '  "info": {"fields": [{"name": "head", "zh-TW": "...", "en": "..."}]}}]}',
    3: '{"descriptions": [{"id": "...", "zh-TW": "...", "en": "...", "evidence": ["file:line"]}]}',
    4: '{"descriptions": [{"id": "project", "zh-TW": "...", "en": "...", "evidence": ["file:line"]}],\n'
       ' "route": {"zh-TW": "one line on the route", "en": "...", "steps": [{"id": "function id", "zh-TW": "...", "en": "..."}]},\n'
       ' "terms": [{"term": "...", "zh-TW": "...", "en": "...", "evidence": ["file:line"]}]}',
}


def apply(root, idx, g, data, by="ai"):
    """Keep an answer's items that match the code: (kept keys, {key: problems})."""
    have = describe.load_all(root)
    its = all_items(root, idx, g)
    kept, rejected = [], {}
    today = datetime.date.today().isoformat()

    def keep(key, entry, info):
        bad = problems(root, idx, info, key, entry)
        if bad:
            rejected[key] = bad
            return
        entry["hash"] = basis(root, idx, info, key, entry)
        have["items"][key] = entry
        kept.append(key)

    for it in data.get("descriptions", []) if isinstance(data, dict) else []:
        key = str(it.get("id", ""))
        if key in its and kind(key) not in ("route", "term"):
            entry = {"text": {l: str(it.get(l, "")).strip() for l in describe.LANGS},
                     "evidence": [str(x) for x in it.get("evidence", [])], "by": by, "at": today}
            if kind(key) == "ext" and it.get("info") is not None:
                entry["info"] = it["info"]
            if kind(key) == "def" and isinstance(it.get("info"), dict) and it["info"].get("fields"):
                entry["info"] = {"fields": [{"name": str(f.get("name", "")), **{l: str(f.get(l, "")).strip() for l in describe.LANGS}}
                                            for f in it["info"]["fields"] if isinstance(f, dict)]}
            keep(key, entry, its[key])
            if kind(key) == "ext" and key in have["items"] and "info" in have["items"][key]:
                inf = describe.clean_info(have["items"][key]["info"], keep=("type",))
                if inf:
                    have["items"][key]["info"] = inf
                else:
                    del have["items"][key]["info"]
    r = data.get("route") if isinstance(data, dict) else None
    if isinstance(r, dict):
        keep("route", {"text": {l: str(r.get(l, "")).strip() for l in describe.LANGS},
                       "steps": [{"id": str(s.get("id", "")), **{l: str(s.get(l, "")).strip() for l in describe.LANGS}} for s in r.get("steps", [])],
                       "by": by, "at": today}, its.get("route", {}))
    if isinstance(data, dict) and isinstance(data.get("terms"), list):
        for k in [k for k in have["items"] if kind(k) == "term"]:
            del have["items"][k]                     # a new glossary replaces the old one
        for t in data["terms"]:
            term = str(t.get("term", "")).strip()
            if term:
                keep("term:" + term, {"term": term, "text": {l: str(t.get(l, "")).strip() for l in describe.LANGS},
                                      "evidence": [str(x) for x in t.get("evidence", [])], "by": by, "at": today},
                     dict(level=4, title=term, files=None, funcs=[]))
    if kept or (isinstance(data, dict) and "terms" in data):
        describe.save(root, items=have["items"])
    return kept, rejected


def described(root, idx, g):
    """For the viewer: {key: {text, state, by, ...}} of every item kept, the route's steps and a term's word kept."""
    have = describe.load_all(root)["items"]
    its = all_items(root, idx, g)
    out = {}
    for key, e in have.items():
        st = state(root, idx, its.get(key), key, e)
        out[key] = {"text": e.get("text", {}), "state": st, "by": e.get("by")}
        if kind(key) == "route":
            out[key]["steps"] = e.get("steps", [])
        if e.get("info"):
            out[key]["info"] = e["info"]
        if kind(key) == "term":
            out[key]["term"] = e.get("term")
            out[key]["evidence"] = e.get("evidence", [])
    return out


def report(root, idx, g):
    """{state: [keys]} of the items kept, and how many there are to describe in each round."""
    have = describe.load_all(root)["items"]
    its = all_items(root, idx, g)
    out = {"ok": [], "stale": [], "wrong": []}
    for key, e in have.items():
        out[state(root, idx, its.get(key), key, e)].append(key)
    missing = {lv: sum(1 for k, v in its.items() if v["level"] == lv and kind(k) != "term" and k not in have) for lv in (2, 3, 4)}
    return out, missing
