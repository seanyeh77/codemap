from api.main import render


def test_render(user, tmp_path):
    assert render(1)["id"] == 1


class TestUsers:
    def test_create(self, client):
        assert client


def helper():
    return 1
