"""Flask and FastAPI: routes and hooks are entry points; FastAPI Depends() is injection."""

import re

ROUTE = re.compile(r"^@(\w+(?:\.\w+)*)\.(route|get|post|put|delete|patch|head|options|websocket|api_route)\(\s*(?:path\s*=\s*)?(['\"])(.*?)\3(.*)\)\s*$", re.S)
HOOK = re.compile(r"^@(\w+(?:\.\w+)*)\.(before_request|after_request|teardown_request|before_first_request|errorhandler|middleware|on_event|exception_handler|context_processor)\b(.*)$", re.S)
DEPENDS = re.compile(r"\b(?:Depends|Security)\(\s*([A-Za-z_]\w*)")


def _routes(c, framework, files, rule):
    for nid in [k for f in files for k in c.files[f]]:
        n = c.nodes[nid]
        for d in n.get("decorators", []):
            m = ROUTE.match(d)
            if m:
                verb, path, rest = m.group(2), m.group(4), m.group(5)
                if verb in ("route", "api_route"):
                    ms = re.findall(r"['\"](\w+)['\"]", (re.search(r"methods\s*=\s*\[([^\]]*)\]", rest) or re.match("", "")).group(1) or "")
                    verb = "/".join(x.upper() for x in ms) or "GET"
                c.entry(nid, framework, "route", f"{verb.upper()} {path}")
                for dep in DEPENDS.findall(rest):           # dependencies=[Depends(auth)]
                    _inject(c, nid, dep, n, rule)
                break
            m = HOOK.match(d)
            if m:
                arg = re.sub(r"^\(|\)$", "", m.group(3).strip())
                c.entry(nid, framework, "hook", m.group(2) + (f" {arg}" if arg else ""))
                break


def _inject(c, consumer, name, n, rule):
    dst = c.find(n["file"], name)
    if dst:
        c.edge(consumer, dst, "inject", rule, n["file"], n["line"])


class Flask:
    name = "flask"

    def detect(self, c):
        self.files = [f for f in c.files if f.endswith(".py") and c.imports(f, r"flask")]
        return bool(self.files)

    def apply(self, c):
        _routes(c, "flask", self.files, "flask.depends")


class FastAPI:
    name = "fastapi"

    def detect(self, c):
        self.files = [f for f in c.files if f.endswith(".py") and c.imports(f, r"fastapi|starlette")]
        return bool(self.files)

    def apply(self, c):
        _routes(c, "fastapi", self.files, "fastapi.depends")
        # a parameter = Depends(provider): FastAPI calls the provider first and passes its result in,
        # in route handlers and in providers alike
        for f in self.files:
            for nid in c.files[f]:
                n = c.nodes[nid]
                for text in n.get("param_text", {}).values():
                    for dep in DEPENDS.findall(text):
                        _inject(c, nid, dep, n, "fastapi.depends")
