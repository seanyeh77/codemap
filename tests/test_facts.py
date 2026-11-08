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
