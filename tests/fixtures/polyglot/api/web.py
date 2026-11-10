from flask import Flask

app = Flask(__name__)


@app.route("/health", methods=["GET", "HEAD"])
def health():
    return "ok"


@app.errorhandler(404)
def missing(e):
    return "no", 404
