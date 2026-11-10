import pytest


@pytest.fixture(scope="session")
def client():
    return make_client()


def make_client():
    return object()


@pytest.fixture
def user(client):
    return {"client": client}
