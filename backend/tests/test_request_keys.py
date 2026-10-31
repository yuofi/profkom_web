"""GL-07: a create repeated after a lost answer returns the first result instead of a copy."""
import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

from database import db, CommentORM, TaskORM
from test_v13_tracker import work  # noqa: F401


def count(orm, **where):
    with db._session() as session:
        return session.query(orm).filter_by(**where).count()


def test_task_create_with_the_same_key_returns_the_first_task(client, work):
    master, key = work["master"], str(uuid.uuid4())
    payload = {**work["payload"], "title": "Повтор после таймаута", "idempotency_key": key}
    first = client.post("/api/tasks", headers=master.headers, json=payload)
    assert first.status_code == 200, first.text
    again = client.post("/api/tasks", headers=master.headers, json=payload)
    assert again.status_code == 200, again.text
    assert again.json()["task_id"] == first.json()["task_id"]
    assert count(TaskORM, title="Повтор после таймаута") == 1
    # The same key with other data, or by someone else, is not a repeat.
    changed = client.post("/api/tasks", headers=master.headers, json={**payload, "title": "Другая"})
    assert changed.status_code == 409 and changed.json()["detail"]["code"] == "duplicate_request_key"
    other = client.post("/api/tasks", headers=work["member"].headers, json=payload)
    assert other.status_code == 409
    assert count(TaskORM, title="Другая") == 0
    # Without a key every request still creates its own task (older clients).
    plain = {**work["payload"], "title": "Без ключа"}
    for _ in range(2):
        assert client.post("/api/tasks", headers=master.headers, json=plain).status_code == 200
    assert count(TaskORM, title="Без ключа") == 2
    assert client.post("/api/tasks", headers=master.headers, json={**payload, "idempotency_key": "not-a-uuid"}).status_code == 422


def test_comment_with_the_same_key_is_added_once(client, work):
    tid, member, key = work["task"]["task_id"], work["member"], str(uuid.uuid4())
    payload = {"content": "Один раз", "idempotency_key": key}
    first = client.post(f"/api/tasks/{tid}/comments", headers=member.headers, json=payload)
    assert first.status_code == 200, first.text
    again = client.post(f"/api/tasks/{tid}/comments", headers=member.headers, json=payload)
    assert again.status_code == 200, again.text
    assert again.json()["comment_id"] == first.json()["comment_id"]
    assert again.json()["content"]["body"] == "Один раз"
    assert count(CommentORM, task_id=tid) == 1
    changed = client.post(f"/api/tasks/{tid}/comments", headers=member.headers, json={**payload, "content": "Другой"})
    assert changed.status_code == 409 and changed.json()["detail"]["code"] == "duplicate_request_key"
    assert client.post(f"/api/tasks/{tid}/comments", headers=work["master"].headers, json=payload).status_code == 409
    # The key is accepted only on create; an edit keeps its own contract.
    edit = client.patch(f"/api/comments/{first.json()['comment_id']}", headers=member.headers, json={"content": "Правка", "idempotency_key": key})
    assert edit.status_code == 422
    assert count(CommentORM, task_id=tid) == 1


def test_old_schema_gets_the_key_columns_once_and_keeps_its_rows(tmp_path):
    path = tmp_path / "old-request-keys.db"
    with sqlite3.connect(path) as c:
        c.executescript(
            "CREATE TABLE tasks(task_id TEXT PRIMARY KEY,season_id TEXT,scope_kind TEXT,scope_id TEXT,title TEXT,description_json TEXT,deadline_at TEXT,assigned_at TEXT,criteria_json TEXT,created_by_user_id INTEGER,created_at TEXT,revision INTEGER);"
            "CREATE TABLE task_comments(comment_id TEXT PRIMARY KEY,task_id TEXT,author_user_id INTEGER,content_json TEXT,files_json TEXT,history_json TEXT,created_at TEXT,updated_at TEXT);")
        c.execute("INSERT INTO tasks VALUES('task-old','s','block','b','Старая','{}',NULL,'t','{}',7,'t',3)")
        c.execute("INSERT INTO task_comments VALUES('comment-old','task-old',7,'{}','[]','[]','t',NULL)")
        rows = (c.execute("SELECT * FROM tasks").fetchall(), c.execute("SELECT * FROM task_comments").fetchall())
    for _ in range(2):
        r = subprocess.run([sys.executable, "-c", "import database; database._ensure_sqlite_request_key_columns()"],
                           cwd=Path(__file__).resolve().parents[1], env={**os.environ, "DATABASE_PATH": str(path)},
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        with sqlite3.connect(path) as c:
            for table in ("tasks", "task_comments"):
                names = [row[1] for row in c.execute(f"PRAGMA table_info({table})")]
                assert names.count("idempotency_key") == 1 and names.count("request_hash") == 1
                assert c.execute("SELECT \"unique\" FROM pragma_index_list(?) WHERE name=?", (table, f"ux_{table}_idempotency_key")).fetchone() == (1,)
            assert c.execute("SELECT task_id,season_id,scope_kind,scope_id,title,description_json,deadline_at,assigned_at,criteria_json,created_by_user_id,created_at,revision FROM tasks").fetchall() == rows[0]
            assert c.execute("SELECT comment_id,task_id,author_user_id,content_json,files_json,history_json,created_at,updated_at FROM task_comments").fetchall() == rows[1]
            assert c.execute("SELECT idempotency_key,request_hash FROM tasks").fetchone() == (None, None)


def test_fresh_schema_has_the_same_unique_key_index():
    with db._session() as session:
        for table in ("tasks", "task_comments"):
            rows = session.execute(__import__("sqlalchemy").text(f"SELECT name,\"unique\" FROM pragma_index_list('{table}')")).fetchall()
            assert (f"ux_{table}_idempotency_key", 1) in [tuple(row) for row in rows]
