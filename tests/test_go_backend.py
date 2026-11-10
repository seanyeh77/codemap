"""The Go backend (go/types) on tests/fixtures/gofix."""

import shutil
import unittest
from pathlib import Path

from codemap import backends

ROOT = Path(__file__).parent / "fixtures" / "gofix"


@unittest.skipUnless(shutil.which("go"), "no Go toolchain")
class GoResolve(unittest.TestCase):
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

    def test_backend(self):
        self.assertIn("go", self.idx["backends"])               # go/types, not the tree-sitter fallback
        self.assertEqual(self.idx["backends"]["go"]["resolution"]["unresolved"], 0)

    # 2A: symbols

    def test_packages_and_methods(self):
        self.assertEqual(self.get("main", "New")["resolution"], "exact")              # store.New(), another package
        self.assertEqual(self.get("main", "Server.Serve")["resolution"], "exact")     # pointer receiver
        self.assertEqual(self.get("Base.Log", "fmt.Println")["resolution"], "exact")  # the standard library

    def test_embedding(self):
        e = self.get("Server.Serve", "Base.Log")                                      # s.Log(): promoted from Base
        self.assertEqual((e["resolution"], e["infer"]["how"], e["infer"]["type"]), ("exact", "embedding", "Server"))

    def test_method_expression(self):
        e = self.get("main", "Server.Close")
        self.assertEqual((e["resolution"], e["infer"]["how"]), ("exact", "methodexpr"))

    # 2B: values

    def test_interface_from_values(self):
        e = self.get("main", "mem.Get")                                               # st = store.New(), which returns &mem{}
        self.assertEqual((e["resolution"], e["infer"]["how"]), ("inferred", "return"))
        e = self.get("Server.Serve", "mem.Get")                                       # the field St was given store.New()
        self.assertEqual(e["resolution"], "inferred")

    def test_function_values_and_closures(self):
        self.assertEqual(self.get("main", "process")["infer"]["how"], "funcvalue")    # h := process; h()
        self.assertEqual(self.get("main", "main.func1")["infer"]["how"], "closure")   # f := func() {...}; f()
        self.assertEqual(self.get("main.func1", "process")["resolution"], "exact")    # inside the closure
        self.assertEqual(self.get("Server.Serve", "process")["infer"]["how"], "field")   # s.Handle(), Handle: process

    # 2C: control flow and dispatch

    def test_go_and_defer(self):
        self.assertEqual(self.get("Server.Serve", "Server.worker")["mode"], "go")
        self.assertEqual(self.get("Server.Serve", "Server.Close")["mode"], "defer")

    def test_interface_dispatch_checks_implementation(self):
        # Pick returns either store: both implementations, and Counter (a Get of another signature) never
        targets = {d for (s, d, k) in self.calls if s == "main" and d.endswith(".Get")}
        self.assertEqual(targets, {"mem.Get", "disk.Get"})
        for d in ("mem.Get", "disk.Get"):
            amb = [e for e in self.calls[("main", d, "call")] if e["resolution"] == "ambiguous"]
            self.assertTrue(amb)
            self.assertEqual(amb[0]["infer"]["how"], "interface")
        self.assertNotIn("Counter.Get", str(self.idx["edges"]))

    # outside interfaces, production and test

    def at(self, file, line):
        return [e for e in self.idx["edges"] if e["file"].endswith(file) and e["line"] == line]

    def test_outside_interface_is_one_node(self):
        # err from errors.New: only the interface method error.Error, no fan-out to the repo's error types
        es = self.at("server/clock.go", 37)
        self.assertEqual([(e["dst"], e["resolution"]) for e in es], [("ext:error.Error", "exact")])
        # err from store.Validate, which returns only *ValidationError: narrowed to that type
        es = self.at("server/clock.go", 35)
        self.assertEqual([(e["dst"].split(":", 1)[1], e["resolution"]) for e in es], [("ValidationError.Error", "inferred")])
        # the repository's implementations hang from the interface method as relations, not calls
        imp = [e for e in self.idx["edges"] if e["kind"] == "implements"]
        self.assertEqual([(e["src"].split(":", 1)[1], e["dst"]) for e in imp], [("ValidationError.Error", "ext:error.Error")])

    def test_production_ignores_test_values(self):
        # production Stamp: c.Now() is time.Now; the closure TestStamp stores is not production's
        self.assertIn(("ext:time.Now", "inferred"), [(e["dst"], e["resolution"]) for e in self.at("server/clock.go", 30)])
        self.assertNotIn("TestStamp", str(self.at("server/clock.go", 30)))
        # c.St.Get: the test's fakeStore is not a candidate in production
        self.assertEqual([e["dst"].split(":", 1)[1] for e in self.at("server/clock.go", 28)], ["mem.Get"])
        # in the test itself, both values the field may hold
        self.assertEqual({e["dst"].removeprefix("ext:").split(":", 1)[-1] for e in self.at("server/clock_test.go", 19)},
                         {"time.Now", "TestStamp.func2"})
        self.assertEqual({e["resolution"] for e in self.at("server/clock_test.go", 19)}, {"ambiguous"})
        self.assertEqual(self.idx["nodes"]["server/clock_test.go:TestStamp"].get("scope"), "test")
        self.assertNotIn("scope", self.idx["nodes"]["server/clock.go:Clocked.Stamp"])

    def test_partial_candidate(self):
        # c.Done() holds the caller's function (unknown) or noop: noop is one target, not the one
        es = self.at("server/clock.go", 29)
        self.assertEqual([(e["dst"].split(":", 1)[1], e["resolution"], e["infer"].get("partial")) for e in es], [("noop", "ambiguous", True)])

    def test_net_http_route(self):
        from codemap import frameworks
        idx = frameworks.run(ROOT, backends.build(ROOT))
        self.assertEqual(idx["nodes"]["server/server.go:Server.Page"]["entry"], {"framework": "net/http", "kind": "route", "text": "/"})

    def test_function_passed_as_value(self):
        e = self.get("Server.Serve", "Server.Page", "ref")                            # http.HandleFunc("/", s.Page)
        self.assertEqual((e["infer"]["how"], e["infer"]["type"]), ("methodvalue", "Server"))


if __name__ == "__main__":
    unittest.main()
