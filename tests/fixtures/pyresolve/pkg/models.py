class User:
    def __init__(self, name):
        self.name = name

    def run(self):
        return self.describe()

    def describe(self):
        return self.name

    def start(self):
        return self.run()

    @classmethod
    def build(cls, name):
        return cls.validate(name)

    @classmethod
    def validate(cls, name):
        return cls(name)


class Admin(User):
    def run(self):
        super().run()
        return self.grant()

    def grant(self):
        return True


class Other:
    def run(self):
        return 0
