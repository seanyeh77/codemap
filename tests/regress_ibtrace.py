"""Regression check on seanyeh77/ibtrace: the 12 questions of the grep / LSP /
Graphify comparison, answered from .codemap/index.json alone.

These questions were also used to design the Layer 2 rules, so passing them
shows the rules still work; it does not show that the codemap helps a reader.

Usage: python3 tests/regress_ibtrace.py PATH_TO_IBTRACE   (after `codemap index`)
"""

import json
import sys
from collections import Counter
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
idx = json.loads((root / ".codemap" / "index.json").read_text())
N, E = idx["nodes"], idx["edges"]
name = lambda nid: N.get(nid, {}).get("name", nid)


def callers(fn, under="src/"):
    return [e for e in E if e["kind"] == "call" and name(e["dst"]) == fn and e["file"].startswith(under)]


def rule(r, **kw):
    return [e for e in E if e.get("rule") == r and all(e.get(k) == v for k, v in kw.items())]


results = []


def q(qid, ok, detail):
    results.append((qid, ok, detail))


c = sorted({name(e["src"]) for e in callers("ibt_hook_context")})
q("I1", c == sorted(["ibv_open_device", "ibv_query_device", "ibv_alloc_pd", "ibv_create_cq", "ibv_create_qp",
                     "ibv_qp_to_qp_ex"]), f"{len(c)} callers: {', '.join(c)}")

c = callers("ibt_resolve_symbol")
per_file = Counter(Path(e["file"]).name for e in c)
fns = {e["src"] for e in c}
q("I2", len(fns) == 34 and per_file == Counter({"verbs.c": 18, "ucp.c": 11, "uct.c": 5}),
  f"{len(fns)} functions, by file {dict(per_file)}")

c = callers("ibt_span_begin")
q("I3", len(c) == 54, f"{len(c)} call sites in src/ over {len({e['file'] for e in c})} files")

a = rule("fnptr_assign", slot="ctx->ops.post_send")
s = [e for e in rule("indirect") if e.get("saved_from") == "ctx->ops.post_send"]
q("I4", [(name(e["dst"]), e["file"], e["line"]) for e in a] == [("trace_post_send", "src/libibtrace/hooks/ops.c", 174)]
  and any(N[e["dst"]]["line"] == 169 for e in s),
  f"assigned at ops.c:{a[0]['line'] if a else '?'}, original kept at ops.c:{N[s[0]['dst']]['line'] if s else '?'}")

d = [e for e in E if e["kind"] == "call" and name(e["src"]) == "ibmon_drain" and name(e["dst"]) == "take"]
t = N.get(d[0]["dst"]) if d else None
q("I5", bool(t) and (t["file"], t["line"]) == ("src/ibmon/reader.c", 163),
  f"ibmon_drain calls take defined at {t['file']}:{t['line']}" if t else "no edge ibmon_drain -> take")

c = rule("ctor", kind="constructor")
c = [e for e in c if name(e["dst"]) == "ibt_attach"]
q("I6", bool(c) and c[0]["line"] == 321 and not callers("ibt_attach"),
  f"no caller; constructor at trace.c:{c[0]['line']}" if c else "constructor not found")

env = idx.get("env", {}).get("IBTRACE_SHM", {})
q("I7", "src/ibmon/child.c:86" in env.get("set", []) and "src/libibtrace/trace.c:324" in env.get("get", []),
  f"set at {[x for x in env.get('set', []) if x.startswith('src/')]}, read at {[x for x in env.get('get', []) if x.startswith('src/')]}")

b = rule("build_define", name="IBT_RING_SLOTS")
q("I8", "partial" if any(e["file"] == "Makefile" and e["line"] == 185 and e["value"] == "64u" for e in b) else False,
  "Makefile:185 sets IBT_RING_SLOTS=64u; the reader's layout check (reader.c:51-52) is not a rule and stays a reading task")

x = rule("cross_lang", name="include/ibtrace/ring.h")
x += rule("cross_lang", name="IBT_LAYER_TABLE")
near = {e.get("near") for e in x if e["file"] == "analysis/ibtrace/formats.py"}
q("I9", "LAYERS:107" in near and any(e["file"] == "tests/test_layer_sync.py" for e in x),
  f"formats.py near {sorted(n for n in near if n)}, plus tests/test_layer_sync.py")

c = callers("ibt_ring_publish", "src/libibtrace/")
q("I10", [(name(e["src"]), e["line"]) for e in c] == [("emit", 441)], f"{[(name(e['src']), e['file'], e['line']) for e in c]}")

c = callers("ibt_ring_is_published", "src/ibmon/")
failed = [u for u in idx["units"] if u["status"] == "failed" and u["file"].startswith("src/ibmon/")]
q("I11", not c and not failed, "no caller in src/ibmon with every src/ibmon unit compiled"
  if not c and not failed else f"callers {c} failed units {failed}")

c = callers("ibt_uct_hook")
q("I12", sorted((Path(e["file"]).name, e["line"]) for e in c) == [("uct.c", 524), ("uct.c", 546)],
  f"{[(e['file'], e['line']) for e in c]}")

for qid, ok, detail in results:
    print(f"{'PARTIAL' if ok == 'partial' else 'PASS' if ok else 'FAIL':7}  {qid:4} {detail}")
full = sum(ok is True for _, ok, _ in results)
part = sum(ok == "partial" for _, ok, _ in results)
print(f"{full} pass, {part} partial, {len(results) - full - part} fail, of {len(results)}")
sys.exit(0 if all(ok for _, ok, _ in results) else 1)
