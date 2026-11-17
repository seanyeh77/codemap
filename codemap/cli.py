"""codemap: a static map of a codebase for people and AI.

Start here, in the repository:
  codemap index                      1. read the code (again after it changes)
  codemap describe                   2. optional: prompts for an AI to say what each function does (codemap describe -h)
  codemap serve                      3. open the map in a browser: http://127.0.0.1:7300/
  codemap export --html                 or one HTML file with the map, to open anywhere

Every command:
  codemap index [--scope DIR ...]   Layer 1 and 2: build .codemap/index.json
  codemap callers NAME               who calls NAME (compiler and rule edges)
  codemap callees NAME               what NAME calls
  codemap where NAME                 definition of NAME, and what it does
  codemap describe [FILE ...]        AI descriptions: prompts for what is not described, --apply the answers, --status
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

from . import arch, backends, check, describe, describe_items, docs, term, frameworks, layer1, rules, view

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
    ui = term.ui()
    idx = backends.build(root, scope, a.jobs, cc, cfg)                  # one step per language
    with ui.step("Rules and framework adapters") as st:
        ui.detail("env, exec, function pointers, LD_PRELOAD")
        idx = rules.run(root, idx, cfg)
        ui.detail("framework adapters")
        idx = frameworks.run(root, idx, cfg)
        rel = idx["stats"].get("rule_edges", {})
        fw = idx["stats"].get("framework_edges", {})
        n = sum(rel.values()) + sum(fw.values())
        st.done(f"{n} relation{'s' * (n != 1)} (each kind in the log)" if n else "nothing found")
    with ui.step(f"Write {INDEX}"):
        idx["root"] = str(root)
        idx["scope"] = scope
        idx["cc"] = cc                             # None: the gcc or g++ each unit names
        (root / INDEX).parent.mkdir(parents=True, exist_ok=True)
        tmp = (root / INDEX).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(idx, indent=1), encoding="utf-8")
        os.replace(tmp, root / INDEX)              # a running `codemap serve` never reads half a file
    # every number and message to the log; on screen, what it adds up to and what needs looking at
    details = index_details(root, idx, t)
    log = root / ".codemap" / "index.log"
    log.write_text("\n".join(details) + "\n", encoding="utf-8")
    if a.verbose:
        print("\n".join(details))
    print()
    for ln in index_summary(idx, time.time() - t).splitlines():
        print(term.fit(ln))
    failed = [u for u in idx["units"] if u["status"] == "failed"]
    if failed:
        ui.say(f"{len(failed)} unit{'s' * (len(failed) != 1)} did not compile (their calls are missing): "
               + ", ".join(u["file"] for u in failed[:3]) + (" ..." if len(failed) > 3 else ""), "warn")
    msgs = sum(len(b.get("errors", [])) for b in idx["backends"].values() if isinstance(b, dict))
    if msgs:
        ui.say(f"{msgs} message{'s' * (msgs != 1)} from the analyzers (the calls around them are still mapped)", "warn")
    print(f"details: {log.relative_to(Path.cwd()) if log.is_relative_to(Path.cwd()) else log}"
          + ("" if a.verbose else "  (or codemap index -v)"))
    next_steps(root, idx)


def index_summary(idx, secs):
    """One line: how many functions and calls, and how sure the calls are."""
    nodes = [n for n in idx["nodes"].values() if n.get("defined") and n.get("kind") != "site" and n.get("line")]
    res = {}
    for b in idx["backends"].values():
        for k, v in (b.get("resolution") or {}).items() if isinstance(b, dict) else []:
            res[k] = res.get(k, 0) + v
    calls = sum(1 for e in idx["edges"] if e.get("kind") in CALLISH)
    sure = [f"{res[k]} {k}" for k in ("exact", "inferred", "ambiguous") if res.get(k)]
    tests = sum(1 for n in nodes if n.get("scope") == "test")
    head = f"{len(nodes)} functions" + (f" ({tests} in tests)" if tests else "") + f", {calls} calls, in {secs:.1f} s"
    how = ", ".join(sure) + (f"; {res['unresolved']} not resolved (left out, never guessed)" if res.get("unresolved") else "")
    return head + (f"\n  calls: {how}" if how else "")


def index_details(root, idx, t):
    """Every number of the run, as the log keeps them."""
    out = []
    p = out.append
    st = idx["stats"]
    if "gcc" in idx["backends"]:
        p(f'{st["units"]} units ({st["compiled"]} compiled, {st["cached"]} cached, {st["failed"]} failed)')
        gb = idx["backends"]["gcc"]
        p(f'{gb["nodes"]} functions, {gb["edges"]} compiler edges, {st["indirect"]} indirect '
          f'({st.get("indirect_unresolved", "?")} unresolved), {st["compiler_inserted"]} compiler-inserted calls dropped')
    for lang in ("python", "go", "typescript"):
        if lang not in idx["backends"]:
            continue
        px = idx["backends"][lang]
        r = px["resolution"]
        p(f'{lang}: {px["files"]} files, {px["nodes"]} definitions, calls {r.get("exact", 0)} exact, '
          f'{r.get("inferred", 0)} inferred, {r.get("ambiguous", 0)} ambiguous, {r.get("unresolved", 0)} unresolved'
          + (f' ({r.get("builtin", 0)} on built-in types not counted)' if lang == "python" else "")
          + (f', {px["refs"]} functions handed on as values' if px.get("refs") else ""))
        for e in px.get("errors", []):
            # a package the type checker could not fully read (a module not downloaded, a newer Go):
            # the calls around it are still mapped
            p(f"  {'parser' if lang == 'python' else 'type checker'}: " + e.replace(str(root) + "/", ""))
    if "syntax-go" in idx["backends"]:
        p(f'go: {idx["backends"]["syntax-go"]["files"]} files read by tree-sitter (no Go toolchain)')
    if "syntax-typescript" in idx["backends"]:
        p(f'typescript: {idx["backends"]["syntax-typescript"]["files"]} files read by tree-sitter (no Node or no TypeScript)')
    if "typescript" in idx["backends"]:
        tb = idx["backends"]["typescript"]
        c = tb.get("cache")
        if c:
            p(f'  program cache: {c["replayed"]} replayed, {c["rebuilt"]} rebuilt'
              + (" (" + ", ".join(f"{k}: {v}" for k, v in sorted(c["why"].items())) + ")" if c["why"] else "")
              + f'; {c["entries"]} entries, {c["mb"]} MB' + (f', {c["removed"]} removed' if c["removed"] else ""))
        p(f'  TypeScript {tb.get("typescript")} from {tb.get("typescript_from")}, {tb.get("programs")} programs'
          + ('; modules not found: ' + ", ".join(tb["placeholders"]) if tb.get("placeholders") else ""))
    if "syntax" in idx["backends"]:
        sx = idx["backends"]["syntax"]
        p(f'tree-sitter: {sx["files"]} files ({", ".join(f"{k} {v}" for k, v in sorted(sx["languages"].items()))}), '
          f'{sx["nodes"]} definitions, {sx["edges"]} calls matched by name')
        for err in sx.get("errors", []):
            p(f"  could not read {err}")
    if st.get("framework_edges"):
        p("framework adapters: " + ", ".join(f"{k} {v}" for k, v in st["framework_edges"].items()))
    p("rule edges: " + ", ".join(f"{k} {v}" for k, v in st.get("rule_edges", {}).items()))
    for u in idx["units"]:
        if u["status"] == "failed":
            p(f'failed: {u["file"]}')
            p("  " + "\n  ".join((u["error"] or "").splitlines()[-20:]))
    p(f"in {time.time() - t:.2f} s")
    return out


def next_steps(root, idx):
    """What to do with the index just built: open it, take it along, and how many functions say what they do."""
    funcs = [(nid, idx["nodes"][nid]) for f in describe.project_files(idx) for nid in describe.funcs_in(idx, f)]
    ai = describe.load(root)
    told = sum(1 for nid, n in funcs if nid in ai or docs.func_doc(root, n["file"], n["line"], n.get("lang", "c")))
    print("\nnext:")
    # descriptions first: the map shows them, and a snapshot keeps only what is there when it is written
    if funcs and told < len(funcs):
        print(term.fit(f"  codemap describe        optional: {len(funcs) - told} of {len(funcs)} functions say nothing about what they do"))
    print(term.fit("  codemap serve           open the map at http://127.0.0.1:7300/"))
    if os.environ.get("SSH_CONNECTION"):                # on a remote machine: how to reach it from the laptop
        host = os.uname().nodename
        print(term.fit(f"                          from your computer: ssh -L 7300:localhost:7300 {host}"))
    print(term.fit("  codemap export --html   or one HTML file with the map, to open anywhere"))


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
    """Write the prompts for an AI to describe what is not described yet (the functions first, then the files,
    commands and the rest, then the components, then the project), or keep its answers, or say where they stand."""
    root = Path(a.root).resolve()
    idx = load(root)
    graph = {}

    def g():                                          # built only when needed, once
        if "g" not in graph:
            with term.ui().step("Read the index and the code"):
                graph["g"] = view.build(root, idx, rules.load_config(root))
        return graph["g"]
    if a.apply:
        bad_total = 0
        for ans in a.apply:                          # several answers: one per prompt
            text = sys.stdin.read() if ans == "-" else Path(ans).read_text(encoding="utf-8")
            try:
                data = json.loads(text)
            except ValueError as e:
                print(f"{ans}: the answer is not JSON: {e}")
                bad_total += 1
                continue
            ds = data.get("descriptions", []) if isinstance(data, dict) else data if isinstance(data, list) else []
            fs = [d for d in ds if isinstance(d, dict) and d.get("id") in idx["nodes"]]
            kept, rejected = describe.apply(root, idx, {"descriptions": fs}, by=a.by) if fs else ([], {})
            rest = dict(data, descriptions=[d for d in ds if d not in fs]) if isinstance(data, dict) else {"descriptions": []}
            if rest.get("descriptions") or rest.get("route") or "terms" in rest:
                k2, r2 = describe_items.apply(root, idx, g(), rest, by=a.by)
                kept += k2
                rejected.update(r2)
            for key, bad in rejected.items():
                print(f"{ans}: not kept: {key}: " + "; ".join(bad))
            print(f"{ans}: kept {len(kept)}" + (f", {len(rejected)} not kept" if rejected else ""))
            bad_total += len(rejected)
        if not bad_total:
            lv, keys = describe_items.pending(root, idx, g(), tests=a.tests)
            print(f"next: codemap describe ({len(keys)} to describe in round {lv}: {describe_items.LEVELS[lv]})" if lv
                  else "everything is described")
        sys.exit(1 if bad_total else 0)
    def agent_text():
        r = describe.report(root, idx)
        total = len([n for f in describe.project_files(idx, a.tests) for n in describe.funcs_in(idx, f)])
        lines = [f"round 1, functions: {len(r['ok'])} of {total} described"]
        ri, missing = describe_items.report(root, idx, g())
        for lv in (2, 3, 4):
            keys = [k for k in ri["ok"] if describe_items.KIND_LEVEL.get(describe_items.kind(k)) == lv]
            lines.append(f"round {lv}, {describe_items.LEVELS[lv]}: {len(keys)} up to date, {missing[lv]} without one")
        return describe.agent_prompt(lines, a.by if a.by != "ai" else "<你的模型名稱>")

    if a.agent:                                      # the instruction alone, to paste or pipe
        text = agent_text()
        if a.output:
            Path(a.output).write_text(text, encoding="utf-8")
            print(f"wrote the instruction to {a.output}: give it to an AI agent (Claude Code) in this repository")
        else:
            print(text)
        return
    if a.status:
        r = describe.report(root, idx)
        for st in ("stale", "wrong"):
            for nid in r[st]:
                print(f"{st}: {fmt_node(idx, nid)}")
        total = len([n for f in describe.project_files(idx, a.tests) for n in describe.funcs_in(idx, f)])
        print(f"round 1, functions: {len(r['ok'])} up to date, {len(r['stale'])} stale, {len(r['wrong'])} wrong, "
              f"{max(0, total - sum(map(len, r.values())))} without one")
        ri, missing = describe_items.report(root, idx, g())
        for st in ("stale", "wrong"):
            for key in ri[st]:
                print(f"{st}: {key}")
        for lv in (2, 3, 4):
            keys = [k for k in ri["ok"] + ri["stale"] + ri["wrong"] if describe_items.KIND_LEVEL.get(describe_items.kind(k)) == lv]
            ok = sum(1 for k in keys if k in ri["ok"])
            print(f"round {lv}, {describe_items.LEVELS[lv]}: {ok} up to date, {len(keys) - ok} stale or wrong, {missing[lv]} without one")
        return
    if a.files:                                      # some files: their functions only
        files = [str(Path(f).resolve().relative_to(root)) if Path(f).resolve().is_relative_to(root) and not (root / f).exists() else f for f in a.files]
        level, ids = 1, describe.pending(root, idx, files, only_missing=not a.rewrite)
    else:                                            # the project: the lowest round with something to write
        files = describe.project_files(idx, a.tests)
        level, ids = describe_items.pending(root, idx, g(), a.level, tests=a.tests, rewrite=a.rewrite)
    if not ids:
        print("everything there has an up-to-date description (codemap describe --rewrite to write it again)")
        return
    if level == 1:
        parts = describe.batches(idx, ids, a.batch)
        texts = [describe.prompt(root, idx, ids=part)[0] for part in parts]
    else:
        size = a.batch if level == 2 else 10 ** 9   # a component, or the project, sees all of its round at once
        parts = [ids[i:i + size] for i in range(0, len(ids), size)]
        texts = [describe_items.prompt(root, idx, g(), level, part) for part in parts]
    if len(texts) == 1 and a.files:
        if a.output:
            Path(a.output).write_text(texts[0], encoding="utf-8")
            print(f"wrote the prompt for {len(ids)} functions to {a.output}")
        else:
            print(texts[0])
        return
    # one prompt per batch, so each answer stays complete. -o x.md: x-01.md, x-02.md beside it;
    # otherwise a folder (default .codemap/prompts), emptied of the last round's prompts and answers first
    out = Path(a.output or ".codemap/prompts")
    out = out if out.is_absolute() else Path.cwd() / out
    if out.suffix == ".md":
        folder, stem = out.parent, out.stem
    else:
        folder, stem = out, "prompt"
        for old in [*folder.glob("prompt-*.md"), *folder.glob("answer-*.json")]:
            old.unlink()                              # the last round's: their items may be described now
    folder.mkdir(parents=True, exist_ok=True)
    if folder.name == "prompts" and folder.parent.name == ".codemap":
        (folder / ".gitignore").write_text("*\n")      # scratch: not part of the repository
    names = []
    for i, text in enumerate(texts, 1):
        names.append(folder / f"{stem}-{i:02d}.md")
        names[-1].write_text(text.replace("codemap describe --apply <that file>", f"codemap describe --apply answer-{i:02d}.json"), encoding="utf-8")
    rel = lambda p: p.relative_to(Path.cwd()) if p.is_relative_to(Path.cwd()) else p
    what = (f"{len(ids)} functions in {len(files)} file{'s' * (len(files) != 1)}" if level == 1
            else f"{len(ids)} item{'s' * (len(ids) != 1)}")
    print(f"round {level} of 4, {describe_items.LEVELS[level]}: {what}: {len(texts)} prompt{'s' * (len(texts) != 1)}, "
          f"{rel(names[0])}" + (f" ... {names[-1].name}" if len(names) > 1 else ""))
    print("give each to an AI, save its answer as answer-NN.json beside it, then:")
    print(f"  codemap describe --apply {rel(folder)}/answer-*.json")
    if level < 4:
        print("then run codemap describe again for the next round")
    # the whole job for an AI agent (Claude Code), on screen to copy: it does every round by itself
    print("\nor give an AI agent (Claude Code, in this repository) the instruction below; it does every round:\n")
    print(agent_text())


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
            print(f"{describe.FILE}: {fmt_node(idx, nid)}: the function changed since it was described (codemap describe writes its prompt again)")
        print(f"{describe.FILE}: functions: {len(r['ok'])} up to date, {len(r['stale'])} stale, {len(r['wrong'])} wrong")
        bad += len(r["wrong"])
        # the files, components, commands, the project and the rest
        g = view.build(root, idx, rules.load_config(root))
        its = describe_items.all_items(root, idx, g)
        have = describe.load_all(root)["items"]
        ri, _ = describe_items.report(root, idx, g)
        for key in ri["wrong"]:
            print(f"{describe.FILE}: {key}: " + "; ".join(describe_items.problems(root, idx, its.get(key) or {}, key, have[key]) or ["no longer in the code"]))
        for key in ri["stale"]:
            print(f"{describe.FILE}: {key}: what it describes changed since (codemap describe writes its prompt again)")
        print(f"{describe.FILE}: the rest: {len(ri['ok'])} up to date, {len(ri['stale'])} stale, {len(ri['wrong'])} wrong")
        bad += len(ri["wrong"])
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
    ui = term.ui()
    with ui.step("Read the index and the code") as st:
        data = view.snapshot(root, load(root), rules.load_config(root), a.notes)
        st.done(f'{data["stats"]["funcs"]} functions, {len(data["edges"])} relations')
    out = Path(a.output or view.snapshot_name(data, ".html" if a.html else ".codemap"))
    with ui.step(f"Write {out}") as st:
        if a.html:
            out.write_text(server.standalone_html(data), encoding="utf-8")
        else:
            view.write_snapshot(out, data)
        size = out.stat().st_size
        st.done(f"{size / 1024 / 1024:.1f} MB" if size >= 1024 * 1024 else f"{size / 1024:.0f} KB")
    if data["dirty"]:
        ui.say(f'{len(data["dirty"])} uncommitted file{"s" * (len(data["dirty"]) != 1)}: the snapshot shows them as they are now, '
               "not as in the commit it names", "warn")
    print()
    print(term.fit(f"open {out} in a browser: no install, no network" if a.html else
                   f"open it at https://seanyeh77.github.io/codemap/ (pick the file), or with codemap viewer"))


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
    s.add_argument("-v", "--verbose", action="store_true", help="print every number and message, not only the summary")
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
    s = sub.add_parser("describe", help="AI descriptions of functions: prompts for the project (or some files), or keep the answers")
    s.add_argument("files", nargs="*", help="only these files (default: the whole project, without its tests)")
    s.add_argument("--tests", action="store_true", help="the test files too")
    s.add_argument("--rewrite", action="store_true", help="also what has an up-to-date description")
    s.add_argument("--level", type=int, choices=(1, 2, 3, 4), help="this round, even if one below it is not done: "
                   "1 functions, 2 files/commands/values/env/data files, 3 components, 4 project/route/glossary")
    s.add_argument("--batch", type=int, default=30, help="functions per prompt when there are many (default 30)")
    s.add_argument("-o", "--output", help="write the prompt here; with several prompts, the folder (default .codemap/prompts)")
    s.add_argument("--apply", metavar="ANSWER", nargs="+", help="keep the AI's JSON answers (- for standard input)")
    s.add_argument("--by", default="ai", help="who wrote the answer, kept with it (e.g. claude-opus-5-5)")
    s.add_argument("--status", action="store_true", help="how many are up to date, stale or wrong")
    s.add_argument("--agent", action="store_true", help="print one instruction for an AI agent (Claude Code) to write every round itself")
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
    try:
        a.fn(a)
    except KeyboardInterrupt:                         # Ctrl-C: the cursor back, one line, the usual status
        term.ui()._restore()
        sys.stderr.write("\ncodemap: stopped\n")
        sys.exit(130)


if __name__ == "__main__":
    main()
