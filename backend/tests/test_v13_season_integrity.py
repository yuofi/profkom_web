import json, pytest
from database import db, AssignmentORM, ContributionORM, UserORM
from models import Block
from test_v13_tracker import work


def accept(client, w):
    a = w["task"]["assignments"][0]["assignment_id"]
    r = client.post(
        f"/api/assignments/{a}/submit",
        headers=w["member"].headers,
        json=dict(expected_revision=1, text="Done", links=[], file_ids=[]),
    )
    assert r.status_code == 200, r.text
    r = client.post(
        f"/api/assignments/{a}/accept",
        headers=w["master"].headers,
        json=dict(expected_revision=client.get(f"/api/assignments/{a}/assessment-inputs",headers=w["master"].headers).json()["workflow_revision"], evaluation=1),
    )
    assert r.status_code == 200, r.text
    return a


def close(client, w, chair):
    sid = w["season"]["season_id"]
    r = client.post(
        f"/api/seasons/{sid}/begin-summary",
        headers=chair.headers,
        json=dict(expected_revision=2),
    )
    assert r.status_code == 200, r.text
    r = client.post(
        f"/api/seasons/{sid}/close",
        headers=chair.headers,
        json=dict(expected_revision=3),
    )
    assert r.status_code == 200, r.text
    return r.json()["summary"]


def test_close_bonus_snapshot_matches_ledger_and_is_repeatable(client, work, superuser):
    w = work
    accept(client, w)
    db.create_block(Block(name="Vacant", master=""))
    summary = close(client, w, superuser)
    sid = w["season"]["season_id"]
    again = client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()
    assert summary == again
    ledger = client.get(
        "/api/assessments", params=dict(season_id=sid), headers=superuser.headers
    ).json()["items"]
    for row in summary["rows"]:
        assert row["total_score"] == pytest.approx(
            sum(
                c["score"] or 0
                for c in ledger
                if c["user"]["user_id"] == row["user"]["user_id"]
            )
        )
    master = next(
        r for r in summary["rows"] if r["user"]["user_id"] == w["master"].user_id
    )
    assert master["total_score"] > 0
    assert (
        client.post(
            f"/api/seasons/{sid}/close",
            headers=superuser.headers,
            json=dict(expected_revision=4),
        ).status_code
        == 409
    )
    assert (
        client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()
        == again
    )


def test_correction_is_atomic_and_preserves_older_versions_and_categories(
    client, work, superuser
):
    w = work
    aid = accept(client, w)
    original = close(client, w, superuser)
    sid = w["season"]["season_id"]
    ver = original["version"]

    def change(hours, revision=None):
        return dict(
            kind="assessment_inputs",
            id=aid,
            expected_revision=revision if revision is not None else client.get(f"/api/assignments/{aid}/assessment-inputs",headers=superuser.headers).json()["revision"],
            values=dict(hours=hours),
        )

    bad = client.post(
        f"/api/seasons/{sid}/summary/correct",
        headers=superuser.headers,
        json=dict(
            expected_version=ver,
            reason="Atomic test",
            changes=[
                change(4),
                dict(
                    kind="task_inputs",
                    id="missing",
                    expected_revision=1,
                    values=dict(criteria={}),
                ),
            ],
        ),
    )
    assert bad.status_code == 404, bad.text
    with db._session() as s:
        assert s.get(AssignmentORM, aid).hours == 2
        assert s.get(AssignmentORM, aid).status == "accepted"
    db.update_user(w["member"].user_id, category="activist")
    r = client.post(
        f"/api/seasons/{sid}/summary/correct",
        headers=superuser.headers,
        json=dict(expected_version=ver, reason="Correct hours", changes=[change(4)]),
    )
    assert r.status_code == 200, r.text
    corrected = r.json()
    assert corrected["applied_revisions"] == [dict(kind="assessment_inputs", id=aid, revision=3)]
    assert corrected["version"] == ver + 1
    assert (
        next(
            x for x in corrected["rows"] if x["user"]["user_id"] == w["member"].user_id
        )["category"]
        == "junior"
    )
    history = client.get(
        f"/api/seasons/{sid}/summary/versions/{ver}", headers=superuser.headers
    )
    assert history.status_code == 200, history.text
    assert history.json()["summary"]["rows"] == original["rows"]
    assert (
        client.get(
            f"/api/seasons/{sid}/summary/versions", headers=w["member"].headers
        ).status_code
        == 403
    )
    # Direct authorized closed PATCH must also version and recalculate the snapshot.
    r = client.patch(
        f"/api/assignments/{aid}/assessment-inputs",
        headers=superuser.headers,
        json=dict(expected_revision=3, hours=6, reason="Second correction"),
    )
    assert r.status_code == 200, r.text
    assert (
        client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()[
            "version"
        ]
        == ver + 2
    )


def test_first_decision_write_and_stale_version(client, work, superuser):
    w = work
    sid = w["season"]["season_id"]
    uid = w["member"].user_id
    r = client.put(
        f"/api/seasons/{sid}/summary/decisions/{uid}",
        headers=superuser.headers,
        json=dict(expected_version=1, decisions=["nice"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    assert next(x for x in r.json()["rows"] if x["user"]["user_id"] == uid)[
        "decisions"
    ] == ["nice"]
    assert (
        client.put(
            f"/api/seasons/{sid}/summary/decisions/{uid}",
            headers=superuser.headers,
            json=dict(expected_version=1, decisions=["kick"]),
        ).status_code
        == 409
    )


def test_event_season_correction_moves_reports_merits_and_tasks(
    client, work, superuser
):
    from datetime import datetime, timezone, timedelta
    from database import EventORM, MeritORM, ReportORM, TaskORM

    w = work
    sid = w["season"]["season_id"]
    now = datetime.now(timezone.utc)
    e = client.post(
        "/api/events",
        headers=superuser.headers,
        json=dict(season_id=sid, title="Event", description=""),
    ).json()
    eid = e["event_id"]
    assert (
        client.put(
            f"/api/events/{eid}/leaders",
            headers=superuser.headers,
            json=dict(expected_revision=1, user_ids=[w["master"].user_id]),
        ).status_code
        == 200
    )
    sub = client.post(
        f"/api/events/{eid}/subevents",
        headers=w["master"].headers,
        json=dict(title="Sub", description=""),
    ).json()
    subid = sub["subevent_id"]
    assert (
        client.put(
            f"/api/subevents/{subid}/organizers",
            headers=w["master"].headers,
            json=dict(expected_revision=1, user_ids=[w["member"].user_id]),
        ).status_code
        == 200
    )
    task = client.post(
        "/api/tasks",
        headers=w["master"].headers,
        json={**w["payload"], "scope": dict(kind="subevent", id=subid)},
    ).json()
    report = client.post(
        "/api/reports",
        headers=w["master"].headers,
        json=dict(
            owner_kind="event",
            owner_id=eid,
            kind="regular",
            title="Report",
            content="Report",
            file_ids=[],
        ),
    ).json()
    merit = client.post(
        "/api/merits",
        headers=w["master"].headers,
        json=dict(
            season_id=sid,
            source_kind="head_merit",
            event_id=eid,
            title="Merit",
            description="",
            assigned_at=(now - timedelta(days=2)).isoformat(),
            deadline_at=(now - timedelta(days=1)).isoformat(),
            criteria={},
            recipients=[
                dict(
                    user_id=w["outside"].user_id,
                    hours=1,
                    evaluation=1,
                    completed_at=(now - timedelta(days=1)).isoformat(),
                )
            ],
            reason="Work",
        ),
    ).json()
    target = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json=dict(
            title="Target",
            type="autumn_winter",
            starts_at=now.isoformat(),
            ends_at=(now + timedelta(days=2)).isoformat(),
        ),
    ).json()
    target_id = target["season_id"]
    revision = client.get(f"/api/events/{eid}", headers=superuser.headers).json()[
        "revision"
    ]
    payload = dict(
        object_kind="event",
        object_id=eid,
        expected_revision=revision,
        target_season_id=target_id,
        reason="Correction",
    )
    assert (
        client.post(
            "/api/season-corrections", headers=superuser.headers, json=payload
        ).status_code
        == 422
    )
    with db._session() as s:
        assert s.get(EventORM, eid).season_id == sid
    assert (
        client.patch(
            f"/api/seasons/{target_id}",
            headers=superuser.headers,
            json=dict(
                expected_revision=1,
                ends_at=(now + timedelta(days=120)).isoformat(),
                reason="Longer",
            ),
        ).status_code
        == 200
    )
    r = client.post("/api/season-corrections", headers=superuser.headers, json=payload)
    assert r.status_code == 200, r.text
    with db._session() as s:
        assert s.get(TaskORM, task["task_id"]).season_id == target_id
        assert s.get(ReportORM, report["report_id"]).season_id == target_id
        assert s.get(MeritORM, merit["merit_id"]).season_id == target_id
        assert s.get(TaskORM, w["task"]["task_id"]).season_id == sid
