"""Production or test code: which files are tests, in every language codemap reads.

The architecture and the type inference of production code leave test code out: a fake a test
puts into a field, or a subclass a test defines, must not make a production call look ambiguous.
Test code is still read and kept, with scope "test", for a test view of its own."""

import re
from pathlib import PurePosixPath

TEST_DIRS = {"test", "tests", "testing", "__tests__", "spec", "specs"}


def is_test(path):
    """A test file by the conventions of its language: x_test.go, test_x.py, x_test.py,
    conftest.py, x.test.ts, x.spec.js, src/test/... in Java, files under tests/."""
    p = PurePosixPath(path)
    name = p.name
    if name.endswith("_test.go"):
        return True
    if name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"):
        return True
    if re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", name):
        return True
    if name.endswith(".java") and "/src/test/" in "/" + p.as_posix():
        return True
    return any(part in TEST_DIRS for part in p.parts[:-1])


def mark(nodes):
    """scope "test" on the definitions in test files; production is the default and is left out."""
    for n in nodes.values():
        if n.get("defined") and n.get("file") and is_test(n["file"]):
            n["scope"] = "test"
