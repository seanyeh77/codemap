"""The command line's progress: one step at a time, a spinner with the seconds and what is happening, then a
check mark and how long it took. Only these lines reach the terminal while a step runs; the details go to a log.

On a terminal (stderr is one, not CI, CODEMAP_PLAIN unset, TERM not dumb) the current step is one line redrawn
every 0.2 s, cut to the window's width (measured again while drawing, so a narrowed window never fills with
copies), with the cursor hidden until it ends. Otherwise each step is a plain `==> step` line and its result.
NO_COLOR turns the colours off.
"""
import atexit
import os
import shutil
import sys
import threading
import time
from contextlib import contextmanager

ESC = "\033"


def _wanted(stream):
    try:
        tty = stream.isatty()
    except (AttributeError, ValueError):
        tty = False
    return tty and not os.environ.get("CI") and os.environ.get("CODEMAP_PLAIN", "0") in ("", "0") and os.environ.get("TERM") != "dumb"


def _utf8(stream):
    enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
    return enc == "utf8"


class UI:
    def __init__(self, stream=None):
        self.out = stream or sys.stderr
        self.live = _wanted(self.out)
        self.color = self.live and not os.environ.get("NO_COLOR")
        self.frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏" if _utf8(self.out) else "|/-\\"
        self.ok, self.bad = ("✓", "!") if _utf8(self.out) else ("ok", "!")
        self.arrow = "→" if _utf8(self.out) else "->"
        self._label = None
        self._detail = ""
        self._t0 = 0.0
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.Lock()
        self.cols = 80
        if self.live:
            atexit.register(self._restore)

    # ---- drawing ----

    def _paint(self, code, text):
        return f"{ESC}[{code}m{text}{ESC}[0m" if self.color else text

    def _measure(self):
        self.cols = max(20, shutil.get_terminal_size((80, 24)).columns)

    def _fit(self, *parts):
        """parts: (text, colour code or None); cut so the visible line never wraps."""
        room, out = self.cols - 1, []
        for text, code in parts:
            if room <= 0:
                break
            text = text.replace("\n", " ")[:room]
            room -= len(text)
            out.append(self._paint(code, text) if code else text)
        return "".join(out)

    def _draw(self, tick):
        if tick % 5 == 0:
            self._measure()
        secs = f"{time.monotonic() - self._t0:.0f}s"
        line = self._fit((f"  {self.frames[tick % len(self.frames)]} ", None), (self._label or "", None),
                         (f"  {secs}", "2"), (f"  {self._detail}" if self._detail else "", "2"))
        with self._lock:
            self.out.write(f"\r{ESC}[K{line}")
            self.out.flush()

    def _spin(self):
        tick = 0
        while not self._stop.wait(0.2 if tick else 0):
            self._draw(tick)
            tick += 1

    def _restore(self):
        if self.live:
            try:
                self.out.write(f"{ESC}[?25h")
                self.out.flush()
            except (OSError, ValueError):
                pass

    # ---- what callers use ----

    def detail(self, text):
        """What is happening inside the current step (the file being read); shown dim after the seconds."""
        self._detail = text or ""
        if not self.live and text and self._label is None:
            pass                                       # plain mode: step lines only, the details go to the log

    def say(self, text="", kind=None):
        """A line that stays (a warning, a result): above the spinner when one is running."""
        mark = {"ok": self._paint("32", self.ok), "warn": self._paint("33", self.bad), "fail": self._paint("31", self.bad)}.get(kind, "")
        with self._lock:
            if self.live and self._label is not None:
                self.out.write(f"\r{ESC}[K")
            self.out.write((f"  {mark} " if mark else "") + text + "\n")
            self.out.flush()

    @contextmanager
    def step(self, label):
        """with ui.step("Python: 13 files") as s: ...; s.done("226 definitions") gives the result shown after it."""
        result = {"text": "", "kind": "ok"}

        class Step:
            def done(self, text="", kind="ok"):
                result["text"], result["kind"] = text, kind

        self._label, self._detail, self._t0 = label, "", time.monotonic()
        if self.live:
            self.out.write(f"{ESC}[?25l")
            self._stop.clear()
            self._thread = threading.Thread(target=self._spin, daemon=True)
            self._thread.start()
        else:
            self.out.write(f"==> {label}\n")
            self.out.flush()
        failed = False
        try:
            yield Step()
        except BaseException:
            failed = True
            raise
        finally:
            took = time.monotonic() - self._t0
            if self._thread:
                self._stop.set()
                self._thread.join()
                self._thread = None
            secs = f"{took:.1f}s" if took < 10 else f"{took:.0f}s"
            if self.live:
                self._measure()
                kind = "fail" if failed else result["kind"]
                mark = self._paint({"ok": "32", "warn": "33", "fail": "31"}[kind], self.ok if kind == "ok" else self.bad)
                tail = self._fit((label, None), (f" {self.arrow} {result['text']}" if result["text"] else "", None), (f"  ({secs})", "2"))
                self.out.write(f"\r{ESC}[K  {mark} {tail}\n{ESC}[?25h")
            else:
                self.out.write(f"    {self.arrow} {'stopped' if failed else (result['text'] or 'done')} ({secs})\n")
            self.out.flush()
            self._label, self._detail = None, ""


_ui = None


def ui():
    """The one UI of this run (on stderr, so stdout stays the command's own output)."""
    global _ui
    if _ui is None:
        _ui = UI()
    return _ui


def fit(text):
    """A line for stdout cut to the terminal's width (with … when cut), unchanged when stdout is not one."""
    if not sys.stdout.isatty():
        return text
    cols = max(20, shutil.get_terminal_size((80, 24)).columns) - 1
    return text if len(text) <= cols else text[: cols - 1] + "…"
