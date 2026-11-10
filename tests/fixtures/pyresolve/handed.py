"""Functions handed on as values: whoever receives them calls them later."""
import threading


def work():
    return 1


def table():
    return {"w": work}


class Loop:
    def __init__(self):
        self.thread = threading.Thread(target=self.tick)
        self.cb = work
        h = self.tick              # a local name: the call through it is an ordinary call edge
        h()

    def tick(self):
        return [work, self.tick]
