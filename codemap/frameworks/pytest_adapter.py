"""pytest: tests and fixtures are entry points; a parameter named like a fixture is injection."""

import re
from pathlib import PurePosixPath

FIXTURE = re.compile(r"^@(?:pytest\.)?fixture\b(.*)$", re.S)
USES = re.compile(r"^@pytest\.mark\.usefixtures\((.*)\)$", re.S)
# fixtures pytest itself provides: injected, but defined outside the repository
BUILTIN = set("""request tmp_path tmp_path_factory tmpdir tmpdir_factory monkeypatch capsys capsysbinary capfd capfdbinary
caplog recwarn pytestconfig cache doctest_namespace record_property record_testsuite_property record_xml_attribute
testdir pytester""".split())


def test_file(f):
    name = PurePosixPath(f).name
    return name.startswith("test_") and name.endswith(".py") or name.endswith("_test.py")


class Pytest:
    name = "pytest"

    def detect(self, c):
        self.files = [f for f in c.files if f.endswith(".py") and (test_file(f) or PurePosixPath(f).name == "conftest.py"
                                                                   or c.imports(f, r"pytest"))]
        return bool(self.files)

    def apply(self, c):
        fixtures = {}                     # (file, fixture name) -> node id
        for f in self.files:
            for nid in c.files[f]:
                n = c.nodes[nid]
                for d in n.get("decorators", []):
                    m = FIXTURE.match(d)
                    if m:
                        named = re.search(r"\bname\s*=\s*['\"](\w+)['\"]", m.group(1))
                        scope = re.search(r"\bscope\s*=\s*['\"](\w+)['\"]", m.group(1))
                        fname = named.group(1) if named else n["name"].rsplit(".", 1)[-1]
                        fixtures[(f, fname)] = nid
                        c.entry(nid, "pytest", "fixture", fname + (f" (scope {scope.group(1)})" if scope else ""))
        for f in self.files:
            if not test_file(f):
                continue
            for nid in c.files[f]:
                n = c.nodes[nid]
                short = n["name"].rsplit(".", 1)[-1]
                cls = c.nodes.get(n.get("class") or "", {})
                if short.startswith("test") and n.get("kind") in ("function", "method") and \
                        (not cls or cls["name"].rsplit(".", 1)[-1].startswith("Test")):
                    c.entry(nid, "pytest", "test", "")

        def visible(f, name):
            """A fixture by name as pytest finds it: the test's own file, then conftest.py upward."""
            if (f, name) in fixtures:
                return fixtures[(f, name)]
            d = PurePosixPath(f).parent
            while True:
                conf = (d / "conftest.py").as_posix().lstrip("./") if str(d) != "." else "conftest.py"
                if (conf, name) in fixtures:
                    return fixtures[(conf, name)]
                if str(d) in (".", ""):
                    return None
                d = d.parent

        for f in self.files:
            for nid in c.files[f]:
                n = c.nodes[nid]
                if n.get("entry", {}).get("framework") != "pytest":
                    continue
                wanted = [p for p in n.get("params", []) if p not in ("self", "cls")]
                for d in n.get("decorators", []):
                    m = USES.match(d)
                    if m:
                        wanted += re.findall(r"['\"](\w+)['\"]", m.group(1))
                for p in wanted:
                    dst = visible(f, p)
                    if dst is None and p in BUILTIN:
                        dst = c.outside(f"pytest fixture {p}")
                    if dst and dst != nid:
                        c.edge(nid, dst, "inject", "pytest.fixture", f, n["line"])
