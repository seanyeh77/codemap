"""Layer 1: precise call edges from the compiler.

Every translation unit in compile_commands.json is recompiled with its own
arguments, except that optimisation is forced to -O0 (so inlining cannot remove
calls) and -fcallgraph-info is added.  GCC then writes one .ci file per unit.
Only -c compilation is needed: nothing is linked and nothing is run.

Results are cached per unit.  A unit is recompiled only when its arguments or
the content of the source file or of any header it includes has changed.
"""

import hashlib
import json
import os
import re
import shlex
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

NODE_RE = re.compile(r'^node: \{ title: "([^"]*)" label: "([^"]*)"( shape : ellipse)? \}')
EDGE_RE = re.compile(r'^edge: \{ sourcename: "([^"]*)" targetname: "([^"]*)"(?: label: "([^"]*)")? \}')
LOC_RE = re.compile(r"^(.*):(\d+):(\d+)$")
INDIRECT = "__indirect_call"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    try:
        return sha(Path(path).read_bytes())
    except OSError:
        return None


def load_compile_db(root):
    db = json.loads((root / "compile_commands.json").read_text())
    units = []
    for e in db:
        args = e.get("arguments") or shlex.split(e["command"])
        directory = Path(e.get("directory", root))
        src = (directory / e["file"]).resolve()
        units.append(dict(args=args, directory=directory, file=src))
    return units


def rewrite_args(args, obj):
    """Keep include paths and defines, drop output, optimisation and dep flags."""
    out, skip = [], False
    for a in args[1:]:
        if skip:
            skip = False
            continue
        if a in ("-o", "-MF", "-MT", "-MQ"):
            skip = True
            continue
        if re.match(r"^-O\w*$", a) or a in ("-MD", "-MMD", "-MP", "-flto") or a.startswith("-flto="):
            continue
        out.append(a)
    if "-c" not in out:
        out.append("-c")
    dep = obj.with_suffix(".d")
    return [args[0]] + out + ["-O0", "-fcallgraph-info", "-MMD", "-MF", str(dep), "-o", str(obj)]


def parse_deps(dep_path, directory):
    try:
        text = dep_path.read_text().replace("\\\n", " ")
    except OSError:
        return []
    _, _, rest = text.partition(":")
    return [str((directory / p).resolve()) for p in rest.split()]


def rel(path, root):
    try:
        return str(Path(path).resolve().relative_to(root))
    except ValueError:
        return str(path)


def compile_unit(unit, root, cache):
    relfile = rel(unit["file"], root)
    key = sha(relfile.encode())[:16]
    obj = cache / f"{key}.o"
    ci = cache / f"{key}.ci"
    meta_path = cache / f"{key}.json"
    args = rewrite_args(unit["args"], obj)
    args_hash = sha(json.dumps(unit["args"]).encode())

    if meta_path.exists() and ci.exists():
        meta = json.loads(meta_path.read_text())
        if meta.get("args") == args_hash and all(file_sha(p) == h for p, h in meta["deps"].items()):
            return dict(file=relfile, status="cached", ci=str(ci), src=str(unit["file"]))

    p = subprocess.run(args, cwd=unit["directory"], capture_output=True, text=True)
    if p.returncode != 0 or not ci.exists():
        return dict(file=relfile, status="failed", error=p.stderr.strip()[-2000:])
    deps = parse_deps(obj.with_suffix(".d"), unit["directory"]) or [str(unit["file"])]
    meta_path.write_text(json.dumps(dict(args=args_hash, deps={d: file_sha(d) for d in deps})))
    obj.unlink(missing_ok=True)
    return dict(file=relfile, status="compiled", ci=str(ci), src=str(unit["file"]))


def find_definition(src_path, name):
    """Line of `name(` that opens a definition, not a prototype or a call."""
    try:
        text = Path(src_path).read_text(errors="replace").splitlines()
    except OSError:
        return None
    rx = re.compile(r"^(?!\s*(?:return|if|while|for|switch)\b)[\w\s\*]*\b" + re.escape(name) + r"\s*\(")
    for i, line in enumerate(text):
        if rx.match(line) and not line.rstrip().endswith(";"):
            j = i
            while j < len(text) and "{" not in text[j] and not text[j].rstrip().endswith(";"):
                j += 1
            if j < len(text) and "{" in text[j]:
                return i + 1
    return None


def parse_ci(path, root, unit_file=None):
    nodes, edges, dropped = {}, [], 0
    for line in Path(path).read_text().splitlines():
        m = NODE_RE.match(line)
        if m:
            title, label, decl = m.groups()
            name, _, loc = label.partition("\\n")
            lm = LOC_RE.match(loc)
            node = dict(name=name, file=rel(lm.group(1), root) if lm else loc,
                        line=int(lm.group(2)) if lm else None, defined=decl is None)
            # GCC labels a definition with its first declaration, often a
            # prototype in a header; the body is in this unit's source file
            if node["defined"] and unit_file and lm and Path(lm.group(1)).resolve() != Path(unit_file):
                line_no = find_definition(unit_file, name)
                if line_no:
                    node.update(file=rel(unit_file, root), line=line_no, declared=node["file"] + f":{node['line']}")
            nodes[title] = node
            continue
        m = EDGE_RE.match(line)
        if m:
            src, dst, label = m.groups()
            lm = LOC_RE.match(label or "")
            if not lm:          # calls the compiler inserted itself, e.g. __stack_chk_fail
                dropped += 1
                continue
            edges.append(dict(src=src, dst=dst, file=rel(lm.group(1), root), line=int(lm.group(2)), col=int(lm.group(3)),
                              kind="indirect" if dst == INDIRECT else "call", source="compiler"))
    return nodes, edges, dropped


def build(root, scope=None, jobs=None):
    root = Path(root).resolve()
    out = root / ".codemap"
    cache = out / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    units = load_compile_db(root)
    if scope:
        units = [u for u in units if any(rel(u["file"], root).startswith(s.rstrip("/") + "/") for s in scope)]

    with ThreadPoolExecutor(jobs or os.cpu_count()) as ex:
        results = list(ex.map(lambda u: compile_unit(u, root, cache), units))

    nodes, edges, dropped = {}, [], 0
    for r in results:
        if "ci" not in r:
            continue
        n, e, d = parse_ci(r["ci"], root, r["src"])
        dropped += d
        for k, v in n.items():
            # a definition wins over a declaration seen in another unit
            if k not in nodes or (v["defined"] and not nodes[k]["defined"]):
                nodes[k] = v
        edges.extend(e)
    seen, uniq = set(), []
    for e in edges:     # a header-defined inline function appears in every unit that includes it
        k = (e["src"], e["dst"], e["file"], e["line"], e["col"])
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    edges = sorted(uniq, key=lambda e: (e["file"], e["line"], e["src"], e["dst"]))
    units_out = [{k: v for k, v in r.items() if k not in ("ci", "src")} for r in results]
    stats = dict(units=len(units), compiled=sum(r["status"] == "compiled" for r in results),
                 cached=sum(r["status"] == "cached" for r in results),
                 failed=sum(r["status"] == "failed" for r in results),
                 nodes=len(nodes), edges=len(edges),
                 indirect=sum(e["kind"] == "indirect" for e in edges), compiler_inserted=dropped)
    return dict(version=1, nodes=nodes, edges=edges, units=units_out, stats=stats)
