"""Run with: python3 -m unittest discover -s tests"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from codemap import facts, source  # noqa: E402

C = r'''#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#define MAX_A 8u
#define MAX_B (MAX_A * 4)
static int table[MAX_B];
static char name[16];
static const int init[] = {1, 2};
static int counter;
static __thread int depth;
static volatile sig_atomic_t stop;

void log_to(const char *path)
{
    FILE *f = fopen(path, "w");      /* a parameter */
    FILE *g = fopen("/tmp/x.log", "a");
    FILE *r = fopen("/etc/hosts", "r");
    char buf[64];
    snprintf(buf, sizeof(buf), "%s.out", path);
    int fd = open(buf, O_WRONLY | O_CREAT, 0644);
    (void)f; (void)g; (void)r; (void)fd;
}

int env(void)
{
    const char *a = getenv("A");
    const char *b = getenv("B");
    if (b == NULL)
        return 0;
    int n = atoi(getenv("C"));
    if (getenv("D"))
        n++;
    return atoi(a) + n + atoi(b);
}

int spawn(void)
{
    if (getenv("LD_PRELOAD") == NULL) {
        setenv("LD_PRELOAD", "x.so", 1);
    }
    setenv("KEEP", "1", 0);
    setenv("ALWAYS", "1", 1);
    if (n_bad())
        return -EINVAL;
    errno = EAGAIN;
    return ENOSYS;
}
'''

MAKE = """all: build/app
build/app: a.c
\tcc -o build/app a.c -lm
install: all
\tinstall -m 755 build/app /usr/local/bin/
\tln -sf /usr/local/bin/app /usr/local/bin/app2
.PHONY: all install
"""


class Facts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp())
        (cls.root / "a.c").write_text(C)
        (cls.root / "Makefile").write_text(MAKE)
        src = C.splitlines()
        line = lambda s: next(i for i, t in enumerate(src, 1) if s in t)
        cls.funcs = {
            "log_to": dict(name="log_to", file="a.c", line=line("void log_to"), end=line("(void)f") + 1),
            "env": dict(name="env", file="a.c", line=line("int env"), end=line("int spawn") - 1),
            "spawn": dict(name="spawn", file="a.c", line=line("int spawn"), end=len(src)),
        }
        source.forget_files()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root)

    def test_writes(self):
        w = facts.writes(self.root, self.funcs)
        self.assertEqual([x["call"] for x in w], ["fopen", "fopen", "open"])        # the "r" open is not a write
        self.assertEqual(w[0]["param"], "path")
        self.assertEqual(w[1]["name"], "/tmp/x.log")
        self.assertEqual(w[2]["format"], "%s.out")

    def test_arrays(self):
        a = {x["name"]: x for x in facts.arrays(self.root, ["a.c"], [
            dict(name="MAX_A", kind="macro", text="MAX_A 8u"), dict(name="MAX_B", kind="macro", text="MAX_B (MAX_A * 4)")])}
        self.assertEqual(a["table"]["value"], "32")
        self.assertNotIn("value", a["name"])          # a plain number needs no working out
        self.assertNotIn("init", a)                   # size from the initializer

    def test_unchecked_env(self):
        found = {x["name"] for x in facts.unchecked_env(self.root, self.funcs)}
        self.assertEqual(found, {"A", "C"})

    def test_plain_writes(self):
        src = (self.root / "a.c").read_text()
        (self.root / "b.c").write_text("static int counter;\nstatic __thread int depth;\nstatic volatile sig_atomic_t stop;\n"
                                       "void f(void)\n{\n    counter++;\n    depth++;\n    stop = 1;\n"
                                       "    __atomic_add_fetch(&counter, 1, __ATOMIC_RELAXED);\n}\n")
        funcs = {"f": dict(name="f", file="b.c", line=4, end=10)}
        w = facts.plain_writes(self.root, funcs, ["b.c"])
        self.assertEqual([(x["name"], [y["l"] for y in x["writes"]]) for x in w], [("counter", [6])])
        self.assertTrue(src)

    def test_env_meaning(self):
        (self.root / "e.h").write_text('#define SHM_DEFAULT "/x"\n')
        (self.root / "e.c").write_text(
            "static int flag_on(const char *n)\n{\n    const char *v = getenv(n);\n    return v == NULL || atoi(v) != 0;\n}\n"
            "void init(void)\n{\n    const char *shm = getenv(\"SHM\");\n    g_rec = flag_on(\"REC\");\n"
            "    open_ring(shm != NULL ? shm : SHM_DEFAULT);\n}\n")
        funcs = {"flag_on": dict(name="flag_on", file="e.c", line=1, end=5), "init": dict(name="init", file="e.c", line=6, end=11)}
        env = {"SHM": {"get": ["e.c:8"]}, "REC": {"get": ["e.c:9"]}}
        m = facts.env_meaning(self.root, funcs, env, {"env": {"REC": {"purpose": "records or not"}}})
        self.assertEqual((m["REC"]["kind"], m["REC"]["default"], m["REC"]["into"], m["REC"]["purpose"]), ("flag", "on", "g_rec", "records or not"))
        self.assertEqual((m["SHM"]["kind"], m["SHM"]["default"]), ("text", 'SHM_DEFAULT ("/x")'))

    def test_silent_limits(self):
        (self.root / "l.c").write_text(
            "void add(int x)\n{\n    if (g_n >= IBT_MAX_CTX)\n        return;\n    g_a[g_n++] = x;\n}\n"
            "void put(int x)\n{\n    if (n >= OTHER_MAX) {\n        fprintf(stderr, \"full\");\n        return;\n    }\n}\n"
            "void parse(int a)\n{\n    if (a >= CPU_SETSIZE)\n        return;\n}\n")
        funcs = {"add": dict(name="add", file="l.c", line=1, end=6), "put": dict(name="put", file="l.c", line=7, end=13),
                 "parse": dict(name="parse", file="l.c", line=14, end=18)}
        got = facts.silent_limits(self.root, funcs)
        self.assertEqual([(x["fid"], x["l"], x["limit"]) for x in got["silent"]], [("add", 3, "IBT_MAX_CTX")])
        self.assertEqual([x["fid"] for x in got["said"]], ["put"])

    def test_uncompiled_calls(self):
        (self.root / "u.c").write_text(
            "#ifndef U_H\n#define U_H\n#endif\nint ready(void) { return 1; }\n"
            "void run(void)\n{\n#ifdef OLD_PATH\n    ready();\n#endif\n    ready();\n}\n")
        funcs = {"ready": dict(name="ready", file="u.c", line=4, end=4), "run": dict(name="run", file="u.c", line=5, end=11)}
        edges = [dict(s="run", d="ready", f="u.c", l=10)]
        got = facts.uncompiled_calls(self.root, funcs, edges)
        self.assertEqual(got, {"ready": [dict(f="u.c", l=8, cond="#ifdef OLD_PATH", by="run")]})

    def test_env_comments(self):
        (self.root / "t.h").write_text("/* X_ALL=1: record every call one by one. Costs a lot. */\n")
        (self.root / "t.c").write_text("static int g_all; /* X_ALL=1 */\n// see also X_ALL in the docs\n")
        got = facts.env_comments(self.root, ["t.h", "t.c"], {"X_ALL"})["X_ALL"]
        self.assertEqual((got[0]["at"], got[0]["defines"], got[0]["text"]), ("t.h:1", True, "X_ALL=1: record every call one by one."))

    def test_arg_strings(self):
        src = ["import subprocess", "", "def tool_path(d):", "    return d + '/mon'", "",
               "def run(d):", "    cmd = [tool_path(d), '-q']", "    cmd += ['--', 'prog']", "    subprocess.Popen(cmd)",
               "", "def other(repo):", "    return subprocess.run(['git', '-C', repo])"]
        self.assertIn("'/mon'", facts.arg_strings(src, 9))
        self.assertNotIn("'/mon'", facts.arg_strings(src, 12))

    def test_env_if_unset(self):
        self.assertEqual(sorted(x["name"] for x in facts.env_if_unset(self.root, self.funcs)), ["KEEP", "LD_PRELOAD"])

    def test_error_codes(self):
        self.assertEqual([x["code"] for x in facts.error_codes(self.root, self.funcs)], ["-EINVAL", "EAGAIN", "ENOSYS"])

    @unittest.skipUnless(shutil.which("make"), "no make")
    def test_products(self):
        p = facts.products(self.root)
        self.assertEqual(p["goal"], "all")
        self.assertEqual([(b["path"], b["kind"], b["files"], b["libs"]) for b in p["built"]],
                         [("build/app", "exec", ["a.c"], ["m"])])
        self.assertEqual(p["install"][0], dict(what=["build/app"], to="/usr/local/bin/"))
        self.assertTrue(p["install"][1]["link"])


if __name__ == "__main__":
    unittest.main()
