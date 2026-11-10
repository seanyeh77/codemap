"""Data for the viewer: what `codemap serve` answers and what a `.codemap`
snapshot holds. A snapshot is gzip-compressed JSON with the same shape as the
server's answers plus the source lines of every function, so that the viewer
can open it without the repository."""

import gzip
import re
import socket
import json
import subprocess
import time
from pathlib import Path

from . import arch, check, docs, facts, rules, state
from .arch import in_repo, repo_func
from .source import c_body_end, code_lines, lines
from .schema import CALL_SOURCES

FORMAT = "codemap-snapshot"
VERSION = 1


def git(root, *args):
    try:
        r = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=10)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def repo_info(root):
    root = Path(root)
    # -z: NUL separated, paths unquoted; a rename's old path follows as its own entry
    status = git(root, "status", "--porcelain", "-z", "--untracked-files=no").split("\0")
    dirty, skip = [], False
    for entry in status:
        if skip or len(entry) < 4:
            skip = False
            continue
        dirty.append(entry[3:])
        skip = bool({"R", "C"} & set(entry[:2]))      # renamed or copied, in the index or the worktree
    return dict(repo=root.name, host=socket.gethostname(), commit=git(root, "rev-parse", "--short", "HEAD").strip() or None,
                dirty=dirty)


BUILD_NAMES = re.compile(r"^(Makefile|GNUmakefile|CMakeLists\.txt|meson\.build)$|\.(mk|cmake|map|ld|lds)$")


def header_files(root):
    """Repository headers: a .c file without its own top comment borrows the one of its header."""
    from .source import walk
    root = Path(root)
    return {str(p.relative_to(root)) for p in walk(root, {".h"})}


def build_files(root):
    """Makefiles, linker scripts and version maps: how the code is built and what it exports."""
    from .source import walk
    root = Path(root)
    return {str(p.relative_to(root)) for p in walk(root) if BUILD_NAMES.search(p.name)}


def doc_files(root, limit=2000):
    """The project's written documents (Markdown, reStructuredText): design notes the code points to,
    such as docs/design/ring-overrun.md, to search and read in the viewer."""
    from .source import walk
    root = Path(root)
    return set(sorted(str(p.relative_to(root)) for p in walk(root, {".md", ".rst"}))[:limit])


def doc_summaries(root, files, sources):
    """[{file, title, text, cited}] for the project's documents: the first heading, the first
    sentence of the paragraph under it, and how many source files name the document (a comment
    such as `see docs/design/ring-overrun.md`). The overview lists them so the most complete
    explanation is found without a search."""
    root = Path(root)
    mds = sorted(f for f in files if f.endswith((".md", ".rst")))
    texts = {s: "\n".join(lines(root / s)) for s in sources if s.endswith((".c", ".h", ".py", ".sh", "Makefile"))}
    out = []
    for f in mds:
        src = lines(root / f)
        title, text, i = None, "", 0
        while i < len(src):
            ln = src[i].strip()
            i += 1
            if title is None:
                m = re.match(r"#{1,3}\s+(.+)", ln)
                if m:
                    title = m.group(1).strip()
                elif ln and i < len(src) and re.fullmatch(r"[=\-~]{3,}", src[i].strip()):  # reStructuredText
                    title, i = ln, i + 1
                continue
            if not ln or ln.startswith(("#", "---", "```", "|", "<!--", "!", ">")):
                if text:
                    break
                continue
            # Chinese lines join without a space: 「指令、」 + 「什麼時候」
            cjk = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")
            text += ("" if not text or cjk.match(text[-1]) or cjk.match(ln[0]) else " ") + ln
        # a sentence ends at 。！？ (no space follows in Chinese) or at . ! ? before a space
        sentence = re.split(r"(?<=[。！？])|(?<=[.!?])\s", text, maxsplit=1)[0] if text else ""
        sentence = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", sentence)          # links read as their text
        sentence = re.sub(r"\*\*|__", "", sentence)
        cited = sum(1 for s, t in texts.items() if f in t or ("/" in f and f.split("/", 1)[1] in t))
        out.append(dict(file=f, title=title or Path(f).stem, text=sentence[:200], cited=cited))
    return out


DEFINE_RE = re.compile(r"^\s*#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?\s*(.*)")


def symbols(root, files):
    """Macros and file-scope variables of C files and headers, to search by name:
    [{name, kind: macro | var, file, line, text}]. Include guards are left out."""
    from . import state
    out = []
    for f in sorted(files):
        if not f.endswith((".c", ".h")):
            continue
        raw = lines(Path(root) / f)
        for i, ln in enumerate(raw, 1):
            m = DEFINE_RE.match(ln)
            if m and (m.group(2) or m.group(3).strip()):
                out.append(dict(name=m.group(1), kind="macro", file=f, line=i,
                                text=(m.group(1) + (m.group(2) or "") + " " + m.group(3).strip().rstrip("\\").strip())[:120]))
        code = [state.STRINGS.sub('""', ln) for ln in code_lines(Path(root) / f)]
        for i, name, static in state._file_scope(code):
            out.append(dict(name=name, kind="var", file=f, line=i, text=raw[i - 1].strip()[:120]))
    return out


BACKEND_OF = {"python": "python", "go": "go", "typescript": "typescript", "javascript": "typescript"}


def external_candidates(edges, funcs):
    """Marks the candidates of an ambiguous call that are all outside methods of the same name
    (id.toString() with id: string | number: String.toString, Number.toString) with "eg", so the
    viewer can show them as one group; the edges themselves stay as they are. Returns per backend
    the ambiguous edges and call sites split into those and the rest (candidates in the repository)."""
    sites = {}
    for x in edges:
        if x.get("resolution") == "ambiguous":
            sites.setdefault((x["s"], x["f"], x["l"], x.get("c")), []).append(x)
    out = {}
    for (s, *_), xs in sites.items():
        names = {(x.get("dn") or x["d"]).rsplit(".", 1)[-1] for x in xs}
        external = all(x["d"] not in funcs for x in xs) and len(names) == 1
        if external:
            for x in xs:
                x["eg"] = True
        b = BACKEND_OF.get(funcs.get(s, {}).get("lang"), "other")
        o = out.setdefault(b, dict(repo_edges=0, repo_sites=0, external_edges=0, external_sites=0))
        kind = "external" if external else "repo"
        o[kind + "_edges"] += len(xs)
        o[kind + "_sites"] += 1
    return out


def build(root, index, config=None):
    """The whole graph the viewer works with, without source text."""
    root = Path(root)
    config = config if config is not None else rules.load_config(root)
    # a static inline in a header has one node per unit: keep one, and count its calls once
    same, seen = {}, {}
    for nid, n in sorted(index["nodes"].items()):
        if not repo_func(n):
            continue
        key = (n["file"], n["line"], n["name"])
        if key in seen:
            same[nid] = seen[key]
        else:
            seen[key] = nid
    raw, sigs = [], set()
    for e in index["edges"]:
        e = dict(e, src=same.get(e["src"], e["src"]), dst=same.get(e["dst"], e["dst"]))
        sig = (e["src"], e["dst"], e["file"], e["line"], e["kind"], e["source"],
               *(e.get(k) for k in ("rule", "name", "slot", "via", "saved_from")))
        if sig not in sigs:
            sigs.add(sig)
            raw.append(e)
    index = dict(index, nodes={k: v for k, v in index["nodes"].items() if k not in same}, edges=raw)
    nodes = index["nodes"]
    # beside compiled C/C++, the other languages are tools around it: the diagram is drawn from the C
    # code, and the tools join it as script components (facts.scripts), as they did before tree-sitter
    if "gcc" in index.get("backends", {"gcc": 1}):
        c_only = {k: v for k, v in nodes.items() if v.get("lang", "c") in ("c", "cpp") or not v.get("defined")}
        lay = arch.layout(dict(index, nodes=c_only, edges=[e for e in index["edges"] if e["src"] in c_only and e["dst"] in c_only]), config)
    else:
        # the architecture is production code's: test files are left out of the diagram
        prod = {k: v for k, v in nodes.items() if v.get("scope") != "test"}
        lay = arch.layout(dict(index, nodes=prod, edges=[e for e in index["edges"] if e["src"] in prod and e["dst"] in prod]), config)
    funcs = {}
    for nid, n in nodes.items():
        if not repo_func(n):
            continue
        # tree-sitter knows where a definition ends; for C the body is found in the text
        end = n["end"] if n.get("end") else max(c_body_end(root / n["file"], n["line"]), n["line"])
        comp = arch.component(n["file"], config)
        # test code is a component of its own: server_test.go is not part of internal/httpapi's map
        if n.get("scope") == "test" and not any(p in ("test", "tests", "testing", "__tests__") for p in comp.split("/")):
            comp += " (tests)"
        funcs[nid] = dict(name=n["name"], file=n["file"], line=n["line"], end=end, comp=comp)
        for k in ("lang", "kind", "entry", "decorators", "scope", "types_incomplete"):
            if n.get(k) and not (k == "lang" and n[k] == "c") and not (k == "kind" and n[k] == "function"):
                funcs[nid][k] = n[k]
        # a repo function with the name of an external library's function replaces it for whoever
        # loads this code first (LD_PRELOAD): it is entered from outside the repo
        api = arch.external((n.get("declared") or "").rsplit(":", 1)[0])
        if api:
            funcs[nid]["api"] = api.removeprefix("external ")
        if end:
            top = min(n.get("top") or n["line"], docs.lead_line(root, n["file"], n["line"]))   # the comment, attributes and decorators above it
            if top < n["line"]:
                funcs[nid]["top"] = top
            if at := docs.atomics(root, n["file"], n["line"], end):
                funcs[nid]["atomics"] = at
    edges = []
    for e in raw:
        if e["source"] in CALL_SOURCES and e["src"] not in funcs:
            continue
        if e["source"] == "rule" and e["src"] not in funcs and e["dst"] not in funcs:
            continue
        if e["kind"] == "indirect" and e["source"] in CALL_SOURCES or e.get("rule") in ("exec", "build_define", "cross_lang"):
            continue                                  # calls through a pointer, and edges into sites: nothing to show
        x = dict(s=e["src"], d=e["dst"], f=e["file"], l=e["line"], k=e["kind"], src=e["source"])
        src_lines = lines(root / e["file"]) if in_repo(e["file"]) else []
        if 1 <= (e["line"] or 0) <= len(src_lines):
            x["t"] = src_lines[e["line"] - 1].strip()[:160]          # the evidence line, for the viewer's explanations
        for k in ("rule", "via", "slot", "saved_from", "name", "read_at", "table", "by", "resolution", "infer", "mode"):
            if e.get(k) is not None:
                x[k] = e[k]
        if e.get("resolution") == "ambiguous" and e.get("col"):
            x["c"] = e["col"]                  # several candidates of one call: the column tells the call apart
        if e["dst"] not in funcs:
            dn = nodes.get(e["dst"])
            x["dn"] = dn["name"] if dn else e["dst"]
            if dn and dn.get("file") and not in_repo(dn["file"]):
                x["ext"] = dn["file"]
            if dn and dn.get("placeholder"):
                x["ph"] = True                 # a package codemap could not read: known by name only
        edges.append(x)
    ambiguity = external_candidates(edges, funcs)
    headers = header_files(root)
    fdocs = docs.files_docs(root, sorted({f["file"] for f in funcs.values()} | headers))
    # scripts that read or set an environment variable can be opened from the search too
    env_files = {r.rsplit(":", 1)[0] for v in index.get("env", {}).values() for r in v.get("get", []) + v.get("set", [])}
    env_files = {f for f in env_files if (root / f).is_file()}
    readable = sorted({f["file"] for f in funcs.values()} | headers | build_files(root) | env_files | doc_files(root))
    syms = symbols(root, readable)
    comps = []
    for cid, c in lay["comps"].items():
        if not c["funcs"]:
            continue
        comp = dict(id=cid, files=len(c["files"]), funcs=len(c["funcs"]),
                    shared=cid in lay["shared"], layer=lay["layer"].get(cid),
                    callers=len(lay["callers"].get(cid, ())))
        # what the component is for: the top comment of its main.c, else of its file with most functions
        mine = sorted({f["file"] for f in funcs.values() if f["comp"] == cid})
        base = Path(cid).name
        main = [f for f in mine if Path(f).name == "main.c"] \
            + [f for f in mine if base in (fdocs.get(f) or {}).get("text", "")] \
            + sorted(mine, key=lambda f: -sum(1 for g in funcs.values() if g["file"] == f))
        # a component's own comment; one borrowed from a header of another component would describe that one
        doc = next((fdocs[f] for f in main if f in fdocs and arch.component(fdocs[f]["file"], config) == cid), None)
        # what the project says the component is for wins over any file's comment
        if config.get("describe", {}).get(cid):
            doc = dict(text=config["describe"][cid], file=".codemap/rules.json", line=0, own=True)
        if doc:
            comp["doc"] = doc
        comps.append(comp)
    shared_order = {cid: i for i, cid in enumerate(lay["shared"])}       # dependencies last
    comps.sort(key=lambda c: (c["shared"], shared_order[c["id"]] if c["shared"] else c["layer"] or 0, c["id"]))
    # a pair can have compiler calls and an environment variable: two links, counted apart
    links = []
    for a, b in sorted(lay["calls_n"].keys() | lay["started"].keys()):
        if lay["calls_n"][(a, b)]:
            links.append(dict(a=a, b=b, n=lay["calls_n"][(a, b)], kind="call"))
        if (a, b) in lay["started"]:
            env = sorted(lay["started"][(a, b)])
            links.append(dict(a=a, b=b, n=len(env), kind="env", names=env))
    # calls into an external API that another component interposes (LD_PRELOAD hooks)
    names = {c["id"] for c in comps}
    for (a, b, api), es in sorted(lay["interposed"].items()):
        if a in names and b in names:
            # where each hooked call is made, for the viewer's line detail
            sites = sorted({(e["src"], e["file"], e["line"], nodes.get(e["dst"], {}).get("name", e["dst"])) for e in es})
            links.append(dict(a=a, b=b, n=len(es), kind="interpose", api=api,
                              sites=[dict(s=s, f=f, l=l, name=nm) for s, f, l, nm in sites]))
    # data passed through a shared component, as declared in .codemap/rules.json "channels"
    for ch in config.get("channels", []):
        if ch.get("from") in names and ch.get("to") in names:
            links.append(dict(a=ch["from"], b=ch["to"], n=0, kind="channel", via=ch.get("via"), label=ch.get("label")))
    # the Python tools: components of their own, with what they run and which headers they read
    built = facts.products(root, config)
    py_comps, py_links = facts.scripts(root, index, config, built, {c["id"] for c in comps if c["shared"]})
    # a repository read by tree-sitter has its Python as components already
    py_comps = [c for c in py_comps if c["id"] not in names]
    comps += py_comps
    links += [l for l in py_links if l["b"] in names]
    readable = sorted(set(readable) | {f for c in py_comps for f in c["scripts"]})     # the scripts open in the viewer
    st = index.get("stats", {})
    out = dict(format=FORMAT, version=VERSION, **repo_info(root), root=str(root.resolve()), generated=int(time.time()),
               stats=dict(units=st.get("units"), failed=st.get("failed"), funcs=len(funcs),
                          edges=sum(1 for x in edges if x["src"] == "compiler"),
                          syntax=sum(1 for x in edges if x["src"] == "syntax"),
                          static=sum(1 for x in edges if x["src"] == "static"),
                          # the analyzers' results, per backend: python, go
                          resolution={name: b["resolution"] for name, b in index.get("backends", {}).items() if b.get("resolution")},
                          # what the analyzers could not do fully, for the reader to weigh their results
                          limits={name: dict(messages=len(b.get("errors", [])), placeholders=b.get("placeholders", []),
                                             incomplete=b.get("incomplete_files", 0))
                                  for name, b in index.get("backends", {}).items() if b.get("errors") or b.get("placeholders")},
                          tests=sum(1 for n in nodes.values() if n.get("scope") == "test" and repo_func(n)),
                          # ambiguous calls whose candidates are all outside methods of one name apart
                          # from those with candidates in the repository, per backend
                          ambiguity=ambiguity,
                          # the compiler that read the code, so a result can be reproduced
                          compilers={name: dict(version=b["typescript"], source=b.get("typescript_from"), cache=b.get("cache"))
                                     for name, b in index.get("backends", {}).items() if b.get("typescript")},
                          languages={k: v for b in index.get("backends", {}).values() for k, v in b.get("languages", {}).items()},
                          frameworks=index.get("frameworks", [])),
               comps=comps, links=links, funcs=funcs, edges=edges, state=state.shared_state(root, funcs),
               files={f: d for f, d in fdocs.items() if any(g["file"] == f for g in funcs.values())},
               env=index.get("env", {}), env_info=facts.env_meaning(root, funcs, index.get("env", {}), config),
               uncompiled=facts.uncompiled_calls(root, funcs, edges), uncompiled_funcs=facts.uncompiled_funcs(root, funcs),
               readable=readable, symbols=syms,
               docs=doc_summaries(root, readable, readable),
               phases={k: [ph for ph in v if isinstance(ph, dict) and ph.get("name") and ph.get("from")]
                       for k, v in config.get("phases", {}).items() if isinstance(v, list)},
               build=built, writes=facts.writes(root, funcs),
               worth=facts.worth_checking(root, funcs, edges, readable, syms),
               config=dict(cc=index.get("cc"), scope=index.get("scope")))
    return out


def notes_files(root, notes=None):
    root = Path(root)
    if notes:
        return [p for p in (root / n for n in notes) if p.is_file()]   # an absolute n stays absolute
    return [p for p in [root / "CODEMAP.md"] if p.is_file()]


def checks(root, index, notes=None):
    out = []
    for p in notes_files(root, notes):
        r = check.check(root, p, index)
        out.append(dict(file=r["file"], refs=r["refs"], claims=r["claims"], items=r["items"]))
    return out


def source(root, file, start=1, end=None):
    """Lines start..end (1-based, inclusive) of a file inside the repository."""
    root = Path(root).resolve()
    p = (root / file).resolve()
    if root not in p.parents or not p.is_file():
        return None
    src = p.read_text(errors="replace").splitlines()     # not cached: the viewer shows the file as it is now
    end = min(end or len(src), len(src))
    return dict(file=file, start=start, lines=src[start - 1:end])


def grep(root, files, query, limit=40):
    """[{file, line, text}]: lines of the given files that contain query, in file order, at most
    limit. For words the graph has no name for: overrun, SIGTERM, ENOSYS. Case is ignored for a
    plain lowercase word; a name with a capital or an underscore (on_signal, SIGTERM) must match as
    written, so on_signal does not find IBMON_SIGNALS_H."""
    raw = query.strip()
    exact = bool(re.search(r"[A-Z_]", raw))
    q = raw if exact else raw.lower()
    if len(q) < 2:
        return []
    root = Path(root).resolve()
    out = []
    for f in sorted(files, key=lambda f: (not f.endswith((".c", ".h")), f)):    # the C sources first
        p = (root / f).resolve()
        if root not in p.parents or not p.is_file():
            continue
        try:
            text = p.read_text(errors="replace")
        except OSError:
            continue
        if q not in (text if exact else text.lower()):
            continue
        for i, ln in enumerate(text.splitlines(), 1):
            if q in (ln if exact else ln.lower()):
                out.append(dict(file=f, line=i, text=ln.strip()[:200]))
                if len(out) >= limit:
                    return out
    return out


def with_sources(root, graph):
    """A copy of the graph with each function's source lines, as a snapshot stores it."""
    funcs = {k: dict(f, src=lines(Path(root) / f["file"])[f.get("top", f["line"]) - 1:f["end"]])
             for k, f in graph["funcs"].items()}
    return dict(graph, funcs=funcs)


def snapshot(root, index, config=None, notes=None, graph=None):
    """The graph with source text and the notes checked now: what a .codemap file holds.
    graph: one already built from this index (the server's cache)."""
    now = {} if graph is None else dict(**repo_info(root), generated=int(time.time()))   # a cached graph is from earlier
    g = graph or build(root, index, config)
    return with_sources(root, dict(g, **now, checks=checks(root, index, notes)))


def pack(data):
    """A snapshot as stored in a .codemap file: gzip-compressed JSON."""
    return gzip.compress(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)


def snapshot_name(data, ext=".codemap"):
    return f'{data["repo"]}-{data["commit"] or "workdir"}{ext}'


def write_snapshot(path, data):
    Path(path).write_bytes(pack(data))

