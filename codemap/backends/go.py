"""The Go backend: go/types, through a small helper program built from codemap/backends/gohelper.

Go's own type checker resolves every name, so this backend does not infer what Go already knows:
package-level functions, methods of concrete types (promoted ones through embedding included),
method values and expressions are exact. What it adds is what a call through an interface or a
function value can reach:

  interface   the repository's types that implement the interface, checked by go/types
              (types.Implements), never by method name; one is inferred, several are ambiguous;
              an interface from outside the repository (error, io.Writer) may have outside
              implementations too, so its targets are marked partial
  assign      the concrete values a variable or field was given (s := &Server{}, Server{db: mem})
  return      a constructor function's concrete return values (func New() Store { return &mem{} })
  funcvalue   handler := process; handler(); a struct field holding a function
  closure     a func literal, called later or right away; it is a node of its own (serve.func1)

Calls under go and defer keep kind "call" and say so in "mode". A function used as a value without
being called (m.HandleFunc("/x", s.page)) is an edge of kind "ref".

The helper uses the standard library only and is built offline once into ~/.cache/codemap. Packages
are found by go.mod and directories, not by `go list`, so a repository whose toolchain or
dependencies cannot be downloaded is still read; calls into packages that cannot be read are named
by import path. Without a Go toolchain, or when the helper fails, the tree-sitter backend reads the
Go files instead.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HELPER = Path(__file__).parent / "gohelper"


def _env():
    env = dict(os.environ)
    # never download: not a toolchain the module asks for, not a dependency
    env.update(GOTOOLCHAIN="local", GOPROXY="off", GOWORK="off", GOFLAGS="", GO111MODULE="on")
    return env


def helper():
    """The helper's path, built if needed; None without a Go toolchain or when it does not build."""
    go = shutil.which("go")
    if not go:
        return None, "no go command"
    src = b"".join((HELPER / f).read_bytes() for f in ("main.go", "go.mod"))
    tag = hashlib.sha256(src).hexdigest()[:16]
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "codemap" / f"gohelper-{tag}"
    exe = cache / "codemap-gohelper"
    if exe.exists():
        return exe, None
    cache.mkdir(parents=True, exist_ok=True)
    work = cache / "src"                       # the package directory may be read-only
    work.mkdir(exist_ok=True)
    for f in ("main.go", "go.mod"):
        shutil.copy(HELPER / f, work / f)
    p = subprocess.run([go, "build", "-o", str(exe), "."], cwd=work, env=_env(), capture_output=True, text=True, timeout=300)
    if p.returncode != 0 or not exe.exists():
        return None, "the Go helper did not build: " + (p.stderr.strip().splitlines() or ["?"])[-1]
    return exe, None


def build(root, files, tests=None):
    """The partial index for the Go files, or None (with the reason on stderr) to fall back."""
    exe, why = helper()
    if exe is None:
        sys.stderr.write(f"codemap: Go files read by tree-sitter ({why})\n")
        return None
    try:
        p = subprocess.run([str(exe)], input=json.dumps(dict(root=str(Path(root).resolve()), files=files, tests=tests)),
                           env=_env(), capture_output=True, text=True, timeout=1800)
        if p.returncode != 0:
            raise RuntimeError((p.stderr.strip().splitlines() or ["?"])[-1])
        part = json.loads(p.stdout)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as e:
        sys.stderr.write(f"codemap: Go files read by tree-sitter (the Go helper failed: {e})\n")
        return None
    # the helper writes empty fields out as missing; the rest of codemap expects them absent or set
    for e in part["edges"]:
        if not e.get("mode"):
            e.pop("mode", None)
        if e.get("infer") and not e["infer"].get("type"):
            e["infer"]["type"] = None
    for n in part["nodes"].values():
        if not n.get("class"):
            n.pop("class", None)
        n.setdefault("line", None)
    return part
