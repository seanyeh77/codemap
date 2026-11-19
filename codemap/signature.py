"""What a function's declaration says, read with tree-sitter: its parameters, how each is passed, and the
keywords on it (static, async, virtual ...). All of it comes from the code and the language's own rules, so it
is certain: the role of a parameter that may be written through (a non-const pointer, a Python list) is left
open here, for the analysis or the AI to fill in.

of(root, file, line, end, lang) -> {"params": [...], "decl": [...], "statics": [...]} or None

params: {"name", "type", "line", "mech", "note"?, "ro"?, "recv"?, "rest"?}
  mech  value | reference | sharing | move (how the language passes it)
  note  address (a pointer: the address is copied) | slice | map | chan | immutable
  ro    true when the language guarantees the callee cannot change what the caller passed (const T *, const T &)
decl:   {"kw", "line"} for each keyword or property: static, extern, inline, virtual, override, final, const,
        noexcept, public, private, protected, abstract, synchronized, export, async, generator, staticmethod,
        classmethod, exported, unexported, internal (a leading underscore, by convention), variadic, receiver-pointer,
        receiver-value
statics: {"name", "line"}: static local variables (C, C++), which keep their value between calls
"""
import re
from functools import lru_cache
from pathlib import Path

from .backends.syntax import EXT, language

FUNC_TYPES = {"function_definition", "function_declaration", "method_declaration", "method_definition",
              "constructor_declaration", "generator_function_declaration", "function_expression", "arrow_function",
              "generator_function", "func_literal"}
BODY = {"compound_statement", "block", "statement_block"}
C_PRIMITIVE_PTR = ("pointer_declarator", "array_declarator", "abstract_pointer_declarator", "abstract_array_declarator")
JAVA_PRIMITIVE = {"integral_type", "floating_point_type", "boolean_type"}
TS_PRIMITIVE = {"number", "string", "boolean", "bigint", "symbol", "undefined", "null"}
PY_IMMUTABLE = {"int", "float", "str", "bool", "bytes", "tuple", "complex", "frozenset", "None"}

_trees = {}


@lru_cache(maxsize=None)
def _lang(file, lang):
    ext = Path(file).suffix.lower()
    lg = EXT.get(ext)
    if lg:
        return lg
    return {"c": "c", "python": "python", "go": "go", "typescript": "typescript", "javascript": "javascript",
            "java": "java"}.get(lang or "c")


def _tree(root, file, lg):
    p = Path(root) / file
    try:
        st = p.stat()
    except OSError:
        return None
    key = (str(p), lg)
    hit = _trees.get(key)
    if hit and hit[0] == st.st_mtime_ns:
        return hit[1]
    L = language(lg)
    if L is None:
        return None
    import tree_sitter as ts
    tree = ts.Parser(L).parse(p.read_bytes())
    if hit:
        _heads.clear()                      # node ids of the old tree may come back
    _trees[key] = (st.st_mtime_ns, tree)
    return tree


def txt(n):
    return n.text.decode("utf-8", "replace") if n is not None else ""


_heads = {}


def _find(node, line, end):
    """The innermost function node that starts at or just above line (decorators, comments) and holds it."""
    # every function node by the lines of its head (start to body), built once per tree
    key = (node.id, node.end_byte)
    heads = _heads.get(key)
    if heads is None:
        heads = {}
        stack = [node]
        while stack:
            n = stack.pop()
            if n.type in FUNC_TYPES:
                r0, r1 = n.start_point[0] + 1, n.end_point[0] + 1
                body = n.child_by_field_name("body")
                head_end = body.start_point[0] + 1 if body is not None else r1
                for ln in range(r0, min(head_end, r1) + 1):
                    heads.setdefault(ln, []).append(n)
            stack.extend(n.children)
        _heads[key] = heads
    best, best_key = None, None
    for n in heads.get(line, ()):
        # the closest start wins; on the same line the outer one (a callback default is not the function)
        k = (n.start_point[0], n.end_byte - n.start_byte)
        if best is None or k > best_key:
            best, best_key = n, k
    return best


def _ident(n):
    """The name inside a C declarator (pointer_declarator > array_declarator > identifier)."""
    while n is not None and n.type not in ("identifier", "field_identifier"):
        n = n.child_by_field_name("declarator") or next((c for c in n.children if c.is_named), None)
    return txt(n)


def _decl_chain(n):
    out = []
    while n is not None:
        out.append(n.type)
        n = n.child_by_field_name("declarator") or next((c for c in n.children if c.is_named and "declarator" in c.type), None)
    return out


def _c_params(fn, lg):
    decl = fn.child_by_field_name("declarator")
    while decl is not None and decl.type != "function_declarator":
        decl = decl.child_by_field_name("declarator")
    plist = decl.child_by_field_name("parameters") if decl is not None else None
    out = []
    for p in plist.named_children if plist is not None else []:
        line = p.start_point[0] + 1
        if p.type == "variadic_parameter":
            out.append(dict(name="...", type="...", line=line, mech="value", rest=True))
            continue
        if p.type not in ("parameter_declaration", "optional_parameter_declaration"):
            continue
        d = p.child_by_field_name("declarator")
        name = _ident(d) if d is not None else ""
        if not name and txt(p).strip() == "void":
            continue
        chain = _decl_chain(d) if d is not None else []
        const = any(c.type == "type_qualifier" and txt(c) == "const" for c in p.children if c != d)
        raw = txt(p)
        if name:                                    # the type is the text without the last occurrence of the name
            hits = list(re.finditer(r"(?<![\w$])" + re.escape(name) + r"(?![\w$])", raw))
            if hits:
                raw = raw[:hits[-1].start()] + raw[hits[-1].end():]
        typ = re.sub(r"\s+", " ", raw).strip()
        it = dict(name=name or "(unnamed)", type=typ, line=line)
        if "reference_declarator" in chain:
            rv = "&&" in txt(d).split(name)[0] if name else "&&" in txt(d)
            if rv:
                it.update(mech="move")
            else:
                it.update(mech="reference", **({"ro": True} if const else {}))
        elif any(c in C_PRIMITIVE_PTR for c in chain):
            it.update(mech="value", note="address", **({"ro": True} if const else {}))
        else:
            it.update(mech="value")
        out.append(it)
    return out


def _py_params(fn):
    out = []
    plist = fn.child_by_field_name("parameters")
    for p in plist.named_children if plist is not None else []:
        line = p.start_point[0] + 1
        name = txt(p.child_by_field_name("name")) if p.child_by_field_name("name") is not None else ""
        rest = None
        if p.type == "identifier":
            name = txt(p)
        elif p.type in ("list_splat_pattern", "dictionary_splat_pattern"):
            name = txt(p.named_children[0]) if p.named_children else txt(p)
            rest = "*" if p.type == "list_splat_pattern" else "**"
        elif not name:
            name = txt(p.named_children[0]) if p.named_children else txt(p)
        if name in ("self", "cls") and not out:
            continue
        typ = txt(p.child_by_field_name("type"))
        it = dict(name=(rest or "") + name, type=typ, line=line, mech="sharing")
        base = re.split(r"[\[|\s]", typ.strip())[0] if typ else ""
        if base in PY_IMMUTABLE:
            it["note"] = "immutable"
        if p.type in ("default_parameter", "typed_default_parameter"):
            v = p.child_by_field_name("value")
            if v is not None and v.type in ("list", "dictionary", "set", "call"):
                it["default_mutable"] = True
        if rest:
            it["rest"] = True
        out.append(it)
    return out


def _go_type(t):
    if t is None:
        return dict(mech="value")
    k = t.type
    if k == "pointer_type":
        return dict(mech="value", note="address")
    if k == "slice_type":
        return dict(mech="value", note="slice")
    if k == "map_type":
        return dict(mech="value", note="map")
    if k == "channel_type":
        return dict(mech="value", note="chan")
    return dict(mech="value")


def _go_params(fn):
    out = []
    lists = [c for c in fn.children if c.type == "parameter_list"]
    recv = fn.type == "method_declaration" and len(lists) >= 2
    params = fn.child_by_field_name("parameters")
    groups = ([(lists[0], True)] if recv else []) + ([(params, False)] if params is not None else [])
    for plist, is_recv in groups:
        for p in plist.named_children:
            if p.type not in ("parameter_declaration", "variadic_parameter_declaration"):
                continue
            t = p.child_by_field_name("type")
            names = [txt(c) for c in p.children if c.type == "identifier"] or ["_"]
            for name in names:
                it = dict(name=name, type=("..." if p.type == "variadic_parameter_declaration" else "") + txt(t),
                          line=p.start_point[0] + 1, **_go_type(t))
                if p.type == "variadic_parameter_declaration":
                    it.update(mech="value", note="slice", rest=True)
                if is_recv:
                    it["recv"] = True
                out.append(it)
    return out


def _java_params(fn):
    out = []
    plist = fn.child_by_field_name("parameters")
    for p in plist.named_children if plist is not None else []:
        if p.type not in ("formal_parameter", "spread_parameter"):
            continue
        t = p.child_by_field_name("type") or next((c for c in p.named_children if c.type.endswith("type") or c.type == "type_identifier"), None)
        name = txt(p.child_by_field_name("name")) or next((txt(c.child_by_field_name("name")) for c in p.named_children if c.type == "variable_declarator"), "")
        it = dict(name=name, type=txt(t) + ("..." if p.type == "spread_parameter" else ""), line=p.start_point[0] + 1)
        if p.type == "spread_parameter":
            it.update(mech="sharing", rest=True)
        elif t is not None and t.type in JAVA_PRIMITIVE:
            it.update(mech="value")
        else:
            it.update(mech="sharing")
        out.append(it)
    return out


def _ts_params(fn):
    out = []
    plist = fn.child_by_field_name("parameters")
    if plist is None:                           # x => x + 1
        p = fn.child_by_field_name("parameter")
        return [dict(name=txt(p), type="", line=p.start_point[0] + 1, mech="sharing")] if p is not None else []
    for p in plist.named_children:
        if p.type not in ("required_parameter", "optional_parameter", "identifier", "rest_pattern", "assignment_pattern",
                          "object_pattern", "array_pattern"):
            continue
        pat = p.child_by_field_name("pattern") or (p.named_children[0] if p.type in ("required_parameter", "optional_parameter") and p.named_children else p)
        ta = p.child_by_field_name("type")
        typ = txt(ta).lstrip(":").strip()
        rest = pat.type == "rest_pattern"
        name = txt(pat.named_children[0]) if rest and pat.named_children else txt(pat)
        if p.type == "assignment_pattern":
            name = txt(p.child_by_field_name("left"))
        it = dict(name=("..." if rest else "") + name + ("?" if p.type == "optional_parameter" else ""), type=typ,
                  line=p.start_point[0] + 1, mech="sharing")
        if typ and typ.split("|")[0].strip() in TS_PRIMITIVE and "|" not in typ:
            it["mech"] = "value"
        if typ.startswith("readonly ") or typ.startswith("Readonly<"):
            it["ro"] = True
        if rest:
            it["rest"] = True
        out.append(it)
    return out


def _head(fn, src_lines):
    """The declaration's text from its first line to where the body starts, and that body node."""
    body = fn.child_by_field_name("body")
    end = body.start_byte if body is not None else fn.end_byte
    return fn.text[: end - fn.start_byte].decode("utf-8", "replace"), body


def _kw(head, words):
    out = []
    for w in words:
        if re.search(r"(?<![\w$])" + re.escape(w) + r"(?![\w$])", head):
            out.append(w)
    return out


def _decl(fn, lg, params, name):
    head, body = _head(fn, None)
    line = fn.start_point[0] + 1
    before = head.split("(", 1)[0]                      # keywords before the parameters
    after = head.rsplit(")", 1)[-1] if ")" in head else ""
    out = []
    add = lambda kw: out.append(dict(kw=kw, line=line))
    if lg in ("c", "cpp"):
        for w in _kw(before, ["static", "extern", "inline", "virtual", "constexpr"]):
            add(w)
        for w in _kw(after, ["const", "noexcept", "override", "final"]):
            add(w)
        if lg == "c" and "static" not in [d["kw"] for d in out] and fn.parent is not None and fn.parent.type == "translation_unit":
            add("extern-linkage")
    elif lg == "java":
        for w in _kw(before, ["public", "private", "protected", "static", "final", "abstract", "synchronized", "default"]):
            add(w)
    elif lg in ("typescript", "tsx", "javascript"):
        exp = fn.parent is not None and fn.parent.type == "export_statement"
        if exp:
            add("export")
        for w in _kw(before, ["public", "private", "protected", "static", "async", "abstract", "readonly"]):
            add(w)
        if fn.type in ("generator_function_declaration", "generator_function") or re.search(r"\*\s*[\w$]*\s*$", before):
            add("generator")
    elif lg == "python":
        dec = fn.parent if fn.parent is not None and fn.parent.type == "decorated_definition" else None
        for d in dec.named_children if dec is not None else []:
            if d.type == "decorator":
                t = txt(d).lstrip("@").strip()
                if t in ("staticmethod", "classmethod", "property", "abstractmethod", "abc.abstractmethod"):
                    out.append(dict(kw=t.split(".")[-1], line=d.start_point[0] + 1))
        if head.lstrip().startswith("async"):
            add("async")
        if body is not None and _yields(body):
            add("generator")
        if name.startswith("_") and not name.startswith("__"):
            add("internal")
    elif lg == "go":
        add("exported" if name[:1].isupper() else "unexported")
        r = next((p for p in params if p.get("recv")), None)
        if r:
            add("receiver-pointer" if r.get("note") == "address" else "receiver-value")
    if any(p.get("rest") for p in params):
        add("variadic")
    return out


def _yields(n):
    for c in n.children:
        if c.type in ("function_definition", "lambda", "class_definition"):
            continue
        if c.type in ("yield", "yield_statement"):
            return True
        if _yields(c):
            return True
    return False


def _statics(body):
    out = []
    stack = [body] if body is not None else []
    while stack:
        n = stack.pop()
        if n.type == "declaration" and any(c.type == "storage_class_specifier" and txt(c) == "static" for c in n.children):
            for d in n.children_by_field_name("declarator"):
                out.append(dict(name=_ident(d.child_by_field_name("declarator") or d) if d.type == "init_declarator" else _ident(d),
                                line=n.start_point[0] + 1))
        if n.type not in FUNC_TYPES or n is body:
            stack.extend(n.children)
    return sorted(out, key=lambda x: x["line"])


def of(root, file, line, end=None, lang=None):
    lg = _lang(file, lang)
    if not lg:
        return None
    tree = _tree(root, file, lg)
    if tree is None:
        return None
    fn = _find(tree.root_node, line, end)
    if fn is None:
        return None
    name = txt(fn.child_by_field_name("name"))
    if lg in ("c", "cpp"):
        params = _c_params(fn, lg)
        d = fn.child_by_field_name("declarator")
        name = name or _ident(d)
    elif lg == "python":
        params = _py_params(fn)
    elif lg == "go":
        params = _go_params(fn)
    elif lg == "java":
        params = _java_params(fn)
    else:
        params = _ts_params(fn)
    out = dict(params=params, decl=_decl(fn, lg, params, name.rsplit(".", 1)[-1] or ""))
    if lg in ("c", "cpp"):
        st = _statics(fn.child_by_field_name("body"))
        if st:
            out["statics"] = st
    return out
