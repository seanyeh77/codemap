from .models import Admin, User
from .repo import Repo
from . import cycle_a


def create():
    return User("x")


def make_admin() -> Admin:
    return Admin("root")


class Service:
    def __init__(self):
        self.repo = Repo()

    def handle(self, item):
        cycle_a.ping()
        return self.repo.save(item)
