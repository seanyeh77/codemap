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

    # containers: the element type, and where it came from

    def how(self, src, dst):
        return {e["infer"]["how"] for e in self.calls[(src, dst)]}

    def test_container_elements(self):
        self.assertEqual(self.how("team", "User.describe"), {"element:annotation"})   # users: list[User]; load() -> list[User]
        self.assertEqual(self.how("team", "Admin.grant"), {"element:append"})         # staff.append(Admin(...)); list(staff).pop()
        self.assertEqual(self.how("team", "Repo.save"), {"element:setitem"})          # by_name["r"] = Repo(); .items()
        self.assertEqual(self.how("team", "User.run"), {"element:comprehension"})     # [User(...) for ...][0]
        self.assertEqual(self.how("Team.describe_all", "User.describe"), {"element:annotation"})   # self.members: list[User]
        self.assertEqual(self.res("team", "User.describe"), {"inferred"})

    def test_exact_type_is_not_ambiguous(self):
        # b = User(...) is exactly a User: Admin overriding run() does not matter
        b = [e for e in self.calls[("exact_vs_bound", "User.run")] if e["line"] == 32]
        self.assertEqual([e["resolution"] for e in b], ["inferred"])
        self.none_at("exact_vs_bound", "Admin.run", 32)
        # [User(...) for ...][0] is exactly a User too
        self.assertEqual(self.res("team", "User.run"), {"inferred"})
        self.none("team", "Admin.run")
        # u: User is a bound: an Admin fits, so both
        self.assertEqual({e["resolution"] for e in self.calls[("exact_vs_bound", "Admin.run")]}, {"ambiguous"})

    def test_partial_container_is_ambiguous(self):
        # HANDLERS also holds a lambda of unknown type: team is one target, not the one target
        es = self.calls[("dispatch", "team")]
        self.assertEqual({e["resolution"] for e in es}, {"ambiguous"})
        self.assertTrue(all(e["infer"].get("partial") for e in es))

    def test_closure_from_a_return(self):
        self.assertEqual(self.res("dispatch", "make_rule.rule"), {"inferred"})     # make_rule(1)(2)

    def none_at(self, src, dst, line):
        self.assertFalse([e for e in self.calls.get((src, dst), []) if e["line"] == line])

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
