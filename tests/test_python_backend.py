"""The Python backend on tests/fixtures/pyresolve: names (2A), types (2B), resolution (2C)."""

import unittest
from pathlib import Path

from codemap import backends

ROOT = Path(__file__).parent / "fixtures" / "pyresolve"


class Resolve(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idx = backends.build(ROOT)
        cls.calls = {}
        for e in cls.idx["edges"]:
            key = (e["src"].split(":", 1)[1], e["dst"].removeprefix("ext:").split(":", 1)[-1])
            cls.calls.setdefault(key, []).append(e)

    def res(self, src, dst):
        es = self.calls.get((src, dst))
        self.assertTrue(es, f"no edge {src} -> {dst}")
        return {e["resolution"] for e in es}

    def none(self, src, dst):
        self.assertNotIn((src, dst), self.calls)

    # 2A: names

    def test_imports(self):
        self.assertEqual(self.res("main", "create"), {"exact"})              # from pkg.service import create as mk
        self.assertEqual(self.res("main", "numpy.array"), {"exact"})         # import numpy as np
        self.assertEqual(self.res("main", "User.__init__"), {"exact"})       # import pkg.models as pm; pm.User(...)
        self.assertEqual(self.res("main", "make_admin"), {"exact"})          # from pkg import service; service.make_admin()
        self.assertEqual(self.res("Service.handle", "ping"), {"exact"})      # from . import cycle_a
        self.assertEqual(self.res("go", "tidy"), {"exact"})                  # a script's sibling module

    def test_relative_imports_and_cycles(self):
        self.assertEqual(self.res("create", "User.__init__"), {"exact"})     # from .models import User
        self.assertEqual(self.res("ping", "pong"), {"exact"})                # cycle_a imports cycle_b imports cycle_a
        self.assertEqual(self.res("again", "ping"), {"exact"})

    def test_methods(self):
        self.assertEqual(self.res("User.run", "User.describe"), {"exact"})   # self.describe()
        self.assertEqual(self.res("User.build", "User.validate"), {"exact"}) # cls.validate()
        self.assertEqual(self.res("User.validate", "User.__init__"), {"exact"})   # cls(name)

    def test_inheritance(self):
        self.assertEqual(self.res("Admin.run", "User.run"), {"exact"})       # super().run()
        self.assertEqual(self.res("make_admin", "User.__init__"), {"exact"}) # Admin() runs the inherited __init__
        # self.run() in User may be Admin.run as well: both, and neither is called the one target
        self.assertEqual(self.res("User.start", "User.run"), {"ambiguous"})
        self.assertEqual(self.res("User.start", "Admin.run"), {"ambiguous"})

    # 2B: types

    def test_types(self):
        self.assertEqual(self.res("main", "User.describe"), {"inferred"})    # alias = user = mk(): return type, assignment
        self.assertEqual(self.res("main", "Admin.grant"), {"inferred"})      # make_admin() -> Admin
        self.assertEqual(self.res("main", "Service.handle"), {"inferred"})   # svc = service.Service()
        self.assertEqual(self.res("Service.handle", "Repo.save"), {"inferred"})   # self.repo = Repo()
        how = {e["infer"]["how"] for e in self.calls[("main", "Admin.grant")]}
        self.assertEqual(how, {"return"})

    def test_union_is_ambiguous(self):
        self.assertIn("ambiguous", self.res("main", "Admin.run"))            # either: User | Admin
        self.assertIn("ambiguous", self.res("main", "User.run"))

    # 2C: no guessing

    def test_unknown_object_gets_no_edge(self):
        # obj has no type: Other.run, User.run and Repo.save all have the right name, and none is chosen
        for dst in ("Other.run", "User.run", "Admin.run", "Repo.save"):
            self.none("unknown", dst)
        st = self.idx["backends"]["python"]["resolution"]
        self.assertEqual(st["unresolved"], 2)
        self.assertTrue(all(e["source"] == "static" for e in self.idx["edges"]))

    def test_builtin_methods_are_not_unresolved(self):
        self.assertNotIn("append", str(self.idx["backends"]["python"]["unresolved_top"]))


if __name__ == "__main__":
    unittest.main()
