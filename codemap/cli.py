"""codemap: a static map of a codebase for people and AI.

  codemap index [--scope DIR ...]   Layer 1 and 2: build .codemap/index.json
  codemap callers NAME               who calls NAME (compiler and rule edges)
  codemap callees NAME               what NAME calls
  codemap where NAME                 definition of NAME
  codemap relations [NAME]           rule edges: pointers, env, exec, build, cross-language
  codemap arch                       write the Architecture section of CODEMAP.md and a diagram
  codemap check [FILE ...]           validate file:line references and call claims
  codemap serve [--port 7300]        open the viewer on the live index (needs the viewer extra)
  codemap export [-o FILE] [--html]  write a .codemap snapshot, or one HTML file with the viewer inside
  codemap viewer [-o DIR]            write the static viewer, which opens .codemap snapshots
"""

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

from . import arch, backends, check, frameworks, layer1, rules, view

INDEX = Path(".codemap") / "index.json"
CALLISH = ("call", "indirect_candidate", "indirect_saved", "fnptr_assign", "constructor", "destructor")


def load(root):
    p = root / INDEX
    if not p.exists():
        sys.exit(f"{p} not found: run `codemap index` first")
    return json.loads(p.read_text(encoding="utf-8"))


def resolve(index, name, required=True):
    nodes = index["nodes"]
    hits = [nid for nid, n in nodes.items() if nid == name or n["name"] == name]
    if not hits and required:
        sys.exit(f"no symbol {name!r} in the index")
    return hits


def fmt_node(index, nid):
    n = index["nodes"].get(nid)
    if not n:
        return nid
    where = f'{n["file"]}:{n["line"]}' if n.get("line") else n.get("file", "")
    return f'{n["name"]}  ({where})' if n.get("defined") else f'{n["name"]}  (declared {where})'


def edge_tag(e):
    t = e["source"] if e["source"] in ("compiler", "static", "syntax") else f'{e["source"]} {e.get("rule", "")}'.strip()
    return f"[{t}, {e['kind']}]" if e["kind"] not in ("call", e.get("rule")) else f"[{t}]"


def backends_langs():
    from .backends import syntax
    return ["C/C++ with compile_commands.json"] + syntax.available()


def cmd_index(a):
    t = time.time()
    root = Path(a.root).resolve()
    cfg = rules.load_config(root)
    scope = a.scope or cfg.get("scope")
    cc = a.cc or cfg.get("cc")
    if not backends.plan(root, cfg):
        sys.exit(f"codemap: nothing to read in {root}: no compile_commands.json and no source file in a language "
                 f"codemap reads ({', '.join(backends_langs())})")
    idx = backends.build(root, scope, a.jobs, cc, cfg)
    layer1.progress("applying rules (env, exec, function pointers, LD_PRELOAD)")
    idx = rules.run(root, idx, cfg)
    layer1.progress("applying framework adapters")
    idx = frameworks.run(root, idx, cfg)
    layer1.progress("")
    idx["root"] = str(root)
    idx["scope"] = scope
    idx["cc"] = cc                             # None: the gcc or g++ each unit names
    (root / INDEX).parent.mkdir(parents=True, exist_ok=True)
    tmp = (root / INDEX).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(idx, indent=1), encoding="utf-8")
    os.replace(tmp, root / INDEX)              # a running `codemap serve` never reads half a file
    st = idx["stats"]
    if "gcc" in idx["backends"]:
        print(f'{st["units"]} units ({st["compiled"]} compiled, {st["cached"]} cached, {st["failed"]} failed) '
              f'in {time.time() - t:.2f} s')
        gb = idx["backends"]["gcc"]
        print(f'{gb["nodes"]} functions, {gb["edges"]} compiler edges, {st["indirect"]} indirect '
              f'({st.get("indirect_unresolved", "?")} unresolved), {st["compiler_inserted"]} compiler-inserted calls dropped')
    if "python" in idx["backends"]:
        px = idx["backends"]["python"]
        r = px["resolution"]
        print(f'python: {px["files"]} files, {px["nodes"]} definitions, calls {r.get("exact", 0)} exact, '
              f'{r.get("inferred", 0)} inferred, {r.get("ambiguous", 0)} ambiguous, {r.get("unresolved", 0)} unresolved '
              f'({r.get("builtin", 0)} on built-in types not counted)')
        for err in px.get("errors", [])[:5]:
            print(f"  could not parse {err}")
    if "syntax" in idx["backends"]:
        sx = idx["backends"]["syntax"]
        print(f'tree-sitter: {sx["files"]} files ({", ".join(f"{k} {v}" for k, v in sorted(sx["languages"].items()))}), '
              f'{sx["nodes"]} definitions, {sx["edges"]} calls matched by name in {time.time() - t:.2f} s')
        for err in sx.get("errors", [])[:5]:
            print(f"  could not read {err}")
    if st.get("framework_edges"):
        print("framework adapters: " + ", ".join(f"{k} {v}" for k, v in st["framework_edges"].items()))
    print("rule edges: " + ", ".join(f"{k} {v}" for k, v in st.get("rule_edges", {}).items()))
    for u in idx["units"]:
        if u["status"] == "failed":
            print(f'failed: {u["file"]}\n  {u["error"].splitlines()[-1] if u["error"] else ""}')


def cmd_edges(a, direction):
    root = Path(a.root).resolve()
    idx = load(root)
    targets = set(resolve(idx, a.name))
    key, other = ("dst", "src") if direction == "callers" else ("src", "dst")
    es = [e for e in idx["edges"] if e[key] in targets and (a.all or e["kind"] in CALLISH)]
    if not es:
        print(f"no {direction} found (an empty result can also mean the file is outside compile_commands.json)")
    for e in sorted(es, key=lambda e: (e["file"], e["line"])):
        print(f'{e["file"]}:{e["line"]}  {fmt_node(idx, e[other])}  {edge_tag(e)}')


def cmd_where(a):
    idx = load(Path(a.root).resolve())
    for nid in resolve(idx, a.name):
        print(fmt_node(idx, nid))


def cmd_relations(a):
    idx = load(Path(a.root).resolve())
    want = set(resolve(idx, a.name, required=False)) if a.name else None
    for e in idx["edges"]:
        if e["source"] != "rule" or (a.rule and e["rule"] != a.rule):
            continue
        if a.name and not ({e["src"], e["dst"]} & want) and e.get("name") != a.name:
            continue
        extra = {k: v for k, v in e.items() if k not in ("src", "dst", "file", "line", "kind", "source", "rule", "key")}
        print(f'{e["file"]}:{e["line"]}  {e["rule"]}  {idx["nodes"].get(e["src"], {}).get("name", e["src"])} -> '
              f'{idx["nodes"].get(e["dst"], {}).get("name", e["dst"])}  {json.dumps(extra) if extra else ""}')


def cmd_arch(a):
    root = Path(a.root).resolve()
    idx = load(root)
    cfg = rules.load_config(root)
    svg = root / ".codemap" / "architecture.svg"
    arch.diagram(idx, cfg, svg)
    p = arch.write_codemap(root, arch.render(idx, cfg, svg_name=".codemap/architecture.svg"))
    print(f"wrote {p.relative_to(root)} and {svg.relative_to(root)}")


def cmd_check(a):
    root = Path(a.root).resolve()
    idx = load(root)
    files = a.files or ["CODEMAP.md"]
    bad = 0
    for f in files:
        r = check.check(root, root / f, idx)
        for p in r["problems"]:
            print(p)
        print(f'{f}: {r["refs"]} references, {r["claims"]} call claims, {len(r["problems"])} problems')
        bad += len(r["problems"])
    sys.exit(1 if bad else 0)


def missing_notes(root, notes):
    gone = [n for n in notes or [] if not (root / n).is_file()]
    if gone:
        sys.exit(f"--notes: {', '.join(gone)} not found")


def cmd_serve(a):
    from . import server
    root = Path(a.root).resolve()
    missing_notes(root, a.notes)
    if not (root / INDEX).exists():
        sys.exit(f"{root / INDEX} not found: run `codemap index` first")
    server.serve(root, a.host, a.port, a.notes)


def cmd_export(a):
    from . import server
    root = Path(a.root).resolve()
    missing_notes(root, a.notes)
    data = view.snapshot(root, load(root), rules.load_config(root), a.notes)
    out = Path(a.output or view.snapshot_name(data, ".html" if a.html else ".codemap"))
    if a.html:
        out.write_text(server.standalone_html(data), encoding="utf-8")
    else:
        view.write_snapshot(out, data)
    dirty = f', {len(data["dirty"])} uncommitted files not in the commit' if data["dirty"] else ""
    print(f'wrote {out} ({out.stat().st_size / 1024:.0f} KB): {data["stats"]["funcs"]} functions, '
          f'{len(data["edges"])} edges{dirty}')


def cmd_viewer(a):
    from . import server
    out = Path(a.output)
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(server.viewer_html(), encoding="utf-8")
    if (server.ASSETS / "assets").is_dir():
        shutil.copytree(server.ASSETS / "assets", out / "assets", dirs_exist_ok=True)   # the Chinese font
    print(f"wrote {out / 'index.html'} and its fonts: open it and pick a .codemap file, or add ?snapshot=URL")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="codemap", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-C", dest="root", default=".", help="repository root (default: current directory)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("index")
    s.add_argument("--scope", nargs="*", help="only translation units under these directories")
    s.add_argument("-j", "--jobs", type=int)
    s.add_argument("--cc", help="GCC to compile with (default: gcc, or the database's compiler if it is GCC)")
    s.set_defaults(fn=cmd_index)
    for d in ("callers", "callees"):
        s = sub.add_parser(d)
        s.add_argument("name")
        s.add_argument("--all", action="store_true", help="include every rule edge, not only calls")
        s.set_defaults(fn=lambda a, d=d: cmd_edges(a, d))
    s = sub.add_parser("where")
    s.add_argument("name")
    s.set_defaults(fn=cmd_where)
    s = sub.add_parser("relations")
    s.add_argument("name", nargs="?")
    s.add_argument("--rule")
    s.set_defaults(fn=cmd_relations)
    s = sub.add_parser("arch")
    s.set_defaults(fn=cmd_arch)
    s = sub.add_parser("check")
    s.add_argument("files", nargs="*")
    s.set_defaults(fn=cmd_check)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=7300)
    s.add_argument("--notes", nargs="*", help="Markdown files the check page validates (default: CODEMAP.md)")
    s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("export")
    s.add_argument("-o", "--output")
    s.add_argument("--html", action="store_true", help="one HTML file with the viewer and the snapshot")
    s.add_argument("--notes", nargs="*")
    s.set_defaults(fn=cmd_export)
    s = sub.add_parser("viewer")
    s.add_argument("-o", "--output", default="codemap-viewer")
    s.set_defaults(fn=cmd_viewer)
    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
