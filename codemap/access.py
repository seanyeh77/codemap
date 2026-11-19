"""What a function does with what it is given and with what lies outside it, read from its body with tree-sitter:
for each parameter the caller can see changes through (a pointer, a reference, a list, an object), whether the
body reads it, writes through it, or hands it on; and the variables outside the function (globals, statics,
package and module variables) it reads or writes, on which lines, and whether atomically.

Only syntax is read: an alias the body makes (q = p), or a call the parameter is handed to that codemap cannot
follow, leaves the answer open rather than guessed. A call to a function of the repository is followed (its own
parameter's role); a call outside it uses the role an AI described for it, when there is one. So every answer here
is marked as inferred.

of(root, file, line, end, lang, sig, roles) -> {"params": {name: {...}}, "shared": [...]}
  params[name]: {"reads": [lines], "writes": [lines], "passes": [[line, callee]], "role": in|out|in-out|None}
  shared: {"name", "scope": global|static|module|package|field, "reads": [lines], "writes": [lines], "atomic": bool}
"""
from . import signature
from .signature import txt

# a method that changes the object it is called on: the language's own containers, not any library's
MUTATORS = {
    "python": {"append", "extend", "insert", "pop", "remove", "clear", "update", "add", "discard", "setdefault",
               "sort", "reverse", "popitem", "appendleft", "extendleft", "popleft", "write", "writelines"},
    "javascript": {"push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set",
                   "add", "delete", "clear"},
    "java": {"add", "addAll", "put", "putAll", "remove", "removeAll", "clear", "set", "sort", "push", "pop",
             "offer", "poll", "addFirst", "addLast", "removeFirst", "removeLast", "retainAll", "replaceAll"},
}
MUTATORS["typescript"] = MUTATORS["tsx"] = MUTATORS["javascript"]

# (node type, field of the thing accessed): access through a parameter or variable goes through these
WRAPPERS = {
    "c": {"subscript_expression": "argument", "field_expression": "argument", "pointer_expression": "argument",
          "parenthesized_expression": None},
    "python": {"attribute": "object", "subscript": "value"},
    "go": {"selector_expression": "operand", "index_expression": "operand", "unary_expression": "operand",
           "parenthesized_expression": None},
    "java": {"field_access": "object", "array_access": "array"},
    "javascript": {"member_expression": "object", "subscript_expression": "object", "parenthesized_expression": None},
}
WRAPPERS["cpp"] = WRAPPERS["c"]
WRAPPERS["typescript"] = WRAPPERS["tsx"] = WRAPPERS["javascript"]

ASSIGN = {"assignment_expression", "assignment", "augmented_assignment", "augmented_assignment_expression",
          "assignment_statement", "short_var_declaration"}
UPDATE = {"update_expression", "inc_statement", "dec_statement"}
CALLS = {"call_expression", "call", "method_invocation", "new_expression", "object_creation_expression"}
ARGS = {"argument_list", "arguments"}
SCOPES = {"function_definition", "function_declaration", "method_declaration", "method_definition", "lambda",
          "arrow_function", "function_expression", "func_literal", "class_definition", "class_declaration"}


def _wrapped(node, lg):
    """Climbs from a name through the accesses on it (p->x.y, *p, p[i], p.attr): the outermost access and whether
    there was one (an access reaches what the caller passed; the bare name is only the local copy)."""
    w = WRAPPERS.get(lg, {})
    cur, through = node, False
    while cur.parent is not None and cur.parent.type in w:
        p = cur.parent
        field = w[p.type]
        if field is None:
            cur = p
            continue
        base = p.child_by_field_name(field)
        if base is None or base.id != cur.id:
            break
        if p.type in ("pointer_expression", "unary_expression"):
            op = txt(p.child_by_field_name("operator")) or txt(p.children[0])
            if op not in ("*",):
                break                                   # &p takes the address: the caller's thing is not touched here
        if lg == "go" and p.type == "selector_expression" and p.parent is not None and p.parent.type == "call_expression" \
                and p.parent.child_by_field_name("function") is not None and p.parent.child_by_field_name("function").id == p.id:
            return p, through, "method"                 # s.Method(): a method of the value
        if lg in ("python", "javascript", "typescript", "tsx") and p.type in ("attribute", "member_expression"):
            par = p.parent
            if par is not None and par.type in ("call", "call_expression") and par.child_by_field_name("function") is not None \
                    and par.child_by_field_name("function").id == p.id:
                return p, through, "method"
        cur, through = p, True
    return cur, through, None


def _left(p):
    return p.child_by_field_name("left")


def _contains(outer, inner):
    return outer is not None and outer.start_byte <= inner.start_byte and inner.end_byte <= outer.end_byte


def _use(node, lg):
    """How a name is used where it stands: (kind, through, extra). kind: read, write, readwrite, pass (handed to a
    call: extra is (callee name, argument index)), method (extra: the method's name), bind (the bare name assigned:
    a local rebinding), addr (&x handed on)."""
    top, through, how = _wrapped(node, lg)
    if how == "method":
        name = txt(top.child_by_field_name("attribute") or top.child_by_field_name("property") or top.child_by_field_name("field"))
        return "method", through, name
    p = top.parent
    if p is None:
        return "read", through, None
    if lg == "java" and p.type == "method_invocation" and p.child_by_field_name("object") is not None \
            and p.child_by_field_name("object").id == top.id:
        return "method", through, txt(p.child_by_field_name("name"))
    if p.type in ("pointer_expression", "unary_expression") and txt(p.children[0]) == "&":
        q = p.parent
        if q is not None and q.type in ARGS:
            call = q.parent
            idx = [c.id for c in q.named_children].index(p.id)
            return "addr", through, (_callee(call), idx)
        return "read", through, None
    if p.type in ARGS:
        idx = [c.id for c in p.named_children].index(top.id) if top.id in [c.id for c in p.named_children] else -1
        return "pass", through, (_callee(p.parent), idx)
    if p.type in ASSIGN:
        left = _left(p)
        if left is not None and _contains(left, top):
            op = txt(p.child_by_field_name("operator")) or ""
            compound = p.type.startswith("augmented") or (op not in ("", "=", ":="))
            # the bare name assigned: a local rebinding for a parameter, a write for an outside variable
            return ("readwrite" if compound else "write") if through else "bind", through, compound
        if lg == "go" and p.type == "assignment_statement":
            pass
        return "read", through, None
    if p.type == "expression_list" and p.parent is not None and p.parent.type in ("assignment_statement", "short_var_declaration"):
        a = p.parent
        if a.child_by_field_name("left") is not None and a.child_by_field_name("left").id == p.id:
            return ("write" if through else "bind"), through, None
        return "read", through, None
    if p.type in UPDATE:
        return ("readwrite" if through else "bind"), through, True
    if p.type in ("delete_statement",) or (p.type == "unary_expression" and txt(p.children[0]) == "delete"):
        return "write", through, None
    if p.type in ("init_declarator", "variable_declarator") and through is False:
        return "alias", through, None
    return "read", through, None


def _alias(node, lg):
    """The local name a parameter is copied into (int16_t *out = output; q = p), or None."""
    top = node
    while top.parent is not None and top.parent.type in ("cast_expression", "parenthesized_expression", "as_expression", "type_assertion"):
        top = top.parent
    p = top.parent
    if p is None:
        return None
    if p.type == "init_declarator" and p.child_by_field_name("value") is not None and p.child_by_field_name("value").id == top.id:
        return signature._ident(p.child_by_field_name("declarator"))
    if p.type == "variable_declarator" and p.child_by_field_name("value") is not None and p.child_by_field_name("value").id == top.id:
        n = p.child_by_field_name("name")
        return txt(n) if n is not None and n.type == "identifier" else None
    if p.type in ("assignment", "assignment_expression") and p.child_by_field_name("right") is not None \
            and p.child_by_field_name("right").id == top.id and _left(p) is not None and _left(p).type == "identifier":
        return txt(_left(p))
    if p.type == "expression_list" and p.parent is not None and p.parent.type == "short_var_declaration" and len(p.named_children) == 1:
        left = p.parent.child_by_field_name("left")
        if left is not None and left.id != p.id and len(left.named_children) == 1:
            return txt(left.named_children[0])
    return None


def _callee(call):
    if call is None:
        return ""
    f = call.child_by_field_name("function") or call.child_by_field_name("name") or call.child_by_field_name("constructor")
    name = txt(f)
    return name.rsplit(".", 1)[-1].rsplit("->", 1)[-1]


def _declares(n):
    """The name being declared (int16_t *out = ...; var x; q := ...), not a use of it."""
    cur = n
    while cur.parent is not None and cur.parent.type in ("pointer_declarator", "array_declarator", "reference_declarator",
                                                          "parenthesized_declarator"):
        cur = cur.parent
    p = cur.parent
    if p is None:
        return False
    if p.type in ("global_statement", "nonlocal_statement"):
        return True
    if p.type in ("init_declarator", "declaration", "variable_declarator", "var_spec", "parameter_declaration"):
        d = p.child_by_field_name("declarator") or p.child_by_field_name("name")
        return d is not None and d.id == cur.id
    if p.type == "expression_list" and p.parent is not None and p.parent.type == "short_var_declaration":
        return p.parent.child_by_field_name("left") is not None and p.parent.child_by_field_name("left").id == p.id
    return False


def _names(body, wanted):
    """Every identifier in the body (not in nested functions or classes) whose text is in wanted."""
    out = []
    stack = list(body.children) if body is not None else []
    while stack:
        n = stack.pop()
        if n.type in SCOPES:
            continue
        if n.type in ("identifier", "field_identifier") and txt(n) in wanted and not _declares(n):
            if n.parent is not None and n.parent.type in ("field_expression", "selector_expression", "member_expression", "attribute", "field_access") \
                    and (n.parent.child_by_field_name("field") or n.parent.child_by_field_name("property")
                         or n.parent.child_by_field_name("attribute")) is not None \
                    and (n.parent.child_by_field_name("field") or n.parent.child_by_field_name("property")
                         or n.parent.child_by_field_name("attribute")).id == n.id:
                pass                                     # x.name: a field called like the parameter, not it
            else:
                out.append(n)
        stack.extend(n.children)
    return sorted(out, key=lambda n: n.start_byte)


def _locals(body, lg):
    """Names the body declares itself (they shadow outside variables)."""
    out = set()
    stack = list(body.children) if body is not None else []
    while stack:
        n = stack.pop()
        if n.type in SCOPES:
            continue
        if n.type in ("init_declarator",):
            out.add(signature._ident(n.child_by_field_name("declarator")))
        elif n.type == "declaration" and lg in ("c", "cpp"):
            for d in n.children_by_field_name("declarator"):
                out.add(signature._ident(d))
        elif n.type in ("variable_declarator",) and n.child_by_field_name("name") is not None:
            out.add(txt(n.child_by_field_name("name")))
        elif n.type == "short_var_declaration":
            for c in (n.child_by_field_name("left") or n).named_children:
                out.add(txt(c))
        elif n.type in ("var_spec",) and n.child_by_field_name("name") is not None:
            out.add(txt(n.child_by_field_name("name")))
        elif lg == "python" and n.type == "assignment" and n.child_by_field_name("left") is not None and n.child_by_field_name("left").type == "identifier":
            out.add(txt(n.child_by_field_name("left")))
        elif lg == "python" and n.type == "for_statement" and n.child_by_field_name("left") is not None:
            out.add(txt(n.child_by_field_name("left")))
        stack.extend(n.children)
    return out


def _globals_declared(body):
    """Python: the names a `global` or `nonlocal` statement makes refer to the module's variables."""
    out = set()
    stack = list(body.children) if body is not None else []
    while stack:
        n = stack.pop()
        if n.type in SCOPES:
            continue
        if n.type in ("global_statement", "nonlocal_statement"):
            out |= {txt(c) for c in n.named_children if c.type == "identifier"}
        stack.extend(n.children)
    return out


def file_vars(root, file, lg):
    """The variables a file declares outside its functions: {name: (scope, line, atomic)}."""
    tree = signature._tree(root, file, lg)
    if tree is None:
        return {}
    out = {}
    for n in tree.root_node.children:
        t = n.type
        if lg in ("c", "cpp") and t == "declaration":
            if any(c.type == "function_declarator" for c in _walk(n, depth=3)):
                continue
            static = any(c.type == "storage_class_specifier" and txt(c) == "static" for c in n.children)
            extern = any(c.type == "storage_class_specifier" and txt(c) == "extern" for c in n.children)
            atomic = "_Atomic" in txt(n) or "atomic_" in txt(n.child_by_field_name("type")) or "std::atomic" in txt(n)
            for d in n.children_by_field_name("declarator"):
                name = signature._ident(d.child_by_field_name("declarator") if d.type == "init_declarator" else d)
                if name:
                    out[name] = ("static" if static else "extern" if extern else "global", n.start_point[0] + 1, atomic)
        elif lg == "python" and t == "expression_statement" and n.named_children and n.named_children[0].type == "assignment":
            left = n.named_children[0].child_by_field_name("left")
            for c in [left] if left is not None and left.type == "identifier" else (left.named_children if left is not None else []):
                if c.type == "identifier":
                    out[txt(c)] = ("module", n.start_point[0] + 1, False)
        elif lg == "go" and t == "var_declaration":
            for spec in _walk(n, depth=3):
                if spec.type == "var_spec":
                    atomic = "atomic." in txt(spec.child_by_field_name("type"))
                    for c in spec.children_by_field_name("name"):
                        out[txt(c)] = ("package", spec.start_point[0] + 1, atomic)
        elif lg in ("typescript", "tsx", "javascript") and t in ("lexical_declaration", "variable_declaration", "export_statement"):
            for d in _walk(n, depth=3):
                if d.type == "variable_declarator" and d.child_by_field_name("name") is not None and d.child_by_field_name("name").type == "identifier":
                    v = d.child_by_field_name("value")
                    if v is not None and v.type in ("arrow_function", "function_expression", "function", "class"):
                        continue
                    out[txt(d.child_by_field_name("name"))] = ("module", d.start_point[0] + 1, False)
    if lg == "java":
        for f in _walk(tree.root_node, depth=6):
            if f.type == "field_declaration" and "static" in txt(next((c for c in f.children if c.type == "modifiers"), None)):
                for d in f.children_by_field_name("declarator"):
                    out[txt(d.child_by_field_name("name"))] = ("field", f.start_point[0] + 1, "Atomic" in txt(f.child_by_field_name("type")))
    return out


def _walk(n, depth):
    out, stack = [], [(n, 0)]
    while stack:
        x, d = stack.pop()
        out.append(x)
        if d < depth:
            stack.extend((c, d + 1) for c in x.children)
    return out


ATOMIC_CALL = ("atomic_", "__atomic_", "__sync_", "InterlockedIncrement", "Interlocked")


def of(root, file, line, end, lang, sig, outside=None, roles_of=None):
    """See the module's docstring. outside: {name: (scope, line, atomic)} of the variables visible from outside the
    function (its file's and the repository's globals); roles_of(callee, index) -> role of a parameter of a call."""
    lg = signature._lang(file, lang)
    if not lg or sig is None:
        return None
    tree = signature._tree(root, file, lg)
    fn = signature._find(tree.root_node, line, end) if tree is not None else None
    if fn is None:
        return None
    body = fn.child_by_field_name("body")
    # the parameters whose changes the caller can see; a plain value is the callee's own copy
    tracked = {p["name"].lstrip("*.").rstrip("?"): p for p in sig.get("params", [])
               if not p.get("rest") and not p.get("ro") and (p.get("note") in ("address", "slice", "map", "chan")
                                                             or p["mech"] in ("reference", "sharing")) and p.get("note") != "immutable"}
    # a copy of the parameter into a local (int16_t *out = output) is followed as the parameter itself
    alias = {}
    for n in _names(body, set(tracked)):
        a = _alias(n, lg)
        if a and a not in tracked:
            alias[a] = txt(n)
    params = {}
    for n in _names(body, set(tracked) | set(alias)):
        if _alias(n, lg) and txt(n) in tracked:
            continue                                     # the copy itself: neither a read nor a write of the data
        name = alias.get(txt(n), txt(n))
        p = tracked[name]
        kind, through, extra = _use(n, lg)
        ln = n.start_point[0] + 1
        r = params.setdefault(name, {"reads": [], "writes": [], "passes": [], "open": False})
        if kind == "bind" and p["mech"] == "reference" and lg == "cpp":
            kind = "write"
        if kind in ("read", "readwrite"):
            r["reads"].append(ln)
        if kind in ("write", "readwrite"):
            r["writes"].append(ln)
        if kind == "method":
            r["reads"].append(ln)                        # xs.append(x): the list grows from what it holds
            if extra in MUTATORS.get(lg, ()):
                r["writes"].append(ln)
        if kind in ("pass", "addr"):
            callee, idx = extra
            role = roles_of(callee, idx) if roles_of and not through else None
            if role:
                if role in ("in", "in-out"):
                    r["reads"].append(ln)
                if role in ("out", "in-out"):
                    r["writes"].append(ln)
            else:
                # handed on to what codemap cannot follow: read there at least, written perhaps
                r["reads"].append(ln)
                r["passes"].append([ln, callee])
                r["open"] = True
        if kind == "alias":
            r["open"] = True
    for name, r in params.items():
        r["reads"] = sorted(set(r["reads"]))
        r["writes"] = sorted(set(r["writes"]))
        w, rd = bool(r["writes"]), bool(r["reads"])
        r["role"] = "in-out" if w and rd else "out" if w else ("in" if rd and not r["open"] else None)
        del r["open"]
    # the variables outside the function: not shadowed by a parameter or a local of the same name
    shared = []
    mine = set()
    if outside:
        mine = set(_locals(body, lg)) | {p["name"].lstrip("*.").rstrip("?") for p in sig.get("params", [])}
        if lg == "python":
            mine -= _globals_declared(body)
        seen = {}
        for n in _names(body, set(outside) - mine):
            name = txt(n)
            kind, through, extra = _use(n, lg)
            ln = n.start_point[0] + 1
            scope, _, atomic = outside[name]
            s = seen.setdefault(name, {"name": name, "scope": scope, "reads": [], "writes": [], "atomic": atomic, "line": None})
            if kind == "addr" and extra[0].startswith(ATOMIC_CALL):
                s["atomic"] = True
                (s["writes"] if any(w in extra[0] for w in ("store", "add", "sub", "exchange", "fetch", "inc", "dec", "or", "and", "xor")) else s["reads"]).append(ln)
                continue
            if lg == "python" and kind == "bind" and name not in _globals_declared(body):
                continue
            if kind in ("write", "readwrite", "bind"):
                s["writes"].append(ln)
            if kind in ("read", "readwrite", "pass", "alias", "addr") or (kind == "bind" and extra):
                s["reads"].append(ln)
            if kind == "method":
                (s["writes"] if extra in MUTATORS.get(lg, ()) else s["reads"]).append(ln)
        for s in seen.values():
            s["reads"], s["writes"] = sorted(set(s["reads"])), sorted(set(s["writes"]))
            del s["line"]
            shared.append(s)
    # the object's own fields (self.x, this.x, a C++ or Java member, a Go receiver's field): state the methods share
    members = _members(fn, body, lg, sig, mine if outside else set(_locals(body, lg)) | {p["name"] for p in sig.get("params", [])})
    if members:
        shared += members
    out = {}
    if params:
        out["params"] = params
    if shared:
        out["shared"] = sorted(shared, key=lambda s: (s["writes"] or s["reads"] or [0])[0])
    return out or None


def run(root, funcs, described=None):
    """{id: access} for the repository's functions in funcs ({id: {file, line, end, lang, sig, name}}): parameter
    roles follow calls into the repository's functions (two rounds) and into outside ones an AI described."""
    from pathlib import Path
    vars_ = {}
    for f in {x["file"] for x in funcs.values()}:
        lg = signature._lang(f, None)
        if lg:
            vars_[f] = file_vars(root, f, lg)
    # what each file sees: its own variables; C, C++ and Go also the repository's globals, or its package's
    seen = {}
    for f, own in vars_.items():
        lg = signature._lang(f, None)
        vis = {}
        if lg in ("c", "cpp"):
            for g, vs in vars_.items():
                if g != f and signature._lang(g, None) in ("c", "cpp"):
                    vis.update({k: v for k, v in vs.items() if v[0] == "global"})
        elif lg == "go":
            for g, vs in vars_.items():
                if g != f and Path(g).parent == Path(f).parent and g.endswith(".go"):
                    vis.update(vs)
        vis.update(own)
        seen[f] = vis
    by_name = {}
    for nid, x in funcs.items():
        by_name.setdefault(x["name"].rsplit(".", 1)[-1], []).append(nid)
    out = {}

    def roles_of(caller_file):
        def role(callee, idx):
            ids = by_name.get(callee, [])
            ids = [i for i in ids if funcs[i]["file"] == caller_file] or ids
            if len(ids) == 1 and ids[0] in out and funcs[ids[0]].get("sig"):
                ps = [p for p in funcs[ids[0]]["sig"]["params"] if not p.get("recv")]
                if 0 <= idx < len(ps):
                    p = ps[idx]
                    if p.get("ro") or (p["mech"] == "value" and not p.get("note")):
                        return "in"
                    return ((out[ids[0]] or {}).get("params", {}).get(p["name"].lstrip("*.").rstrip("?")) or {}).get("role")
                return None
            d = (described or {}).get("ext:" + callee) or {}
            ps = (d.get("info") or {}).get("params") or []
            return ps[idx].get("role") if 0 <= idx < len(ps) else None
        return role

    for _ in range(2):
        for nid, x in funcs.items():
            if x.get("sig"):
                out[nid] = of(root, x["file"], x["line"], x.get("end"), x.get("lang"), x["sig"], seen.get(x["file"]), roles_of(x["file"]))
    return {k: v for k, v in out.items() if v}


def _class_fields(fn, lg):
    """The instance fields of the class a method belongs to (C++, Java): {name}. Out-of-class C++ definitions
    (Ring::push) look the class up in the same file."""
    cls = fn.parent
    while cls is not None and cls.type not in ("class_specifier", "struct_specifier", "class_declaration", "class_body",
                                               "field_declaration_list"):
        cls = cls.parent
    if cls is None and lg == "cpp":
        d = fn.child_by_field_name("declarator")
        while d is not None and d.type != "function_declarator":
            d = d.child_by_field_name("declarator")
        q = d.child_by_field_name("declarator") if d is not None else None
        if q is not None and q.type == "qualified_identifier":
            owner = txt(q.child_by_field_name("scope"))
            root = fn
            while root.parent is not None:
                root = root.parent
            cls = next((n for n in _walk(root, 6) if n.type in ("class_specifier", "struct_specifier")
                        and txt(n.child_by_field_name("name")) == owner), None)
    if cls is None:
        return set()
    body = cls.child_by_field_name("body") or cls
    out = set()
    for n in body.children:
        if n.type == "field_declaration":
            if lg == "java" and "static" in txt(next((c for c in n.children if c.type == "modifiers"), None)):
                continue
            if any(c.type == "function_declarator" for c in _walk(n, 3)):
                continue
            for d in n.children_by_field_name("declarator"):
                name = txt(d.child_by_field_name("name")) if lg == "java" else signature._ident(d)
                if name:
                    out.add(name)
    return out


def _members(fn, body, lg, sig, mine):
    """Reads and writes of the object's own fields in a method: [{name, scope: "member", reads, writes, atomic}]."""
    if body is None:
        return []
    found = {}

    def note(name, node):
        kind, through, extra = _use(node, lg)
        ln = node.start_point[0] + 1
        s = found.setdefault(name, {"name": name, "scope": "member", "reads": [], "writes": [], "atomic": False})
        if kind in ("write", "readwrite", "bind"):
            s["writes"].append(ln)
        if kind in ("read", "readwrite", "pass", "alias", "addr") or (kind == "bind" and extra is True):
            s["reads"].append(ln)
        if kind == "method":
            s["reads"].append(ln)
            if extra in MUTATORS.get(lg, ()):
                s["writes"].append(ln)

    selfname = {"python": ("self", "cls"), "javascript": ("this",), "typescript": ("this",), "tsx": ("this",),
                "java": ("this",), "cpp": ("this",)}.get(lg, ())
    recv = next((p["name"] for p in sig.get("params", []) if p.get("recv")), None) if lg == "go" else None
    fields = _class_fields(fn, lg) - mine if lg in ("cpp", "java") else set()
    stack = list(body.children)
    while stack:
        n = stack.pop()
        if n.type in SCOPES:
            continue
        # self.x, this.x, this->x, m.x (a Go receiver)
        if n.type in ("attribute", "member_expression", "field_access", "field_expression", "selector_expression"):
            obj = n.child_by_field_name("object") or n.child_by_field_name("argument") or n.child_by_field_name("operand")
            fld = n.child_by_field_name("attribute") or n.child_by_field_name("property") or n.child_by_field_name("field")
            if obj is not None and fld is not None and (txt(obj) in selfname or (recv and txt(obj) == recv)) \
                    and obj.type in ("identifier", "this", "self", "field_identifier"):
                # a method call on the object itself (self.flush()) is not a field
                par = n.parent
                if not (par is not None and par.type in ("call", "call_expression", "method_invocation")
                        and (par.child_by_field_name("function") or par.child_by_field_name("name")) is not None
                        and (par.child_by_field_name("function") or par.child_by_field_name("name")).id in (n.id, fld.id)):
                    # this.x and a bare x are the same member in C++ and Java: one name
                    note(txt(fld) if lg in ("cpp", "java") else f"{txt(obj)}.{txt(fld)}", n)
                    continue
        # a bare member name in a C++ or Java method
        if fields and n.type in ("identifier", "field_identifier") and txt(n) in fields and not _declares(n) \
                and not (n.parent is not None and n.parent.type in ("field_expression", "field_access", "method_invocation", "call_expression")
                         and (n.parent.child_by_field_name("field") or n.parent.child_by_field_name("name") or n.parent.child_by_field_name("function")) is not None
                         and (n.parent.child_by_field_name("field") or n.parent.child_by_field_name("name") or n.parent.child_by_field_name("function")).id == n.id):
            note(txt(n), n)
            continue
        stack.extend(n.children)
    out = []
    for v in found.values():
        v["reads"], v["writes"] = sorted(set(v["reads"])), sorted(set(v["writes"]))
        out.append(v)
    return sorted(out, key=lambda v: (v["writes"] or v["reads"] or [0])[0])
