"""Runs the real app on a migrated copy and prints what it answers (not a test module).

    python tests/migrated_app_probe.py /abs/migrated.db '[{"op": "get", "as": 1, "path": "/api/session"}]'

The tests start it in a separate process: the app binds its database at import, and the
suite's own database must stay untouched. VK is a local double: a token is the VK ID of
its owner. Nothing leaves the machine.
"""

import json
import os
import sys
import time
from pathlib import Path

os.environ["DATABASE_PATH"] = sys.argv[1]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import vk_auth  # noqa: E402
from auth import create_access_token  # noqa: E402
from database import db, UserORM  # noqa: E402

vk_auth.verified_identity = lambda token: {
    "subject": "vk:" + token, "vk_id": token, "first_name": "Синтетик", "last_name": "Тестов"
}
client = TestClient(main.app)


def headers(uid):
    return {"Authorization": "Bearer " + create_access_token(uid)}


def run(step):
    op = step["op"]
    if op == "users":
        with db._session() as s:
            return s.query(UserORM).count()
    if op == "vk":
        r = client.post("/api/auth/vk", json={"access_token": step["vk_id"]})
        if r.status_code != 200:
            return dict(status=r.status_code, detail=r.json().get("detail"))
        me = client.get("/api/session", headers={"Authorization": "Bearer " + r.json()["access_token"]})
        return dict(status=200, user_id=me.json()["user_id"])
    if op in ("get", "post", "put", "patch"):
        start = time.perf_counter()
        r = client.request(op.upper(), step["path"], headers=headers(step["as"]), json=step.get("json"))
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else None
        return dict(status=r.status_code, json=body, seconds=round(time.perf_counter() - start, 3))
    raise ValueError(op)


print(json.dumps([run(step) for step in json.loads(sys.argv[2])], ensure_ascii=False))
