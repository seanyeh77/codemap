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


def can_ask():
    """A person at a terminal can answer: stdin and stderr are terminals and the plain mode is off."""
    try:
        return sys.stdin.isatty() and ui().live
    except (AttributeError, ValueError):
        return False


def _key(fd):
    ch = os.read(fd, 1)
    if ch != b"\x1b":
        return ch.decode(errors="ignore")
    rest = os.read(fd, 2)                          # an arrow: ESC [ A / ESC [ B
    return {b"[A": "up", b"[B": "down", b"OA": "up", b"OB": "down"}.get(rest, "esc")


def choose(question, options, default=0):
    """Ask one question with a list to pick from: options are (value, label). Up and down (or j / k, or the
    number) move, Enter picks. Without a terminal it answers the default without asking. Ctrl-C stops the run."""
    if not can_ask():
        return options[default][0]
    try:
        import termios
        import tty
    except ImportError:                              # Windows: no raw keys here, so no question
        return options[default][0]
    u, out, fd = ui(), sys.stderr, sys.stdin.fileno()
    at, n = default, len(options)
    hint = u._paint("2", "  (↑↓ Enter)" if _utf8(out) else "  (up/down, Enter)")
    pointer = "❯" if _utf8(out) else ">"

    def draw(first):
        if not first:
            out.write(f"{ESC}[{n}A")
        for i, (_, label) in enumerate(options):
            line = f"  {pointer} {i + 1}. {label}" if i == at else f"    {i + 1}. {label}"
            out.write(f"\r{ESC}[K" + (u._paint("36", line) if i == at else line) + "\n")
        out.flush()

    out.write(f"{question}{hint}\n{ESC}[?25l")
    draw(True)
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        while True:
            k = _key(fd)
            if k in ("\r", "\n"):
                break
            if k == "\x03":
                raise KeyboardInterrupt
            if k in ("up", "k"):
                at = (at - 1) % n
            elif k in ("down", "j", "\t"):
                at = (at + 1) % n
            elif k.isdigit() and 1 <= int(k) <= n:
                at = int(k) - 1
            else:
                continue
            draw(False)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        out.write(f"{ESC}[{n + 1}A\r{ESC}[J{ESC}[?25h")      # the question and its list give way to one line
        out.write(f"{question} {u._paint('36', options[at][1])}\n")
        out.flush()
    return options[at][0]
