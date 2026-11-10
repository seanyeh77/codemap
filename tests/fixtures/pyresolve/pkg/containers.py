from .models import Admin, User
from .repo import Repo


def load() -> list[User]:
    return []


def team():
    users: list[User] = []
    for user in users:
        user.describe()
    staff = []
    staff.append(Admin("a"))
    for s in staff:
        s.grant()
    for i, u in enumerate(load()):
        u.describe()
    by_name = {}
    by_name["r"] = Repo()
    by_name["r"].save(1)
    for k, r in by_name.items():
        r.save(2)
    first = [User("x") for _ in range(3)][0]
    first.run()
    pool = list(staff)
    pool.pop().grant()


def exact_vs_bound(u: User):
    b = User("b")
    b.run()
    u.run()


class Team:
    def __init__(self):
        self.members: list[User] = []

    def describe_all(self):
        for m in self.members:
            m.describe()


def make_handler():
    return lambda: 0


def make_rule(n):
    def rule(x):
        return x > n
    return rule


HANDLERS = {"team": team, "other": make_handler()}


def dispatch(name):
    HANDLERS[name]()
    make_rule(1)(2)
