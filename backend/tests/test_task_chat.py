"""Local synthetic coverage of scoped chat binding and the durable announcement protocol."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import hashlib
import json
import uuid

import pytest
from sqlalchemy import text

import bot_api
import task_chat as chat
from bot_models import BotLinkORM, BotStatusORM
from database import db, TaskORM, TaskQueueORM, TaskRosterORM, UserORM
from domain_models import ScopeChatBindingORM as Binding, ScopeChatCodeORM as Code, TaskChatAnnouncementORM as Job, TaskChatPartORM as Part
from settings import settings
from test_bot_api import BOT, HASH, body
from test_v13_tracker import work  # noqa:F401

PREFIX = "/api/bot/v1"


def seed_chat(client, work, monkeypatch):
    """Reusable synthetic setup for root's cross-component HTTP acceptance tests."""
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    at = chat.stamp(chat.now())
    with db._session() as session:
        for actor, vk in ((work["master"], 901), (work["member"], 902)):
            session.add(BotLinkORM(user_id=actor.user_id, vk_user_id=vk, messages_allowed=True, messages_at=at,
                token_status="ok", token_at=at, linked_at=at, updated_at=at))
        session.add(BotStatusORM(id=1, last_seen_at=bot_api.stamp(chat.now()), heartbeat_json=json.dumps({"features":[chat.FEATURE],"interval_s":5}), paused=False))
        session.commit()
    path = "/api/scopes/block/" + work["block"]["block_id"] + "/chat"
    code = client.post(path+"/link-code", headers=work["master"].headers, json={"expected_revision":0})
    assert code.status_code == 200, code.text
    response = client.post(PREFIX+"/chats/confirm", headers=BOT, json=dict(code=code.json()["code"], vk_user_id=901,
        bot_identity=777, peer_id=2000000001, title="Синтетический IT", observed_at=at, can_send=True, author_is_admin=True))
    assert response.status_code == 200, response.text
    return dict(path=path, binding=response.json(), code=code.json()["code"], **work)


@pytest.fixture
def linked(client, work, monkeypatch): return seed_chat(client, work, monkeypatch)


def task(client, linked, **extra):
    payload = {**linked["payload"], "idempotency_key":str(uuid.uuid4()), "chat_announcement":{"enabled":True,"binding_revision":linked["binding"]["revision"]}, **extra}
    response = client.post("/api/tasks", headers=linked["master"].headers, json=payload)
    assert response.status_code == 200, response.text
    return response.json(), payload


def work_job(client):
    response = client.get(PREFIX+"/work", headers=BOT, params={"features":chat.FEATURE})
    assert response.status_code == 200, response.text
    return response.json()["chat_announcements"][0]


def lease(client, descriptor, worker=None):
    response = client.post(PREFIX+"/chat-announcements/"+descriptor["job_id"]+"/claim", headers=BOT,
        json={"worker_id":worker or str(uuid.uuid4()), "payload_hash":descriptor["payload_hash"]})
    assert response.status_code == 200, response.text
    return response.json()


def authorize(client, descriptor, claim, part=0, total=1, random_id=51):
    payload = dict(lease_token=claim["lease_token"], fence=claim["fence"], part_number=part, parts_total=total,
        random_id=random_id, part_hash=hashlib.sha256(str(part).encode()).hexdigest(), payload_hash=descriptor["payload_hash"])
    response=client.post(PREFIX+"/chat-announcements/"+descriptor["job_id"]+"/authorize", headers=BOT, json=payload)
    assert response.status_code == 200, response.text
    return payload, response.json()


def report_part(client, descriptor, auth, status="sent", **extra):
    payload={k:auth[k] for k in ("lease_token","fence","part_number","random_id","part_hash")}
    payload.update(job_id=descriptor["job_id"], status=status, **extra)
    return client.post(PREFIX+"/report", headers=BOT, json=body(hb=None, chat_results=[payload]))


def test_atomic_outbox_idempotency_and_read_only_feature_negotiation(client, linked):
    created, payload=task(client,linked)
    assert created["chat_announcement"]["state"] == "pending"
    repeat=client.post("/api/tasks",headers=linked["master"].headers,json=payload)
    assert repeat.status_code==200 and repeat.json()["task_id"]==created["task_id"]
    changed=client.post("/api/tasks",headers=linked["master"].headers,json={**payload,"chat_announcement":None})
    assert changed.status_code==409
    assert "chat_announcements" not in client.get(PREFIX+"/work",headers=BOT).json()
    desc=work_job(client)
    assert desc["mode"]=="assignees" and desc["recipient_vk_ids"]==[902]
    assert "Текст" not in desc["text"]
    with db._session() as session:
        assert session.query(Job).count()==1
        before=session.execute(text("SELECT total_changes() ")).scalar()
        assert chat.due_work(50,chat.now())
        assert session.execute(text("SELECT total_changes() ")).scalar()==before
        assert session.query(Job).one().state=="pending"
    bad={**payload,"idempotency_key":str(uuid.uuid4()),"chat_announcement":{"enabled":True,"binding_revision":99}}
    with db._session() as session: before=session.query(TaskORM).count()
    assert client.post("/api/tasks",headers=linked["master"].headers,json=bad).status_code==409
    with db._session() as session: assert session.query(TaskORM).count()==before


def test_lease_fences_manifest_and_sent_recovery(client, linked):
    task(client,linked);desc=work_job(client);worker=str(uuid.uuid4());claim=lease(client,desc,worker)
    assert lease(client,desc,worker)==claim
    other=client.post(PREFIX+"/chat-announcements/"+desc["job_id"]+"/claim",headers=BOT,json={"worker_id":str(uuid.uuid4()),"payload_hash":desc["payload_hash"]})
    assert other.status_code==409
    auth,_=authorize(client,desc,claim,total=2)
    assert report_part(client,desc,auth,message_id=123).status_code==200
    with db._session() as session:
        row=session.get(Job,desc["job_id"]);row.lease_expires_at=chat.stamp(chat.now()-timedelta(seconds=1));session.commit()
    claim2=lease(client,desc)
    assert claim2["fence"]==claim["fence"]+1
    stale=report_part(client,desc,auth,message_id=123)
    assert stale.status_code==409 and stale.json()["detail"]["code"]=="chat_lease_stale"
    auth2,result=authorize(client,desc,claim2,total=2)
    assert result["already_sent"] and result["message_id"]==123
    assert report_part(client,desc,auth2,message_id=123).status_code==200
    changed={**auth2,"random_id":999}
    assert client.post(PREFIX+"/chat-announcements/"+desc["job_id"]+"/authorize",headers=BOT,json=changed).status_code==409
    final,_=authorize(client,desc,claim2,part=1,total=2,random_id=52)
    assert report_part(client,desc,final,message_id=124).status_code==200
    assert report_part(client,desc,final,message_id=124).status_code==200
    with db._session() as session:
        assert session.get(Job,desc["job_id"]).state=="sent"
        assert session.query(Part).count()==2


def test_unlink_stale_revision_cancels_and_code_is_one_use(client,linked):
    task(client,linked);desc=work_job(client);claim=lease(client,desc)
    repeat=dict(code=linked["code"],vk_user_id=901,bot_identity=777,peer_id=2000000001,title="Синтетический IT",
        observed_at=chat.stamp(chat.now()),can_send=True,author_is_admin=True)
    assert client.post(PREFIX+"/chats/confirm",headers=BOT,json=repeat).status_code==200
    assert client.post(PREFIX+"/chats/confirm",headers=BOT,json={**repeat,"peer_id":2000000002}).status_code==409
    assert client.request("DELETE",linked["path"],headers=linked["master"].headers,json={"expected_revision":0}).status_code==409
    unlinked=client.request("DELETE",linked["path"],headers=linked["master"].headers,json={"expected_revision":1})
    assert unlinked.status_code==200 and unlinked.json()["binding"] is None and unlinked.json()["revision"]==2
    assert client.post(PREFIX+"/chats/confirm",headers=BOT,json=repeat).status_code==409
    with db._session() as session: assert session.get(Job,desc["job_id"]).state=="cancelled"
    auth=dict(lease_token=claim["lease_token"],fence=claim["fence"],part_number=0,parts_total=1,random_id=51,part_hash="a"*64,payload_hash=desc["payload_hash"])
    assert client.post(PREFIX+"/chat-announcements/"+desc["job_id"]+"/authorize",headers=BOT,json=auth).status_code==409


def test_private_missing_identity_roles_and_offline(client,linked,monkeypatch):
    qid=linked["task"]["queue"]["queue_id"]
    params={"queue_id":qid,"assignee_user_ids":str(linked["member"].user_id)}
    assert client.get("/api/tasks/chat-context",headers=linked["master"].headers,params=params).json()["available"]
    with db._session() as session:
        row=session.get(BotStatusORM,1);row.last_seen_at=bot_api.stamp(chat.now()-timedelta(days=1));session.commit()
    offline=client.get("/api/tasks/chat-context",headers=linked["master"].headers,params=params).json()
    assert offline["available"] and not offline["bot_online"]
    task(client,linked)
    assert client.get(linked["path"],headers=linked["member"].headers).status_code==403
    member=client.get("/api/tasks/chat-context",headers=linked["member"].headers,params=params).json()
    assert member["reason"]=="forbidden"
    with db._session() as session:
        session.get(TaskQueueORM,qid).is_private=True;session.commit()
    result=client.get("/api/tasks/chat-context",headers=linked["master"].headers,params=params).json()
    assert result["reason"]=="private_queue"
    with db._session() as session:
        session.get(TaskQueueORM,qid).is_private=False
        session.delete(session.get(BotLinkORM,linked["member"].user_id));session.commit()
    result=client.get("/api/tasks/chat-context",headers=linked["master"].headers,params=params).json()
    assert result["reason"]=="missing_vk" and result["missing_vk_user_ids"]==[linked["member"].user_id]


def test_retry_generation_and_duplicate_failure_do_not_duplicate_parts(client,linked):
    created,_=task(client,linked);desc=work_job(client);claim=lease(client,desc);auth,_=authorize(client,desc,claim)
    assert report_part(client,desc,auth,status="failed",error_code="send_denied").status_code==200
    assert report_part(client,desc,auth,status="failed",error_code="send_denied").status_code==200
    with db._session() as session:
        job=session.get(Job,desc["job_id"]);assert job.attempts==1;revision=job.revision
    retry=client.post("/api/tasks/"+created["task_id"]+"/chat-announcement/retry",headers=linked["master"].headers,json={"expected_revision":revision})
    assert retry.status_code==200,retry.text
    assert work_job(client)["retry_generation"]==1
    claim2=lease(client,desc);auth2,_=authorize(client,desc,claim2)
    assert report_part(client,desc,auth2,message_id=3).status_code==200
    with db._session() as session: assert session.query(Part).count()==1


def test_sweep_cancels_stale_recipient_snapshot_and_expiry(client,linked):
    created,_=task(client,linked)
    with db._session() as session:
        session.get(TaskRosterORM,(created["task_id"],linked["member"].user_id)).role="left";session.commit()
    heartbeat={"version":"synthetic","started_at":chat.stamp(chat.now()),"interval_s":5,"features":[chat.FEATURE]}
    response=client.post(PREFIX+"/report",headers=BOT,json=body(hb=heartbeat))
    assert response.status_code==200,response.text
    result=client.get("/api/tasks/"+created["task_id"],headers=linked["master"].headers).json()["chat_announcement"]
    assert result["state"]=="cancelled" and result["error_code"]=="payload_changed"


def test_parallel_duplicate_create_and_competing_claims(client,linked):
    payload={**linked["payload"],"idempotency_key":str(uuid.uuid4()),"chat_announcement":{"enabled":True,"binding_revision":1}}
    def create(_): return client.post("/api/tasks",headers=linked["master"].headers,json=payload)
    with ThreadPoolExecutor(max_workers=4) as pool: responses=list(pool.map(create,range(6)))
    assert all(r.status_code==200 for r in responses),[(r.status_code,r.text) for r in responses]
    assert len({r.json()["task_id"] for r in responses})==1
    with db._session() as session: assert session.query(Job).count()==1
    desc=work_job(client)
    def compete(_): return client.post(PREFIX+"/chat-announcements/"+desc["job_id"]+"/claim",headers=BOT,
        json={"worker_id":str(uuid.uuid4()),"payload_hash":desc["payload_hash"]})
    with ThreadPoolExecutor(max_workers=4) as pool: claims=list(pool.map(compete,range(6)))
    assert sorted(r.status_code for r in claims)==[200,409,409,409,409,409]


def test_code_hash_only_rotation_expiry_and_durable_attempt_limit(client,linked):
    created=client.post(linked["path"]+"/link-code",headers=linked["master"].headers,json={"expected_revision":1})
    assert created.status_code==200
    again=client.post(linked["path"]+"/link-code",headers=linked["master"].headers,json={"expected_revision":1})
    with db._session() as session:
        assert session.get(Code,chat.digest(created.json()["code"])).expires_at <= chat.stamp(chat.now())
        assert all(created.json()["code"] not in str(vars(r)) for r in session.query(Code))
    payload=dict(code="bad-code",vk_user_id=1001,bot_identity=777,peer_id=2000000001,title="Synthetic",
                 observed_at=chat.stamp(chat.now()),can_send=True,author_is_admin=True)
    for _ in range(5): assert client.post(PREFIX+"/chats/confirm",headers=BOT,json=payload).status_code==409
    assert client.post(PREFIX+"/chats/confirm",headers=BOT,json=payload).status_code==429
    wrong=client.post(PREFIX+"/chats/confirm",headers=BOT,json={**payload,"vk_user_id":902,"code":again.json()["code"]})
    assert wrong.status_code==409
    stale=client.post(PREFIX+"/chats/confirm",headers=BOT,json={**payload,"vk_user_id":901,"code":again.json()["code"],"observed_at":chat.stamp(chat.now()-timedelta(minutes=3))})
    assert stale.status_code==409 and stale.json()["detail"]["code"]=="chat_observation_stale"


def test_primary_lead_only_service_cannot_issue_but_can_revoke(client,linked,make_user,monkeypatch):
    deputy=make_user()
    block=client.get("/api/blocks",headers=linked["master"].headers).json()[0]
    leader=block["master"]
    db.set_deputies(leader["role_assignment_id"],[deputy.user_id],leader["revision"])
    card=client.get("/api/blocks",headers=deputy.headers).json()[0]
    assert "edit_block" in card["capabilities"] and "manage_chat" not in card["capabilities"]
    assert client.post(linked["path"]+"/link-code",headers=deputy.headers,json={"expected_revision":1}).status_code==403
    from test_service_account import LOGIN, PASSWORD, HASH as ROOT_HASH, service
    monkeypatch.setattr(settings,"ROOT_LOGIN",LOGIN)
    monkeypatch.setattr(settings,"ROOT_PASSWORD_HASH",ROOT_HASH)
    _, headers = service(client)
    view=client.get(linked["path"],headers=headers)
    assert view.status_code==200,view.text
    assert "unlink_chat" in view.json()["capabilities"] and "link_chat" not in view.json()["capabilities"]
    assert client.post(linked["path"]+"/link-code",headers=headers,json={"expected_revision":1}).status_code==403
    assert client.request("DELETE",linked["path"],headers=headers,json={"expected_revision":1}).status_code==200


def test_startup_adds_chat_tables_twice_preserving_legacy_rows(linked,tmp_path):
    """Rehearse a real SQLite backup of the synthetic schema without the additive tables."""
    import os
    import sqlite3
    import subprocess
    import sys
    from pathlib import Path
    import database
    target=tmp_path/"legacy.db"
    with sqlite3.connect(database.engine.url.database) as source, sqlite3.connect(target) as destination:
        source.backup(destination)
    tables=("task_chat_parts","task_chat_announcements","scope_chat_attempts","scope_chat_codes","scope_chat_bindings")
    with sqlite3.connect(target) as conn:
        for table in tables: conn.execute('DROP TABLE '+table)
        preserved={name:conn.execute('SELECT * FROM '+name+' ORDER BY 1').fetchall() for name in ("users","tasks","task_tracker","task_queues","block_metadata")}
    env={**os.environ,"DATABASE_PATH":str(target)}
    for _ in range(2):
        result=subprocess.run([sys.executable,"-c","import database"],cwd=Path(__file__).resolve().parents[1],env=env,capture_output=True,text=True,timeout=40)
        assert result.returncode==0,result.stderr
        with sqlite3.connect(target) as conn:
            assert conn.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
            assert all(conn.execute('SELECT count(*) FROM '+table).fetchone()[0]==0 for table in tables)
            assert preserved=={name:conn.execute('SELECT * FROM '+name+' ORDER BY 1').fetchall() for name in preserved}


def test_optional_intent_preserves_pre_feature_idempotency_digest(client,linked):
    from main import TaskCreateIn
    import request_keys
    payload={**linked["payload"],"idempotency_key":str(uuid.uuid4())}
    model=TaskCreateIn(**payload)
    legacy_hash=hashlib.sha256(model.model_dump_json(exclude={"idempotency_key","chat_announcement"}).encode()).hexdigest()
    assert request_keys.digest(model)==legacy_hash
    disabled=TaskCreateIn(**{**payload,"chat_announcement":{"enabled":False}})
    assert request_keys.digest(disabled)==legacy_hash
    first=client.post("/api/tasks",headers=linked["master"].headers,json=payload)
    assert first.status_code==200
    repeat=client.post("/api/tasks",headers=linked["master"].headers,json={**payload,"chat_announcement":{"enabled":False}})
    assert repeat.status_code==200 and repeat.json()["task_id"]==first.json()["task_id"]
    with db._session() as session: assert session.query(Job).count()==0


def test_retention_erases_typed_vk_recipients_and_does_not_replay(client,linked,superuser):
    from account_cleanup import purge
    from test_retention_release_criteria import archive
    created,_=task(client,linked)
    archive(client,superuser,linked["member"])
    assert purge("2024-01-01T00:00:00+00:00",False)["purged_count"]==1
    with db._session() as session:
        job=session.query(Job).filter_by(task_id=created["task_id"]).one()
        assert job.state=="cancelled"
        assert json.loads(job.recipient_user_ids_json)==[]
        assert json.loads(job.payload_json)["recipient_vk_ids"]==[]


def test_event_primary_leader_binding_and_no_implicit_subevent_inheritance(client,linked,superuser):
    event=client.post("/api/events",headers=superuser.headers,json={"season_id":linked["season"]["season_id"],"title":"Синтетическое событие"})
    assert event.status_code==200,event.text
    event=event.json();eid=event["event_id"]
    assigned=client.put("/api/events/"+eid+"/leaders",headers=superuser.headers,
        json={"expected_revision":event["revision"],"user_ids":[linked["master"].user_id]})
    assert assigned.status_code==200,assigned.text
    event_card=client.get("/api/events/"+eid,headers=linked["master"].headers).json()
    assert "manage_chat" in event_card["capabilities"]
    path="/api/scopes/event/"+eid+"/chat"
    code=client.post(path+"/link-code",headers=linked["master"].headers,json={"expected_revision":0})
    assert code.status_code==200,code.text
    confirmed=client.post(PREFIX+"/chats/confirm",headers=BOT,json={"code":code.json()["code"],"vk_user_id":901,
        "bot_identity":777,"peer_id":2000000002,"title":"Команда события","observed_at":chat.stamp(chat.now()),"can_send":True,"author_is_admin":True})
    assert confirmed.status_code==200,confirmed.text
    created,_=task(client,linked,scope={"kind":"event","id":eid},assignees=[])
    desc=work_job(client)
    assert desc["peer_id"]==2000000002 and desc["mode"]=="all" and desc["recipient_vk_ids"]==[]
    sub=client.get("/api/tasks/chat-context",headers=linked["master"].headers,params={"scope_kind":"subevent","scope_id":"synthetic"})
    assert sub.status_code==200 and sub.json()["reason"]=="unsupported_scope"


def test_work_bounded_overfetch_and_rotating_sweep_do_not_starve(client,linked):
    jobs=[]
    for i in range(29):
        created,_=task(client,linked,title="Synthetic "+str(i))
        jobs.append(created)
    with db._session() as session:
        # The first ten jobs fail their recipient snapshot; an eleventh valid must be offered.
        for created in jobs[:10]: session.get(TaskRosterORM,(created["task_id"],linked["member"].user_id)).role="left"
        session.commit()
    assert work_job(client)["task_id"]==jobs[10]["task_id"]
    at=chat.now()
    with db.atomic(), db._session() as session:
        chat.sweep(session,at)
        session.flush()
        assert session.query(Job).filter(Job.checked_at.isnot(None)).count()==25
        last=session.get(TaskRosterORM,(jobs[-1]["task_id"],linked["member"].user_id));last.role="left"
    with db.atomic(), db._session() as session:
        chat.sweep(session,at+timedelta(seconds=1))
        session.flush()
        assert session.query(Job).filter_by(task_id=jobs[-1]["task_id"]).one().state=="cancelled"
        assert session.query(Job).filter(Job.checked_at.isnot(None)).count()==29


def test_anonymized_creator_summary_and_legacy_nested_nulls(client,linked,superuser):
    from account_cleanup import purge
    from test_retention_release_criteria import archive
    created,_=task(client,linked)
    archive(client,superuser,linked["master"])
    assert purge("2024-01-01T00:00:00+00:00",False)["purged_count"]==1
    response=client.get("/api/tasks/"+created["task_id"],headers=superuser.headers)
    assert response.status_code==200,response.text
    assert response.json()["chat_announcement"]["created_by"]["user_id"] is None
    work=bot_api.Work(server_time=bot_api.stamp(chat.now()),commands=[bot_api.Command(command_id="synthetic",kind="logs",args={},
        requested_by=bot_api.Requester(),created_at=bot_api.stamp(chat.now()))]).model_dump()
    assert "chat_announcements" not in work
    assert work["commands"][0]["requested_by"]=={"user_id":None,"vk_user_id":None,"name":None}


def test_chat_only_report_runs_hourly_clean_using_stored_feature(client,linked,monkeypatch):
    called=[]
    monkeypatch.setattr(chat,"clean",lambda session,at:called.append(True))
    with db._session() as session:
        session.get(BotStatusORM,1).cleaned_at=bot_api.stamp(chat.now()-timedelta(hours=2));session.commit()
    result=client.post(PREFIX+"/report",headers=BOT,json=body(hb=None))
    assert result.status_code==200,result.text
    assert called==[True]


def test_same_report_sent_fact_survives_unavailable_observation_and_sweep(client,linked):
    created,_=task(client,linked);desc=work_job(client);claim=lease(client,desc);auth,_=authorize(client,desc,claim)
    result={key:auth[key] for key in ("lease_token","fence","part_number","random_id","part_hash")}
    result.update(job_id=desc["job_id"],status="sent",message_id=91)
    heartbeat={"version":"synthetic","started_at":chat.stamp(chat.now()),"interval_s":5,"features":[chat.FEATURE]}
    observation={"binding_id":desc["binding_id"],"binding_revision":desc["binding_revision"],"bot_identity":777,
        "peer_id":2000000001,"title":"Synthetic","state":"unavailable","observed_at":chat.stamp(chat.now())}
    response=client.post(PREFIX+"/report",headers=BOT,json=body(hb=heartbeat,chat_results=[result],chat_observations=[observation]))
    assert response.status_code==200,response.text
    with db._session() as session:
        assert session.get(Job,desc["job_id"]).state=="sent"
        assert session.get(Binding,desc["binding_id"]).state=="unavailable"


@pytest.mark.parametrize("has_sent_part", [False, True])
def test_expired_offline_announcement_projects_terminal_without_any_report_or_write(client,linked,has_sent_part):
    from test_bot_api import sql
    created,_=task(client,linked)
    desc=work_job(client)
    if has_sent_part:
        claim=lease(client,desc)
        authorize(client,desc,claim,total=2)
    with db._session() as session:
        job=session.get(Job,desc["job_id"])
        job.expires_at=chat.stamp(chat.now()-timedelta(seconds=1))
        if has_sent_part:
            part=session.get(Part,(job.announcement_id,0));part.state="sent";part.message_id=71
        session.commit()
        saved_state,saved_revision=job.state,job.revision
    # No heartbeat/report/maintenance is called; simply opening the task must stop polling.
    with sql() as statements:
        response=client.get("/api/tasks/"+created["task_id"],headers=linked["master"].headers)
    assert response.status_code==200,response.text
    view=response.json()["chat_announcement"]
    assert view["state"]==("partial" if has_sent_part else "cancelled")
    assert view["error_code"]=="expired" and view["capabilities"]==[]
    assert not any(statement.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "REPLACE")) for statement in statements)
    with db._session() as session:
        persisted=session.get(Job,desc["job_id"])
        assert (persisted.state,persisted.revision)==(saved_state,saved_revision)
        assert persisted.checked_at is None


def test_hourly_expiry_keeps_partial_beyond_rotating_sweep_budget(client,linked):
    from test_bot_api import sql
    created=[]
    for index in range(26):
        item,_=task(client,linked,title="Expiry budget "+str(index))
        created.append(item)
    last_id=created[-1]["chat_announcement"]["announcement_id"]
    with db._session() as session:
        last=session.get(Job,last_id)
        descriptor={"job_id":last_id,"payload_hash":last.payload_hash}
    claim=lease(client,descriptor)
    authorize(client,descriptor,claim,total=2,random_id=128)
    at=chat.now()
    with db.atomic(), db._session() as session:
        part=session.get(Part,(last_id,0));part.state="sent";part.message_id=81
        for job in session.query(Job):job.expires_at=chat.stamp(at-timedelta(seconds=1))
    with db.atomic(), db._session() as session:
        chat.sweep(session,at)
        session.flush()
        last=session.get(Job,last_id)
        assert last.checked_at is None and last.state=="sending"
        with sql() as statements:chat.clean(session,at)
        assert len([query for query in statements if query.upper().startswith("UPDATE TASK_CHAT_ANNOUNCEMENTS")])==1
    with db._session() as session:
        last=session.get(Job,last_id)
        assert last.state=="partial" and last.error_code=="expired"
        assert session.query(Job).filter_by(state="cancelled").count()==25
        assert chat.summary(session,last,linked["master"].user_id)["capabilities"]==[]
        persisted_revision=last.revision
    # Repeat maintenance does not reopen/reset a terminal job or increment its revision.
    with db.atomic(), db._session() as session:chat.clean(session,at+timedelta(minutes=1))
    with db._session() as session:assert session.get(Job,last_id).revision==persisted_revision
