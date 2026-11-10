from pkg.models import User


class FakeUser(User):
    """A test's stand-in: production code never holds one."""

    def describe(self):
        return "fake"


def test_describe():
    FakeUser("x").describe()
