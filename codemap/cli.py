"""codemap: a static map of a codebase for people and AI.

  codemap index [--scope DIR ...]   Layer 1 and 2: build .codemap/index.json
  codemap callers NAME               who calls NAME (compiler and rule edges)
  codemap callees NAME               what NAME calls
  codemap where NAME                 definition of NAME
  codemap relations [NAME]           rule edges: pointers, env, exec, build, cross-language
  codemap arch                       write the Architecture section of CODEMAP.md and a diagram
  codemap check [FILE ...]           validate file:line references and call claims
"""

import argparse
import json
import sys
import time
from pathlib import Path

from . import arch, check, layer1, rules

INDEX = Path(".codemap") / "index.json"
CALLISH = ("call", "indirect_candidate", "indirect_saved", "fnptr_assign", "constructor", "destructor")


def load(root):
    p = root / INDEX
    if not p.exists():
        sys.exit(f"{p} not found: run `codemap index` first")
    return json.loads(p.read_text())


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
    t = e["source"] if e["source"] == "compiler" else f'rule {e["rule"]}'
    return f"[{t}, {e['kind']}]" if e["kind"] not in ("call", e.get("rule")) else f"[{t}]"


def cmd_index(a):
    t = time.time()
    root = Path(a.root).resolve()
    scope = a.scope or rules.load_config(root).get("scope")
    idx = layer1.build(root, scope, a.jobs, a.cc or rules.load_config(root).get("cc"))
    idx = rules.run(root, idx, rules.load_config(root))
    idx["root"] = str(root)
    idx["scope"] = scope
    (root / INDEX).write_text(json.dumps(idx, indent=1))
    st = idx["stats"]
    print(f'{st["units"]} units ({st["compiled"]} compiled, {st["cached"]} cached, {st["failed"]} failed) '
          f'in {time.time() - t:.2f} s')
    print(f'{st["nodes"]} functions, {st["edges"]} compiler edges, {st["indirect"]} indirect '
          f'({st.get("indirect_unresolved", "?")} unresolved), {st["compiler_inserted"]} compiler-inserted calls dropped')
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
    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
