"""The TypeScript backend (the TypeScript compiler API) on tests/fixtures/tsfix."""

import shutil
import unittest
from pathlib import Path

from codemap import backends
from codemap.backends import ts

ROOT = Path(__file__).parent / "fixtures" / "tsfix"


def available():
    return shutil.which("node") and ts.typescript(ROOT, ts.configs_of(ROOT))[0] is not None


@unittest.skipUnless(available(), "no Node or no TypeScript to load")
class TsResolve(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idx = backends.build(ROOT)
        cls.calls = {}
        for e in cls.idx["edges"]:
            key = (e["src"].split(":", 1)[1], e["dst"].removeprefix("ext:").split(":", 1)[-1], e["kind"])
            cls.calls.setdefault(key, []).append(e)

    def get(self, src, dst, kind="call"):
        es = self.calls.get((src, dst, kind))
        self.assertTrue(es, f"no {kind} edge {src} -> {dst}")
        return es[0]

    def no(self, src, dst, kind="call"):
        self.assertNotIn((src, dst, kind), self.calls)

    def how(self, e):
        return (e["resolution"], (e.get("infer") or {}).get("how"))

    def test_backend(self):
        b = self.idx["backends"]["typescript"]
        self.assertEqual(b["languages"], {"typescript": 8, "javascript": 1})
        self.assertEqual(b["placeholders"], ["not-installed", "react"])         # modules that are not installed
        self.assertEqual(b["programs"], 1)                                      # packages/core: same options, one program
        self.assertEqual(b["incomplete_files"], 2)                                # app.ts and view.tsx: missing modules
        self.assertTrue(self.idx["nodes"]["src/app.ts:names"].get("types_incomplete"))
        self.assertNotIn("types_incomplete", self.idx["nodes"]["src/shapes.ts:Shape.area"])

    def test_types_only(self):
        # .d.ts files and node_modules give types, never nodes
        self.assertFalse(any(n.get("file", "").endswith(".d.ts") or "node_modules" in n.get("file", "")
                             for n in self.idx["nodes"].values()))
        self.assertEqual(self.get("names", "track")["resolution"], "exact")     # declared in src/env.d.ts
        self.assertEqual(self.get("libs", "fakelib.register")["resolution"], "exact")
        self.assertEqual(self.how(self.get("Logger.start", "fakelib.Client.send")), ("exact", "type"))
        self.assertTrue(self.idx["nodes"]["ext:not-installed.missing"].get("placeholder"))

    # 3A: modules and classes

    def test_imports(self):
        self.assertEqual(len(self.calls[("names", "add", "call")]), 2)          # import alias, re-export alias
        for dst in ("sub", "mul", "Geo.dist"):                                  # namespace import, default, namespace
            self.assertEqual(self.get("names", dst)["resolution"], "exact")

    def test_classes(self):
        self.assertEqual(self.how(self.get("shapes", "Circle.constructor")), ("exact", "new"))
        self.assertEqual(self.get("shapes", "Shape.constructor")["resolution"], "exact")   # Square: inherited
        self.assertEqual(self.get("shapes", "Dog")["resolution"], "exact")                 # no constructor anywhere
        self.assertEqual(self.how(self.get("Circle.constructor", "Shape.constructor")), ("exact", "super"))
        self.assertEqual(self.how(self.get("Circle.area", "Shape.area")), ("exact", "super"))
        self.assertEqual(self.how(self.get("Old.m", "Old.n")), ("exact", "this"))         # JavaScript
        self.assertEqual(self.get("run", "helper")["resolution"], "exact")                # exports.run = function

    def test_overrides(self):
        # this.area() and s: Shape: Circle overrides area, so either may run; the test's subclass is left out
        self.assertEqual(self.how(self.get("Shape.describe", "Circle.area")), ("ambiguous", "override"))
        self.assertEqual(self.get("Shape.describe", "Shape.area")["resolution"], "ambiguous")
        es = {e["line"]: self.how(e) for e in self.calls[("shapes", "Circle.area", "call")]}
        self.assertEqual(es, {18: ("exact", "type"), 21: ("ambiguous", "override")})       # c = new Circle(); s: Shape
        self.no("shapes", "TestShape.area")
        self.no("Shape.describe", "TestShape.area")
        self.assertEqual(self.how(self.get("Animal.greet", "Dog.speak")), ("inferred", "override"))   # abstract, one subclass

    # 3B: types and values

    def test_types(self):
        es = {e["line"]: self.how(e) for e in self.calls[("types", "Circle.area", "call")]}
        self.assertEqual(es[28], ("exact", "type"))          # make().area(): the return type
        self.assertEqual(es[30], ("exact", "type"))          # let s = make(): assignment
        self.assertEqual(es[31], ("ambiguous", "type"))      # Circle | Square
        self.assertEqual(es[32], ("ambiguous", "override"))  # T extends Shape
        self.assertEqual(es[33], ("exact", "type"))          # Circle & {name()}

    def test_function_values(self):
        self.assertEqual(self.how(self.get("values", "add")), ("inferred", "funcvalue"))        # let cb = sum; cb()
        self.assertEqual(self.how(self.get("values", "counter.fn1")), ("inferred", "returned"))   # a returned closure
        self.assertEqual(self.how(self.get("values", "values.fn1", "ref")), ("exact", "closure"))
        self.assertEqual(self.get("values.fn1", "mul")["resolution"], "exact")
        e = self.get("run", "values.fn1")                                                       # f(): a parameter
        self.assertEqual((e["resolution"], e["infer"].get("partial")), ("ambiguous", True))
        self.assertEqual(self.how(self.get("Button.click", "names")), ("ambiguous", "funcvalue"))   # a field, via new Button(names)
        self.assertEqual(self.how(self.get("values", "names", "ref")), ("exact", "funcvalue"))

    def test_workspace_package(self):
        # @fix/core points at a build that does not exist: its source is the target, not a placeholder
        self.assertEqual(self.get("names", "coreRun")["dst"],
                         "packages/core/src/index.ts:coreRun")

    def test_jsx(self):
        self.assertEqual(self.how(self.get("Page", "Fancy")), ("exact", "jsx"))                  # forwardRef keeps the name
        self.assertEqual(self.get("Fancy", "add")["resolution"], "exact")
        self.assertEqual(self.how(self.get("Page", "Badge")), ("exact", "jsx"))
        self.assertEqual(self.get("Page", "Page.save", "ref")["resolution"], "exact")             # onPress={save}
        self.assertEqual(self.get("Badge", "Page.save")["resolution"], "ambiguous")               # the prop, called

    # 3C: interfaces and scope

    def test_interfaces(self):
        for impl in ("MemStore.get", "FileStore.get"):
            self.assertEqual(self.how(self.get("use", impl)), ("ambiguous", "interface"))
        self.no("use", "FakeStore.get")                                                          # a test's fake
        self.assertEqual(self.how(self.get("narrowed", "MemStore.get")), ("inferred", "constructor"))
        # nothing in production implements Handler: the interface method, exact as the method called
        self.assertEqual(self.how(self.get("dispatch", "Handler.handle")), ("exact", "interface"))
        self.assertEqual(self.get("FakeHandler.handle", "Handler.handle", "implements")["source"], "static")
        self.assertEqual(self.how(self.get("check", "FakeStore.get")), ("inferred", "constructor"))   # in the test itself

    def test_scope(self):
        self.assertEqual(self.idx["nodes"]["tests/fakes.test.ts:FakeStore.get"]["scope"], "test")
        self.assertNotIn("scope", self.idx["nodes"]["src/stores.ts:MemStore.get"])

    def test_library_setter(self):
        # const [n, setN] = useValue(0): the library's function, named by its declared type
        self.assertEqual(self.how(self.get("counterHook", "fakelib.Setter")), ("inferred", "returned"))

    def test_decorators(self):
        # run when the class is defined: from the class, not from the method they mark
        self.assertEqual(self.how(self.get("Api", "Route")), ("exact", "decorator"))
        self.assertEqual(self.how(self.get("Api", "Entity")), ("exact", "decorator"))
        self.no("Api.list", "Route")
        self.assertEqual(self.get("Api.list", "names")["resolution"], "exact")

    def test_outside_methods(self):
        self.assertEqual(self.how(self.get("libs", "Array.map")), ("exact", "type"))
        self.assertEqual(self.get("libs", "libs.fn1", "ref")["resolution"], "exact")


class TsFallback(unittest.TestCase):
    def test_tree_sitter_without_node(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"CODEMAP_NODE": "/nonexistent/node"}):
            idx = backends.build(ROOT)
        if "syntax-typescript" not in idx["backends"]:
            self.skipTest("tree-sitter grammars not installed")
        self.assertNotIn("typescript", idx["backends"])
        self.assertEqual(idx["backends"]["syntax-typescript"]["fallback"], "tree-sitter")
        self.assertFalse(any(n.get("file", "").endswith(".d.ts") for n in idx["nodes"].values()))
        self.assertTrue(all(e["source"] in ("syntax", "framework", "rule") for e in idx["edges"]))


if __name__ == "__main__":
    unittest.main()
