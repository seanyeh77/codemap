"""Test scope: the file conventions and the .codemap/rules.json override."""

import unittest

from codemap import scope


class Scope(unittest.TestCase):
    def test_conventions(self):
        for p in ("tests/a.py", "pkg/test_x.py", "x/y_test.go", "web/src/a.test.tsx", "src/__tests__/b.ts", "conftest.py"):
            self.assertEqual(scope.classify(p), "test", p)
        for p in ("pkg/x.py", "web/src/App.tsx", "cmd/main.go", "testing_utils.py"):
            self.assertEqual(scope.classify(p), "production", p)

    def test_override(self):
        cfg = {"source_scope": {"production": ["tests/tools", "tests/bench.py"], "test": ["examples/", "tests/tools/fake.py"]}}
        self.assertEqual(scope.classify("tests/tools/gen.py", cfg), "production")
        self.assertEqual(scope.classify("tests/bench.py", cfg), "production")
        self.assertEqual(scope.classify("tests/test_a.py", cfg), "test")
        self.assertEqual(scope.classify("examples/demo.py", cfg), "test")
        self.assertEqual(scope.classify("tests/tools/fake.py", cfg), "test")      # the longer match wins
        self.assertEqual(scope.classify("tests/toolsx.py", cfg), "test")          # a prefix is a path, not a string

    def test_mark_keeps_test_nodes(self):
        nodes = {"tests/tools/gen.py:f": {"defined": True, "file": "tests/tools/gen.py"},
                 "tests/test_a.py:t": {"defined": True, "file": "tests/test_a.py"}}
        scope.mark(nodes, {"source_scope": {"production": ["tests/tools"]}})
        self.assertNotIn("scope", nodes["tests/tools/gen.py:f"])
        self.assertEqual(nodes["tests/test_a.py:t"]["scope"], "test")
        self.assertEqual(len(nodes), 2)


if __name__ == "__main__":
    unittest.main()
