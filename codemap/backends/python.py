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

from ..scope import is_test as _convention
from ..source import lines

BUILTINS = set(dir(builtins))
BUILTIN_TYPES = {"list", "dict", "set", "tuple", "str", "bytes", "frozenset", "bytearray", "open", "int", "float"}
# container types by the names annotations use for them
SEQ = {"list": "list", "set": "set", "frozenset": "set", "tuple": "tuple", "dict": "dict", "sequence": "list",
       "mutablesequence": "list", "iterable": "iter", "iterator": "iter", "collection": "list", "abstractset": "set",
       "mapping": "dict", "mutablemapping": "dict", "deque": "list", "defaultdict": "dict", "ordereddict": "dict",
       "generator": "iter", "counter": "dict"}
# methods that put something into a container
PUTS = {"append", "appendleft", "add", "insert", "extend", "update"}
EXACT_FROM = {"module", "class", "self", "cls", "super", "name"}      # receivers whose target is certain


_LINES = {}


def _seg(src, node):
    """The source text of a node (ast.get_source_segment, without splitting the file again each time)."""
    ls = _LINES.get(id(src))
    if ls is None or ls[0] is not src:
        ls = _LINES[id(src)] = (src, src.splitlines(True))
    try:
        a, b = node.lineno - 1, node.end_lineno - 1
        lines_ = ls[1]
        if a == b:
            return lines_[a].encode()[node.col_offset:node.end_col_offset].decode(errors="replace")
        first = lines_[a].encode()[node.col_offset:].decode(errors="replace")
        last = lines_[b].encode()[:node.end_col_offset].decode(errors="replace")
        return first + "".join(lines_[a + 1:b]) + last
    except (AttributeError, IndexError, TypeError):
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
    def __init__(self, root, files, tests=None):
        self.root = Path(root)
        self.tests = set(tests) if tests is not None else None
        self.modules, self.by_file, self.short = {}, {}, {}
        self.nodes, self.funcs, self.classes = {}, {}, {}
        self.edges, self.unresolved, self.errors, self.builtin = [], {}, [], 0
        self._ret, self._mro, self._busy, self._cache, self._taint, self._vis = {}, {}, set(), {}, set(), {}
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


    def is_test(self, path):
        """A test file: as .codemap/rules.json says when the build passed the list, else by convention."""
        return path in self.tests if self.tests is not None else _convention(path)
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
                if parent is not None and not cls:       # def rule(d): ... inside a function: a local name
                    parent.locals.setdefault(st.name, []).append(("def", nid))
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
                if parent is not None and not cls:
                    parent.locals.setdefault(st.name, []).append(("defcls", nid))
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
        """Every value a local name is given in the function, without descending into nested definitions:
        assignments, annotations, with ... as, :=, loop variables, and what is put into a container."""
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
                    if st.value is not None:
                        f.locals[st.target.id].append(("expr", st.value))
                elif isinstance(st.target, ast.Attribute) and isinstance(st.target.value, ast.Name) and st.target.value.id == "self" and f.cls:
                    f.cls.attrs.setdefault(st.target.attr, []).append(("ann", st.annotation, f))
                    if st.value is not None:
                        self._bind(f, st.target, st.value)
            elif isinstance(st, (ast.With, ast.AsyncWith)):
                for it in st.items:
                    if isinstance(it.optional_vars, ast.Name):
                        f.locals.setdefault(it.optional_vars.id, []).append(("expr", it.context_expr))
            elif isinstance(st, ast.NamedExpr) and isinstance(st.target, ast.Name):
                f.locals.setdefault(st.target.id, []).append(("expr", st.value))
            elif isinstance(st, (ast.For, ast.AsyncFor, ast.comprehension)):
                self._bind_iter(f, st.target, st.iter)
            elif isinstance(st, ast.Call) and isinstance(st.func, ast.Attribute) and st.func.attr in PUTS and st.args:
                # users.append(User()), seen.add(x), queue.extend(items), self.users.append(u)
                arg = st.args[-1] if st.func.attr == "insert" else st.args[0]
                how = "extend" if st.func.attr in ("extend", "update") else "append"
                self._put(f, st.func.value, ("elems" if how == "extend" else "elem", arg, st.func.attr))

    def _bind(self, f, target, value):
        if isinstance(target, ast.Name):
            f.locals.setdefault(target.id, []).append(("expr", value))
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self" and f.cls:
            f.cls.attrs.setdefault(target.attr, []).append(("expr", value, f))      # self.client = Client()
        elif isinstance(target, ast.Subscript):                                     # by_id[k] = User()
            self._put(f, target.value, ("elem", value, "setitem"))
        elif isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)) and len(target.elts) == len(value.elts):
            for t, v in zip(target.elts, value.elts):                               # a, b = A(), B()
                self._bind(f, t, v)

    def _put(self, f, holder, entry):
        """Something put into a container: kept with the container's name, and how it got there."""
        if isinstance(holder, ast.Name):
            f.locals.setdefault(holder.id, []).append(entry)
        elif isinstance(holder, ast.Attribute) and isinstance(holder.value, ast.Name) and holder.value.id == "self" and f.cls:
            f.cls.attrs.setdefault(holder.attr, []).append(entry + (f,) if len(entry) == 2 else (entry[0], entry[1], f, entry[2]))

    def _bind_iter(self, f, target, it):
        """for user in users; for i, user in enumerate(users); for k, v in d.items(); comprehensions alike."""
        if isinstance(target, ast.Name):
            f.locals.setdefault(target.id, []).append(("iter", it))
        elif isinstance(target, (ast.Tuple, ast.List)) and len(target.elts) == 2 and isinstance(it, ast.Call):
            fn = it.func
            if isinstance(fn, ast.Name) and fn.id == "enumerate" and it.args and isinstance(target.elts[1], ast.Name):
                f.locals.setdefault(target.elts[1].id, []).append(("iter", it.args[0]))
            elif isinstance(fn, ast.Attribute) and fn.attr == "items" and isinstance(target.elts[1], ast.Name):
                f.locals.setdefault(target.elts[1].id, []).append(("values", fn.value))

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

    def overrides(self, cid, name, prod=True):
        """Methods of the same name in subclasses: where self.m() may also go. Production code is not
        reached by a subclass a test defines."""
        out, todo = [], list(self.classes[cid].subclasses)
        while todo:
            s = todo.pop()
            if prod and self.is_test(self.classes[s].module.file):
                continue
            if name in self.classes[s].methods:
                out.append(self.classes[s].methods[name])
            todo.extend(self.classes[s].subclasses)
        return out

    # ------------------------------------------------------------------ types (2B)
    #
    # A type is a tuple:
    #   ("inst", class, exact)   an object; exact when it was made by that class's constructor, so no
    #                            subclass can stand in for it; not exact for self, annotations, cls
    #   ("cls", class, exact)    the class itself
    #   ("module", Module) ("func", id) ("ext", dotted) ("super", class) ("builtin", name)
    #   ("coll", kind, elems, values)  a list, set, tuple, iterator or dict; elems (dict: keys) and
    #                            values are frozensets of (type, how the element got in)
    #   ("method", id, class, receiver kind, exact)   ("cmeth", coll, name): a container's method

    def ann(self, expr, m):
        """The types an annotation names: User, mod.User, "User", User | None, Optional[User], Union[A, B],
        list[User], dict[str, User], Iterable[User]."""
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
            args = expr.slice.elts if isinstance(expr.slice, ast.Tuple) else [expr.slice]
            if head in ("Optional", "Union", "Annotated", "Final", "ClassVar"):
                return set().union(*(self.ann(a, m) for a in (args[:1] if head == "Annotated" else args)))
            kind = SEQ.get(head.lower())
            if kind == "dict":
                vals = self.ann(args[1], m) if len(args) > 1 else set()
                return {("coll", "dict", frozenset((t, "annotation") for t in self.ann(args[0], m)), frozenset((t, "annotation") for t in vals))}
            if kind:
                elems = set().union(*(self.ann(a, m) for a in args if not (isinstance(a, ast.Constant) and a.value is Ellipsis)))
                return {("coll", kind, frozenset((t, "annotation") for t in elems), frozenset())}
            return set()
        if isinstance(expr, ast.Name) and expr.id in BUILTIN_TYPES and self.member(m, expr.id) is None:
            return {("coll", SEQ[expr.id], frozenset(), frozenset())} if expr.id in SEQ else {("builtin", expr.id)}
        out = set()
        for t, _ in self.types(expr, m, None):
            if t[0] == "cls":
                out.add(("inst", t[1], False))          # an annotation is a bound: a subclass's object fits too
            elif t[0] == "ext":
                out.add(("ext", t[1]))
        return out

    def types(self, expr, m, f, depth=0):
        """{(type, evidence)}: what an expression may be; evidence says how it was found (self,
        constructor, annotation, return, assign, attribute, element:<how>), for the edge's resolution."""
        if expr is None or depth > 14:
            return set()
        # a name's value is the same wherever it is read in a function: one entry per (function, name)
        key = ("n", id(f), expr.id, id(m)) if isinstance(expr, ast.Name) else (id(expr), id(f))
        return self._memo(key, lambda: self._types(expr, m, f, depth))

    def _memo(self, key, compute):
        """compute() once per key. A cycle (x = x.next, out.append(f(out))) is cut with an empty answer;
        every value being worked out at that moment may lack the cut part, so those are not kept."""
        if key in self._cache:
            return self._cache[key]
        if key in self._busy:
            self._taint |= self._busy
            return set()
        self._busy.add(key)
        try:
            out = compute()
        finally:
            self._busy.discard(key)
        if key in self._taint:
            self._taint.discard(key)
        else:
            self._cache[key] = out
        return out

    @staticmethod
    def _coll(kind, elems=(), values=()):
        return ("coll", kind, frozenset(elems), frozenset(values))

    def elements(self, t, values=False):
        """{(type, evidence)} of what iterating a container gives (a dict: its keys; values=True: its values)."""
        if t[0] != "coll":
            return set()
        src = t[3] if values or t[1] == "dict" and values else t[2]
        return {(x, "element:" + ev.removeprefix("element:")) for x, ev in src}

    def _types(self, expr, m, f, depth):
        if isinstance(expr, ast.Name):
            return self._name(expr.id, m, f, depth)
        if isinstance(expr, ast.Attribute):
            out = set()
            for (t, ev) in self.types(expr.value, m, f, depth + 1):
                out |= self._attr(t, ev, expr.attr, depth, not self.is_test(m.file))
            return out
        if isinstance(expr, ast.Call):
            fn = expr.func
            if isinstance(fn, ast.Name) and fn.id == "super" and f is not None and f.cls:
                return {(("super", f.cls.id), "super")}
            if isinstance(fn, ast.Name) and self.member(m, fn.id) is None and not (f and fn.id in self._visible_locals(f)):
                if fn.id in ("list", "sorted", "tuple", "set", "reversed", "frozenset") and expr.args:   # list(users)
                    elems = set().union(*(self.elements(t) for t, _ in self.types(expr.args[0], m, f, depth + 1)))
                    return {(self._coll(SEQ.get(fn.id, "list"), elems), "constructor")}
                if fn.id in ("next", "min", "max") and expr.args:
                    return set().union(*(self.elements(t) for t, _ in self.types(expr.args[0], m, f, depth + 1)))
                if fn.id in BUILTIN_TYPES:
                    return {((self._coll(SEQ[fn.id]) if fn.id in SEQ else ("builtin", fn.id)), "constructor")}   # dict(), open()
            out = set()
            for (t, ev) in self.types(fn, m, f, depth + 1):
                if t[0] == "cls":
                    out.add((("inst", t[1], t[2]), "constructor"))                # User(): exactly a User
                elif t[0] == "func":
                    out |= {(r, ev2) for r, ev2 in self.returns(t[1])}            # create_user() -> User
                elif t[0] == "ext" and t[1].rsplit(".", 1)[-1][:1].isupper():
                    out.add((("ext", t[1]), "constructor"))                     # FastAPI(): an outside class's object
                elif t[0] == "cmeth":
                    out |= self._cmeth_result(t[1], t[2], expr, m, f, depth)
            return out
        if isinstance(expr, ast.Subscript):                                     # users[0], by_id[k]
            out = set()
            for t, _ in self.types(expr.value, m, f, depth + 1):
                if t[0] == "coll" and not isinstance(expr.slice, ast.Slice):
                    out |= self.elements(t, values=t[1] == "dict")
                elif t[0] == "coll":
                    out.add((t, "assign"))
            return out
        if isinstance(expr, (ast.List, ast.Set, ast.Tuple)):
            kind = {ast.List: "list", ast.Set: "set", ast.Tuple: "tuple"}[type(expr)]
            return {(self._coll(kind, self._each(expr.elts, "literal", m, f, depth)), "literal")}
        if isinstance(expr, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
            kind = {ast.ListComp: "list", ast.SetComp: "set", ast.GeneratorExp: "iter"}[type(expr)]
            return {(self._coll(kind, self._each([expr.elt], "comprehension", m, f, depth)), "literal")}
        if isinstance(expr, ast.Dict):
            return {(self._coll("dict", self._each([k for k in expr.keys if k is not None], "literal", m, f, depth),
                                self._each(expr.values, "literal", m, f, depth)), "literal")}
        if isinstance(expr, ast.DictComp):
            return {(self._coll("dict", self._each([expr.key], "comprehension", m, f, depth),
                                self._each([expr.value], "comprehension", m, f, depth)), "literal")}
        if isinstance(expr, ast.JoinedStr) or isinstance(expr, ast.Constant) and isinstance(expr.value, (str, bytes)):
            return {(("builtin", "bytes" if isinstance(getattr(expr, "value", ""), bytes) else "str"), "literal")}
        if isinstance(expr, ast.IfExp):
            return self.types(expr.body, m, f, depth + 1) | self.types(expr.orelse, m, f, depth + 1)
        if isinstance(expr, ast.BoolOp):
            return set().union(*(self.types(v, m, f, depth + 1) for v in expr.values))
        if isinstance(expr, ast.Await):
            return self.types(expr.value, m, f, depth + 1)
        return set()

    def _each(self, exprs, how, m, f, depth):
        """The element types of a literal or comprehension. An element whose type is not known leaves an
        ("unknown",) mark: a call through the container then has targets nobody listed, so the ones
        found are only some of them (ambiguous), never the one target."""
        out = set()
        for e in exprs:
            got = {(t, how) for t, ev in self.types(e, m, f, depth + 1) if not (ev == "literal" and t[0] == "builtin")}
            if not got and not isinstance(e, (ast.Constant, ast.JoinedStr)):
                got = {(("unknown",), how)}
            out |= got
        return out

    def _cmeth_result(self, coll, name, call, m, f, depth):
        """What a container's method gives back: users.pop() a User, by_id.get(k) a User, d.values()
        its values, users.copy() the same container."""
        if name in ("pop", "popleft", "popitem") and coll[1] != "dict" or name == "get" and coll[1] != "dict":
            return self.elements(coll)
        if coll[1] == "dict" and name in ("get", "pop", "setdefault"):
            return self.elements(coll, values=True)
        if coll[1] == "dict" and name == "values":
            return {(self._coll("iter", coll[3]), "assign")}
        if coll[1] == "dict" and name == "keys":
            return {(self._coll("iter", coll[2]), "assign")}
        if name == "copy":
            return {(coll, "assign")}
        return set()

    def _merge(self, out, puts, depth, g):
        """Containers plus what was put into them later: users = [] then users.append(User())."""
        if not puts:
            return out
        extra = set()
        for kind, x, how in puts:
            got = self.types(x, g.module if g else None, g, depth + 1) if g else set()
            if not got and kind == "elem":
                got = {(("unknown",), how)}
            if kind == "elems":                        # extend(items): the elements of items
                extra |= {(t, how) for c, _ in got for t, _ in self.elements(c)}
            else:
                extra |= {(t, how) for t, _ in got}
        colls = [(t, ev) for t, ev in out if t[0] == "coll"]
        rest = {(t, ev) for t, ev in out if t[0] != "coll"}
        if not colls:
            return rest | {(self._coll("list", extra), "assign")}
        for t, ev in colls:
            if t[1] == "dict":
                rest.add((("coll", "dict", t[2], t[3] | frozenset(extra)), ev))
            else:
                rest.add((("coll", t[1], t[2] | frozenset(extra), t[3]), ev))
        return rest

    def _name(self, name, m, f, depth):
        g = f
        while g is not None:                  # the function's locals, then those of enclosing functions
            first = g.node.args.posonlyargs + g.node.args.args
            if g.cls and first and first[0].arg == name and not g.static:
                return {(("cls", g.cls.id, False), "cls")} if g.classmethod else {(("inst", g.cls.id, False), "self")}
            if name in g.locals:
                out, puts = set(), []
                for entry in g.locals[name]:
                    kind, x = entry[0], entry[1]
                    if kind == "ann":
                        out |= {(t, "annotation") for t in self.ann(x, g.module)}
                    elif kind == "expr":
                        out |= {(t, "assign" if ev in ("module", "class", "name", "literal") and t[0] in ("inst", "coll") else ev)
                                for t, ev in self.types(x, g.module, g, depth + 1)}
                    elif kind == "def":
                        out.add((("func", x), "name"))
                    elif kind == "defcls":
                        out.add((("cls", x, True), "class"))
                    elif kind == "iter":                 # for user in users: an element
                        out |= {e for t, _ in self.types(x, g.module, g, depth + 1) for e in self.elements(t)}
                    elif kind == "values":               # for k, v in d.items(): a value
                        out |= {e for t, _ in self.types(x, g.module, g, depth + 1) for e in self.elements(t, values=True)}
                    else:                                # put in: append, add, extend, d[k] = v
                        puts.append((kind, x, entry[2]))
                return self._merge(out, puts, depth, g)
            if any(a.arg == name for a in g.node.args.posonlyargs + g.node.args.args + g.node.args.kwonlyargs):
                return set()                   # a parameter with no annotation: unknown
            g = g.parent
        ref = self.member(m, name)
        if ref is None:
            return set()
        if ref[0] == "func":
            return {(("func", ref[1]), "name")}
        if ref[0] == "class":
            return {(("cls", ref[1], True), "class")}
        if ref[0] == "module":
            return {(("module", ref[1]), "module")}
        if ref[0] == "ext":
            return {(("ext", ref[1]), "module")}
        out = set()                            # a module variable: client = Client()
        for kind, x in ref[1].assigns.get(ref[2], []):
            if kind == "ann":
                out |= {(t, "annotation") for t in self.ann(x, ref[1])}
            else:
                out |= {(t, "assign" if ev in ("constructor", "literal") else ev) for t, ev in self.types(x, ref[1], None, depth + 1)
                        if t[0] in ("inst", "func", "cls", "module", "ext", "coll")}
        return out

    def _attr(self, t, ev, name, depth, prod=True):
        kind = t[0]
        if kind == "module":
            ref = self.member(t[1], name)
            if ref is None:
                return set()
            if ref[0] == "func":
                return {(("func", ref[1]), "module")}
            if ref[0] == "class":
                return {(("cls", ref[1], True), "module")}
            if ref[0] == "module":
                return {(("module", ref[1]), "module")}
            if ref[0] == "ext":
                return {(("ext", ref[1]), "module")}
            return self._name(name, t[1], None, depth + 1)
        if kind == "ext":
            return {(("ext", f"{t[1]}.{name}"), ev)}
        if kind == "builtin":
            return {(("builtin", f"{t[1]}.{name}"), ev)}
        if kind == "coll":
            return {(("cmeth", t, name), ev)}
        if kind in ("inst", "cls", "super"):
            cid, exact = t[1], (t[2] if kind != "super" else True)
            meth = self.lookup(cid, name, after=cid if kind == "super" else None)
            if meth:
                return {(("method", meth, cid, kind, exact), ev)}
            # not in the repository's classes: a method an outside base class provides (self.addSwitch, super().__init__)
            outside = [b for c in self.mro(cid) for b in self.classes[c].bases if b.startswith("ext:")]
            if outside and not any(name in self.classes[c].attrs for c in self.mro(cid)):
                return {(("ext", f"{outside[0][4:]}.{name}"), ev)}
            out = set()
            for c in self.mro(cid):                 # an attribute: self.client.send() -> Client.send
                km = self.classes[c].module
                attrs = self.classes[c].attrs.get(name, [])
                base, puts = set(), []
                for a in attrs:
                    akind, x, g = a[0], a[1], a[2]
                    if prod and g is not None and self.is_test(g.module.file):
                        continue                     # what a test stores in an attribute is not production's
                    if akind == "ann":
                        base |= {(tt, "attribute") for tt in self.ann(x, km)}
                    elif akind == "expr":
                        base |= {(tt, "attribute") for tt, _ in self.types(x, km, g, depth + 1)
                                 if tt[0] in ("inst", "func", "cls", "ext", "coll")}
                    else:
                        puts.append((akind, x, a[3]) if len(a) > 3 else (akind, x, "append"))
                if attrs:
                    g0 = next((a[2] for a in attrs if a[2] is not None), None)
                    out |= self._merge(base, puts, depth, g0) if g0 else base
            return out
        return set()

    def returns(self, fid):
        """{(type, evidence)} a function returns: its annotation, else what its return statements give."""
        if fid in self._ret:
            return self._ret[fid]
        self._ret[fid] = set()                       # recursion: f calls itself
        f = self.funcs.get(fid)
        if f is None:
            return set()
        out = {(t, "return") for t in self.ann(f.node.returns, f.module)}
        if not out:
            for st in self._own(f.node):
                if isinstance(st, ast.Return) and st.value is not None:
                    # what the function made keeps its exactness: return User() is exactly a User
                    # return rule: a function made inside, handed out to be called later
                    out |= {(t, "return") for t, _ in self.types(st.value, f.module, f) if t[0] in ("inst", "ext", "coll", "func")}
        self._ret[fid] = out
        return out

    # ------------------------------------------------------------------ calls

    def targets(self, call, m, f):
        """[(node id, evidence, receiver class or None, kind)] a call can go to."""
        out = []
        # a set: in a fixed order, so the evidence an edge keeps does not change from run to run;
        # a constructor is the strongest (x: Path, then x = Path(x))
        for t, ev in sorted(self.types(call.func, m, f), key=lambda x: (x[1] != "constructor", repr(x[1]), repr(x[0]))):
            if t[0] == "func":
                out.append((t[1], ev, None, "func"))
            elif t[0] == "cls":                     # User(): the constructor runs
                init = self.lookup(t[1], "__init__")
                out.append((init or t[1], "constructor" if ev in ("class", "module") else ev, t[1], "init"))
            elif t[0] == "method":
                meth, cid, how, exact = t[1], t[2], t[3], t[4]
                out.append((meth, ev, cid, how))
                # an object whose class is only a bound (self, cls, an annotation) may be a subclass's:
                # its overrides are possible targets too; one made by a constructor is exactly that class
                if how in ("inst", "cls") and not exact:
                    out += [(o, "override", cid, how) for o in self.overrides(cid, self.nodes[meth]["name"].rsplit(".", 1)[-1], not self.is_test(m.file))]
            elif t[0] == "ext":
                out.append(("ext:" + t[1], ev, None, "ext"))
            elif t[0] == "unknown":
                out.append(("unknown:", ev, None, "unknown"))      # a target nobody can name
            elif t[0] in ("builtin", "cmeth", "coll"):
                out.append(("builtin:" + (t[1] if t[0] == "builtin" else t[1][1] + "." + t[2] if t[0] == "cmeth" else t[1]), ev, None, "builtin"))
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
                    partial = any(x[0] == "unknown:" for x in got)
                    got = [x for x in got if x[0] != "unknown:"]
                    if not got:
                        self.unresolved[label] = self.unresolved.get(label, 0) + 1
                        continue
                    if not got:
                        self.unresolved[label] = self.unresolved.get(label, 0) + 1
                        continue
                    repo = [x for x in got if not x[0].startswith("ext:")]
                    many = len(repo) > 1 or partial and bool(repo)
                    for dst, ev, cid, how in got:
                        if dst.startswith("ext:"):
                            self.nodes.setdefault(dst, dict(name=dst[4:], file="", line=None, defined=False))
                        res = "ambiguous" if many and not dst.startswith("ext:") else "exact" if ev in EXACT_FROM or ev == "constructor" and how == "init" and cid and self._direct(n) else "inferred"
                        e = dict(src=owner, dst=dst, file=m.file, line=n.lineno, col=n.col_offset + 1, kind="call",
                                 source="static", resolution=res)
                        if res != "exact" or ev in ("self", "super", "cls"):
                            e["infer"] = dict(how=ev, type=self.nodes[cid]["name"] if cid in self.nodes else None)
                            if partial:
                                e["infer"]["partial"] = True       # the container also holds things of unknown type
                        self.edges.append(e)

    @staticmethod
    def _direct(call):
        """User(...) written as a name or a dotted name: the class is named, not inferred."""
        return isinstance(call.func, (ast.Name, ast.Attribute))

    def _visible_locals(self, f):
        if f.id in self._vis:
            return self._vis[f.id]
        names, g = set(), f
        while g is not None:
            names |= set(g.locals) | {a.arg for a in g.node.args.posonlyargs + g.node.args.args + g.node.args.kwonlyargs}
            g = g.parent
        self._vis[f.id] = names
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


def build(root, files, tests=None):
    a = Analyzer(root, files, tests)
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
