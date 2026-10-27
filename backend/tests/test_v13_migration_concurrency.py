import hashlib, json, os, sqlite3, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from database import db, SeasonORM, RoleAssignmentORM
from test_v13_tracker import work


def test_legacy_migration_and_explicit_mapping_are_repeatable(tmp_path):
    path = tmp_path / "legacy.db"
    report = tmp_path / "report.json"
    root = Path(__file__).resolve().parents[1]
    with sqlite3.connect(path) as c:
        c.executescript("""
        CREATE TABLE users(user_id INTEGER PRIMARY KEY,hashed_password TEXT NOT NULL,kkr_score INTEGER NOT NULL,group_number TEXT NOT NULL,blocks TEXT NOT NULL,banned BOOLEAN NOT NULL,super_user BOOLEAN NOT NULL,admin BOOLEAN NOT NULL,photo_url TEXT);
        CREATE TABLE contact_info(user_id INTEGER PRIMARY KEY,surname TEXT NOT NULL,name TEXT NOT NULL,patronymic TEXT NOT NULL,kkr_name TEXT NOT NULL,group_number TEXT NOT NULL,location TEXT NOT NULL,blocks TEXT NOT NULL,phone TEXT NOT NULL,vk TEXT NOT NULL,tg TEXT NOT NULL,email TEXT NOT NULL UNIQUE,budget BOOLEAN NOT NULL,in_profcom BOOLEAN NOT NULL);
        CREATE TABLE block(name TEXT PRIMARY KEY,master TEXT NOT NULL,hr TEXT NOT NULL,cnt_of_human INTEGER NOT NULL,arr_of_human TEXT NOT NULL);
        CREATE TABLE guides(guide_id INTEGER PRIMARY KEY,title TEXT NOT NULL,owner_block TEXT NOT NULL,text TEXT NOT NULL,description TEXT NOT NULL,original_link TEXT);
        CREATE TABLE pgas_entries(entry_id INTEGER PRIMARY KEY,title TEXT NOT NULL,year INTEGER NOT NULL,file_url TEXT NOT NULL,file_name TEXT NOT NULL,file_type TEXT NOT NULL,created_at TEXT NOT NULL,uploaded_by INTEGER);
        INSERT INTO users VALUES(1,'synthetic',0,'301','IT',0,1,1,'https://sun.userapi.com/photo.png');
        INSERT INTO contact_info VALUES(1,'Имя','Тест','','Тест Имя','301','','IT','','','','one@example.com',1,1);
        INSERT INTO block VALUES('IT','Тест Имя','',1,'[1]');
        INSERT INTO guides VALUES(42,'КМБ','none','<p><strong>Исходный</strong></p>','Old',NULL);
        INSERT INTO pgas_entries VALUES(7,'ПГАС',2025,'https://example.com/old.pdf','old.pdf','application/pdf','2025-01-01T00:00:00Z',1);
        """)
    cmd = [
        sys.executable,
        str(root / "scripts/migrate_v13.py"),
        "--database",
        str(path),
        "--report",
        str(report),
    ]
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    subprocess.run(cmd, check=True, cwd=root, capture_output=True)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    subprocess.run(cmd + ["--apply"], check=True, cwd=root, capture_output=True)
    with sqlite3.connect(path) as c:
        assert (
            c.execute(
                "SELECT COUNT(*) FROM role_assignments WHERE scope_kind='global'"
            ).fetchone()[0]
            == 0
        )
        assert (
            c.execute("SELECT text FROM guides WHERE guide_id=42").fetchone()[0]
            == "<p><strong>Исходный</strong></p>"
        )
        assert (
            c.execute("SELECT file_url FROM pgas_entries WHERE entry_id=7").fetchone()[
                0
            ]
            == "https://example.com/old.pdf"
        )
        assert (
            c.execute("SELECT photo_url FROM users WHERE user_id=1").fetchone()[0]
            is None
        )
        mid = c.execute(
            "SELECT material_id FROM materials WHERE legacy_guide_id=42"
        ).fetchone()[0]
        bid = c.execute(
            "SELECT block_id FROM block_metadata WHERE legacy_name='IT'"
        ).fetchone()[0]
        counts = {
            t: c.execute("SELECT COUNT(*) FROM " + t).fetchone()[0]
            for t in (
                "users",
                "contact_info",
                "guides",
                "pgas_entries",
                "materials",
                "memberships",
            )
        }
    mapping = tmp_path / "ids.json"
    mapping.write_text(
        json.dumps(
            dict(
                chair_user_id=1,
                hr_block_id=bid,
                block_masters=[dict(block_id=bid, user_id=1)],
                vk_identities=[dict(vk_user_id="123", user_id=1)],
                participation_intervals=[
                    dict(user_id=1, started_at="2026-01-01T00:00:00Z", ended_at=None)
                ],
            )
        )
    )
    for _ in range(2):
        subprocess.run(
            cmd + ["--apply", "--mapping", str(mapping)],
            check=True,
            cwd=root,
            capture_output=True,
        )
    with sqlite3.connect(path) as c:
        assert counts == {
            t: c.execute("SELECT COUNT(*) FROM " + t).fetchone()[0] for t in counts
        }
        assert (
            c.execute(
                "SELECT material_id FROM materials WHERE legacy_guide_id=42"
            ).fetchone()[0]
            == mid
        )
        assert (
            c.execute(
                "SELECT COUNT(*) FROM role_assignments WHERE role='chair'"
            ).fetchone()[0]
            == 1
        )
        assert (
            c.execute(
                "SELECT COUNT(*) FROM role_assignments WHERE role='master'"
            ).fetchone()[0]
            == 1
        )
        assert c.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    # Retention dry-run must not run startup migrations or change the DB.
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    subprocess.run(
        [
            sys.executable,
            str(root / "scripts/cleanup_accounts.py"),
            "--database",
            str(path),
        ],
        check=True,
        cwd=root,
        capture_output=True,
    )
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_concurrent_planned_creation_and_assignment_accept_are_atomic(
    app, client, superuser, work
):
    from datetime import datetime, timezone, timedelta

    def send(path, body, headers):
        with TestClient(app) as c:
            return c.post(path, headers=headers, json=body)

    # The work fixture's season is open, so exactly one new planned season is allowed.
    now = datetime.now(timezone.utc)
    body = dict(
        title="Planned",
        type="autumn_winter",
        starts_at=now.isoformat(),
        ends_at=(now + timedelta(days=100)).isoformat(),
    )
    with ThreadPoolExecutor(2) as pool:
        responses = list(
            pool.map(lambda _: send("/api/seasons", body, superuser.headers), range(2))
        )
    assert sorted(r.status_code for r in responses) == [200, 409]
    w = work
    aid = w["task"]["assignments"][0]["assignment_id"]
    submitted = send(
        "/api/assignments/" + aid + "/submit",
        dict(expected_revision=1, text="Done", links=[], file_ids=[]),
        w["member"].headers,
    )
    assert submitted.status_code == 200, submitted.text
    body = dict(expected_revision=client.get("/api/assignments/"+aid+"/assessment-inputs",headers=w["master"].headers).json()["workflow_revision"], evaluation=1)
    with ThreadPoolExecutor(2) as pool:
        responses = list(
            pool.map(
                lambda _: send(
                    "/api/assignments/" + aid + "/accept", body, w["master"].headers
                ),
                range(2),
            )
        )
    assert sorted(r.status_code for r in responses) == [200, 409]
    from database import ContributionORM

    with db._session() as s:
        assert s.query(ContributionORM).filter_by(assignment_id=aid).count() == 1


def test_competing_chair_transfers_leave_one_chair(app, client, superuser, make_user):
    from auth import create_access_token

    first = make_user()
    second = make_user()
    revision = db.get_leadership().revision

    def transfer(uid):
        with TestClient(app) as c:
            return c.post(
                "/api/leadership/transfer",
                headers=superuser.headers,
                json=dict(expected_revision=revision, new_chair_user_id=uid),
            )

    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(transfer, [first.user_id, second.user_id]))
    assert sum(r.status_code == 200 for r in responses) == 1
    assert all(r.status_code in (200, 403, 409) for r in responses)
    lead = db.get_leadership()
    assert lead.chair.user_id in (first.user_id, second.user_id) and lead.deputies == []
    assert not db.is_chair(superuser.user_id)
    with db._session() as s:
        assert (
            s.query(RoleAssignmentORM)
            .filter_by(role="chair", scope_kind="global")
            .count()
            == 1
        )


def test_competing_reassignment_does_not_duplicate_new_executor(
    app, client, work, make_user
):
    from membership import set_membership, block_id_for
    from database import AssignmentORM

    new = make_user()
    w = work
    bid = w["payload"]["scope"]["id"]
    aid = w["task"]["assignments"][0]["assignment_id"]
    with db.atomic():
        with db._session() as s:
            set_membership(
                s,
                new.user_id,
                bid,
                True,
                w["master"].user_id,
                "Fixture approved member",
            )
            s.commit()
    body = dict(
        expected_revision=1,
        new_assignee_user_id=new.user_id,
        hours=1,
        previous_outcome="cancelled",
        reason="Reassign",
    )

    def send(_):
        with TestClient(app) as c:
            return c.post(
                "/api/assignments/" + aid + "/reassign",
                headers=w["master"].headers,
                json=body,
            )

    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(send, range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    with db._session() as s:
        assert (
            s.query(AssignmentORM)
            .filter_by(task_id=w["task"]["task_id"], assignee_user_id=new.user_id)
            .count()
            == 1
        )
        assert s.get(AssignmentORM, aid).status == "cancelled"


def test_competing_report_publication_creates_one_version(app, client, work, superuser):
    from database import ReportVersionORM

    w = work
    event = client.post(
        "/api/events",
        headers=superuser.headers,
        json=dict(
            season_id=w["season"]["season_id"],
            title="Concurrent report",
            description="",
        ),
    ).json()
    assert (
        client.put(
            "/api/events/" + event["event_id"] + "/leaders",
            headers=superuser.headers,
            json=dict(expected_revision=1, user_ids=[w["master"].user_id]),
        ).status_code
        == 200
    )
    report = client.post(
        "/api/reports",
        headers=w["master"].headers,
        json=dict(
            owner_kind="event",
            owner_id=event["event_id"],
            kind="final",
            title="Final",
            content=dict(format="markdown", body="Final body"),
            file_ids=[],
        ),
    ).json()

    def send(_):
        with TestClient(app) as c:
            return c.post(
                "/api/reports/" + report["report_id"] + "/publish",
                headers=w["master"].headers,
                json=dict(expected_revision=1),
            )

    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(send, range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    with db._session() as s:
        assert (
            s.query(ReportVersionORM).filter_by(report_id=report["report_id"]).count()
            == 1
        )
