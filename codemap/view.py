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
    lay = arch.layout(index, config)
    funcs = {}
    for nid, n in nodes.items():
        if not repo_func(n):
            continue
        end = max(c_body_end(root / n["file"], n["line"]), n["line"])   # 0 when the file is gone
        funcs[nid] = dict(name=n["name"], file=n["file"], line=n["line"], end=end,
                          comp=arch.component(n["file"], config))
        # a repo function with the name of an external library's function replaces it for whoever
        # loads this code first (LD_PRELOAD): it is entered from outside the repo
        api = arch.external((n.get("declared") or "").rsplit(":", 1)[0])
        if api:
            funcs[nid]["api"] = api.removeprefix("external ")
        if end:
            top = docs.lead_line(root, n["file"], n["line"])   # the comment and attributes above it
            if top < n["line"]:
                funcs[nid]["top"] = top
            if at := docs.atomics(root, n["file"], n["line"], end):
                funcs[nid]["atomics"] = at
    edges = []
    for e in raw:
        if e["source"] == "compiler" and e["src"] not in funcs:
            continue
        if e["source"] == "rule" and e["src"] not in funcs and e["dst"] not in funcs:
            continue
        if e["kind"] == "indirect" and e["source"] == "compiler" or e.get("rule") in ("exec", "build_define", "cross_lang"):
            continue                                  # calls through a pointer, and edges into sites: nothing to show
        x = dict(s=e["src"], d=e["dst"], f=e["file"], l=e["line"], k=e["kind"], src=e["source"])
        src_lines = lines(root / e["file"]) if in_repo(e["file"]) else []
        if 1 <= (e["line"] or 0) <= len(src_lines):
            x["t"] = src_lines[e["line"] - 1].strip()[:160]          # the evidence line, for the viewer's explanations
        for k in ("rule", "via", "slot", "saved_from", "name", "read_at", "table"):
            if e.get(k) is not None:
                x[k] = e[k]
        if e["dst"] not in funcs:
            dn = nodes.get(e["dst"])
            x["dn"] = dn["name"] if dn else e["dst"]
            if dn and dn.get("file") and not in_repo(dn["file"]):
                x["ext"] = dn["file"]
        edges.append(x)
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
    comps += py_comps
    links += [l for l in py_links if l["b"] in names]
    readable = sorted(set(readable) | {f for c in py_comps for f in c["scripts"]})     # the scripts open in the viewer
    st = index.get("stats", {})
    out = dict(format=FORMAT, version=VERSION, **repo_info(root), root=str(root.resolve()), generated=int(time.time()),
               stats=dict(units=st.get("units"), failed=st.get("failed"), funcs=len(funcs),
                          edges=sum(1 for x in edges if x["src"] == "compiler")),
               comps=comps, links=links, funcs=funcs, edges=edges, state=state.shared_state(root, funcs),
               files={f: d for f, d in fdocs.items() if any(g["file"] == f for g in funcs.values())},
               env=index.get("env", {}), env_info=facts.env_meaning(root, funcs, index.get("env", {}), config),
               uncompiled=facts.uncompiled_calls(root, funcs, edges),
               readable=readable, symbols=syms,
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

