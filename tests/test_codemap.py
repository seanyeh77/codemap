"""Run with: python3 -m unittest discover -s tests"""

import gzip
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from codemap import arch, check, layer1, rules, view  # noqa: E402


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
        self.assertEqual([i["status"] for i in r["items"]], ["fail", "fail", "fail"])
        self.assertEqual([i["line"] for i in r["items"]], [1, 2, 3])
        self.assertIsNone(r["items"][2]["fix"])                        # past the end and nothing named: no guess
        fix = r["items"][1]["fix"]
        self.assertIsNotNone(fix)
        self.assertTrue(fix["before"].startswith("- `install` stores"))

    def test_check_messages(self):
        md = self.root / "msg.md"
        md.write_text("- `traced_send` and `install`; `nothing_here` at `src/lib/lib.c:5`\n- `src/lib/lib.c:3-1`\n")
        a, b = check.check(self.root, md, self.idx)["items"]
        self.assertNotRegex(a["why"], r"提及\s*$")
        self.assertEqual((b["status"], b["fix"]), ("fail", None))
        self.assertIn("顛倒", b["why"])

    def test_fix_finds_the_file_and_the_line(self):
        md = self.root / "fix.md"
        md.write_text("- `install` 在 `lib.c:1`\n")
        it = check.check(self.root, md, self.idx)["items"][0]
        self.assertEqual(it["status"], "fail")
        self.assertRegex(it["fix"]["after"], r"^- `install` 在 `src/lib/lib\.c:\d+`$")
        n = len((self.root / "src/lib/lib.c").read_text().splitlines())
        md.write_text("- `install` 在 `src/lib/lib.c:1-9999`\n")
        fix = check.check(self.root, md, self.idx)["items"][0]["fix"]
        self.assertIsNotNone(fix)                                      # only the end is wrong: still fixed
        self.assertRegex(fix["after"], rf"`src/lib/lib\.c:\d+-{n}`")
        md.write_text("- see `src/lib/lib.c:2-9999`\n")                     # no names: the start stays, the end is cut
        fix = check.check(self.root, md, self.idx)["items"][0]["fix"]
        self.assertEqual(fix["after"], f"- see `src/lib/lib.c:2-{n}`")

    def test_check_short_path_and_shared_callee(self):
        md = self.root / "soft.md"
        md.write_text("- `install` at `lib.c:17`\n- `peek_a -> peek_b`\n")
        a, b = check.check(self.root, md, self.idx)["items"]
        self.assertEqual(a["status"], "done")                          # right, only the path is short
        self.assertEqual(a["fix"]["after"], "- `install` at `src/lib/lib.c:17`")
        self.assertEqual(b["status"], "review")                        # no call, but both call last_send
        self.assertIn("last_send", b["why"])

    def test_shared_state_and_entry_points(self):
        g = view.build(self.root, self.idx, {})
        st = {s["name"]: s for s in g["state"]}
        users = {g["funcs"][u]["name"] for u, _ in st["saved_send_value"]["users"]}
        self.assertEqual(users, {"log_event", "last_send"})
        self.assertTrue(st["saved_send_value"]["static"])

    def test_definition_line_skips_comments(self):
        n = [n for n in self.idx["nodes"].values() if n["name"] == "fixture_debug" and n.get("defined")][0]
        self.assertTrue((self.root / n["file"]).read_text().splitlines()[n["line"] - 1].startswith("int fixture_debug"))

    def test_env_read_through_a_wrapper(self):
        self.assertIn("FIXTURE_DEBUG", self.idx["env"])
        self.assertTrue(self.idx["env"]["FIXTURE_DEBUG"]["get"][0].startswith("src/lib/lib.c:"))

    def test_function_passed_as_argument(self):
        e = [e for e in self.edges(rule="fnptr_pass") if names(self.idx, e["dst"]) == "cmp"]
        self.assertEqual([(names(self.idx, x["src"]), x["slot"]) for x in e], [("sort_it", "qsort")])

    def test_docs_in_the_graph(self):
        g = view.build(self.root, self.idx, {})
        app = [c for c in g["comps"] if c["id"] == "src/app"][0]
        self.assertTrue(app["doc"]["text"].startswith("app - starts"))
        attach = [f for f in g["funcs"].values() if f["name"] == "attach"][0]
        self.assertLess(attach["top"], attach["line"])          # the constructor attribute above it

    def test_check_items_for_the_viewer(self):
        md = self.root / "ok.md"
        md.write_text("| a | b |\n| --- | --- |\n| `use` | `src/lib/lib.c:24` |\n")
        items = check.check(self.root, md, self.idx)["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["text"], "`use` · `src/lib/lib.c:24`")
        self.assertEqual(items[0]["at"], "ok.md:3")

    def test_viewer_graph(self):
        g = view.build(self.root, self.idx, {})
        self.assertEqual(g["format"], view.FORMAT)
        ids = {c["id"] for c in g["comps"]}
        self.assertTrue({"src/lib", "src/app"} <= ids, ids)
        for e in g["edges"]:
            self.assertTrue(e["s"] in g["funcs"] or e["d"] in g["funcs"], e)
        for f in g["funcs"].values():
            self.assertGreaterEqual(f["end"], f["line"])
            self.assertNotIn("src", f)

    def test_dirty_files_survive_renames(self):
        with tempfile.TemporaryDirectory() as d:
            run = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True)
            run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
            for n in ("a.txt", "b.txt"):
                Path(d, n).write_text(n)
            run("add", "."); run("commit", "-qm", "x")
            Path(d, "a.txt").write_text("changed")
            Path(d, "b.txt").rename(Path(d, "c.txt")); run("add", "-N", "c.txt")
            self.assertEqual(sorted(view.repo_info(d)["dirty"]), ["a.txt", "c.txt"])

    def test_two_variables_on_one_line_stay_two_edges(self):
        idx = json.loads(json.dumps(self.idx))
        e = next(x for x in idx["edges"] if x.get("rule") == "env")
        idx["edges"].append(dict(e, name=e["name"] + "_2"))
        g = view.build(self.root, idx, {})
        self.assertEqual(sorted(x["name"] for x in g["edges"] if x.get("rule") == "env" and x["f"] == e["file"] and x["l"] == e["line"]),
                         sorted([e["name"], e["name"] + "_2"]))

    def test_static_inline_copies_become_one_function(self):
        idx = json.loads(json.dumps(self.idx))
        nid, n = next((k, v) for k, v in idx["nodes"].items() if v.get("defined") and v["name"] == "install")
        idx["nodes"]["other-unit:install"] = dict(n)                  # the same header function, from another unit
        idx["edges"] += [dict(e, src="other-unit:install") for e in idx["edges"] if e["src"] == nid]
        g = view.build(self.root, idx, {})
        self.assertEqual([k for k, f in g["funcs"].items() if f["name"] == "install"], [min(nid, "other-unit:install")])
        sigs = [(e["s"], e["d"], e["f"], e["l"], e["k"]) for e in g["edges"]]
        self.assertEqual(len(sigs), len(set(sigs)))
        self.assertEqual(g["links"], view.build(self.root, self.idx, {})["links"])   # calls counted once

    def test_snapshot_round_trip(self):
        data = view.snapshot(self.root, self.idx, {})
        out = self.tmp / "s.codemap"
        view.write_snapshot(out, data)
        back = json.loads(gzip.decompress(out.read_bytes()))
        self.assertEqual(back["funcs"].keys(), data["funcs"].keys())
        f = next(iter(back["funcs"].values()))
        self.assertTrue(f["src"])

    def test_source_stays_inside_the_repo(self):
        self.assertIsNone(view.source(self.root, "../../etc/passwd"))
        self.assertEqual(view.source(self.root, "src/lib/lib.c", 1, 2)["start"], 1)


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
        except ImportError:
            raise unittest.SkipTest("the viewer extra is not installed")
        Fixture.setUpClass.__func__(cls)
        (cls.root / ".codemap").mkdir(exist_ok=True)
        (cls.root / ".codemap" / "index.json").write_text(json.dumps(cls.idx))
        from codemap import server
        cls.client = TestClient(server.create_app(cls.root, allowed_hosts=["testserver"]))
        cls.other = TestClient(server.create_app(cls.root), base_url="http://evil.example")

    def test_api(self):
        c = self.client
        meta = c.get("/api/meta").json()
        self.assertFalse(meta["capabilities"]["rebuild"])
        g = c.get("/api/graph").json()
        self.assertEqual(g["format"], view.FORMAT)
        self.assertEqual(c.get("/api/source", params={"file": "../x"}).status_code, 404)
        self.assertEqual(c.get("/api/source", params={"file": "compile_commands.json"}).status_code, 404)   # not a source file
        self.assertEqual(self.other.get("/api/meta").status_code, 400)                                     # DNS rebinding
        self.assertEqual(c.get("/api/source", params={"file": "src/lib/lib.c", "start": 1, "end": 3}).json()["start"], 1)
        r = c.get("/api/snapshot")
        self.assertIn(".codemap", r.headers["content-disposition"])
        self.assertEqual(r.content[:2], b"\x1f\x8b")
        self.assertIn("<div id=\"root\">", c.get("/").text)

    def test_source_follows_edits_on_disk(self):
        f = self.root / "src" / "lib" / "lib.c"
        before = f.read_text()
        try:
            self.client.get("/api/source", params={"file": "src/lib/lib.c", "start": 1, "end": 1})
            f.write_text("/* edited */\n" + before)
            first = self.client.get("/api/source", params={"file": "src/lib/lib.c", "start": 1, "end": 1}).json()["lines"]
            self.assertEqual(first, ["/* edited */"])
        finally:
            f.write_text(before)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
