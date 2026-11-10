"""Framework adapters: what a framework calls by itself, which no call in the code shows.

Every adapter works on the merged graph (codemap.schema) and adds three kinds
of fact, never anything else:

  1. entry point   node["entry"] = {framework, kind, text}: the framework calls
                   this function (a route handler, a test, an event handler)
  2. injection     edge kind "inject", consumer -> provider: the framework runs
                   the provider and passes its result in (pytest fixture,
                   FastAPI Depends, Spring @Autowired)
  3. callback      edge kind "callback", registrar -> handler: code hands a
                   function to the framework, which calls it on an event
                   (ONOS addListener, Ryu set_ev_cls)

Edges from adapters have source "framework" and rule "<framework>.<what>".
An adapter runs only when the repository imports its framework.
"""

import re

from . import go_http, onos, python_web, pytest_adapter, ryu

ADAPTERS = [python_web.Flask(), python_web.FastAPI(), pytest_adapter.Pytest(), ryu.Ryu(), ryu.Mininet(), onos.Onos(),
            go_http.GoHTTP()]


class Ctx:
    """What adapters read and write."""

    def __init__(self, root, index):
        self.root, self.index = root, index
        self.nodes, self.edges = index["nodes"], []
        self.files = {}
        for nid, n in self.nodes.items():
            if n.get("defined") and n.get("file"):
                self.files.setdefault(n["file"], []).append(nid)

    def lang(self, *langs):
        return [(k, n) for k, n in self.nodes.items() if n.get("defined") and n.get("lang") in langs]

    def imports(self, file, pattern):
        """The file's import lines match pattern (the module name, as a regular expression)."""
        from ..source import lines
        rx = re.compile(r"^\s*(from\s+(%s)\b|import\s+(%s)\b|import\s+[\w.{}\s,*]*from\s+['\"](%s))" % (pattern, pattern, pattern))
        return any(rx.match(ln) for ln in lines(self.root / file)[:400])

    def entry(self, nid, framework, kind, text):
        self.nodes[nid]["entry"] = dict(framework=framework, kind=kind, text=text)

    def edge(self, src, dst, kind, rule, file, line):
        self.edges.append(dict(src=src, dst=dst, file=file, line=line, col=1, kind=kind, source="framework", rule=rule))

    def find(self, file, name, langs=("python",)):
        """The definition a name means in a file: there, else the only one in the repository."""
        here = [k for k in self.files.get(file, []) if self.nodes[k]["name"] == name]
        if len(here) == 1:
            return here[0]
        anywhere = [k for k, n in self.nodes.items() if n.get("defined") and n.get("lang") in langs and n["name"] == name]
        return anywhere[0] if len(anywhere) == 1 else None

    def methods(self, cls_id):
        return [k for k, n in self.nodes.items() if n.get("class") == cls_id]

    def outside(self, name):
        """A node for something the framework provides (a built-in fixture, an event)."""
        nid = "ext:" + name
        self.nodes.setdefault(nid, dict(name=name, file="", line=None, defined=False))
        return nid


def run(root, index, config=None):
    from pathlib import Path
    disabled = set((config or {}).get("frameworks", {}).get("disable", []))
    c = Ctx(Path(root), index)
    used = []
    for a in ADAPTERS:
        if a.name in disabled or not a.detect(c):
            continue
        a.apply(c)
        used.append(a.name)
    index["edges"] = index["edges"] + c.edges
    counts = {}
    for e in c.edges:
        counts[e["rule"]] = counts.get(e["rule"], 0) + 1
    entries = {}
    for n in c.nodes.values():
        if "entry" in n:
            k = f'{n["entry"]["framework"]}.{n["entry"]["kind"]}'
            entries[k] = entries.get(k, 0) + 1
    index["stats"]["framework_edges"] = counts
    index["stats"]["framework_entries"] = entries
    index["frameworks"] = used
    return index
