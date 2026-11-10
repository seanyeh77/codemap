from fastapi import Depends, FastAPI

from .db import Session, current_user, get_db

app = FastAPI()


@app.get("/users/{uid}")
def read_user(uid: int, db: Session = Depends(get_db), me=Depends(current_user)):
    return render(uid)


@app.post("/users", dependencies=[Depends(current_user)])
def create_user():
    return render(0)


def render(uid):
    return {"id": uid}
