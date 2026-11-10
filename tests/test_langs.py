"""The tree-sitter backend and the framework adapters on tests/fixtures/polyglot."""

import shutil
import unittest
from pathlib import Path

from codemap import backends, frameworks, rules, view
from codemap.backends import syntax

ROOT = Path(__file__).parent / "fixtures" / "polyglot"
NEED = ("python", "java", "go", "typescript", "html", "css")


@unittest.skipUnless(all(syntax.language(l) for l in ("python", "java", "go", "typescript", "html", "css")),
                     "tree-sitter grammars not installed")
class Polyglot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idx = frameworks.run(ROOT, backends.build(ROOT))
        cls.pairs = {(e["src"].split(":", 1)[-1] if ":" in e["src"] else e["src"], e["dst"].split(":", 1)[-1], e["source"], e.get("by"))
                     for e in cls.idx["edges"]}

    def has(self, src, dst, source="syntax", by=None):
        self.assertIn((src, dst, source, by), self.pairs)

    def test_languages(self):
        go = "go" if shutil.which("go") else "syntax-go"      # go/types, or tree-sitter without a Go toolchain
        self.assertEqual(self.idx["backends"]["syntax"]["languages"],
                         {"java": 1, "typescript": 2, "html": 1, "css": 1})
        self.assertEqual(self.idx["backends"][go]["languages"], {"go": 2})
        self.assertEqual(self.idx["backends"]["python"]["languages"], {"python": 7})     # its own backend

    def test_python_calls(self):
        self.has("current_user", "lookup", "static")                       # same file
        self.has("test_render", "render", "static")                        # from api.main import render
        self.has("Switch.packet_in", "Switch.learn", "static")             # self.learn()
        self.has("get_db", "Session", "static")                            # a class: no __init__, the class itself
        self.assertIn("ext:fastapi.FastAPI", self.idx["nodes"])            # an outside module's function

    def test_java_calls(self):
        self.has("AppComponent.activate", "AppComponent.log")    # own class's method, no this.
        self.has("AppComponent.ReactivePacketProcessor.process", "AppComponent.ReactivePacketProcessor.forward")
        self.has("AppComponent.ReactivePacketProcessor.forward", "AppComponent.log")   # the enclosing class

    def test_go_calls(self):
        if shutil.which("go"):                                   # go/types knows s's type: no name matching
            self.has("main", "New", "static")
            self.has("main", "helper", "static")
            self.has("main", "Store.Put", "static")
            self.has("Store.Put", "normalize", "static")
            return
        self.has("main", "New")                                  # store.New() through the import path
        self.has("main", "helper")                               # same package
        self.has("main", "Store.Put", by="name")                 # s.Put(): the receiver's type is unknown
        self.has("Store.Put", "normalize")

    def test_typescript_and_html(self):
        self.has("go", "format")                                 # import { format } from './util'
        self.has("go", "show")                                   # const show = () => ...
        self.has("go", "Counter.bump", by="name")
        self.has("<page>", "go")                                 # onclick="go()"
        self.has("<page>", "<module>")                           # <script src>, <link href>
        # console.log is not a repository method, least of all the Java one
        self.assertNotIn(("show", "AppComponent.log", "syntax", "name"), self.pairs)

    def entry(self, nid):
        return self.idx["nodes"][nid].get("entry", {})

    def test_web_routes_and_depends(self):
        self.assertEqual(self.entry("api/main.py:read_user")["text"], "GET /users/{uid}")
        self.assertEqual(self.entry("api/web.py:health")["text"], "GET/HEAD /health")
        self.assertEqual(self.entry("api/web.py:missing")["kind"], "hook")
        self.has("read_user", "get_db", "framework")
        self.has("read_user", "current_user", "framework")
        self.has("create_user", "current_user", "framework")    # dependencies=[Depends(...)]

    def test_pytest(self):
        self.assertEqual(self.entry("tests/test_api.py:test_render")["kind"], "test")
        self.assertEqual(self.entry("tests/test_api.py:TestUsers.test_create")["kind"], "test")
        self.assertNotIn("entry", self.idx["nodes"]["tests/test_api.py:helper"])
        self.assertEqual(self.entry("tests/conftest.py:client")["text"], "client (scope session)")
        self.has("test_render", "user", "framework")              # from conftest.py
        self.has("user", "client", "framework")                   # a fixture using a fixture
        self.has("TestUsers.test_create", "client", "framework")
        self.has("test_render", "pytest fixture tmp_path", "framework")   # built in

    def test_ryu_mininet_onos(self):
        self.assertEqual(self.entry("ctrl/switch.py:Switch.packet_in")["text"], "EventOFPPacketIn (MAIN_DISPATCHER)")
        self.assertEqual(self.entry("ctrl/switch.py:Switch.__init__")["kind"], "app")
        self.has("os-ken event EventOFPPacketIn", "Switch.packet_in", "framework")
        self.assertEqual(self.entry("topo/net.py:Star.build")["kind"], "topology")
        java = "onos/src/main/java/org/example/app/AppComponent.java:"
        self.assertEqual(self.entry(java + "AppComponent")["kind"], "component")
        self.assertEqual(self.entry(java + "AppComponent.activate")["text"], "activate")
        self.has("AppComponent.activate", "AppComponent.ReactivePacketProcessor.process", "framework")

    def test_viewer_graph(self):
        g = view.build(ROOT, rules.run(ROOT, dict(self.idx, edges=list(self.idx["edges"])), {}), {})
        self.assertEqual(g["stats"]["languages"]["go"], 2)
        self.assertGreater(g["stats"]["syntax"], 10)
        self.assertGreater(g["stats"]["static"], 15)
        f = g["funcs"]["api/main.py:read_user"]
        self.assertEqual((f["lang"], f["entry"]["kind"], f["end"]), ("python", "route", 10))
        self.assertTrue(any(e["src"] == "framework" and e["k"] == "inject" for e in g["edges"]))
        self.assertIn("api", {c["id"] for c in g["comps"]})


if __name__ == "__main__":
    unittest.main()
