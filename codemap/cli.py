"""codemap: a static map of a codebase for people and AI.

Start here, in the repository:
  codemap index                      1. read the code (again after it changes)
  codemap describe FILE -o prompt.md 2. optional: have an AI say what each function does (codemap describe -h)
  codemap serve                      3. open the map in a browser: http://127.0.0.1:7300/
  codemap export --html                 or one HTML file with the map, to open anywhere

Every command:
  codemap index [--scope DIR ...]   Layer 1 and 2: build .codemap/index.json
  codemap callers NAME               who calls NAME (compiler and rule edges)
  codemap callees NAME               what NAME calls
  codemap where NAME                 definition of NAME, and what it does
  codemap describe [FILE ...]        AI descriptions: write the prompt, --apply the answer, --status
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

from . import arch, backends, check, describe, docs, frameworks, layer1, rules, view

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


def desc_lines(root, idx, nid, ai=None):
    """What is known about what a function does, one kind per line: its author's line, an AI's description
    with its state, and the facts (who calls it, what it calls)."""
    n = idx["nodes"].get(nid)
    if not n or not n.get("defined") or not n.get("line"):
        return []
    out = []
    if doc := docs.func_doc(root, n["file"], n["line"], n.get("lang", "c")):
        out.append(f"doc: {doc}")
    entry = (ai if ai is not None else describe.load(root)).get(nid)
    if entry:
        st = describe.state(root, idx, nid, entry)
        for lang in describe.LANGS:
            if entry.get("text", {}).get(lang):
                out.append(f"ai {lang} ({st}): {entry['text'][lang]}")
    ins, outs = describe.neighbours(idx, nid)
    out.append(f"facts: called by {len(ins)} function{'s' * (len(ins) != 1)}, calls {len(outs)}")
    return out


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
    for lang in ("python", "go", "typescript"):
        if lang not in idx["backends"]:
            continue
        px = idx["backends"][lang]
        r = px["resolution"]
        print(f'{lang}: {px["files"]} files, {px["nodes"]} definitions, calls {r.get("exact", 0)} exact, '
              f'{r.get("inferred", 0)} inferred, {r.get("ambiguous", 0)} ambiguous, {r.get("unresolved", 0)} unresolved'
              + (f' ({r.get("builtin", 0)} on built-in types not counted)' if lang == "python" else "")
              + (f', {px["refs"]} functions handed on as values' if px.get("refs") else ""))
        errs = px.get("errors", [])
        if errs:
            # a package the type checker could not fully read (a module not downloaded, a newer Go):
            # the calls around it are still mapped
            print(f"  {len(errs)} messages from the {'parser' if lang == 'python' else 'type checker'}, first: "
                  + "; ".join(e.replace(str(root) + "/", "") for e in errs[:3]))
    if "syntax-go" in idx["backends"]:
        print(f'go: {idx["backends"]["syntax-go"]["files"]} files read by tree-sitter (no Go toolchain)')
    if "syntax-typescript" in idx["backends"]:
        print(f'typescript: {idx["backends"]["syntax-typescript"]["files"]} files read by tree-sitter (no Node or no TypeScript)')
    if "typescript" in idx["backends"]:
        tb = idx["backends"]["typescript"]
        c = tb.get("cache")
        if c:
            print(f'  program cache: {c["replayed"]} replayed, {c["rebuilt"]} rebuilt'
                  + (" (" + ", ".join(f"{k}: {v}" for k, v in sorted(c["why"].items())) + ")" if c["why"] else "")
                  + f'; {c["entries"]} entries, {c["mb"]} MB' + (f', {c["removed"]} removed' if c["removed"] else ""))
        print(f'  TypeScript {tb.get("typescript")} from {tb.get("typescript_from")}, {tb.get("programs")} programs'
              + ('; modules not found: ' + ", ".join(tb["placeholders"][:8]) + (" ..." if len(tb["placeholders"]) > 8 else "")
                 if tb.get("placeholders") else ""))
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
    next_steps(root, idx)


def next_steps(root, idx):
    """What to do with the index just built: open it, take it along, and how many functions say what they do."""
    funcs = [(nid, n) for nid, n in idx["nodes"].items()
             if n.get("defined") and n.get("line") and n.get("kind") not in ("module", "file") and n.get("scope") != "test"]
    ai = describe.load(root)
    told = sum(1 for nid, n in funcs if nid in ai or docs.func_doc(root, n["file"], n["line"], n.get("lang", "c")))
    print("\nnext:")
    # descriptions first: the map shows them, and a snapshot keeps only what is there when it is written
    if funcs and told < len(funcs):
        print(f"  codemap describe FILE         {len(funcs) - told} of {len(funcs)} functions have no comment or description: "
              "have an AI write them (optional)")
    print("  codemap serve                 open the map: http://127.0.0.1:7300/ (from a laptop: ssh -L 7300:localhost:7300 HOST)")
    print("  codemap export --html         or one HTML file with the map, to open anywhere")


def cmd_edges(a, direction):
    root = Path(a.root).resolve()
    idx = load(root)
    targets = set(resolve(idx, a.name))
    key, other = ("dst", "src") if direction == "callers" else ("src", "dst")
    es = [e for e in idx["edges"] if e[key] in targets and (a.all or e["kind"] in CALLISH)]
    if not es:
        print(f"no {direction} found (an empty result can also mean the file is outside compile_commands.json)")
    ai = describe.load(root) if a.describe else None
    for e in sorted(es, key=lambda e: (e["file"], e["line"])):
        print(f'{e["file"]}:{e["line"]}  {fmt_node(idx, e[other])}  {edge_tag(e)}')
        if a.describe:                                        # what the function on the other side does
            for ln in desc_lines(root, idx, e[other], ai):
                print("    " + ln)


def cmd_where(a):
    root = Path(a.root).resolve()
    idx = load(root)
    ai = describe.load(root)
    for nid in resolve(idx, a.name):
        print(fmt_node(idx, nid))
        for ln in desc_lines(root, idx, nid, ai):
            print("  " + ln)


def cmd_describe(a):
    """Write the prompt for an AI to describe the functions of some files, or keep its answer, or say where
    the kept descriptions stand."""
    root = Path(a.root).resolve()
    idx = load(root)
    if a.apply:
        text = sys.stdin.read() if a.apply == "-" else Path(a.apply).read_text(encoding="utf-8")
        try:
            kept, rejected = describe.apply(root, idx, text, by=a.by)
        except ValueError as e:
            sys.exit(f"the answer is not JSON: {e}")
        for nid, bad in rejected.items():
            print(f"not kept: {nid}: " + "; ".join(bad))
        print(f"kept {len(kept)} descriptions in {describe.FILE}" + (f", {len(rejected)} not kept" if rejected else ""))
        sys.exit(1 if rejected else 0)
    if a.status or not a.files:
        r = describe.report(root, idx)
        total = sum(1 for n in idx["nodes"].values() if n.get("defined") and n.get("kind") not in ("module", "file") and n.get("line"))
        for st in ("stale", "wrong"):
            for nid in r[st]:
                print(f"{st}: {fmt_node(idx, nid)}")
        print(f"{len(r['ok'])} up to date, {len(r['stale'])} stale (the function changed), {len(r['wrong'])} wrong, "
              f"{total - sum(map(len, r.values()))} functions without one")
        if not a.files:
            print("describe a file: codemap describe FILE [--missing] > prompt.md")
        return
    files = [str(Path(f).resolve().relative_to(root)) if Path(f).is_absolute() or (root / f).exists() is False and Path(f).exists() else f for f in a.files]
    text, n = describe.prompt(root, idx, files, only_missing=a.missing)
    if not n:
        sys.exit("no functions to describe in " + ", ".join(files) + (" (all up to date)" if a.missing else ""))
    if a.output:
        Path(a.output).write_text(text, encoding="utf-8")
        print(f"wrote the prompt for {n} functions to {a.output}")
    else:
        print(text)


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
    # the AI descriptions kept: one that cites what the code does not have is a problem; a stale one is said
    if describe.path(root).exists():
        r = describe.report(root, idx)
        for nid in r["wrong"]:
            print(f"{describe.FILE}: {fmt_node(idx, nid)}: " + "; ".join(describe.problems(root, idx, nid, describe.load(root)[nid])))
        for nid in r["stale"]:
            print(f"{describe.FILE}: {fmt_node(idx, nid)}: the function changed since it was described (codemap describe --missing)")
        print(f"{describe.FILE}: {len(r['ok'])} up to date, {len(r['stale'])} stale, {len(r['wrong'])} wrong")
        bad += len(r["wrong"])
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
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("index")
    s.add_argument("--scope", nargs="*", help="only translation units under these directories")
    s.add_argument("-j", "--jobs", type=int)
    s.add_argument("--cc", help="GCC to compile with (default: gcc, or the database's compiler if it is GCC)")
    s.set_defaults(fn=cmd_index)
    for d in ("callers", "callees"):
        s = sub.add_parser(d)
        s.add_argument("name")
        s.add_argument("--all", action="store_true", help="include every rule edge, not only calls")
        s.add_argument("-d", "--describe", action="store_true", help="what each function on the list does")
        s.set_defaults(fn=lambda a, d=d: cmd_edges(a, d))
    s = sub.add_parser("where")
    s.add_argument("name")
    s.set_defaults(fn=cmd_where)
    s = sub.add_parser("describe", help="AI descriptions of functions: a prompt for some files, or keep the answer")
    s.add_argument("files", nargs="*", help="files whose functions to describe (prints the prompt)")
    s.add_argument("--missing", action="store_true", help="only functions without an up-to-date description")
    s.add_argument("-o", "--output", help="write the prompt here")
    s.add_argument("--apply", metavar="ANSWER", help="keep the AI's JSON answer (- for standard input)")
    s.add_argument("--by", default="ai", help="who wrote the answer, kept with it (e.g. claude-opus-5-5)")
    s.add_argument("--status", action="store_true", help="how many are up to date, stale or wrong")
    s.set_defaults(fn=cmd_describe)
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
    if not a.cmd:                                     # `codemap` alone: how to start, not an error
        print(__doc__)
        return
    a.fn(a)


if __name__ == "__main__":
    main()
