"""Public HTTP protocol acceptance; synthetic people/chat, no VK/S3 calls."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import socket
import statistics
import subprocess
import threading
import time
import uuid

import pytest

from settings import settings
from test_bot_api import BOT, HASH, body, heartbeat, sql
from test_bot_notify import linked
from test_v13_tracker import work  # noqa: F401


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def chat_work(client, work, monkeypatch):
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    monkeypatch.setattr(settings, "PUBLIC_SITE_URL", "https://site.example")
    linked(work["master"].user_id, 901)
    linked(work["member"].user_id, 902)
    ok(client.post("/api/bot/v1/report", headers=BOT,
                   json=body(hb=heartbeat(features=["chat_announcements_v1"]))))
    path = f'/api/scopes/block/{work["block"]["block_id"]}/chat'
    code = ok(client.post(path + "/link-code", headers=work["master"].headers,
                          json={"expected_revision": 0}))
    from test_bot_api import at
    binding = ok(client.post("/api/bot/v1/chats/confirm", headers=BOT, json={
        "code": code["code"], "vk_user_id": 901, "bot_identity": 900001,
        "peer_id": 2000000001, "title": "Synthetic team", "observed_at": at(),
        "can_send": True, "author_is_admin": True,
    }))
    return {**work, "chat_path": path, "binding": binding}


def create(client, work, **changes):
    payload = {**work["payload"], "idempotency_key": uuid.uuid4().hex,
               "chat_announcement": {"enabled": True, "binding_revision": work["binding"]["revision"]},
               **changes}
    return ok(client.post("/api/tasks", headers=work["master"].headers, json=payload)), payload


def poll(client):
    return ok(client.get("/api/bot/v1/work?features=chat_announcements_v1", headers=BOT))["chat_announcements"]


def claim(client, job):
    return ok(client.post(f'/api/bot/v1/chat-announcements/{job["job_id"]}/claim', headers=BOT,
                          json={"worker_id": str(uuid.uuid4()), "payload_hash": job["payload_hash"]}))


def manifest(job, lease, number, total=2):
    return {"lease_token": lease["lease_token"], "fence": lease["fence"], "part_number": number,
            "parts_total": total, "random_id": 501 + number,
            "part_hash": hashlib.sha256(f"synthetic immutable part {number}".encode()).hexdigest(),
            "payload_hash": job["payload_hash"]}


def authorize(client, job, part):
    return client.post(f'/api/bot/v1/chat-announcements/{job["job_id"]}/authorize', headers=BOT, json=part)


def report(client, job, part, status="sent"):
    result = {key: value for key, value in part.items() if key not in {"parts_total", "payload_hash"}}
    result.update(job_id=job["job_id"], status=status)
    result.update({"message_id": 3001 + part["part_number"]} if status == "sent" else {"error_code": "send_failed"})
    return client.post("/api/bot/v1/report", headers=BOT, json=body(hb=None, chat_results=[result]))


def measure_creation(origin, work, report_path):
    """Opt-in bounded localhost measurement; data and bot are entirely synthetic."""
    import httpx

    def post(announce, start_gate=None):
        payload = {**work["payload"], "assignees": [], "idempotency_key": uuid.uuid4().hex}
        if announce:
            payload["chat_announcement"] = {"enabled": True, "binding_revision": work["binding"]["revision"]}
        with httpx.Client(base_url=origin, trust_env=False, timeout=40) as client:
            if start_gate is not None:
                start_gate.wait(timeout=30)
            start = time.perf_counter()
            response = client.post("/api/tasks", headers=work["master"].headers, json=payload)
            elapsed = 1000 * (time.perf_counter() - start)
        assert response.status_code == 200, response.text
        task = response.json()
        if announce:
            assert task["chat_announcement"]["state"] == "pending"
        else:
            assert task["chat_announcement"] is None
        return elapsed, task["task_id"]

    for flag in [False, True, False, True]: post(flag)
    baseline, announced, delta = [], [], []
    for index in range(30):
        pair = {}
        for flag in ([False, True] if index % 2 == 0 else [True, False]):
            pair[flag] = post(flag)[0]
        baseline.append(pair[False]);announced.append(pair[True]);delta.append(pair[True]-pair[False])
    def stats(values):
        ordered = sorted(values)
        return {"n": len(values), "mean_ms": round(statistics.mean(values), 3),
                "p50_ms": round(statistics.median(values), 3), "p95_ms": round(ordered[math.ceil(.95*len(values))-1], 3),
                "max_ms": round(max(values), 3)}
    gate = threading.Barrier(100)
    def concurrent(_):
        return post(True, gate)
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=100) as pool:
        results = list(pool.map(concurrent, range(100)))
    assert len({task_id for _, task_id in results}) == 100
    from database import db
    from domain_models import TaskChatAnnouncementORM
    with db._session() as session:
        queued = session.query(TaskChatAnnouncementORM).filter(
            TaskChatAnnouncementORM.task_id.in_([task_id for _, task_id in results]),
            TaskChatAnnouncementORM.state == "pending").count()
    assert queued == 100
    report = {"scope": "localhost HTTP on developer machine, temporary SQLite, bot stopped, VK mocked",
              "paired_no_announcement": stats(baseline), "paired_announcement": stats(announced),
              "paired_delta": stats(delta), "simultaneous_100": stats([elapsed for elapsed, _ in results]),
              "simultaneous_wall_seconds": round(time.perf_counter()-start, 3),
              "http_200_count": 100, "unique_task_count": 100, "persisted_pending_announcements": queued,
              "percentile_method": "nearest rank",
              "note": "Local acceptance measurement, not a production capacity estimate"}
    target = Path(report_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + "\n")


def test_partial_delivery_manual_retry_uses_same_job_parts_and_fences(client, chat_work):
    work = chat_work
    task, payload = create(client, work)
    replay = ok(client.post("/api/tasks", headers=work["master"].headers, json=payload))
    assert replay["task_id"] == task["task_id"]
    assert replay["chat_announcement"]["announcement_id"] == task["chat_announcement"]["announcement_id"]
    assert "chat_announcements" not in ok(client.get("/api/bot/v1/work", headers=BOT))
    with sql() as statements:
        jobs = poll(client)
        context = ok(client.get("/api/tasks/chat-context", headers=work["master"].headers,
                               params={"queue_id": task["queue"]["queue_id"], "assignee_user_ids": work["member"].user_id}))
    assert all(statement.lstrip().startswith("SELECT") for statement in statements), statements
    assert context["available"] and context["recipient_mode"] == "assignees"
    assert len(jobs) == 1
    job = jobs[0]
    assert job["recipient_vk_ids"] == [902]
    assert "Текст" not in job["text"]  # description never leaves the site
    lease = claim(client, job)
    other = client.post(f'/api/bot/v1/chat-announcements/{job["job_id"]}/claim', headers=BOT,
                        json={"worker_id": str(uuid.uuid4()), "payload_hash": job["payload_hash"]})
    assert other.status_code == 409
    first, second = manifest(job, lease, 0), manifest(job, lease, 1)
    ok(authorize(client, job, first));ok(report(client, job, first))
    ok(authorize(client, job, second));ok(report(client, job, second, "failed"))
    status = ok(client.get(f'/api/tasks/{task["task_id"]}', headers=work["master"].headers))["chat_announcement"]
    assert status["state"] == "partial"
    assert "retry_chat_announcement" in status["capabilities"]
    ok(client.post(f'/api/tasks/{task["task_id"]}/chat-announcement/retry', headers=work["master"].headers,
                   json={"expected_revision": status["revision"]}))
    resumed = poll(client)[0]
    assert resumed["job_id"] == job["job_id"] and resumed["payload_hash"] == job["payload_hash"]
    assert resumed["retry_generation"] > job["retry_generation"]
    lease2 = claim(client, resumed)
    assert lease2["fence"] > lease["fence"]
    assert report(client, job, first).status_code == 409  # an ignored stale result is never acknowledged
    first2, second2 = manifest(job, lease2, 0), manifest(job, lease2, 1)
    saved = ok(authorize(client, job, first2))
    assert saved["already_sent"] and saved["message_id"] == 3001
    assert authorize(client, job, {**second2, "random_id": 99999}).status_code == 409
    ok(authorize(client, job, second2));ok(report(client, job, second2))
    ok(report(client, job, second2))
    final = ok(client.get(f'/api/tasks/{task["task_id"]}', headers=work["master"].headers))["chat_announcement"]
    assert final["state"] == "sent"
    assert poll(client) == []


def test_unlink_after_first_part_prevents_remaining_sends_and_keeps_task(client, chat_work):
    work = chat_work
    task, _ = create(client, work, assignees=[])
    job = poll(client)[0]
    assert job["mode"] == "all" and job["recipient_vk_ids"] == []
    lease = claim(client, job)
    first = manifest(job, lease, 0)
    ok(authorize(client, job, first));ok(report(client, job, first))
    ok(client.request("DELETE", work["chat_path"], headers=work["master"].headers,
                      json={"expected_revision": work["binding"]["revision"]}))
    assert authorize(client, job, manifest(job, lease, 1)).status_code == 409
    saved = ok(client.get(f'/api/tasks/{task["task_id"]}', headers=work["master"].headers))
    assert saved["title"] == task["title"]
    assert saved["chat_announcement"]["state"] in {"cancelled", "partial"}
    assert poll(client) == []


@pytest.mark.skipif(not os.getenv("PROFKOM_TASK_CHAT_BOT_SOURCE"), reason="Optional sibling HereBot cross-service acceptance")
def test_real_herebot_worker_restarts_against_local_http_without_duplicate_parts(client, chat_work, monkeypatch, tmp_path):
    """Both codebases run unchanged; only VK is fake. A second bot process resumes its DB."""
    import uvicorn
    import main
    from database import db
    from domain_models import TaskChatAnnouncementORM

    source = Path(os.environ["PROFKOM_TASK_CHAT_BOT_SOURCE"]).resolve()
    # Keep the venv launcher path: resolving its symlink would select bare Python.
    python = Path(os.environ["PROFKOM_TASK_CHAT_BOT_PYTHON"]).absolute()
    assert (source / "core/site_chat.py").is_file() and python.is_file()
    server_socket = socket.socket()
    server_socket.bind(("127.0.0.1", 0))
    port = server_socket.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    monkeypatch.setattr(settings, "PUBLIC_SITE_URL", origin)
    task, _ = create(client, chat_work, assignees=[])
    server = uvicorn.Server(uvicorn.Config(main.app, log_level="error", lifespan="off"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [server_socket]}, daemon=True)
    thread.start()
    script = r'''
import json, sys
from pathlib import Path
from peewee import SqliteDatabase
from core.site_api import SiteClient
from core.site_chat import ChatWorker
from models import Chats, SiteChatJob, SiteChatPart
base, folder, ticks = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3])
database = SqliteDatabase(folder / 'bot.db')
models = [Chats, SiteChatJob, SiteChatPart]
class FakeVk:
    def inspect(self, peer):
        return ({**{i: False for i in range(1,102)}, -900001: True}, list(range(1,102)), 'Synthetic team')
    def send(self, peer, text, random_id):
        log = folder / 'sends.json'
        sent = json.loads(log.read_text()) if log.exists() else []
        assert all(item['random_id'] != random_id for item in sent), 'Duplicate provider send'
        sent.append({'random_id':random_id, 'mentions':text.count('[id'), 'message_id':4000+len(sent)})
        log.write_text(json.dumps(sent))
        return sent[-1]['message_id']
with database.bind_ctx(models):
    database.create_tables(models)
    client = SiteClient(base, 't'*43)
    client.session.trust_env = False
    worker = ChatWorker(client, FakeVk(), 900001)
    worker.offer(client.get_work(chat_announcements=True))
    for _ in range(ticks): worker.tick()
    print(json.dumps({'parts': SiteChatPart.select().count(), 'done': SiteChatJob.get().done}))
database.close()
'''
    env = {**os.environ, "PYTHON_DOTENV_DISABLED": "1", "VK_TOKEN": "synthetic",
           "VK_GROUP_ID": "900001", "ALLOWED_IDS": "1", "SITE_API_URL": "", "SITE_BOT_TOKEN": "",
           "USE_POSTGRES_LOCALLY": "false"}
    try:
        for _ in range(200):
            if server.started: break
            time.sleep(.01)
        assert server.started
        def run(ticks):
            response = subprocess.run([str(python), "-c", script, origin, str(tmp_path), str(ticks)],
                                      cwd=source, env=env, text=True, capture_output=True, timeout=40)
            assert response.returncode == 0, response.stdout + response.stderr
            return json.loads(response.stdout.strip().splitlines()[-1])
        assert run(1) == {"parts": 3, "done": False}
        assert len(json.loads((tmp_path / "sends.json").read_text())) == 1
        # The first process is gone. Expire only the synthetic lease, then restart the actual worker.
        with db.atomic(), db._session() as session:
            job = session.query(TaskChatAnnouncementORM).filter_by(task_id=task["task_id"]).one()
            job.lease_expires_at = "2000-01-01T00:00:00+00:00"
        assert run(3) == {"parts": 3, "done": True}
        sent = json.loads((tmp_path / "sends.json").read_text())
        assert len(sent) == len({part["random_id"] for part in sent}) == 3
        assert sum(part["mentions"] for part in sent) == 101
        saved = ok(client.get(f'/api/tasks/{task["task_id"]}', headers=chat_work["master"].headers))
        assert saved["chat_announcement"]["state"] == "sent"
        assert poll(client) == []
        if os.getenv("PROFKOM_TASK_CHAT_PERF_REPORT"):
            from bot_models import BotStatusORM
            with db.atomic(), db._session() as session:
                session.get(BotStatusORM, 1).last_seen_at = "2000-01-01T00:00:00Z"
            measure_creation(origin, chat_work, os.environ["PROFKOM_TASK_CHAT_PERF_REPORT"])
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        server_socket.close()
        assert not thread.is_alive(), "Disposable localhost server failed to stop"
