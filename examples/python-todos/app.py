"""A small todo API in plain Python (standard library only): the "original" service.

    python3 seed.py data/todos.db
    DB=data/todos.db WEBHOOK_URL=http://127.0.0.1:9900/hooks PORT=3200 python3 app.py

Routes: GET /todos[?done=true|false], GET /todos/<id>, POST /todos, PATCH /todos/<id>,
DELETE /todos/<id>, GET /stats. Completing a todo POSTs {"event": "todo.completed", ...} to WEBHOOK_URL.

It reports its outbound calls to gerra with the x-gerra-effects header (see effects.py), the same
protocol @gerra/sdk-node implements for Node, so gerra can check that a rewrite still sends the webhook.
"""
import json
import os
import re
import sqlite3
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from effects import Effects

DB = os.environ.get("DB", "data/todos.db")
WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "")


def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    return db


def todo(row):
    return {"id": row["id"], "title": row["title"], "done": bool(row["done"])}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, status, value=None):
        body = b"" if value is None else json.dumps(value).encode("utf-8")
        self.send_response(status)
        if value is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.effects.send_header(self)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            value = json.loads(self.rfile.read(length) or b"null")
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    def notify(self, event, item):
        if not WEBHOOK_URL:
            return
        payload = {"event": event, "todo": item}
        req = urllib.request.Request(
            WEBHOOK_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                status = res.status
        except urllib.error.HTTPError as err:
            status = err.code
        self.effects.record({"type": "http", "method": "POST", "url": WEBHOOK_URL, "body": payload, "status": status})

    def route(self, method):
        self.effects = Effects(self.headers)
        db = connect()
        try:
            with db:  # commits before the answer goes out, so the next request sees this one's writes
                status, value = self.dispatch(db, method)
        finally:
            db.close()
        self.send_json(status, value)

    def dispatch(self, db, method):
        path, _, query = self.path.partition("?")
        if path == "/todos" and method == "GET":
            sql, args = "select * from todos", []
            if query in ("done=true", "done=false"):
                sql, args = sql + " where done = ?", [1 if query == "done=true" else 0]
            return (200, [todo(r) for r in db.execute(sql + " order by id", args)])
        if path == "/todos" and method == "POST":
            body = self.read_json()
            title = (body or {}).get("title")
            if not isinstance(title, str) or not title.strip():
                return (400, {"error": "title is required"})
            cur = db.execute("insert into todos (title) values (?)", [title.strip()])
            return (201, todo(db.execute("select * from todos where id = ?", [cur.lastrowid]).fetchone()))
        if path == "/stats" and method == "GET":
            total, done = db.execute("select count(*), coalesce(sum(done), 0) from todos").fetchone()
            percent = round(done * 100 / total) if total else 0
            return (200, {"total": total, "done": done, "open": total - done, "percent_done": percent})
        m = re.fullmatch(r"/todos/(\d+)", path)
        if not m:
            return (404, {"error": "not found"})
        row = db.execute("select * from todos where id = ?", [int(m.group(1))]).fetchone()
        if row is None:
            return (404, {"error": "todo %s not found" % m.group(1)})
        if method == "GET":
            return (200, todo(row))
        if method == "DELETE":
            db.execute("delete from todos where id = ?", [row["id"]])
            return (204, None)
        if method == "PATCH":
            body = self.read_json()
            if body is None:
                return (400, {"error": "expected a JSON object"})
            title = body.get("title", row["title"])
            done = body.get("done", bool(row["done"]))
            if not isinstance(title, str) or not isinstance(done, bool):
                return (400, {"error": "title must be a string and done a boolean"})
            db.execute("update todos set title = ?, done = ? where id = ?", [title, int(done), row["id"]])
            item = todo(db.execute("select * from todos where id = ?", [row["id"]]).fetchone())
            if done and not row["done"]:
                self.notify("todo.completed", item)
            return (200, item)
        return (405, {"error": "method not allowed"})

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3200"))
    print("todos (Python) listening on http://localhost:%d" % port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
