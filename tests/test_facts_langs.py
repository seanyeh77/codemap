"""Overview facts for languages other than C: files written, calls that end the program."""

import tempfile
import unittest
from pathlib import Path

from codemap import facts

SRC = '''import os, shutil, sys
from pathlib import Path


def save(path, data):
    pending = path.with_suffix(".new")
    with pending.open("w") as f:
        f.write(data)
    os.replace(str(pending), str(path))


def read(path):
    with open(path) as f:
        return f.read()


def log(name):
    open(f"logs/{name}.txt", "a").close()
    Path("out.json").write_text("{}")
    os.environ.setdefault("MODE", "fast")
    sys.exit(1)
'''


class Writes(unittest.TestCase):
    def test_python(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "app.py").write_text(SRC)
            funcs = {"app.py:save": dict(name="save", file="app.py", line=5, end=9),
                     "app.py:read": dict(name="read", file="app.py", line=12, end=14),
                     "app.py:log": dict(name="log", file="app.py", line=17, end=21)}
            got = {(w["fid"].split(":")[1], w["l"], w["call"], w.get("name") or w.get("format") or w.get("param") or w.get("expr"))
                   for w in facts.writes(d, funcs)}
            self.assertEqual(got, {("save", 7, "open", "pending"),             # Path.open("w")
                                   ("save", 9, "os.replace", "path"),          # str(path) is the parameter
                                   ("log", 18, "open", "logs/{name}.txt"),     # an f-string: its format
                                   ("log", 19, "write_text", "out.json")})     # read mode is not a write
            unset = facts.py_env_if_unset(d, funcs)
            self.assertEqual([(u["name"], u["l"], u["how"]) for u in unset], [("MODE", 20, "setdefault")])

    def test_stops_and_covers(self):
        edges = [dict(s="app.py:log", d="ext:sys.exit", f="app.py", l=21, k="call", src="static", dn="sys.exit"),
                 dict(s="app.py:log", d="ext:sys.getsizeof", f="app.py", l=22, k="call", src="static", dn="sys.getsizeof")]
        self.assertEqual([s["name"] for s in facts.stops(edges)], ["sys.exit"])
        self.assertEqual(facts.COVERS["arrays"], ("c",))          # a C-only check: the viewer leaves it out for Python


CMD_SRC = '''import subprocess


def _run(namespace, argv, timeout=5):
    return subprocess.run(["ip", "netns", "exec", namespace, *argv], timeout=timeout, check=False)


def sync(asn):
    ns = f"l3-r{asn}"
    _run(ns, ["ip", "-j", "route"])


def guard():
    try:
        sync(1)
    except Exception as e:
        print(e)
'''


class Commands(unittest.TestCase):
    def test_reads_commands_broad(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "app.py").write_text(SRC)
            Path(d, "cmd.py").write_text(CMD_SRC)
            funcs = {"app.py:save": dict(name="save", file="app.py", line=5, end=9),
                     "app.py:read": dict(name="read", file="app.py", line=12, end=14),
                     "app.py:log": dict(name="log", file="app.py", line=17, end=21),
                     "cmd.py:_run": dict(name="_run", file="cmd.py", line=4, end=5),
                     "cmd.py:sync": dict(name="sync", file="cmd.py", line=8, end=10),
                     "cmd.py:guard": dict(name="guard", file="cmd.py", line=13, end=17)}
            # open(path) with no mode reads; open(..., "a") and Path.open("w") do not
            self.assertEqual([(r["fid"], r["l"], r.get("param")) for r in facts.py_reads(d, funcs)], [("app.py:read", 13, "path")])
            edges = [dict(s="cmd.py:_run", d="ext:subprocess.run", f="cmd.py", l=5, k="exec"),
                     dict(s="cmd.py:sync", d="cmd.py:_run", f="cmd.py", l=10, k="call")]
            cmds = facts.py_commands(d, funcs, edges)
            self.assertEqual(len(cmds), 1)
            self.assertEqual(cmds[0]["timeout"], "timeout")
            self.assertEqual([v["cmd"] for v in cmds[0]["via"]], ["ip netns exec l3-r{asn} ip -j route"])
            broad = facts.broad_excepts(d, funcs)
            self.assertEqual([(b["fid"], b["l"], b["what"]) for b in broad], [("cmd.py:guard", 16, "Exception")])
