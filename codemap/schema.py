"""The graph every backend writes and everything after it reads.

The core of codemap (rules, facts, the viewer, checks) depends only on this
schema, never on a parser or a compiler. A backend turns one kind of source
into nodes and edges; a framework adapter adds what a framework calls by
itself. Adding a language means adding a backend, not changing the pipeline.

index.json
----------
{
  "version": 2,
  "nodes": {id: Node},
  "edges": [Edge],
  "units": [...],          # what the gcc backend compiled; other backends add none
  "backends": {name: {"files": n, "languages": [..], ...}},
  "stats": {...},
}

Node (a function, method, class, module-level code, or an outside name)
  name      str   what a person calls it: "run", "Router.add_route"
  file      str   path from the repository root; "/usr/include/..." or "" outside it
  line      int   first line of the definition
  end       int?  last line; the gcc backend leaves it out (c_body_end finds it)
  defined   bool  the repository defines it (False: only called)
  lang      str?  "c", "python", "java", "go", "typescript", "javascript", "html", "css"
  kind      str?  "function" (default), "method", "class", "module", "page", "stylesheet"
  decorators [str]?  decorator or annotation text, as written: "@app.route('/x')"
  params    [str]?  parameter names, for adapters that inject by name (pytest fixtures)
  param_text {str: str}?  a parameter's annotation and default as written ("Session = Depends(get_db)")
  bases     [str]?  a class's parents as written ("app_manager.OSKenApp", "PacketProcessor")
  class     str?    for a method, the id of its class
  entry     {framework, kind, text}?  set by a framework adapter: called by the framework

Edge (a relation from src to dst, both node ids)
  file, line, col   where the evidence is
  kind      "call" | "indirect" | a rule or adapter kind ("route", "inject", "callback", ...)
  source    how it is known, strongest first:
              "compiler"   a compiler recorded the call (C/C++)
              "static"     a language's own analyzer resolved it (Python: codemap.backends.python)
              "syntax"     parsed with tree-sitter and matched by name
              "rule"       a codemap rule inferred it from the source text
              "framework"  a framework adapter: the framework makes this call
  rule      str?  the rule or adapter that made it ("fnptr_assign", "pytest.fixture")
  by        "name"?  a syntax edge whose receiver's type is unknown, matched on a method name
                     defined once in the repository
  resolution        a static edge: "exact" (names decide the target), "inferred" (a type does),
                    "ambiguous" (one of several targets, each with an edge); a call with no
                    target found gets no edge and is counted as unresolved
  infer     {how, type}?  how the receiver's type was found: self, cls, super, constructor,
                    annotation, return, assign, attribute, override; and the class
"""

VERSION = 2

# sources whose edges are calls written in the code, as opposed to inferred ones
CALL_SOURCES = ("compiler", "static", "syntax")
SOURCES = CALL_SOURCES + ("rule", "framework")


def merge(parts):
    """One index from several backends' results: nodes by id (a definition wins over a mention),
    edges concatenated without duplicates, stats added up per backend."""
    nodes, edges, units, backends, seen = {}, [], [], {}, set()
    for name, part in parts:
        for k, v in part.get("nodes", {}).items():
            if k not in nodes or (v.get("defined") and not nodes[k].get("defined")):
                nodes[k] = v
        for e in part.get("edges", []):
            sig = (e["src"], e["dst"], e.get("file"), e.get("line"), e.get("col"), e.get("kind"), e.get("source"))
            if sig not in seen:
                seen.add(sig)
                edges.append(e)
        units += part.get("units", [])
        backends[name] = part.get("stats", {})
    edges.sort(key=lambda e: (e.get("file") or "", e.get("line") or 0, e["src"], e["dst"]))
    stats = dict(nodes=len(nodes), edges=len(edges))
    gcc = backends.get("gcc", {})
    for k in ("units", "compiled", "cached", "failed", "indirect", "compiler_inserted"):
        stats[k] = gcc.get(k, 0)
    return dict(version=VERSION, nodes=nodes, edges=edges, units=units, backends=backends, stats=stats)
