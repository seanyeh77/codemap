"""`codemap serve`: the viewer and a read-only JSON API over the index.

The API answers from .codemap/index.json and the files in the repository, so
the viewer always shows the current working tree. Rebuilding the index and
expanding macros are advertised as capabilities the viewer can ask for; this
version reports them as not available yet."""

import base64
import json
import socket
import threading
from pathlib import Path
from urllib.parse import quote

from . import rules, view
from .source import forget_files

ASSETS = Path(__file__).parent / "viewer_dist"
CAPABILITIES = dict(rebuild=False, macro=False, grep=True)


def viewer_html():
    p = ASSETS / "index.html"
    if not p.exists():
        raise FileNotFoundError(f"{p} is missing: build the viewer with `npm run build` in viewer/")
    return p.read_text(encoding="utf-8")


def create_app(root, notes=None, allowed_hosts=None):
    """allowed_hosts guards against DNS rebinding: a web page that resolves its
    own name to 127.0.0.1 cannot read the repository through this server."""
    try:
        from fastapi import FastAPI, HTTPException, Query
        from fastapi.middleware.trustedhost import TrustedHostMiddleware
        from fastapi.responses import HTMLResponse, Response
    except ImportError as e:      # pragma: no cover
        raise SystemExit("codemap serve needs the viewer extra: uv tool install 'codemap[viewer] @ git+https://github.com/seanyeh77/codemap'") from e

    root = Path(root).resolve()
    index_path = root / ".codemap" / "index.json"
    state = {"cache": None}
    lock = threading.Lock()

    def index():
        """The index and the viewer graph, rebuilt when index.json changes."""
        if not index_path.exists():
            raise HTTPException(404, f"找不到 {index_path}，請先執行 codemap index。")
        with lock:
            mtime = index_path.stat().st_mtime
            c = state["cache"]
            if c is None or c["mtime"] != mtime:
                forget_files()
                idx = json.loads(index_path.read_text(encoding="utf-8"))
                g = view.build(root, idx, rules.load_config(root))
                files = set(g.get("readable", ())) | {f["file"] for f in g["funcs"].values()}   # source, headers, build files
                for n in notes or ():                                       # the notes being checked, to read whole
                    rel = Path(n).resolve()
                    if root.resolve() in rel.parents:
                        files.add(str(rel.relative_to(root.resolve())))
                c = state["cache"] = dict(mtime=mtime, index=idx, graph=g, files=files)
            return c

    app = FastAPI(title="codemap", version="0.2.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts or ["localhost", "127.0.0.1", "[::1]"])

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    def home():
        return viewer_html()

    if (ASSETS / "assets").is_dir():               # the Chinese font, in pieces the page asks for by need
        from fastapi.staticfiles import StaticFiles
        app.mount("/assets", StaticFiles(directory=ASSETS / "assets"), name="assets")

    @app.get("/api/meta")
    def meta():
        """Repository, commit, uncommitted files and what this server can do."""
        c = index()
        return dict(root=str(root), capabilities=CAPABILITIES, indexed=int(c["mtime"]), **view.repo_info(root))

    @app.get("/api/graph")
    def graph():
        """Components, functions and every call or rule edge between them."""
        return index()["graph"]

    @app.get("/api/source")
    def source(file: str, start: int = Query(1, ge=1), end: int | None = Query(None, ge=1)):
        """Lines of a source file the index knows (1-based, inclusive)."""
        r = view.source(root, file, start, end) if file in index()["files"] else None
        if r is None:
            raise HTTPException(404, f"{file} 不在 {root.name} 的索引裡，請重新執行 codemap index。")
        return r

    @app.get("/api/grep")
    def grep(q: str = Query(..., min_length=2, max_length=200), limit: int = Query(40, ge=1, le=200)):
        """Lines of the readable files and the notes that contain q (case ignored)."""
        return view.grep(root, index()["files"], q, limit)

    @app.get("/api/checks")
    def checks():
        """Validate the notes again: file:line references and call claims."""
        idx = index()["index"]
        forget_files()
        return view.checks(root, idx, notes)

    @app.get("/api/snapshot", response_class=Response)
    def snapshot():
        """Download the current index as a .codemap snapshot."""
        c = index()
        forget_files()                                  # the notes may have changed since indexing
        data = view.snapshot(root, c["index"], notes=notes, graph=c["graph"])
        return Response(view.pack(data), media_type="application/gzip",
                        headers={"Content-Disposition": attachment(view.snapshot_name(data))})

    return app


def attachment(name):
    """A Content-Disposition value that survives non-ASCII names and quotes."""
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def serve(root, host="127.0.0.1", port=7300, notes=None):
    import uvicorn
    # bound to every interface on purpose: the person chose to expose it
    wildcard = host in ("0.0.0.0", "::")
    bracketed = f"[{host}]" if ":" in host else host     # an IPv6 address in a Host header or URL
    hosts = ["*"] if wildcard else ["localhost", "127.0.0.1", "[::1]", socket.gethostname(), bracketed]
    app = create_app(root, notes, hosts)
    shown = socket.gethostname() if wildcard else bracketed
    print(f"codemap viewer for {Path(root).resolve().name}: http://{shown}:{port}/")
    if host in ("127.0.0.1", "localhost"):
        print(f"from your laptop: ssh -L {port}:localhost:{port} {socket.gethostname()}  "
              "(VS Code Remote-SSH forwards the port by itself)")
    uvicorn.run(app, host=host, port=port, log_level="warning")


def standalone_html(data):
    """The viewer with a snapshot inside, as one file that opens from disk."""
    tag = f'<script id="codemap-snapshot" type="application/gzip;base64">{base64.b64encode(view.pack(data)).decode()}</script>'
    html = viewer_html()
    return html.replace("</body>", tag + "</body>", 1) if "</body>" in html else html + tag
