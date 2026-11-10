"""Go net/http: functions registered with HandleFunc or Handle are route handlers.

The Go backend already records a function handed on as a value (edge kind "ref"); a ref on a line
that registers a pattern makes its target an entry point the server calls."""

import re

from ..source import lines

# a call whose first argument is an HTTP pattern: m.HandleFunc("GET /x", h), r.Get("/x", h), and the
# project's own wrappers around them: api("POST /api/records", s.apiCreateRecord)
REG = re.compile(r'\w\(\s*"((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+)?(/[^"]*)"')
VERB = re.compile(r'\.(Get|Post|Put|Patch|Delete|Head|Options)\(\s*"')


class GoHTTP:
    name = "net/http"

    def detect(self, c):
        self.files = [f for f in c.files if f.endswith(".go") and any('"net/http"' in ln for ln in lines(c.root / f)[:80])]
        return bool(self.files)

    def apply(self, c):
        files = set(self.files)
        for e in c.index["edges"]:
            if e.get("kind") != "ref" or e.get("file") not in files or e["dst"] not in c.nodes or not c.nodes[e["dst"]].get("defined"):
                continue
            text = lines(c.root / e["file"])[e["line"] - 1] if e["line"] else ""
            m = REG.search(text)
            if not m:
                continue
            verb = (m.group(1) or "").strip() or (VERB.search(text).group(1).upper() if VERB.search(text) else "")
            route = f"{verb} {m.group(2)}".strip()
            old = c.nodes[e["dst"]].get("entry")
            if old and old.get("framework") == "net/http" and route not in old["text"].split(", "):
                route = old["text"] + ", " + route              # one handler, several patterns
            c.entry(e["dst"], "net/http", "route", route)
