"""What a file defines besides its functions, for the viewer's 定義 view: types, file-level variables, constants and
macros, and what it imports and exports. Read with tree-sitter, one file at a time.

of(root, file) -> {types, vars, consts, imports, exports}, each a list of items:
  types:   {name, kind (struct, union, enum, typedef, class, interface, type, record), typedef (a struct named the
           same by its typedef), line, end, of (a typedef's type), doc, fields: [{name, type, line, doc}]}
  vars:    {name, scope (global, static, extern, module, package, field), type, line, end, doc}
  consts:  {name, kind (macro, const, enum), line, end, value, params (a macro's), doc}
  imports: {text, line, path and local (C), module and names (the names it brings in)}
  exports: {name, line}
doc is what the author wrote about it (a comment or a docstring). run(root, funcs, readable) adds to every type,
variable and constant the lines of the file that use its name (at) and the functions that use it (users, users_n
past USERS_MAX), and to an import the repository file it names (file) and the lines that use what it brings in (at).
Uses are found by name: a word match in the function bodies of the file and of the files that include or import it.
"""

import re
from pathlib import Path

from . import signature
from .signature import txt

WORD = re.compile(r"[A-Za-z_]\w*")
CONST_NAME = re.compile(r"^_*[A-Z][A-Z0-9_]*$")
HEADERS = (".h", ".hh", ".hpp", ".hxx")
USERS_MAX = 40


def _line(n):
    return n.start_point[0] + 1


def _end(n):
    """The last line of a node: a preprocessor line ends at the start of the next one."""
    row = n.end_point[0]
    if n.end_point[1] == 0 and row > n.start_point[0]:
        row -= 1
    return row + 1


def _short(s, n=80):
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n - 1] + "…"


# ---- C and C++ --------------------------------------------------------------

def _c_fields(body):
    out = []
    if body is None:
        return out
    for f in body.named_children:
        if f.type != "field_declaration":
            continue
        ty = txt(f.child_by_field_name("type"))
        for d in f.children_by_field_name("declarator"):
            name = signature._ident(d)
            if name:
                # the declarator's own marks belong to the type: char *buf[8] is a char *[8]
                rest = txt(d).replace(name, "", 1).strip()
                out.append(dict(name=name, type=_short((ty + " " + rest).strip(), 40), line=_line(f)))
    return out


def _c_enum(spec, out):
    body = spec.child_by_field_name("body")
    for e in (body.named_children if body is not None else []):
        if e.type == "enumerator":
            v = e.child_by_field_name("value")
            out["consts"].append(dict(name=txt(e.child_by_field_name("name")), kind="enum", line=_line(e),
                                      value=_short(txt(v), 40) if v is not None else None))


def _c_spec(spec, out, typedef=None, line=None, end=None):
    """struct, union or enum specifier; with typedef the name it gets."""
    kind = spec.type.split("_")[0]          # struct_specifier -> struct
    name = txt(spec.child_by_field_name("name"))
    body = spec.child_by_field_name("body")
    if body is None and typedef is None:
        return                              # struct ring *p: a use, not a definition
    if kind == "enum" and body is not None:
        _c_enum(spec, out)
    fields = _c_fields(body) if kind != "enum" else [dict(name=txt(e.child_by_field_name("name")), type="", line=_line(e))
                                                     for e in (body.named_children if body is not None else []) if e.type == "enumerator"]
    if typedef and typedef == name and body is not None:
        # typedef struct ring {...} ring: one type with two spellings
        out["types"].append(dict(name=name, kind=kind, typedef=True, line=line, end=end, fields=fields))
    elif typedef:
        out["types"].append(dict(name=typedef, kind="typedef", line=line, end=end,
                                 of=f"{kind} {name}".strip() if name or body is None else kind, fields=fields))
        if name and body is not None:
            out["types"].append(dict(name=name, kind=kind, line=_line(spec), end=_end(spec), fields=fields))
    elif name:
        out["types"].append(dict(name=name, kind=kind, line=_line(spec), end=_end(spec), fields=fields))


def _c(tree, out):
    stack = list(reversed(tree.root_node.children))
    while stack:
        n = stack.pop()
        t = n.type
        if t in ("preproc_if", "preproc_ifdef", "preproc_else", "preproc_elif", "preproc_elifdef", "linkage_specification",
                 "declaration_list", "namespace_definition"):
            stack.extend(reversed(n.children))      # what an #ifdef, extern "C" or a namespace holds is still the file's
            continue
        if t == "preproc_include":
            p = n.child_by_field_name("path")
            out["imports"].append(dict(text=txt(p), line=_line(n), path=txt(p).strip('"<>'), local=txt(p).startswith('"')))
        elif t == "preproc_def":
            name = txt(n.child_by_field_name("name"))
            val = n.child_by_field_name("value")
            if val is None and re.fullmatch(r"\w+_H(_|PP)?_?|_+\w+_H_*", name):
                continue                            # an include guard
            out["consts"].append(dict(name=name, kind="macro", line=_line(n), end=_end(n), value=_short(txt(val), 40) if val is not None else None))
        elif t == "preproc_function_def":
            out["consts"].append(dict(name=txt(n.child_by_field_name("name")), kind="macro", line=_line(n), end=_end(n),
                                      params=txt(n.child_by_field_name("parameters")),
                                      value=_short(txt(n.child_by_field_name("value")), 40)))
        elif t == "type_definition":
            ty = n.child_by_field_name("type")
            base = txt(ty)                          # what each name is: typedef struct {...} A, *PA makes PA an A *
            for d in n.children_by_field_name("declarator"):
                name = _tname(d)
                if not name:
                    continue
                if ty is not None and ty.type in ("struct_specifier", "union_specifier", "enum_specifier"):
                    _c_spec(ty, out, typedef=name, line=_line(n), end=_end(n))
                    if ty.child_by_field_name("body") is not None:
                        ty, base = None, txt(ty.child_by_field_name("name")) or name     # the body once
                    continue
                rest = txt(d).replace(name, "", 1).strip()
                out["types"].append(dict(name=name, kind="typedef", line=_line(n), end=_end(n),
                                         of=_short((base + " " + rest).strip(), 40), fields=[]))
        elif t in ("struct_specifier", "union_specifier", "enum_specifier", "class_specifier"):
            if t == "class_specifier":
                out["types"].append(dict(name=txt(n.child_by_field_name("name")), kind="class", line=_line(n), end=_end(n),
                                         fields=_c_fields(n.child_by_field_name("body"))))
            else:
                _c_spec(n, out)
        elif t == "declaration":
            ty = n.child_by_field_name("type")
            if ty is not None and ty.type in ("struct_specifier", "union_specifier", "enum_specifier") and ty.child_by_field_name("body") is not None:
                _c_spec(ty, out)                    # struct ring { ... } r;
            if any(c.type == "function_declarator" for c in _walk(n, 3)):
                continue                            # a prototype
            quals = {txt(c) for c in n.children if c.type in ("storage_class_specifier", "type_qualifier")}
            for d in n.children_by_field_name("declarator"):
                inner = d.child_by_field_name("declarator") if d.type == "init_declarator" else d
                name = signature._ident(inner)
                if not name:
                    continue
                rest = txt(inner).replace(name, "", 1).strip()
                type_text = _short((txt(ty) + " " + rest).strip(), 40)
                if "const" in quals and d.type == "init_declarator" and "*" not in rest:
                    out["consts"].append(dict(name=name, kind="const", line=_line(n), end=_end(n), type=type_text,
                                              value=_short(txt(d.child_by_field_name("value")), 40)))
                else:
                    scope = "static" if "static" in quals else "extern" if "extern" in quals else "global"
                    out["vars"].append(dict(name=name, scope=scope, type=type_text, line=_line(n), end=_end(n)))


def _tname(n):
    """The name a typedef declarator gives (a type_identifier, under pointers or arrays)."""
    while n is not None and n.type not in ("type_identifier", "identifier", "primitive_type"):
        n = n.child_by_field_name("declarator") or next((c for c in n.children if c.is_named), None)
    return txt(n)


def _walk(n, depth):
    out, stack = [], [(n, 0)]
    while stack:
        x, d = stack.pop()
        out.append(x)
        if d < depth:
            stack.extend((c, d + 1) for c in x.children)
    return out


# ---- Python -----------------------------------------------------------------

def _py_class_fields(body):
    out = []
    for s in (body.named_children if body is not None else []):
        if s.type == "expression_statement" and s.named_children and s.named_children[0].type == "assignment":
            a = s.named_children[0]
            left = a.child_by_field_name("left")
            if left is not None and left.type == "identifier":
                out.append(dict(name=txt(left), type=txt(a.child_by_field_name("type")), line=_line(s)))
    return out


def _python(tree, out):
    for n in tree.root_node.children:
        t = n.type
        if t == "decorated_definition":
            n = n.child_by_field_name("definition") or n
            t = n.type
        if t == "import_statement":
            for c in n.named_children:
                name = txt(c.child_by_field_name("alias")) if c.type == "aliased_import" else txt(c).split(".")[0]
                mod = txt(c.child_by_field_name("name")) if c.type == "aliased_import" else txt(c)
                out["imports"].append(dict(text=mod, line=_line(n), module=mod, names=[name]))
        elif t == "import_from_statement":
            mod = n.child_by_field_name("module_name")
            names = []
            for c in n.children_by_field_name("name"):
                names.append(txt(c.child_by_field_name("alias")) if c.type == "aliased_import" else txt(c))
            if any(c.type == "wildcard_import" for c in n.children):
                names.append("*")
            out["imports"].append(dict(text=f"{txt(mod)}: {', '.join(names)}", line=_line(n), module=txt(mod), names=names))
        elif t == "class_definition":
            out["types"].append(dict(name=txt(n.child_by_field_name("name")), kind="class", line=_line(n), end=_end(n),
                                     fields=_py_class_fields(n.child_by_field_name("body"))))
        elif t == "expression_statement" and n.named_children and n.named_children[0].type == "assignment":
            a = n.named_children[0]
            left = a.child_by_field_name("left")
            names = [left] if left is not None and left.type == "identifier" else \
                [c for c in (left.named_children if left is not None else []) if c.type == "identifier"]
            for c in names:
                name = txt(c)
                if name == "__all__":
                    v = a.child_by_field_name("right")
                    for s in (v.named_children if v is not None else []):
                        if s.type == "string":
                            out["exports"].append(dict(name=txt(s).strip("'\"").strip(), line=_line(s)))
                elif CONST_NAME.match(name):
                    out["consts"].append(dict(name=name, kind="const", line=_line(n), end=_end(n), value=_short(txt(a.child_by_field_name("right")), 40)))
                else:
                    out["vars"].append(dict(name=name, scope="module", type=txt(a.child_by_field_name("type")), line=_line(n), end=_end(n)))


# ---- Go ---------------------------------------------------------------------

def _go(tree, out):
    for n in tree.root_node.children:
        t = n.type
        if t == "import_declaration":
            for s in _walk(n, 3):
                if s.type == "import_spec":
                    path = txt(s.child_by_field_name("path")).strip('"')
                    alias = txt(s.child_by_field_name("name"))
                    out["imports"].append(dict(text=txt(s.child_by_field_name("path")), line=_line(s), module=path,
                                               names=[alias or path.split("/")[-1]]))
        elif t == "const_declaration":
            for s in n.named_children:
                if s.type == "const_spec":
                    v = s.child_by_field_name("value")
                    for c in s.children_by_field_name("name"):
                        out["consts"].append(dict(name=txt(c), kind="const", line=_line(s), end=_end(s), value=_short(txt(v), 40) if v is not None else None))
        elif t == "type_declaration":
            for s in n.named_children:
                if s.type not in ("type_spec", "type_alias"):
                    continue
                ty = s.child_by_field_name("type")
                kind = {"struct_type": "struct", "interface_type": "interface"}.get(ty.type if ty is not None else "", "type")
                fields = []
                if ty is not None and ty.type == "struct_type":
                    for f in _walk(ty, 3):
                        if f.type == "field_declaration":
                            for c in f.children_by_field_name("name"):
                                fields.append(dict(name=txt(c), type=_short(txt(f.child_by_field_name("type")), 40), line=_line(f)))
                elif ty is not None and ty.type == "interface_type":
                    fields = [dict(name=txt(m.child_by_field_name("name")), type="", line=_line(m)) for m in ty.named_children
                              if m.type in ("method_spec", "method_elem") and m.child_by_field_name("name") is not None]
                out["types"].append(dict(name=txt(s.child_by_field_name("name")), kind=kind, line=_line(s), end=_end(s),
                                         of=_short(txt(ty), 40) if kind == "type" else None, fields=fields))
        elif t == "var_declaration":
            for s in _walk(n, 3):
                if s.type == "var_spec":
                    for c in s.children_by_field_name("name"):
                        out["vars"].append(dict(name=txt(c), scope="package", type=txt(s.child_by_field_name("type")), line=_line(s), end=_end(s)))
    # an exported name in Go starts with a capital letter
    for k in ("types", "consts", "vars"):
        out["exports"] += [dict(name=x["name"], line=x["line"]) for x in out[k] if x["name"][:1].isupper()]


# ---- TypeScript and JavaScript ------------------------------------------------

def _ts_members(body):
    out = []
    for m in (body.named_children if body is not None else []):
        name = m.child_by_field_name("name")
        if name is not None and m.type in ("property_signature", "public_field_definition", "field_definition", "method_signature",
                                           "method_definition", "enum_assignment"):
            ty = m.child_by_field_name("type")
            out.append(dict(name=txt(name), type=_short(txt(ty).lstrip(": "), 40) if ty is not None else "", line=_line(m)))
        elif m.type == "property_identifier":
            out.append(dict(name=txt(m), type="", line=_line(m)))
    return out


def _ts_decl(n, out, exported):
    t = n.type
    name = n.child_by_field_name("name")
    if t in ("interface_declaration", "type_alias_declaration", "enum_declaration", "class_declaration", "abstract_class_declaration"):
        kind = {"interface_declaration": "interface", "type_alias_declaration": "type", "enum_declaration": "enum"}.get(t, "class")
        body = n.child_by_field_name("body")
        out["types"].append(dict(name=txt(name), kind=kind, line=_line(n), end=_end(n),
                                 of=_short(txt(n.child_by_field_name("value")), 40) if kind == "type" else None,
                                 fields=_ts_members(body)))
        if exported:
            out["exports"].append(dict(name=txt(name), line=_line(n)))
    elif t in ("lexical_declaration", "variable_declaration"):
        const = txt(n).startswith("const")
        for d in n.named_children:
            if d.type != "variable_declarator" or d.child_by_field_name("name") is None:
                continue
            nm = d.child_by_field_name("name")
            v = d.child_by_field_name("value")
            if nm.type != "identifier":
                continue
            if exported:
                out["exports"].append(dict(name=txt(nm), line=_line(d)))
            if v is not None and v.type in ("arrow_function", "function_expression", "function", "class"):
                continue                                    # a function: listed with the functions
            ty = d.child_by_field_name("type")
            if const and CONST_NAME.match(txt(nm)):
                out["consts"].append(dict(name=txt(nm), kind="const", line=_line(d), end=_end(d), value=_short(txt(v), 40) if v is not None else None))
            else:
                out["vars"].append(dict(name=txt(nm), scope="module", type=_short(txt(ty).lstrip(": "), 40) if ty is not None else "", line=_line(d), end=_end(d)))
    elif t in ("function_declaration", "generator_function_declaration") and exported and name is not None:
        out["exports"].append(dict(name=txt(name), line=_line(n)))


def _ts(tree, out):
    for n in tree.root_node.children:
        t = n.type
        if t == "import_statement":
            src = n.child_by_field_name("source")
            names = [txt(c.child_by_field_name("alias") or c.child_by_field_name("name")) for c in _walk(n, 4) if c.type == "import_specifier"]
            names += [txt(c) for c in _walk(n, 3) if c.type == "identifier" and c.parent is not None and c.parent.type in ("import_clause", "namespace_import")]
            out["imports"].append(dict(text=txt(src), line=_line(n), module=txt(src).strip("'\"`"), names=names))
        elif t == "export_statement":
            d = n.child_by_field_name("declaration")
            if d is not None:
                _ts_decl(d, out, True)
            else:
                for c in _walk(n, 3):
                    if c.type == "export_specifier":
                        out["exports"].append(dict(name=txt(c.child_by_field_name("alias") or c.child_by_field_name("name")), line=_line(c)))
                if any(c.type == "default" for c in n.children):
                    out["exports"].append(dict(name="default", line=_line(n)))
        else:
            _ts_decl(n, out, False)


# ---- Java -------------------------------------------------------------------

def _java(tree, out):
    for n in _walk(tree.root_node, 8):
        t = n.type
        if t == "import_declaration":
            name = txt(next((c for c in n.named_children if c.type in ("scoped_identifier", "identifier")), None))
            out["imports"].append(dict(text=name, line=_line(n), module=name, names=[name.split(".")[-1]]))
        elif t in ("class_declaration", "interface_declaration", "enum_declaration", "record_declaration"):
            kind = t.split("_")[0]
            body = n.child_by_field_name("body")
            fields = []
            for f in (body.named_children if body is not None else []):
                if f.type == "field_declaration":
                    for d in f.children_by_field_name("declarator"):
                        fields.append(dict(name=txt(d.child_by_field_name("name")), type=txt(f.child_by_field_name("type")), line=_line(f)))
                elif f.type == "enum_constant":
                    fields.append(dict(name=txt(f.child_by_field_name("name")), type="", line=_line(f)))
            out["types"].append(dict(name=txt(n.child_by_field_name("name")), kind=kind, line=_line(n), end=_end(n), fields=fields))
        elif t == "field_declaration":
            mods = txt(next((c for c in n.children if c.type == "modifiers"), None))
            if "static" in mods and "final" in mods:
                for d in n.children_by_field_name("declarator"):
                    v = d.child_by_field_name("value")
                    out["consts"].append(dict(name=txt(d.child_by_field_name("name")), kind="const", line=_line(n), end=_end(n),
                                              value=_short(txt(v), 40) if v is not None else None))
            elif "static" in mods:
                for d in n.children_by_field_name("declarator"):
                    out["vars"].append(dict(name=txt(d.child_by_field_name("name")), scope="field", type=txt(n.child_by_field_name("type")), line=_line(n), end=_end(n)))


# ---- what the author wrote about each one ----------------------------------

COMMENT_TYPES = ("comment", "line_comment", "block_comment")


def _clean(text):
    """A comment's words, without its markers, as one paragraph (the first, when there are several)."""
    from . import docs
    lines = [re.sub(r"^\s*#+\s?", "", ln) for ln in text.splitlines()]
    paras = docs._comment_text(lines)
    t = " ".join(paras[0].split()) if paras else ""
    return t[:300] if len(t) > 3 else ""


def _comments(tree, src):
    """{last row: (first row, text)} of the comments alone on their lines, and {row: text} of the comments that
    follow code on their line."""
    alone, after = {}, {}
    stack = [tree.root_node]
    while stack:
        n = stack.pop()
        if n.type in COMMENT_TYPES:
            r0, c0 = n.start_point
            line = src[r0] if r0 < len(src) else ""
            if line[:c0].strip():
                after[r0] = txt(n)
            else:
                alone[n.end_point[0]] = (r0, txt(n))
        stack.extend(n.children)
    return alone, after


def _doc_for(line, end, alone, after):
    """What the author wrote about a definition: the comment after the code on its line for a one-line definition
    (int pid; /* Main process pid */, the comment above it is often a heading for a group); else the block of
    adjacent comments right above it, else a comment after the code on its last line."""
    rows = (line - 1,) if line == end else (end - 1,)
    trailing = next((_clean(after[r]) for r in rows if r in after and _clean(after[r])), None)
    if line == end and trailing:
        return trailing
    row, block = line - 2, []
    while row in alone:
        r0, text = alone[row]
        block.insert(0, text)
        row = r0 - 1
    return (_clean("\n".join(block)) if block else None) or trailing


def _py_docstrings(tree):
    """{line of a class or an assignment: its docstring}: a class's first statement, or a string right after a
    module-level assignment."""
    out = {}
    for n in tree.root_node.children:
        d = n.child_by_field_name("definition") if n.type == "decorated_definition" else n
        if d is not None and d.type == "class_definition":
            body = d.child_by_field_name("body")
            first = body.named_children[0] if body is not None and body.named_children else None
            if first is not None and first.type == "expression_statement" and first.named_children and first.named_children[0].type == "string":
                out[_line(d)] = txt(first).strip("\"' \n")
        if n.type == "expression_statement" and n.named_children and n.named_children[0].type == "string":
            prev = n.prev_named_sibling
            if prev is not None and prev.type == "expression_statement" and prev.named_children and prev.named_children[0].type == "assignment":
                out[_line(prev)] = txt(n).strip("\"' \n")
    return {k: " ".join(v.split("\n\n")[0].split())[:300] for k, v in out.items() if v.strip()}


def _docs(tree, root, file, lg, out):
    src = (Path(root) / file).read_text(errors="replace").splitlines()
    alone, after = _comments(tree, src)
    pydoc = _py_docstrings(tree) if lg == "python" else {}
    for k in ("types", "vars", "consts"):
        for x in out[k]:
            d = pydoc.get(x["line"]) or _doc_for(x["line"], x.get("end", x["line"]), alone, after)
            # a comment in a macro's text: /* or // outside its string literals ("http://...")
            bare = re.sub(r'"(?:\\.|[^"\\])*"', lambda q: " " * len(q.group(0)), x.get("value") or "")
            m = re.search(r"/\*|//", bare) if x.get("kind") == "macro" else None
            if m:
                # #define X 16 /* ... */: the comment is part of the macro's text
                d = d or _clean(x["value"][m.start():])
                x["value"] = x["value"][:m.start()].strip() or None
            if d:
                x["doc"] = d
            for f in x.get("fields", []):
                fd = _doc_for(f["line"], f["line"], alone, after)
                if fd:
                    f["doc"] = fd


READERS = {"c": _c, "cpp": _c, "python": _python, "go": _go, "typescript": _ts, "tsx": _ts, "javascript": _ts, "java": _java}


def of(root, file):
    # by the file's extension only: a README or a Makefile is not C
    lg = signature.EXT.get(Path(file).suffix.lower())
    if lg not in READERS:
        return None
    tree = signature._tree(root, file, lg)
    if tree is None:
        return None
    out = dict(types=[], vars=[], consts=[], imports=[], exports=[])
    READERS[lg](tree, out)
    _docs(tree, root, file, lg, out)
    for k in ("types", "vars", "consts", "exports"):
        seen, keep = set(), []
        for x in out[k]:
            if x.get("name") and (x["name"], x["line"]) not in seen:
                seen.add((x["name"], x["line"]))
                keep.append(x)
        out[k] = sorted(keep, key=lambda x: x["line"])
    out["imports"].sort(key=lambda x: x["line"])
    return out if any(out.values()) else None


# ---- who uses them ---------------------------------------------------------

def _resolve(root, file, imp, files):
    """The repository file an include or import names, or None."""
    import posixpath
    here = Path(file).parent
    if "path" in imp:                                   # C: "ring.h" next to the file, else any file of that name
        if not imp.get("local"):
            return None                                 # <poll.h> is the system's, even when a file of that name is here
        p = (here / imp["path"]).as_posix()
        if p in files:
            return p
        tail = "/" + imp["path"]
        return next((f for f in sorted(files) if f.endswith(tail) or f == imp["path"]), None)
    mod = imp.get("module") or ""
    if mod.startswith("."):                             # Python relative or ./x in TypeScript
        if "/" in mod:                                  # ./x, ../x: from the file's folder
            base = posixpath.normpath((here / mod).as_posix())
            cands = [base + e for e in (".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js")] + [base]
        else:
            ups = len(mod) - len(mod.lstrip("."))
            base = here
            for _ in range(ups - 1):
                base = base.parent
            rest = mod.lstrip(".").replace(".", "/")
            b = (base / rest).as_posix() if rest else base.as_posix()
            cands = [b + ".py", b + "/__init__.py"]
        return next((c for c in cands if c in files), None)
    rel = mod.replace(".", "/")
    return next((f for f in sorted(files) if f == rel + ".py" or f.endswith("/" + rel + ".py") or f == rel + "/__init__.py"), None)


def run(root, funcs, readable=()):
    """{file: definitions} for the files of funcs and the other readable files (headers), with at and users filled in."""
    root = Path(root)
    by_file = {}
    for fid, f in funcs.items():
        # functions and methods: a class or a module's top level is not "a function that uses it"
        if f.get("line") and f.get("end") and f.get("kind", "function") in ("function", "method"):
            by_file.setdefault(f["file"], []).append(fid)
    # header files define types without defining functions: read every file the viewer can open too
    files = {f["file"] for f in funcs.values()} | set(readable)
    out = {}
    for f in sorted(files):
        d = of(root, f)
        if d:
            out[f] = d
    # which files include or import each file
    readers = {}
    for f, d in out.items():
        for imp in d["imports"]:
            target = _resolve(root, f, imp, files)
            if target:
                imp["file"] = target
                readers.setdefault(target, set()).add(f)
    # the words of each function's body, once
    words, lines_of = {}, {}

    def text(f):
        if f not in lines_of:
            try:
                lines_of[f] = (root / f).read_text(errors="replace").splitlines()
            except OSError:
                lines_of[f] = []
        return lines_of[f]

    def body_words(fid):
        if fid not in words:
            fn = funcs[fid]
            words[fid] = set(WORD.findall("\n".join(text(fn["file"])[fn["line"] - 1:fn["end"]])))
        return words[fid]

    for f, d in out.items():
        src = text(f)
        at = {}
        for i, ln in enumerate(src, 1):
            for w in set(WORD.findall(ln)):
                at.setdefault(w, []).append(i)
        scope = [f] + sorted(readers.get(f, ()))
        for k in ("types", "vars", "consts"):
            for x in d[k]:
                lo, hi = x["line"], x.get("end", x["line"])
                x["at"] = [i for i in at.get(x["name"], []) if not lo <= i <= hi][:200]
                static = x.get("scope") == "static" or (k != "vars" and not f.endswith(HEADERS) and signature.EXT.get(Path(f).suffix.lower()) in ("c", "cpp"))
                users = [fid for g in ([f] if static else scope) for fid in sorted(by_file.get(g, ()), key=lambda i: funcs[i]["line"])
                         if x["name"] in body_words(fid)]
                x["users"] = users[:USERS_MAX]
                if len(users) > USERS_MAX:
                    x["users_n"] = len(users)
        for imp in d["imports"]:
            names = [n for n in imp.get("names", []) if n != "*"]
            imp["at"] = sorted({i for n in names for i in at.get(n, []) if i != imp["line"]})[:200]
    return out
