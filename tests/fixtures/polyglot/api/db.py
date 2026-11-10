"""The database session for the API."""


class Session:
    def close(self):
        pass


def get_db():
    db = Session()
    try:
        yield db
    finally:
        db.close()


def current_user(db=None):
    return lookup(db, "me")


def lookup(db, name):
    return {"name": name}
