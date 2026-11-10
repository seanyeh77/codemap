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
