import numpy as np

import pkg.models as pm
from pkg import service
from pkg.models import Admin, User
from pkg.service import create as mk


def main():
    user = mk()
    user.run()
    alias = user
    alias.describe()
    admin = service.make_admin()
    admin.grant()
    svc = service.Service()
    svc.handle(1)
    pm.User("y").run()
    np.array([1])
    either: User | Admin = pick()
    either.run()


def pick():
    return User("z")


def unknown(obj):
    obj.run()
    obj.save(1)


if __name__ == "__main__":
    main()
