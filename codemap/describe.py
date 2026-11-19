"""AI descriptions of functions (kind C): what each function does, in Traditional Chinese and English.

codemap never calls an AI itself. `codemap describe FILE` writes a prompt with each function's code and
neighbours; an AI answers with JSON; `codemap describe --apply ANSWER` checks the answer and keeps it in
.codemap/descriptions.json. Each kept description records a hash of the function's source, so a changed
function shows its description as stale, and the places and names it cites are checked against the code.

descriptions.json: {"version": 1, "funcs": {id: {"text": {"zh-TW": str, "en": str}, "evidence": ["file:line"],
"hash": str, "by": str, "at": iso date, "info": {...}}}}

info is what a reader needs beside the sentence, each line in both languages and, where it is about one line of
the code, that line: context (which thread runs it, what triggers it), shared (data outside it that it reads or
writes), params (each parameter's role: in, out, in-out, and what it is), returns (what each value means),
effects (what it changes besides its return value), contract (pre, post, error, ownership), and checks (a
language pitfall or the code doing something other than its comment says). What the code's own declaration says
(types, how each parameter is passed, static, async ...) is not asked for: signature.py reads it from the code.
"""
import datetime
import hashlib
import json
import re
from pathlib import Path

from . import docs, signature

FILE = ".codemap/descriptions.json"
LANGS = ("zh-TW", "en")
CODE = re.compile(r"`([^`\n]{1,80})`")
REF = re.compile(r"^(?P<f>[^\s:]+):(?P<l>\d+)$")


def path(root):
    return Path(root) / FILE


def load_all(root):
    """The whole file: {"funcs": {...}, "items": {...}}; items are files, components, commands and the rest."""
    try:
        data = json.loads(path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    return {"funcs": data.get("funcs", {}) or {}, "items": data.get("items", {}) or {}}


def load(root):
    return load_all(root)["funcs"]


def save(root, funcs=None, items=None):
    """Write the functions' or the items' descriptions, keeping the other half as it is."""
    data = load_all(root)
    if funcs is not None:
        data["funcs"] = funcs
    if items is not None:
        data["items"] = items
    p = path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 2, "funcs": dict(sorted(data["funcs"].items())),
                             "items": dict(sorted(data["items"].items()))}, ensure_ascii=False, indent=1) + "\n",
                 encoding="utf-8")


def source(root, node):
    """The function's lines as the file is now (not the cached copy: a changed function must read as changed)."""
    try:
        src = (Path(root) / node["file"]).read_text(errors="replace").splitlines()
    except OSError:
        src = []
    return src[node["line"] - 1: node.get("end") or node["line"]]


def digest(root, node):
    """A hash of the function's source, blank-insensitive at line ends: a changed function makes its description stale."""
    text = "\n".join(ln.rstrip() for ln in source(root, node))
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def neighbours(idx, nid):
    """(callers, callees): ids of the repository functions on either side of nid."""
    nodes = idx["nodes"]
    ins = sorted({e["src"] for e in idx["edges"] if e["dst"] == nid and e["src"] in nodes and e["src"] != nid})
    outs = sorted({e["dst"] for e in idx["edges"] if e["src"] == nid and e["dst"] in nodes and e["dst"] != nid})
    return ins, outs


def problems(root, idx, nid, entry):
    """What in a description does not match the code: a cited place outside the function and its neighbours, a
    `name` in code font that is neither in the function's source nor one of its neighbours, a language missing."""
    node = idx["nodes"].get(nid)
    if not node:
        return ["the function is no longer in the index"]
    out = []
    text = entry.get("text") or {}
    for lang in LANGS:
        if not str(text.get(lang, "")).strip():
            out.append(f"no {lang} text")
    ins, outs = neighbours(idx, nid)
    near = [idx["nodes"][x] for x in [nid, *ins, *outs] if idx["nodes"][x].get("file") and idx["nodes"][x].get("line")]
    for ref in entry.get("evidence") or []:
        m = REF.match(str(ref).strip())
        if not m:
            out.append(f"evidence {ref!r} is not file:line")
            continue
        f, line = m["f"], int(m["l"])
        if not any(n["file"] == f and n["line"] <= line <= (n.get("end") or n["line"]) for n in near):
            out.append(f"evidence {ref} is not in the function or a function it calls or is called by")
    body = "\n".join(source(root, node))
    names = {idx["nodes"][x]["name"] for x in [nid, *ins, *outs]}
    names |= {n.rsplit(".", 1)[-1] for n in names}

    def code_names(where, txt):
        for lang in LANGS:
            for word in CODE.findall(str(txt.get(lang, ""))):
                w = word.strip().rstrip("()")
                if w and w not in names and w not in body and not re.fullmatch(r"-?\d+|NULL|nullptr|nil|None|null|true|false|True|False", w):
                    out.append(f"{where}{lang}: `{word}` is not in the function's code nor a function next to it")
    code_names("", text)
    out += info_problems(root, node, entry.get("info"), code_names)
    return out


INFO_KINDS = ("context", "shared", "params", "returns", "effects", "contract", "checks")
ROLES = ("in", "out", "in-out")
CONTRACT = ("pre", "post", "error", "ownership")
CHECKS = ("trap", "desc")


def info_problems(root, node, info, code_names):
    """What in a description's info does not fit the function: an unknown part or kind, a line outside the
    function, a parameter it does not have, a language missing."""
    if not info:
        return []
    if not isinstance(info, dict):
        return ["info is not an object"]
    out = []
    lo, hi = node["line"], node.get("end") or node["line"]
    sig = signature.of(root, node["file"], node["line"], node.get("end"), node.get("lang"))
    have = {p["name"].lstrip("*.").rstrip("?") for p in (sig or {}).get("params", [])}
    for part, items in info.items():
        if part not in INFO_KINDS:
            out.append(f"info: unknown part {part!r} (one of {', '.join(INFO_KINDS)})")
            continue
        for i, it in enumerate(items if isinstance(items, list) else []):
            where = f"info.{part}[{i}] "
            if not isinstance(it, dict):
                out.append(where + "is not an object")
                continue
            for lang in LANGS:
                if not str(it.get(lang, "")).strip():
                    out.append(where + f"has no {lang} text")
            if it.get("line") is not None:
                try:
                    ln = int(it["line"])
                except (TypeError, ValueError):
                    ln = 0
                if not lo <= ln <= hi:
                    out.append(where + f"line {it['line']} is not in the function ({lo}-{hi})")
            if part == "params":
                if str(it.get("name", "")).lstrip("*.") not in have and sig is not None:
                    out.append(where + f"the function has no parameter {it.get('name')!r} (it has {', '.join(sorted(have)) or 'none'})")
                if it.get("role") not in ROLES:
                    out.append(where + f"role must be one of {', '.join(ROLES)}")
            if part == "contract" and it.get("kind") not in CONTRACT:
                out.append(where + f"kind must be one of {', '.join(CONTRACT)}")
            if part == "checks" and it.get("kind") not in CHECKS:
                out.append(where + f"kind must be one of {', '.join(CHECKS)}")
            code_names(where, it)
    return out


def clean_info(info):
    """The info as kept: only its known parts, each item's languages, line, and name, role or kind."""
    if not isinstance(info, dict):
        return None
    out = {}
    for part in INFO_KINDS:
        items = []
        for it in info.get(part) or []:
            if not isinstance(it, dict):
                continue
            x = {lang: str(it.get(lang, "")).strip() for lang in LANGS}
            if it.get("line") is not None:
                x["line"] = int(it["line"])
            for k in ("name", "role", "kind"):
                if it.get(k):
                    x[k] = str(it[k]).lstrip("*.") if k == "name" else str(it[k])
            items.append(x)
        if items:
            out[part] = items
    return out or None


def state(root, idx, nid, entry):
    """ok, stale (the function changed since), or wrong (it cites what the code does not have)."""
    node = idx["nodes"].get(nid)
    if not node or problems(root, idx, nid, entry):
        return "wrong"
    return "ok" if entry.get("hash") == digest(root, node) else "stale"


def funcs_in(idx, file):
    """The repository's own functions in a file (not call sites, outside functions or the file itself), in order."""
    from .arch import repo_func
    return sorted((nid for nid, n in idx["nodes"].items()
                   if n.get("file") == file and repo_func(n) and n.get("line") and n.get("kind") not in ("module", "file")),
                  key=lambda nid: idx["nodes"][nid]["line"])


def pending(root, idx, files, only_missing=False):
    """The ids to describe in these files, in file order; with only_missing, not those up to date."""
    have = load(root) if only_missing else {}
    out = []
    for file in files:
        for nid in funcs_in(idx, file):
            if not (nid in have and state(root, idx, nid, have[nid]) == "ok"):
                out.append(nid)
    return out


def project_files(idx, tests=False):
    """Every file with a function of the repository's own, test files only with tests."""
    from .arch import repo_func
    return sorted({n["file"] for n in idx["nodes"].values()
                   if repo_func(n) and n.get("line") and n.get("kind") not in ("module", "file")
                   and (tests or n.get("scope") != "test")})


def batches(idx, ids, size=30):
    """ids cut into prompts of about size functions; a file stays in one prompt unless it alone is bigger."""
    out, cur = [], []
    by_file = {}
    for nid in ids:
        by_file.setdefault(idx["nodes"][nid]["file"], []).append(nid)
    for group in by_file.values():
        while len(group) > size:                      # one big file: in pieces of size
            if cur:
                out.append(cur)
                cur = []
            out.append(group[:size])
            group = group[size:]
        if cur and len(cur) + len(group) > size:
            out.append(cur)
            cur = []
        cur += group
    if cur:
        out.append(cur)
    return out


def prompt(root, idx, files=None, only_missing=False, ids=None):
    """The prompt for an AI: each function with its code, its author's line and its neighbours, and the answer's
    exact form. Give files (with only_missing, functions up to date are left out) or the ids themselves."""
    ids = list(ids) if ids is not None else pending(root, idx, files or [], only_missing)
    parts, last = [], None
    for nid in ids:
        n = idx["nodes"][nid]
        if n["file"] != last:
            parts.append(f'## {n["file"]}\n')
            last = n["file"]
        ins, outs = neighbours(idx, nid)
        name = lambda x: (f'{idx["nodes"][x]["name"]} ({idx["nodes"][x]["file"]}:{idx["nodes"][x]["line"]})'
                          if idx["nodes"][x].get("line") else f'{idx["nodes"][x]["name"]} (outside the repository)')
        doc = docs.func_doc(root, n["file"], n["line"], n.get("lang", "c"))
        sig = signature.of(root, n["file"], n["line"], n.get("end"), n.get("lang"))
        ps = [p for p in (sig or {}).get("params", []) if p["name"] != "..."]
        parts.append(f'### id: {nid}\n'
                     f'- name: {n["name"]}, {n["file"]}:{n["line"]}-{n.get("end") or n["line"]}\n'
                     + (f'- parameters: {", ".join(p["name"].lstrip("*.") + (" (" + p["type"] + ")" if p["type"] else "") for p in ps)}\n' if ps else "")
                     + (f'- the author wrote: {doc}\n' if doc else "")
                     + f'- called by: {", ".join(map(name, ins)) or "nothing in the repository"}\n'
                     + f'- calls: {", ".join(map(name, outs)) or "nothing in the repository"}\n\n'
                     + "```\n" + "\n".join(f"{n['line'] + i}: {ln}" for i, ln in enumerate(source(root, n))) + "\n```\n")
    if not ids:
        return None, 0
    return HEAD + "\n".join(parts), len(ids)


HEAD = """Describe what each function below does, for a reader who opens this code for the first time.

For every function write one sentence in Traditional Chinese (zh-TW, at most 60 characters) and one in English
(en, at most 30 words). Say what it does and what it is for, in the terms of this program; do not repeat the
function's name or restate its parameters. Use only what the code below shows. Put a name from the code in
backticks (`ring_open`); every such name must be in the function's code or be one of the functions listed next
to it. Give as evidence the one to three lines (file:line) that show it most directly; each must be in the
function itself or in a function it calls or is called by.

Then, in "info", write what a reader needs to use or change it, in short facts. Write a fact only when the code
below shows it; leave a part out when there is nothing to say. Each fact has zh-TW (at most 50 characters) and en
(at most 25 words), and "line" when it is about one line of the function (that line's number). Do not judge or
warn in these parts: say what the code does ("writes `count` without an atomic operation"), not that it is wrong.
- context: which thread or loop runs it and what triggers it (a callback registered with a library, a signal
  handler, each request), and what that forbids (must not block). Leave it out when it simply runs on its caller's thread.
- shared: data outside the function that it reads or writes: globals, static variables, fields of a shared
  object; say read or write, and atomic or under which lock when the code shows it.
- params: for every parameter the caller passes something into and may get something back from (a pointer, a
  reference, a list, an object): "name" as listed, "role" in, out or in-out, and what it holds. Other parameters
  only when their meaning is not obvious from the name.
- returns: what each return value means (`-1`: stopped, errno not set).
- effects: what it changes besides its return value and parameters: files, sockets, output, processes, memory it
  allocates or frees.
- contract: "kind" pre (what must hold before the call), post (what holds after), error (what happens when it
  fails), ownership (who frees or closes what it hands out or takes).
- checks: "kind" trap (a pitfall of the language the code falls into: a mutable default argument, an append the
  caller never sees, an unsigned wrap) or desc (the code does something other than its comment or name says).
  Only what the code below shows for certain.

Answer with JSON only, in this form (one entry per id below, ids copied exactly):

{"descriptions": [{"id": "...", "zh-TW": "...", "en": "...", "evidence": ["file:line"],
  "info": {"context": [{"zh-TW": "...", "en": "..."}],
           "params": [{"name": "buf", "role": "out", "zh-TW": "...", "en": "...", "line": 12}],
           "returns": [{"zh-TW": "...", "en": "...", "line": 30}],
           "contract": [{"kind": "pre", "zh-TW": "...", "en": "..."}]}}]}

Then save it to a file and run: codemap describe --apply <that file>

"""


def apply(root, idx, answer, by="ai"):
    """Keep the answer's descriptions that match the code; returns (kept ids, {id: problems}) for the rest."""
    data = json.loads(answer) if isinstance(answer, str) else answer
    items = data.get("descriptions", []) if isinstance(data, dict) else data
    have = load(root)
    kept, rejected = [], {}
    today = datetime.date.today().isoformat()
    for it in items if isinstance(items, list) else []:
        nid = str(it.get("id", ""))
        entry = {"text": {lang: str(it.get(lang, "")).strip() for lang in LANGS},
                 "evidence": [str(x) for x in it.get("evidence", [])], "by": by, "at": today}
        if it.get("info") is not None:
            entry["info"] = it.get("info")
        bad = problems(root, idx, nid, entry)
        if bad:
            rejected[nid] = bad
            continue
        entry["hash"] = digest(root, idx["nodes"][nid])
        if "info" in entry:
            entry["info"] = clean_info(entry["info"])
            if not entry["info"]:
                del entry["info"]
        have[nid] = entry
        kept.append(nid)
    if kept:
        save(root, have)
    return kept, rejected


def report(root, idx):
    """{state: [ids]} for every kept description: ok, stale, wrong."""
    out = {"ok": [], "stale": [], "wrong": []}
    for nid, entry in load(root).items():
        out[state(root, idx, nid, entry)].append(nid)
    return out


AGENT = """Write the codemap descriptions for this project (functions, files, commands, components, the project). They come in four rounds, each resting on the one before it, so finish a round before the next. Repeat these steps until `codemap describe` prints `everything is described`:

1. In the project's root, run `codemap describe`. It writes `prompt-01.md`, `prompt-02.md` and so on in `.codemap/prompts/`, and says which round it is.
2. Read each `prompt-NN.md` and answer it as it asks, JSON only, saved as `answer-NN.json` in the same folder (the same number as its prompt). Write only from the code and facts the prompt shows; where you are unsure, write only what you are sure of, never guess.
3. Run `codemap describe --apply .codemap/prompts/answer-*.json --by {by}`.
4. If some are `not kept`, read the reason given (a cited line outside what it describes, a name in code font the code does not have, a term not on its cited line, two route steps with no call between them), fix just those, save them as a new answer file and `--apply` it; skip any still not kept after two tries.
5. Go back to step 1 for the next round.

Rules:
- Do not change any of the project's code or settings; write only the answer files in `.codemap/prompts/`.
- Answer every prompt in full, one entry for every id in it.
- When everything is done, run `codemap describe --status` and report each round's numbers, and what you skipped and why.

Where the project stands now:
{status}
"""


AGENT_ZH = """請替這個專案寫 codemap 說明（函式、檔案、指令、元件、專案）。說明分四輪，每一輪依據上一輪的結果，所以一輪做完才做下一輪。重複下面的步驟，直到 `codemap describe` 印出 `everything is described`：

1. 在專案根目錄執行 `codemap describe`。它會在 `.codemap/prompts/` 產生 `prompt-01.md`、`prompt-02.md` 等檔案，並印出這是第幾輪。
2. 一份一份讀 `prompt-NN.md`，照裡面的要求回答，只寫 JSON，存成同一個資料夾的 `answer-NN.json`（編號和 prompt 相同）。只根據 prompt 裡給的程式碼與資料寫，不確定的就只寫確定的部分，不要猜。
3. 執行 `codemap describe --apply .codemap/prompts/answer-*.json --by {by}`。
4. 如果有 `not kept`，讀它列出的原因（引用的行不在範圍內、寫成程式碼字體的名稱不在程式碼裡、名詞不在引用的那一行、閱讀路線的兩步之間沒有呼叫關係），只修正那幾筆，存成新的 answer 檔再 `--apply` 一次；修了兩次還不行就跳過。
5. 回到第 1 步，做下一輪。

規則：
- 不要修改專案的任何原始碼或設定，只寫 `.codemap/prompts/` 裡的 answer 檔。
- 每一份 prompt 都要回答完整，每個 id 都要有一筆。
- 全部完成後執行 `codemap describe --status`，回報每一輪的數字，以及跳過了哪些項目和原因。

目前的進度：
{status}
"""


def screen_lang(asked=None):
    """The language of what describe says on screen: --lang, else the system's (zh... is Chinese), else English."""
    import os
    if asked:
        return asked
    loc = os.environ.get("LC_ALL") or os.environ.get("LC_MESSAGES") or os.environ.get("LANG") or ""
    return "zh-TW" if loc.lower().startswith("zh") else "en"


def _settings_file():
    import os
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return Path(base) / "codemap" / "settings.json"


def pick_lang(asked=None):
    """--lang, else a question on a terminal (the last answer, or the system's language, picked to start with),
    else the last answer or the system's. The answer is kept in ~/.config/codemap/settings.json for next time."""
    from . import term
    f = _settings_file()
    try:
        saved = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    if not isinstance(saved, dict):
        saved = {}
    lang = asked
    if not lang:
        start = saved.get("lang") if saved.get("lang") in ("zh-TW", "en") else screen_lang()
        options = [("zh-TW", "中文（繁體）"), ("en", "English")]
        lang = term.choose("Language / 語言:", options, 0 if start == "zh-TW" else 1)
    if (asked or term.can_ask()) and lang != saved.get("lang"):      # only an answer someone gave is kept
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(dict(saved, lang=lang), indent=2) + "\n", encoding="utf-8")
        except OSError:
            pass                                     # a read-only home: ask again next time
    return lang


def agent_prompt(status_lines, by=None, lang="en"):
    """One instruction an AI agent (Claude Code, a coding assistant) can follow to write every round by itself."""
    zh = lang.startswith("zh")
    by = by or ("<你的模型名稱>" if zh else "<your model's name>")
    return (AGENT_ZH if zh else AGENT).format(by=by, status="\n".join("- " + s for s in status_lines))
