"""Run with: python3 -m unittest discover -s tests"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from codemap import arch, check, layer1, rules  # noqa: E402


def names(idx, nid):
    return idx["nodes"].get(nid, {}).get("name", nid)


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("cc"):
            raise unittest.SkipTest("no C compiler")
        cls.tmp = Path(tempfile.mkdtemp())
        cls.root = cls.tmp / "fixture"
        shutil.copytree(HERE / "fixture", cls.root)
        cc = [dict(directory=str(cls.root), file=f,
                   arguments=["cc", "-O2", "-Iinclude", "-c", "-o", f"build/{Path(f).name}.o", f])
              for f in ("src/lib/lib.c", "src/app/main.c")]
        (cls.root / "compile_commands.json").write_text(json.dumps(cc))
        cls.idx = rules.run(cls.root, layer1.build(cls.root))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def edges(self, **kw):
        return [e for e in self.idx["edges"] if all(e.get(k) == v for k, v in kw.items())]

    def test_compiles_every_unit(self):
        self.assertEqual(self.idx["stats"]["failed"], 0)
        self.assertEqual(self.idx["stats"]["units"], 2)

    def test_macro_call_is_seen(self):
        # LOG_CALL(v) expands to log_event(v); text search would not find it
        hit = [e for e in self.edges(kind="call") if names(self.idx, e["dst"]) == "log_event"]
        self.assertEqual([(e["file"], e["line"]) for e in hit], [("src/lib/lib.c", 13)])

    def test_only_compiled_ifdef_branch(self):
        pick = [n for n in self.idx["nodes"].values() if n["name"] == "pick" and n["defined"]]
        self.assertEqual([(p["file"], p["line"]) for p in pick], [("src/lib/lib.c", 37)])

    def test_definition_line_not_prototype(self):
        n = self.idx["nodes"]["install"]
        self.assertEqual((n["file"], n["line"]), ("src/lib/lib.c", 17))

    def test_compiler_inserted_calls_dropped(self):
        self.assertFalse([e for e in self.idx["edges"] if e["dst"] == "__stack_chk_fail"])

    def test_fnptr_and_indirect(self):
        fp = self.edges(rule="fnptr_assign")
        self.assertEqual([(names(self.idx, e["src"]), names(self.idx, e["dst"]), e["line"]) for e in fp],
                         [("install", "traced_send", 19)])
        ind = self.edges(rule="indirect")
        self.assertEqual([(names(self.idx, e["src"]), names(self.idx, e["dst"])) for e in ind], [("use", "traced_send")])

    def test_ctor(self):
        ct = self.edges(rule="ctor")
        self.assertEqual([(names(self.idx, e["dst"]), e["line"]) for e in ct], [("attach", 27)])

    def test_env_and_exec(self):
        env = self.edges(rule="env")
        self.assertEqual([(names(self.idx, e["src"]), names(self.idx, e["dst"]), e["name"]) for e in env],
                         [("main", "attach", "FIXTURE_QUEUE")])
        self.assertEqual([e["call"] for e in self.edges(rule="exec")], ["execvp"])

    def test_build_define(self):
        bd = self.edges(rule="build_define")
        self.assertEqual({(e["file"], e["line"], e["value"]) for e in bd}, {("Makefile", 2, "4u")})

    def test_cross_lang(self):
        cl = self.edges(rule="cross_lang")
        self.assertIn(("tools/read.py", 1, "QUEUE_SLOTS"), {(e["file"], e["line"], e["name"]) for e in cl})
        self.assertIn("SLOTS:3", {e.get("near") for e in cl})

    def test_cache(self):
        again = layer1.build(self.root)
        self.assertEqual(again["stats"]["cached"], 2)
        (self.root / "include" / "api.h").write_text((self.root / "include" / "api.h").read_text() + "\n")
        third = layer1.build(self.root)
        self.assertEqual(third["stats"]["compiled"], 2)    # a header change rebuilds its users

    def test_generated_codemap_passes_check(self):
        text = arch.render(self.idx)
        md = self.root / "CODEMAP.md"
        md.write_text(text)
        r = check.check(self.root, md, self.idx)
        self.assertEqual(r["problems"], [])
        self.assertGreater(r["refs"], 0)

    def test_check_catches_wrong_claims(self):
        md = self.root / "bad.md"
        md.write_text("- `use -> install` at `src/lib/lib.c:24`\n"
                      "- `install` stores `traced_send` at `src/lib/lib.c:5`\n"
                      "- `src/lib/lib.c:500`\n")
        r = check.check(self.root, md, self.idx)
        self.assertEqual(len(r["problems"]), 4, r["problems"])


if __name__ == "__main__":
    unittest.main()
