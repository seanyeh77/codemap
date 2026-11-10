"""The Python backend: calls resolved through symbols and simple types, with Python's own ast.

It is a backend of its own, not a special case of the tree-sitter one: it
reads Python as Python does. Each call gets a resolution:

  exact       the name decides one target: a module's function, an import,
              a class's constructor, self/cls inside a class, super()
  inferred    a type said where the call goes: x = User(), x: User,
              x = create_user() returning User, self.client = Client()
  ambiguous   several targets are possible (x: A | B, a method a subclass
              overrides); every one gets an edge
  unresolved  nothing decides it: no edge, counted in the stats

A call that types cannot place is never matched on its name across the
repository: that would be a guess, and this backend does not guess.

Edges have source "static". Nodes have the same ids and fields as the
tree-sitter backend writes, so framework adapters read both alike.

2A, names:  import m, import m as a, from m import f, from .m import f,
            module functions, classes, methods, self.m(), cls.m(),
            inheritance (the MRO), super(), import cycles
2B, types:  constructors, annotations (including X | Y, Optional, Union),
            return values, assignments, instance attributes, inheritance
"""

import ast
import builtins
import re
from pathlib import Path

from ..source import lines

BUILTINS = set(dir(builtins))
BUILTIN_TYPES = {"list", "dict", "set", "tuple", "str", "bytes", "frozenset", "bytearray", "open", "int", "float"}
EXACT_FROM = {"module", "class", "self", "cls", "super", "name"}      # receivers whose target is certain


def _seg(src, node):
    try:
        return ast.get_source_segment(src, node) or ""
    except Exception:
        return ""


class Module:
    def __init__(self, name, file, tree, src):
        self.name, self.file, self.tree, self.src = name, file, tree, src
        self.defs = {}         # name -> node id (functions and classes at the top of the module)
        self.imports = {}      # local name -> ("module", dotted) | ("from", dotted, name)
        self.stars = []        # dotted modules imported with *
        self.assigns = {}      # module variable -> [value exprs]
        self.package = name if file.endswith("__init__.py") else name.rpartition(".")[0]


class Func:
    def __init__(self, nid, node, module, cls, parent):
        self.id, self.node, self.module, self.cls, self.parent = nid, node, module, cls, parent
        self.locals = {}       # name -> [("expr", value) | ("ann", annotation) | ("iter", ...)]
        self.static = any(isinstance(d, ast.Name) and d.id == "staticmethod" for d in node.decorator_list)
        self.classmethod = any(isinstance(d, ast.Name) and d.id == "classmethod" for d in node.decorator_list)


class Klass:
    def __init__(self, nid, node, module):
        self.id, self.node, self.module = nid, node, module
        self.methods = {}      # name -> node id
        self.attrs = {}        # instance or class attribute -> [(kind, expr, func or None)]
        self.bases = []        # resolved: class ids, or "ext:..." names
        self.subclasses = []


class Analyzer:
    def __init__(self, root, files):
        self.root = Path(root)
        self.modules, self.by_file, self.short = {}, {}, {}
        self.nodes, self.funcs, self.classes = {}, {}, {}
        self.edges, self.unresolved, self.errors, self.builtin = [], {}, [], 0
        self._ret, self._mro, self._busy = {}, {}, set()
        for f in files:
            self._load(f)
        for m in list(self.by_file.values()):
            self._collect(m)
        for k in self.classes.values():
            k.bases = [b for b in (self._class_ref(e, k.module) for e in k.node.bases) if b]
            for b in k.bases:
                if b in self.classes:
                    self.classes[b].subclasses.append(k.id)

    # ------------------------------------------------------------------ modules

    def _names(self, rel):
        """The dotted names a file is imported by: from the top of its package, and from the root."""
        p = Path(rel)
        parts = list(p.with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        top = len(p.parts) - 1                     # how many directories up the package goes
        d = self.root / p.parent
        while top > 0 and (d / "__init__.py").exists():
            d, top = d.parent, top - 1
        names = [".".join(parts[top:])] if parts[top:] else []
        if ".".join(parts) not in names and parts:
            names.append(".".join(parts))
        return names

    def _load(self, rel):
        try:
            src = (self.root / rel).read_text(errors="replace")
            tree = ast.parse(src, filename=rel)
        except (OSError, SyntaxError, ValueError) as e:
            self.errors.append(f"{rel}: {e.__class__.__name__}: {e}")
            return
        names = self._names(rel)
        m = Module(names[0] if names else Path(rel).stem, rel, tree, src)
        self.by_file[rel] = m
        for n in names:
            self.short.setdefault(n, []).append(m)

    def module(self, dotted, near=None):
        """The repository module a dotted name means, preferring one next to the importer (sys.path[0])."""
        ms = self.short.get(dotted, [])
        if len(ms) > 1 and near is not None:
            here = [m for m in ms if str(Path(m.file).parent) == str(Path(near.file).parent)]
            ms = here or ms
        return ms[0] if ms else None

    # ------------------------------------------------------------------ definitions

    def _node(self, nid, node, m, kind, extra=None):
        n = dict(name=nid.split(":", 1)[1], file=m.file, line=node.lineno, end=getattr(node, "end_lineno", node.lineno),
                 defined=True, lang="python", kind=kind)
        if getattr(node, "decorator_list", None):
            n["decorators"] = ["@" + _seg(m.src, d) for d in node.decorator_list]
            n["top"] = min(d.lineno for d in node.decorator_list)
        n.update(extra or {})
        self.nodes[nid] = n

    def _collect(self, m):
        rel = m.file
        for st in m.tree.body:
            self._imports(m, st)
        self._scan_body(m, m.tree.body, [], None, None)
        for st in ast.walk(m.tree):
            if isinstance(st, (ast.Assign, ast.AnnAssign)) and st in m.tree.body:
                for t in (st.targets if isinstance(st, ast.Assign) else [st.target]):
                    if isinstance(t, ast.Name):
                        m.assigns.setdefault(t.id, []).append(("ann", st.annotation) if isinstance(st, ast.AnnAssign) and st.value is None
                                                             else ("expr", st.value))
        self.nodes.setdefault(f"{rel}:<module>", dict(name=Path(rel).name, file=rel, line=1, end=len(m.src.splitlines()) or 1,
                                                      defined=True, lang="python", kind="module"))

    def _imports(self, m, st):
        if isinstance(st, ast.Import):
            for a in st.names:
                if a.asname:
                    m.imports[a.asname] = ("module", a.name)
                else:                                     # import a.b binds a
                    m.imports[a.name.split(".")[0]] = ("module", a.name.split(".")[0])
        elif isinstance(st, ast.ImportFrom):
            base = st.module or ""
            if st.level:
                pkg = m.package.split(".") if m.package else []
                pkg = pkg[:len(pkg) - (st.level - 1)] if st.level > 1 else pkg
                base = ".".join(pkg + ([st.module] if st.module else []))
            for a in st.names:
                if a.name == "*":
                    m.stars.append(base)
                else:
                    m.imports[a.asname or a.name] = ("from", base, a.name)
        elif isinstance(st, (ast.If, ast.Try)):          # if TYPE_CHECKING: ..., try: import x except: ...
            for s in getattr(st, "body", []) + getattr(st, "orelse", []) + [h for x in getattr(st, "handlers", []) for h in x.body] \
                    + getattr(st, "finalbody", []):
                self._imports(m, s)

    def _scan_body(self, m, body, scope, cls, parent):
        for st in body:
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qual = ".".join(scope + [st.name])
                nid = f"{m.file}:{qual}"
                args = st.args
                params = [a.arg for a in args.posonlyargs + args.args + ([args.vararg] if args.vararg else []) + args.kwonlyargs
                          + ([args.kwarg] if args.kwarg else [])]
                text = {}
                defaults = dict(zip([a.arg for a in (args.posonlyargs + args.args)][-len(args.defaults):], args.defaults)) if args.defaults else {}
                defaults.update({a.arg: d for a, d in zip(args.kwonlyargs, args.kw_defaults) if d is not None})
                for a in args.posonlyargs + args.args + args.kwonlyargs:
                    parts = [_seg(m.src, x) for x in (a.annotation, defaults.get(a.arg)) if x is not None]
                    if parts:
                        text[a.arg] = " = ".join(parts)
                extra = dict(params=params)
                if text:
                    extra["param_text"] = text
                if cls:
                    extra["class"] = cls.id
                self._node(nid, st, m, "method" if cls else "function", extra)
                f = self.funcs[nid] = Func(nid, st, m, cls, parent)
                if cls:
                    cls.methods.setdefault(st.name, nid)
                elif not scope:
                    m.defs[st.name] = nid
                self._locals(f)
                self._scan_body(m, st.body, scope + [st.name], None, f)
            elif isinstance(st, ast.ClassDef):
                qual = ".".join(scope + [st.name])
                nid = f"{m.file}:{qual}"
                self._node(nid, st, m, "class", dict(bases=[_seg(m.src, b) for b in st.bases]) if st.bases else None)
                k = self.classes[nid] = Klass(nid, st, m)
                if not scope:
                    m.defs[st.name] = nid
                for s in st.body:                              # class attributes: x = ..., x: T
                    if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
                        k.attrs.setdefault(s.target.id, []).append(("ann", s.annotation, None))
                    elif isinstance(s, ast.Assign):
                        for t in s.targets:
                            if isinstance(t, ast.Name):
                                k.attrs.setdefault(t.id, []).append(("expr", s.value, None))
                self._scan_body(m, st.body, scope + [st.name], k, parent)
            elif isinstance(st, (ast.If, ast.Try, ast.With, ast.AsyncWith, ast.For, ast.AsyncFor, ast.While, ast.Match)) \
                    or type(st).__name__ == "TryStar":
                # definitions inside blocks: if __name__ == "__main__", try/except ImportError, a def inside a with
                inner = getattr(st, "body", []) + getattr(st, "orelse", []) + getattr(st, "finalbody", []) \
                    + [h for x in getattr(st, "handlers", []) for h in x.body] + [s for c in getattr(st, "cases", []) for s in c.body]
                self._scan_body(m, inner, scope, cls, parent)

    def _locals(self, f):
        """Every value a local name is given in the function, without descending into nested definitions."""
        for a in f.node.args.posonlyargs + f.node.args.args + f.node.args.kwonlyargs:
            if a.annotation is not None:
                f.locals.setdefault(a.arg, []).append(("ann", a.annotation))
        for st in self._own(f.node):
            if isinstance(st, ast.Assign):
                for t in st.targets:
                    self._bind(f, t, st.value)
            elif isinstance(st, ast.AnnAssign):
                if isinstance(st.target, ast.Name):
                    f.locals.setdefault(st.target.id, []).append(("ann", st.annotation))
                else:
                    self._bind(f, st.target, st.value)
            elif isinstance(st, (ast.With, ast.AsyncWith)):
                for it in st.items:
                    if isinstance(it.optional_vars, ast.Name):
                        f.locals.setdefault(it.optional_vars.id, []).append(("expr", it.context_expr))
            elif isinstance(st, ast.NamedExpr) and isinstance(st.target, ast.Name):
                f.locals.setdefault(st.target.id, []).append(("expr", st.value))

    def _bind(self, f, target, value):
        if isinstance(target, ast.Name):
            f.locals.setdefault(target.id, []).append(("expr", value))
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self" and f.cls:
            f.cls.attrs.setdefault(target.attr, []).append(("expr", value, f))      # self.client = Client()

    @staticmethod
    def _own(node):
        """The nodes of a function body, not those of functions and classes defined inside it."""
        # a def's decorators and defaults run where it is defined, not when it is called
        todo = list(node.body) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else list(ast.iter_child_nodes(node))
        while todo:
            n = todo.pop()
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                if isinstance(n, ast.Lambda):
                    todo.extend(ast.iter_child_nodes(n))
                continue
            yield n
            todo.extend(ast.iter_child_nodes(n))

    # ------------------------------------------------------------------ symbols (2A)

    def member(self, m, name, seen=None):
        """What a name means at the top of module m: a definition, an import, a submodule, a star import.
        ("func", id) | ("class", id) | ("module", Module) | ("ext", dotted) | ("var", Module, name) | None"""
        seen = seen if seen is not None else set()
        key = (m.file, name)
        if key in seen:                       # import cycles: a imports b imports a
            return None
        seen.add(key)
        if name in m.defs:
            nid = m.defs[name]
            return ("class", nid) if nid in self.classes else ("func", nid)
        if name in m.imports:
            imp = m.imports[name]
            if imp[0] == "module":
                mod = self.module(imp[1], m)
                return ("module", mod) if mod else ("ext", imp[1])
            base, attr = imp[1], imp[2]
            mod = self.module(base, m)
            if mod:
                got = self.member(mod, attr, seen)
                if got:
                    return got
            sub = self.module(f"{base}.{attr}", m)
            if sub:
                return ("module", sub)
            return ("ext", f"{base}.{attr}") if not mod else None
        if name in m.assigns:
            return ("var", m, name)
        sub = self.module(f"{m.name}.{name}", m) if m.file.endswith("__init__.py") else None
        if sub:
            return ("module", sub)
        for star in m.stars:
            mod = self.module(star, m)
            got = self.member(mod, name, seen) if mod else None
            if got:
                return got
        return None

    def _class_ref(self, expr, m):
        """A base class expression: a class id, an "ext:" name, or None."""
        for t, _ in self.types(expr, m, None):
            if t[0] == "cls":
                return t[1]
            if t[0] == "ext":
                return "ext:" + t[1]
        return None

    def mro(self, cid):
        if cid not in self._mro:
            self._mro[cid] = [cid]
            out, todo = [cid], [b for b in self.classes[cid].bases if b in self.classes]
            for b in todo:
                for c in self.mro(b):
                    if c not in out:
                        out.append(c)
            self._mro[cid] = out
        return self._mro[cid]

    def lookup(self, cid, name, after=None):
        """The method a class finds for a name along its MRO (after `after`, for super())."""
        order = self.mro(cid)
        if after is not None:
            order = order[order.index(after) + 1:] if after in order else []
        for c in order:
            if name in self.classes[c].methods:
                return self.classes[c].methods[name]
        return None

    def overrides(self, cid, name):
        """Methods of the same name in subclasses: where self.m() may also go."""
        out, todo = [], list(self.classes[cid].subclasses)
        while todo:
            s = todo.pop()
            if name in self.classes[s].methods:
                out.append(self.classes[s].methods[name])
            todo.extend(self.classes[s].subclasses)
        return out

    # ------------------------------------------------------------------ types (2B)

    def ann(self, expr, m):
        """The types an annotation names: User, mod.User, "User", User | None, Optional[User], Union[A, B]."""
        if expr is None:
            return set()
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            try:
                expr = ast.parse(expr.value, mode="eval").body
            except SyntaxError:
                return set()
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.BitOr):
            return self.ann(expr.left, m) | self.ann(expr.right, m)
        if isinstance(expr, ast.Subscript):
            head = _seg(m.src, expr.value).rsplit(".", 1)[-1]
            if head.lower() in ("list", "dict", "set", "tuple", "frozenset", "sequence", "mapping", "iterable"):
                return {("builtin", head.lower() if head.lower() in BUILTIN_TYPES else "list")}
            if head in ("Optional", "Union", "Annotated", "Final", "ClassVar"):
                args = expr.slice.elts if isinstance(expr.slice, ast.Tuple) else [expr.slice]
                if head == "Annotated":
                    args = args[:1]
                return set().union(*(self.ann(a, m) for a in args))
            return set()
        if isinstance(expr, ast.Name) and expr.id in BUILTIN_TYPES and self.member(m, expr.id) is None:
            return {("builtin", expr.id)}
        out = set()
        for t, _ in self.types(expr, m, None):
            if t[0] == "cls":
                out.add(("inst", t[1]))
            elif t[0] == "ext":
                out.add(("ext", t[1]))
        return out

    def types(self, expr, m, f, depth=0):
        """{(type, evidence)}: what an expression may be. A type is ("inst", class), ("cls", class),
        ("module", Module), ("func", id), ("ext", dotted), ("super", class); evidence says how it was
        found, for the edge's resolution."""
        if expr is None or depth > 12:
            return set()
        key = (id(expr), id(f))
        if key in self._busy:                 # x = x.next: the value depends on itself
            return set()
        self._busy.add(key)
        try:
            return self._types(expr, m, f, depth)
        finally:
            self._busy.discard(key)

    def _types(self, expr, m, f, depth):
        if isinstance(expr, ast.Name):
            return self._name(expr.id, m, f, depth)
        if isinstance(expr, ast.Attribute):
            out = set()
            for (t, ev) in self.types(expr.value, m, f, depth + 1):
                out |= self._attr(t, ev, expr.attr, depth)
            return out
        if isinstance(expr, ast.Call):
            if isinstance(expr.func, ast.Name) and expr.func.id == "super" and f is not None and f.cls:
                return {(("super", f.cls.id), "super")}
            out = set()
            if isinstance(expr.func, ast.Name) and expr.func.id in BUILTIN_TYPES and self.member(m, expr.func.id) is None:
                return {(("builtin", expr.func.id), "constructor")}           # dict(), list(), open()
            for (t, ev) in self.types(expr.func, m, f, depth + 1):
                if t[0] == "cls":
                    out.add((("inst", t[1]), "constructor"))                 # User()
                elif t[0] == "func":
                    out |= {(r, "return") for r in self.returns(t[1])}        # create_user() -> User
                elif t[0] == "ext" and t[1].rsplit(".", 1)[-1][:1].isupper():
                    out.add((("ext", t[1]), "constructor"))                 # FastAPI(): an outside class's object
            return out
        # literals and comprehensions: the language's own types, whose methods (append, get, join) are not
        # the repository's
        if isinstance(expr, (ast.List, ast.ListComp)):
            return {(("builtin", "list"), "literal")}
        if isinstance(expr, (ast.Dict, ast.DictComp)):
            return {(("builtin", "dict"), "literal")}
        if isinstance(expr, (ast.Set, ast.SetComp)):
            return {(("builtin", "set"), "literal")}
        if isinstance(expr, ast.Tuple):
            return {(("builtin", "tuple"), "literal")}
        if isinstance(expr, ast.JoinedStr) or isinstance(expr, ast.Constant) and isinstance(expr.value, (str, bytes)):
            return {(("builtin", "str" if not isinstance(getattr(expr, "value", ""), bytes) else "bytes"), "literal")}
        if isinstance(expr, (ast.IfExp,)):
            return self.types(expr.body, m, f, depth + 1) | self.types(expr.orelse, m, f, depth + 1)
        if isinstance(expr, ast.BoolOp):
            return set().union(*(self.types(v, m, f, depth + 1) for v in expr.values))
        if isinstance(expr, (ast.Await,)):
            return self.types(expr.value, m, f, depth + 1)
        return set()

    def _name(self, name, m, f, depth):
        g = f
        while g is not None:                  # the function's locals, then those of enclosing functions
            first = g.node.args.posonlyargs + g.node.args.args
            if g.cls and first and first[0].arg == name and not g.static:
                return {(("cls", g.cls.id), "cls")} if g.classmethod else {(("inst", g.cls.id), "self")}
            if name in g.locals:
                out = set()
                for kind, x in g.locals[name]:
                    if kind == "ann":
                        out |= {(t, "annotation") for t in self.ann(x, g.module)}
                    else:
                        out |= {(t, ev if ev not in ("module", "class", "name") else "assign") if t[0] == "inst" else (t, ev)
                                for t, ev in self.types(x, g.module, g, depth + 1)}
                return out
            if any(a.arg == name for a in g.node.args.posonlyargs + g.node.args.args + g.node.args.kwonlyargs):
                return set()                   # a parameter with no annotation: unknown
            g = g.parent
        ref = self.member(m, name)
        if ref is None:
            return set()
        if ref[0] == "func":
            return {(("func", ref[1]), "name")}
        if ref[0] == "class":
            return {(("cls", ref[1]), "class")}
        if ref[0] == "module":
            return {(("module", ref[1]), "module")}
        if ref[0] == "ext":
            return {(("ext", ref[1]), "module")}
        out = set()                            # a module variable: client = Client()
        for kind, x in ref[1].assigns.get(ref[2], []):
            if kind == "ann":
                out |= {(t, "annotation") for t in self.ann(x, ref[1])}
            else:
                out |= {(t, "assign" if ev == "constructor" else ev) for t, ev in self.types(x, ref[1], None, depth + 1)
                        if t[0] in ("inst", "func", "cls", "module", "ext")}
        return out

    def _attr(self, t, ev, name, depth):
        kind = t[0]
        if kind == "module":
            ref = self.member(t[1], name)
            if ref is None:
                return set()
            if ref[0] == "func":
                return {(("func", ref[1]), "module")}
            if ref[0] == "class":
                return {(("cls", ref[1]), "module")}
            if ref[0] == "module":
                return {(("module", ref[1]), "module")}
            if ref[0] == "ext":
                return {(("ext", ref[1]), "module")}
            return self._name(name, t[1], None, depth + 1)
        if kind == "ext":
            return {(("ext", f"{t[1]}.{name}"), ev)}
        if kind == "builtin":
            return {(("builtin", f"{t[1]}.{name}"), ev)}
        if kind in ("inst", "cls", "super"):
            cid = t[1]
            meth = self.lookup(cid, name, after=cid if kind == "super" else None)
            if meth:
                return {(("method", meth, cid, kind), ev)}
            # not in the repository's classes: a method an outside base class provides (self.addSwitch, super().__init__)
            outside = [b for c in self.mro(cid) for b in self.classes[c].bases if b.startswith("ext:")]
            if outside and not any(name in self.classes[c].attrs for c in self.mro(cid)):
                return {(("ext", f"{outside[0][4:]}.{name}"), ev)}
            out = set()
            for c in self.mro(cid):                 # an attribute: self.client.send() -> Client.send
                for akind, x, g in self.classes[c].attrs.get(name, []):
                    km = self.classes[c].module
                    if akind == "ann":
                        out |= {(tt, "attribute") for tt in self.ann(x, km)}
                    else:
                        out |= {(tt, "attribute") for tt, _ in self.types(x, km, g, depth + 1) if tt[0] in ("inst", "func", "cls", "ext")}
            return out
        return set()

    def returns(self, fid):
        """The types a function returns: its annotation, else what its return statements give."""
        if fid in self._ret:
            return self._ret[fid]
        self._ret[fid] = set()                       # recursion: f calls itself
        f = self.funcs.get(fid)
        if f is None:
            return set()
        out = self.ann(f.node.returns, f.module)
        if not out:
            for st in self._own(f.node):
                if isinstance(st, ast.Return) and st.value is not None:
                    out |= {t for t, _ in self.types(st.value, f.module, f) if t[0] in ("inst", "ext")}
        self._ret[fid] = out
        return out

    # ------------------------------------------------------------------ calls

    def targets(self, call, m, f):
        """[(node id, evidence, receiver class or None, kind)] a call can go to."""
        out = []
        for t, ev in self.types(call.func, m, f):
            if t[0] == "func":
                out.append((t[1], ev, None, "func"))
            elif t[0] == "cls":                     # User(): the constructor runs
                init = self.lookup(t[1], "__init__")
                out.append((init or t[1], "constructor" if ev in ("class", "module") else ev, t[1], "init"))
            elif t[0] == "method":
                meth, cid, how = t[1], t[2], t[3]
                out.append((meth, ev, cid, how))
                if how == "inst" and ev == "self":   # self.m() also reaches subclasses' overrides
                    out += [(o, "override", cid, how) for o in self.overrides(cid, self.nodes[meth]["name"].rsplit(".", 1)[-1])]
            elif t[0] == "ext":
                out.append(("ext:" + t[1], ev, None, "ext"))
            elif t[0] == "builtin":
                out.append(("builtin:" + t[1], ev, None, "builtin"))
        seen, uniq = set(), []
        for x in out:
            if x[0] not in seen:
                seen.add(x[0])
                uniq.append(x)
        return uniq

    def run(self):
        for m in self.by_file.values():
            scopes = [(f"{m.file}:<module>", None, list(self._module_level(m.tree)))]
            for fid, f in self.funcs.items():
                if f.module is m:
                    scopes.append((fid, f, list(self._own(f.node))))
            for owner, f, nodes in scopes:
                for n in nodes:
                    if not isinstance(n, ast.Call):
                        continue
                    if isinstance(n.func, ast.Name) and n.func.id in BUILTINS and self.member(m, n.func.id) is None \
                            and not (f and n.func.id in self._visible_locals(f)):
                        continue                      # print, len, super: the language's own
                    got = [x for x in self.targets(n, m, f) if x[0] != owner]
                    label = _seg(m.src, n.func)
                    if got and all(x[0].startswith("builtin:") for x in got):
                        self.builtin += 1                 # rows.append(): known, and not the repository's
                        continue
                    got = [x for x in got if not x[0].startswith("builtin:")]
                    if not got:
                        self.unresolved[label] = self.unresolved.get(label, 0) + 1
                        continue
                    repo = [x for x in got if not x[0].startswith("ext:")]
                    many = len(repo) > 1
                    for dst, ev, cid, how in got:
                        if dst.startswith("ext:"):
                            self.nodes.setdefault(dst, dict(name=dst[4:], file="", line=None, defined=False))
                        res = "ambiguous" if many and not dst.startswith("ext:") else "exact" if ev in EXACT_FROM or ev == "constructor" and how == "init" and cid and self._direct(n) else "inferred"
                        e = dict(src=owner, dst=dst, file=m.file, line=n.lineno, col=n.col_offset + 1, kind="call",
                                 source="static", resolution=res)
                        if res != "exact" or ev in ("self", "super", "cls"):
                            e["infer"] = dict(how=ev, type=self.nodes[cid]["name"] if cid in self.nodes else None)
                        self.edges.append(e)

    @staticmethod
    def _direct(call):
        """User(...) written as a name or a dotted name: the class is named, not inferred."""
        return isinstance(call.func, (ast.Name, ast.Attribute))

    def _visible_locals(self, f):
        names, g = set(), f
        while g is not None:
            names |= set(g.locals) | {a.arg for a in g.node.args.posonlyargs + g.node.args.args + g.node.args.kwonlyargs}
            g = g.parent
        return names

    @staticmethod
    def _module_level(tree):
        """Module and class body statements: code that runs on import, decorators included."""
        todo = list(ast.iter_child_nodes(tree))
        while todo:
            n = todo.pop()
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                todo.extend(n.decorator_list)
                todo.extend(d for d in n.args.defaults + [x for x in n.args.kw_defaults if x is not None])
                continue
            if isinstance(n, ast.ClassDef):
                todo.extend(n.decorator_list + n.bases + [k.value for k in n.keywords])
                todo.extend(s for s in n.body)
                continue
            yield n
            todo.extend(ast.iter_child_nodes(n))


def build(root, files):
    a = Analyzer(root, files)
    a.run()
    # module nodes only when code runs at the top of the file
    used = {e["src"] for e in a.edges} | {e["dst"] for e in a.edges}
    nodes = {k: v for k, v in a.nodes.items() if v.get("kind") != "module" or k in used}
    counts = {}
    for e in a.edges:
        counts[e["resolution"]] = counts.get(e["resolution"], 0) + 1
    counts["unresolved"] = sum(a.unresolved.values())
    counts["builtin"] = a.builtin
    top = sorted(a.unresolved.items(), key=lambda kv: -kv[1])[:20]
    stats = dict(files=len(a.by_file), languages={"python": len(a.by_file)},
                 nodes=sum(1 for n in nodes.values() if n.get("defined")), edges=len(a.edges),
                 resolution=counts, unresolved_top=top, errors=a.errors)
    return dict(nodes=nodes, edges=a.edges, stats=stats)
