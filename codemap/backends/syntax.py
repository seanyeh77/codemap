"""The fallback backend for every language: parse with tree-sitter, match calls by name.

What it finds is what the text says: definitions, the calls in their bodies,
imports. A call is joined to a definition when the name decides it: the same
file, an import, the enclosing class for self/this, or a name defined once in
the repository. Its edges are marked source "syntax"; a call it cannot place
on one definition is left out rather than guessed. Calls into imported
outside modules (requests.get, os.path.join) become outside nodes.

Grammars come from the tree-sitter-<language> wheels, which carry the parser
inside them: nothing is downloaded when codemap runs.
"""

import re
from pathlib import Path

from ..source import lines

EXT = {
    ".py": "python",                 # .pyi stubs describe outside libraries: not read
    ".java": "java",
    ".go": "go",
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".html": "html", ".htm": "html",
    ".css": "css",
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
}
# the language a person names: tsx is TypeScript
LANG_NAME = {"tsx": "typescript"}

_LANGS = {}


def language(lang):
    """The tree-sitter Language for lang, or None when its grammar is not installed."""
    if lang in _LANGS:
        return _LANGS[lang]
    try:
        import tree_sitter as ts
        mod = __import__({"tsx": "tree_sitter_typescript", "typescript": "tree_sitter_typescript"}.get(lang, f"tree_sitter_{lang}"))
        fn = {"typescript": "language_typescript", "tsx": "language_tsx"}.get(lang, "language")
        _LANGS[lang] = ts.Language(getattr(mod, fn)())
    except (ImportError, AttributeError):
        _LANGS[lang] = None
    return _LANGS[lang]


def available():
    return sorted({LANG_NAME.get(l, l) for l in set(EXT.values()) if language(l)})


def txt(node):
    return node.text.decode("utf-8", "replace") if node is not None else ""


# ---------------------------------------------------------------------------
# per-language shapes

class Spec:
    """Where a language keeps its definitions, calls and imports in the syntax tree."""
    defs = {}            # node type -> kind ("function", "method", "class")
    classes = set()      # node types that open a class scope
    calls = set()        # node types of a call
    self_names = ("self", "this", "cls")

    def def_name(self, node):
        return txt(node.child_by_field_name("name"))

    def decorators(self, node):
        return []

    def params(self, node):
        return []

    def param_text(self, node):
        """{parameter: its default or annotation as written}, for adapters (FastAPI Depends)."""
        return {}

    def bases(self, node):
        """The classes and interfaces a class names as its parents, as written."""
        return []

    def callee(self, node):
        """(receiver text or None, called name) of a call node, or None."""
        fn = node.child_by_field_name("function")
        if fn is None:
            return None
        if fn.type in ("identifier",):
            return None, txt(fn)
        if fn.type in ("attribute", "member_expression", "selector_expression", "field_expression"):
            obj = fn.child_by_field_name("object") or fn.child_by_field_name("operand") or fn.child_by_field_name("argument")
            name = fn.child_by_field_name("attribute") or fn.child_by_field_name("property") or fn.child_by_field_name("field")
            return txt(obj), txt(name)
        return None

    def imports(self, root, file, tree):
        """{local name: (module path or None, name in that module or None)}"""
        return {}


class Python(Spec):
    defs = {"function_definition": "function", "class_definition": "class"}
    classes = {"class_definition"}
    calls = {"call"}

    def decorators(self, node):
        p = node.parent
        return [txt(d) for d in p.children if d.type == "decorator"] if p is not None and p.type == "decorated_definition" else []

    def params(self, node):
        ps = node.child_by_field_name("parameters")
        out = []
        for c in ps.named_children if ps is not None else []:
            n = c if c.type == "identifier" else c.child_by_field_name("name") or next((x for x in c.named_children if x.type == "identifier"), None)
            if n is not None:
                out.append(txt(n))
        return out

    def param_text(self, node):
        ps = node.child_by_field_name("parameters")
        out = {}
        for c in ps.named_children if ps is not None else []:
            if c.type in ("default_parameter", "typed_default_parameter", "typed_parameter"):
                n = c.child_by_field_name("name") or next((x for x in c.named_children if x.type == "identifier"), None)
                rest = [txt(c.child_by_field_name(k)) for k in ("type", "value") if c.child_by_field_name(k) is not None]
                if n is not None and rest:
                    out[txt(n)] = " = ".join(rest)
        return out

    def bases(self, node):
        sc = node.child_by_field_name("superclasses")
        return [txt(c) for c in sc.named_children if c.type != "keyword_argument"] if sc is not None else []

    def imports(self, root, file, tree):
        out = {}
        pkg = Path(file).parent
        for n in tree.root_node.children:
            if n.type == "import_statement":
                for c in n.named_children:
                    if c.type == "dotted_name":
                        out[txt(c).split(".")[0]] = (txt(c).split(".")[0], None)
                    elif c.type == "aliased_import":
                        out[txt(c.child_by_field_name("alias"))] = (txt(c.child_by_field_name("name")), None)
            elif n.type == "import_from_statement":
                mod = n.child_by_field_name("module_name")
                m = txt(mod)
                if m.startswith("."):
                    dots = len(m) - len(m.lstrip("."))
                    base = pkg
                    for _ in range(dots - 1):
                        base = base.parent
                    m = ".".join([p for p in base.parts] + ([m.lstrip(".")] if m.lstrip(".") else []))
                if any(c.type == "wildcard_import" for c in n.children):
                    out["*"] = (m, None)
                for c in n.children_by_field_name("name"):
                    if c.type == "aliased_import":
                        out[txt(c.child_by_field_name("alias"))] = (m, txt(c.child_by_field_name("name")))
                    else:
                        out[txt(c)] = (m, txt(c))
        return out


class Java(Spec):
    defs = {"method_declaration": "method", "constructor_declaration": "method", "class_declaration": "class",
            "interface_declaration": "class", "enum_declaration": "class", "record_declaration": "class"}
    classes = {"class_declaration", "interface_declaration", "enum_declaration", "record_declaration"}
    calls = {"method_invocation", "object_creation_expression"}

    def decorators(self, node):
        mods = next((c for c in node.children if c.type == "modifiers"), None)
        return [txt(c) for c in mods.children if c.type in ("annotation", "marker_annotation")] if mods is not None else []

    def params(self, node):
        ps = node.child_by_field_name("parameters")
        return [txt(c.child_by_field_name("name")) for c in (ps.named_children if ps is not None else []) if c.child_by_field_name("name") is not None]

    def bases(self, node):
        out = []
        for k in ("superclass", "interfaces"):
            c = node.child_by_field_name(k)
            if c is not None:
                out += [re.sub(r"<.*", "", txt(x)) for x in c.named_children[0].named_children] if k == "interfaces" and c.named_children \
                    else [txt(x) for x in c.named_children]
        return out

    def callee(self, node):
        if node.type == "object_creation_expression":
            return None, re.sub(r"<.*", "", txt(node.child_by_field_name("type")))
        obj = node.child_by_field_name("object")
        return (txt(obj) if obj is not None else None), txt(node.child_by_field_name("name"))

    def imports(self, root, file, tree):
        out = {}
        for n in tree.root_node.children:
            if n.type == "import_declaration":
                path = re.sub(r"^import\s+(static\s+)?|;$", "", txt(n)).strip()
                out[path.rsplit(".", 1)[-1]] = (path.rsplit(".", 1)[0], path.rsplit(".", 1)[-1])
        return out


class Go(Spec):
    defs = {"function_declaration": "function", "method_declaration": "method"}
    calls = {"call_expression"}
    self_names = ()

    def def_name(self, node):
        name = txt(node.child_by_field_name("name"))
        recv = node.child_by_field_name("receiver")
        if recv is not None:
            t = re.findall(r"[A-Za-z_]\w*", txt(recv.named_children[0].child_by_field_name("type")) if recv.named_children else "")
            if t:
                return f"{t[-1]}.{name}"
        return name

    def params(self, node):
        ps = node.child_by_field_name("parameters")
        return [txt(n) for c in (ps.named_children if ps is not None else []) for n in c.children_by_field_name("name")]

    def imports(self, root, file, tree):
        out = {}
        for n in tree.root_node.children:
            if n.type == "import_declaration":
                for spec in [x for x in n.named_children if x.type == "import_spec"] + \
                            [y for x in n.named_children if x.type == "import_spec_list" for y in x.named_children]:
                    path = txt(spec.child_by_field_name("path")).strip('"`')
                    alias = spec.child_by_field_name("name")
                    out[txt(alias) if alias is not None else path.rsplit("/", 1)[-1]] = (path, None)
        return out


class Script(Spec):
    """JavaScript and TypeScript."""
    defs = {"function_declaration": "function", "generator_function_declaration": "function",
            "method_definition": "method", "class_declaration": "class", "abstract_class_declaration": "class"}
    classes = {"class_declaration", "abstract_class_declaration", "class"}
    calls = {"call_expression", "new_expression"}

    def def_name(self, node):
        if node.type == "variable_declarator":
            return txt(node.child_by_field_name("name"))
        return txt(node.child_by_field_name("name"))

    def decorators(self, node):
        out, prev = [], node.prev_named_sibling
        while prev is not None and prev.type == "decorator":
            out.insert(0, txt(prev))
            prev = prev.prev_named_sibling
        return out

    def params(self, node):
        ps = node.child_by_field_name("parameters")
        out = []
        for c in ps.named_children if ps is not None else []:
            n = c.child_by_field_name("pattern") or c
            if n.type == "identifier":
                out.append(txt(n))
        return out

    def callee(self, node):
        if node.type == "new_expression":
            return None, txt(node.child_by_field_name("constructor"))
        return super().callee(node)

    def imports(self, root, file, tree):
        out = {}
        for n in tree.root_node.children:
            if n.type != "import_statement":
                continue
            src = txt(n.child_by_field_name("source")).strip("'\"`")
            clause = next((c for c in n.named_children if c.type == "import_clause"), None)
            for c in clause.named_children if clause is not None else []:
                if c.type == "identifier":
                    out[txt(c)] = (src, "default")
                elif c.type == "named_imports":
                    for s in c.named_children:
                        name, alias = s.child_by_field_name("name"), s.child_by_field_name("alias")
                        out[txt(alias or name)] = (src, txt(name))
                elif c.type == "namespace_import":
                    out[txt(c.named_children[-1])] = (src, None)
        return out


class C(Spec):
    defs = {"function_definition": "function"}
    calls = {"call_expression"}
    self_names = ()

    def def_name(self, node):
        d = node.child_by_field_name("declarator")
        while d is not None and d.type not in ("identifier", "field_identifier", "qualified_identifier", "destructor_name"):
            d = d.child_by_field_name("declarator") or (d.named_children[0] if d.named_children else None)
        return txt(d)


SPECS = {"python": Python(), "java": Java(), "go": Go(), "typescript": Script(), "tsx": Script(), "javascript": Script(),
         "c": C(), "cpp": C()}


# ---------------------------------------------------------------------------
# reading one file

def parse_file(root, rel, lang):
    """(nodes, raw calls, imports) of one source file."""
    import tree_sitter as ts
    data = (Path(root) / rel).read_bytes()
    tree = ts.Parser(language(lang)).parse(data)
    spec = SPECS[lang]
    nodes, calls = {}, []
    base = LANG_NAME.get(lang, lang)
    module = f"{rel}:<module>"

    def visit(node, scope, owner, cls):
        kind = spec.defs.get(node.type)
        # const f = () => ...: an arrow function or function expression bound to a name
        if node.type == "variable_declarator" and isinstance(spec, Script):
            v = node.child_by_field_name("value")
            if v is not None and v.type in ("arrow_function", "function_expression", "function"):
                kind = "function"
        if kind:
            name = spec.def_name(node)
            if name:
                qual = ".".join(scope + [name]) if not (lang == "go" and "." in name) else name
                if kind == "function" and cls:
                    kind = "method"
                nid = f"{rel}:{qual}"
                n = dict(name=qual, file=rel, line=node.start_point[0] + 1, end=node.end_point[0] + 1,
                         defined=True, lang=base, kind=kind)
                target = node
                if node.type == "variable_declarator":
                    target = node.child_by_field_name("value")
                if d := spec.decorators(node.parent if node.type == "variable_declarator" and node.parent is not None else node):
                    n["decorators"] = d
                if p := spec.params(target):
                    n["params"] = p
                if pt := spec.param_text(target):
                    n["param_text"] = pt
                if node.type in spec.classes and (b := spec.bases(node)):
                    n["bases"] = b
                if cls and kind == "method":
                    n["class"] = f"{rel}:{'.'.join(scope)}"
                if node.parent is not None and node.parent.type == "decorated_definition":
                    n["top"] = node.parent.start_point[0] + 1        # the decorators above the def
                nodes[nid] = n
                is_cls = node.type in spec.classes
                for c in node.children:
                    visit(c, scope + [name], owner if is_cls else nid, is_cls)
                return
        if node.type in spec.calls:
            got = spec.callee(node)
            if got and got[1]:
                calls.append(dict(owner=owner or module, recv=got[0], name=got[1], line=node.start_point[0] + 1,
                                  col=node.start_point[1] + 1, cls=None))
        for c in node.children:
            visit(c, scope, owner, cls and node.type not in spec.defs)

    visit(tree.root_node, [], None, False)
    if any(c["owner"] == module for c in calls):
        nodes[module] = dict(name=Path(rel).name, file=rel, line=1, end=len(lines(Path(root) / rel)) or 1,
                             defined=True, lang=base, kind="module")
    return nodes, calls, spec.imports(root, rel, tree)


def parse_html(root, rel):
    """A page: the scripts and stylesheets it loads, and the functions its inline handlers call."""
    import tree_sitter as ts
    tree = ts.Parser(language("html")).parse((Path(root) / rel).read_bytes())
    pid = f"{rel}:<page>"
    loads, handlers = [], []

    def visit(n):
        if n.type == "start_tag" or n.type == "self_closing_tag":
            tag = txt(n.named_children[0]).lower() if n.named_children else ""
            for a in n.named_children:
                if a.type != "attribute":
                    continue
                key = txt(a.named_children[0]).lower()
                val = txt(a.named_children[1]).strip("'\"") if len(a.named_children) > 1 else ""
                at = (a.start_point[0] + 1, a.start_point[1] + 1)
                if (tag == "script" and key == "src") or (tag == "link" and key == "href"):
                    loads.append((val, at))
                elif key.startswith("on"):
                    for m in re.finditer(r"\b([A-Za-z_$][\w$]*)\s*\(", val):
                        handlers.append((m.group(1), at))
        for c in n.children:
            visit(c)

    visit(tree.root_node)
    node = dict(name=Path(rel).name, file=rel, line=1, end=len(lines(Path(root) / rel)) or 1, defined=True,
                lang="html", kind="page")
    return {pid: node}, loads, handlers


# ---------------------------------------------------------------------------
# joining calls to definitions

def _module_file(files, lang, mod, here):
    """The repository file a module path names, or None for an outside module."""
    if not mod:
        return None
    if lang == "python":
        p = mod.replace(".", "/")
        for cand in (f"{p}.py", f"{p}/__init__.py"):
            if cand in files:
                return cand
        return None
    if lang in ("typescript", "tsx", "javascript"):
        if not mod.startswith("."):
            return None
        base = (Path(here).parent / mod).as_posix()
        base = re.sub(r"(^|/)\./", r"\1", base)
        while "/../" in base:
            base = re.sub(r"[^/]+/\.\./", "", base, count=1)
        for ext in ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"):
            if base + ext in files:
                return base + ext
        return None
    if lang == "go":
        tail = mod.rstrip("/")
        dirs = {str(Path(f).parent) for f in files if f.endswith(".go")}
        hit = [d for d in dirs if tail == d or tail.endswith("/" + d)]
        return hit[0] if len(hit) == 1 else None
    return None


# methods that lists, dicts, strings, files and threads all have: a call to one says nothing about
# which class's method runs
COMMON_METHODS = set("""get set append extend insert pop remove clear copy update keys values items add discard
sort reverse index count join split strip lstrip rstrip replace format startswith endswith lower upper encode
decode read write close open flush seek readline readlines run start stop wait send recv put next push shift
map filter reduce forEach find some every then catch finally toString valueOf length size has delete apply call
bind emit on off once equals hashCode compareTo iterator stream collect String Error print""".split())


# languages that call each other's functions directly
FAMILY = {"typescript": "js", "javascript": "js", "c": "c", "cpp": "c"}
FAMILY.update({k: k for k in ("python", "java", "go")})


def build(root, files):
    """Nodes and edges for the files this backend reads (paths from the root)."""
    root = Path(root)
    by_lang, nodes, calls, imports, errors = {}, {}, [], {}, []
    for f in files:
        lang = EXT.get(Path(f).suffix)
        if lang and language(lang) is not None:
            by_lang.setdefault(lang, []).append(f)
    pages = []
    for lang, fs in by_lang.items():
        for f in fs:
            try:
                if lang == "html":
                    pages.append((f,) + parse_html(root, f))
                    continue
                if lang == "css":
                    nodes[f"{f}:<module>"] = dict(name=Path(f).name, file=f, line=1, end=len(lines(root / f)) or 1,
                                                  defined=True, lang="css", kind="stylesheet")
                    continue
                n, c, im = parse_file(root, f, lang)
            except (OSError, ValueError) as e:
                errors.append(f"{f}: {e}")
                continue
            nodes.update(n)
            for x in c:
                x["file"], x["lang"] = f, lang
            calls += c
            imports[f] = im
    fileset = set(files)

    # where a name is defined: in a file, in the whole repository, as a method of a class
    in_file, top, methods, classes = {}, {}, {}, {}
    for nid, n in nodes.items():
        if n["kind"] in ("module", "page", "stylesheet"):
            continue
        short = n["name"].rsplit(".", 1)[-1]
        in_file.setdefault((n["file"], n["name"]), []).append(nid)
        if n["kind"] == "method":
            methods.setdefault(short, []).append(nid)
        else:
            top.setdefault(short, []).append(nid)
        if n["kind"] == "class":
            classes[nid] = n

    def init_of(cls_id):
        """Calling a class runs its constructor."""
        for k in ("__init__", "constructor", nodes[cls_id]["name"].rsplit(".", 1)[-1]):
            if f"{cls_id}.{k}" in nodes:
                return f"{cls_id}.{k}"
        return cls_id

    def one(ids):
        return ids[0] if len(ids) == 1 else None

    edges, outside = [], {}
    for c in calls:
        by_name = False
        f, lang, name, recv = c["file"], c["lang"], c["name"], c["recv"]
        owner = nodes.get(c["owner"], {})
        im = imports.get(f, {})
        dst = None
        if recv is None:
            if lang == "go":   # a package is a directory: functions of the same directory, by name
                same_dir = [x for x in top.get(name, []) if str(Path(nodes[x]["file"]).parent) == str(Path(f).parent)]
                dst = one(same_dir)
            dst = dst or one(in_file.get((f, name), []))
            # Java and TypeScript call their own class's methods without this.: the enclosing classes first
            if dst is None and lang in ("java", "typescript", "tsx", "javascript") and owner.get("class"):
                cls = nodes[owner["class"]]["name"]
                while cls and dst is None:
                    dst = one(in_file.get((f, f"{cls}.{name}"), []))
                    cls = cls.rpartition(".")[0]
            if dst is None and name in im:
                mod, orig = im[name]
                mf = _module_file(fileset, lang, mod, f)
                if mf:
                    dst = one(in_file.get((mf, orig or name), [])) or (f"{mf}:<module>" if orig is None else None)
                elif lang == "python" and mod and _module_file(fileset, lang, f"{mod}.{orig}", f):
                    dst = None                                   # a submodule, not a call
                else:
                    outside[name] = (f"{mod}.{orig}" if orig and orig != "default" else mod) if mod else name
                    dst = "ext:" + outside[name]
            # a bare name defined once in the repository: Java classes of the package and browser scripts
            # share one namespace; a Python file must import a name (or star-import its module) to call it
            if dst is None and lang not in ("go", "python") or dst is None and lang == "python" and "*" in im:
                dst = one([x for x in top.get(name, []) if FAMILY.get(nodes[x]["lang"]) == FAMILY.get(LANG_NAME.get(lang, lang))])
            if dst is None and lang in ("c", "cpp"):
                outside[name] = name
                dst = "ext:" + name
        else:
            r = recv.split("(")[0]
            if r in SPECS[lang].self_names and owner.get("class"):
                dst = one(in_file.get((f, nodes[owner["class"]]["name"] + "." + name), []))
            elif r.split(".")[0] in im:
                head = r.split(".")[0]
                mod, orig = im[head]
                sub = orig if orig and orig != "default" else None
                # the module the receiver names: import harness.routing as r, from harness import routing
                path = ".".join(x for x in (mod, sub) if x) + r[len(head):]
                if lang == "go":
                    d = _module_file(fileset, "go", mod, f)
                    dst = one([x for x in top.get(name, []) if str(Path(nodes[x]["file"]).parent) == d]) if d else None
                    repo = d is not None
                else:
                    mf = _module_file(fileset, lang, path, f) if lang == "python" else _module_file(fileset, lang, mod, f)
                    if mf and lang != "python" and sub:
                        dst = one(in_file.get((mf, f"{sub}.{name}"), []))        # import {Router} from './r'; Router.add()
                    elif mf:
                        dst = one(in_file.get((mf, name), []))
                    else:
                        cls_file = _module_file(fileset, lang, mod, f)          # from x import Router; Router.add()
                        dst = one(in_file.get((cls_file, f"{sub}.{name}"), [])) if cls_file and sub else None
                        mf = cls_file
                    repo = mf is not None
                if dst is None and not repo:
                    key = f"{path}.{name}"
                    outside[key] = key
                    dst = "ext:" + key
            elif name not in COMMON_METHODS:
                # an object of unknown type: a method name defined once in the repository, in the same
                # language, decides it, unless every container and string has a method of that name
                dst = one([x for x in methods.get(name, []) if FAMILY.get(nodes[x]["lang"]) == FAMILY.get(LANG_NAME.get(lang, lang))])
                by_name = dst is not None
        if dst in classes:
            dst = init_of(dst)
        if dst and dst != c["owner"]:
            e = dict(src=c["owner"], dst=dst, file=f, line=c["line"], col=c["col"], kind="call", source="syntax")
            if by_name:
                e["by"] = "name"           # the receiver's type is unknown: matched on the method name alone
            edges.append(e)
    for key, name in outside.items():
        nodes["ext:" + name] = dict(name=name, file="", line=None, defined=False)

    # pages: what they load, and the functions their handlers call
    for f, pn, loads, handlers in pages:
        nodes.update(pn)
        pid = next(iter(pn))
        for src, (ln, col) in loads:
            target = (Path(f).parent / src.split("?")[0]).as_posix().lstrip("./") if not re.match(r"^[a-z]+:|^//", src) else None
            target = re.sub(r"[^/]+/\.\./", "", target) if target else None
            if target in fileset:
                mid = f"{target}:<module>"
                nodes.setdefault(mid, dict(name=Path(target).name, file=target, line=1, end=len(lines(root / target)) or 1,
                                           defined=True, lang=LANG_NAME.get(EXT.get(Path(target).suffix, ""), EXT.get(Path(target).suffix)),
                                           kind="stylesheet" if target.endswith(".css") else "module"))
                edges.append(dict(src=pid, dst=mid, file=f, line=ln, col=col, kind="loads", source="syntax"))
        for name, (ln, col) in handlers:
            dst = one([x for x in top.get(name, []) if nodes[x].get("lang") in ("javascript", "typescript")])
            if dst:
                edges.append(dict(src=pid, dst=dst, file=f, line=ln, col=col, kind="call", source="syntax"))

    langs = {}
    for lang, fs in by_lang.items():
        langs[LANG_NAME.get(lang, lang)] = langs.get(LANG_NAME.get(lang, lang), 0) + len(fs)
    stats = dict(files=sum(langs.values()), languages=langs, nodes=sum(1 for n in nodes.values() if n.get("defined")),
                 edges=len(edges), errors=errors)
    return dict(nodes=nodes, edges=edges, stats=stats)
