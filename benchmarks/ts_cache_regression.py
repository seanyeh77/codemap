"""Correctness regression for the TypeScript program cache, on a repository's real history.

Checks out the last N commits of a git repository one after another and, at every commit, indexes
the TypeScript/JavaScript files twice: with the program cache (carried over from the commit before)
and without it. The two graphs must be the same: every edge in order, every node, every count. One
line per commit goes to OUT/results.jsonl with the cache's replayed and rebuilt programs, why, the
times, and the comparison; a run stopped half way resumes where it stopped.

Run it on a copy of the repository, never on a working checkout: it checks out other commits (and
puts the starting commit back at the end). Its dependencies, if any, stay as they are installed.

    uv run python benchmarks/ts_cache_regression.py /path/to/copy --commits 30 --out /tmp/regress
    uv run python benchmarks/ts_cache_regression.py /path/to/copy --commits 30 --out /tmp/regress --to 15
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codemap import backends, scope  # noqa: E402
from codemap.backends import ts  # noqa: E402

# what differs between two runs of the same code without changing the graph
VOLATILE = ("ms", "max_rss_mb", "slowest_programs", "phase", "cache", "typescript_from", "profile", "loaded", "groups")


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def index(repo, cache):
    os.environ["CODEMAP_TS_CACHE"] = "1" if cache else "0"
    files = dict(backends.plan(repo)).get("typescript", [])
    t = time.time()
    part = ts.build(repo, files, scope.test_files(files))
    if part is None:
        raise SystemExit("the TypeScript helper did not run (no Node or no TypeScript)")
    return part, time.time() - t


def compare(a, b):
    """The ways two partial indexes differ; empty when they are the same graph."""
    out = []
    if [json.dumps(e, sort_keys=True) for e in a["edges"]] != [json.dumps(e, sort_keys=True) for e in b["edges"]]:
        ea = {json.dumps(e, sort_keys=True) for e in a["edges"]}
        eb = {json.dumps(e, sort_keys=True) for e in b["edges"]}
        out.append(f"edges: {len(ea - eb)} only with the cache, {len(eb - ea)} only without, order {'differs' if ea == eb else 'n/a'}")
    if a["nodes"] != b["nodes"]:
        ka, kb = set(a["nodes"]), set(b["nodes"])
        changed = sum(1 for k in ka & kb if a["nodes"][k] != b["nodes"][k])
        out.append(f"nodes: {len(ka - kb)} only with the cache, {len(kb - ka)} only without, {changed} different")
    sa = {k: v for k, v in a["stats"].items() if k not in VOLATILE}
    sb = {k: v for k, v in b["stats"].items() if k not in VOLATILE}
    if sa != sb:
        out.append("stats: " + ", ".join(sorted(k for k in set(sa) | set(sb) if sa.get(k) != sb.get(k))))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("repo", type=Path)
    ap.add_argument("--commits", type=int, default=30, help="how many commits back from the starting one")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--to", type=int, default=None, help="stop after this step (0 is the oldest commit, cold)")
    a = ap.parse_args()
    repo = a.repo.resolve()
    a.out.mkdir(parents=True, exist_ok=True)
    state = a.out / "start.json"
    if state.exists():
        start = json.loads(state.read_text())
    else:
        head = git(repo, "rev-parse", "HEAD")
        commits = git(repo, "rev-list", "--reverse", f"{head}~{a.commits}..{head}").split()
        start = dict(head=head, commits=[git(repo, "rev-parse", f"{head}~{a.commits}")] + commits)
        state.write_text(json.dumps(start))
    results = a.out / "results.jsonl"
    done = {json.loads(l)["step"] for l in results.read_text().splitlines()} if results.exists() else set()
    try:
        for step, commit in enumerate(start["commits"]):
            if a.to is not None and step > a.to:
                break
            if step in done:
                continue
            prev = start["commits"][step - 1] if step else None
            git(repo, "checkout", "-q", commit)
            changed = git(repo, "diff", "--name-only", prev, commit).split() if prev else []
            cached, t_cached = index(repo, True)
            full, t_full = index(repo, False)
            diff = compare(cached, full)
            row = dict(step=step, commit=commit[:7], changed=len(changed),
                       code=sum(1 for f in changed if f.endswith(ts.EXTS)), cache=cached["stats"].get("cache"),
                       seconds_cached=round(t_cached, 1), seconds_full=round(t_full, 1),
                       edges=len(full["edges"]), nodes=len(full["nodes"]), same=not diff, differences=diff)
            with results.open("a") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{step:02d} {commit[:7]} same={not diff} replayed={row['cache']['replayed']} rebuilt={row['cache']['rebuilt']} "
                  f"{row['seconds_cached']} s / {row['seconds_full']} s", flush=True)
    finally:
        if a.to is None or a.to >= len(start["commits"]) - 1:
            git(repo, "checkout", "-q", start["head"])
    rows = [json.loads(l) for l in results.read_text().splitlines()]
    bad = [r for r in rows if not r["same"]]
    print(f"{len(rows)} steps, {len(bad)} with a different graph" + "".join(f"\n  {r['step']}: {r['differences']}" for r in bad))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
