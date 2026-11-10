"""The TypeScript/JavaScript backend: the TypeScript compiler API, through a small Node helper.

The helper (codemap/backends/tshelper/main.js) builds one ts.Program per tsconfig/jsconfig (files no
config lists get default options with allowJs), so the TypeScript compiler resolves imports,
exports, aliases, namespaces, classes, inheritance and types; codemap adds what a call through an
interface, an override or a function value can reach:

  exact       the name or the receiver's static type decides the method (an import, a class's
              method nothing overrides, this/super, an outside library's method); an interface
              method nothing in the production code implements is exact too: the method called is
              certain, the code that runs is not
  inferred    one target, found through values: what a variable, field or prop was given (a
              closure, a function, a method handed on, new C()), the one class that implements an
              interface, a function that returns a function
  ambiguous   several targets: overrides, several implementations, a union, or values of which
              some are unknown (a parameter: callers may pass anything)

JSX elements are calls to their components. A function used as a value without being called
(onClick={save}, an inline callback) is an edge of kind "ref". .d.ts files and node_modules are
read for types only; what they declare is an "ext:" node. A module that cannot be found (no
node_modules) leaves its names known by the import only: placeholders.

TypeScript itself comes from the repository's node_modules when it is 5.x or 6.x (a project on
TypeScript 6 keeps its own compiler); otherwise from codemap's cache, which holds one exact version
(VERSION), installed there once with npm, so the same codemap reads the same code the same way
whenever and wherever it runs. The index records which version read the code and from where.
Without Node, or without a TypeScript to load, the tree-sitter backend reads these files instead.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HELPER = Path(__file__).parent / "tshelper" / "main.js"
EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
CONFIGS = ("tsconfig.json", "jsconfig.json")
VERSION = "5.9.3"        # the exact compiler codemap installs into its cache (the JavaScript-based API)


def _cache():
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "codemap" / "typescript" / VERSION


def _usable(pkg, exact=None):
    """The typescript package directory, if it is one codemap can load: major 5 or 6 (TypeScript 7 is
    the native compiler, without this API), or exactly the given version."""
    try:
        v = json.loads((pkg / "package.json").read_text())["version"]
    except (OSError, ValueError, KeyError):
        return None
    ok = v == exact if exact else v.split(".")[0] in ("5", "6")
    return pkg if ok and (pkg / "lib" / "typescript.js").exists() else None


def typescript(root, configs):
    """(path of the typescript package, where it came from) or (None, why)."""
    if os.environ.get("CODEMAP_TYPESCRIPT"):
        p = _usable(Path(os.environ["CODEMAP_TYPESCRIPT"]))
        if p:
            return p, "CODEMAP_TYPESCRIPT"
    root = Path(root)
    dirs = {root}
    for c in configs:
        d = (root / c).parent
        while d != root and root in d.parents:
            dirs.add(d)
            d = d.parent
    # the outermost one: a monorepo's own compiler is at its root, a package may pin another
    for d in sorted(dirs, key=lambda x: (len(x.parts), str(x))):
        p = _usable(d / "node_modules" / "typescript")
        if p:
            return p, "the repository's node_modules" + ("" if d == root else f" ({d.relative_to(root).as_posix()})")
    cache = _cache()
    p = _usable(cache / "node_modules" / "typescript", VERSION)
    if p:
        return p, "codemap's cache"
    npm = shutil.which("npm")
    if not npm:
        return None, "no TypeScript in the repository's node_modules and no npm to install one"
    failed = cache / "install-failed"
    if failed.exists() and time.time() - failed.stat().st_mtime < 86400:
        return None, "installing TypeScript failed in the last day: " + failed.read_text().strip()
    cache.mkdir(parents=True, exist_ok=True)
    sys.stderr.write(f"codemap: installing typescript@{VERSION} into {cache} (once)\n")
    try:
        r = subprocess.run([npm, "install", "--prefix", str(cache), f"typescript@{VERSION}", "--save-exact", "--no-audit",
                            "--no-fund", "--loglevel=error"], capture_output=True, text=True, timeout=300)
        why = (r.stderr.strip().splitlines() or ["?"])[-1] if r.returncode else None
    except (OSError, subprocess.TimeoutExpired) as e:
        why = str(e)
    p = _usable(cache / "node_modules" / "typescript", VERSION)
    if p:
        failed.unlink(missing_ok=True)
        return p, "codemap's cache"
    failed.write_text(why or "no typescript package after npm install")
    return None, "installing TypeScript failed: " + (why or "?")


def configs_of(root):
    from ..source import walk
    root = Path(root)
    return [p.relative_to(root).as_posix() for p in walk(root)
            if p.name in CONFIGS or (p.name.startswith("tsconfig.") and p.suffix == ".json")]


def packages_of(root):
    """The repository's own package.json files: a monorepo's workspace packages."""
    from ..source import walk
    root = Path(root)
    return [p.relative_to(root).as_posix() for p in walk(root) if p.name == "package.json"]


def build(root, files, tests=None):
    """The partial index for the TS/JS files, or None (with the reason on stderr) to fall back."""
    node = os.environ.get("CODEMAP_NODE") or shutil.which("node")
    if not node:
        sys.stderr.write("codemap: TypeScript/JavaScript files read by tree-sitter (no node command)\n")
        return None
    configs = configs_of(root)
    pkg, where = typescript(root, configs)
    if pkg is None:
        sys.stderr.write(f"codemap: TypeScript/JavaScript files read by tree-sitter ({where})\n")
        return None
    try:
        flags = ["--max-old-space-size=8192"] + (["--expose-gc"] if os.environ.get("CODEMAP_TS_PROFILE") else [])
        p = subprocess.run([node, *flags, str(HELPER)],
                           input=json.dumps(dict(root=str(Path(root).resolve()), files=files, tests=tests or [],
                                                 configs=configs, packages=packages_of(root), ts=str(pkg))),
                           capture_output=True, text=True, timeout=3600)
        if p.returncode != 0:
            raise RuntimeError((p.stderr.strip().splitlines() or ["?"])[-1])
        part = json.loads(p.stdout)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as e:
        sys.stderr.write(f"codemap: TypeScript/JavaScript files read by tree-sitter (the TypeScript helper failed: {e})\n")
        return None
    part["stats"]["typescript_from"] = where
    for n in part["nodes"].values():
        n.setdefault("line", None)
    return part
