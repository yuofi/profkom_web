from datetime import datetime, timezone, timedelta
import pytest
from database import db, BlockORM, TaskORM, AssignmentORM, SeasonORM
from models import Block


@pytest.fixture
def work(client, superuser, make_user):
    master = make_user()
    member = make_user()
    outside = make_user()
    db.create_block(Block(name="IT", master="", arr_of_human=[member.user_id]))
    b = client.get("/api/blocks", headers=superuser.headers).json()[0]
    assert (
        client.put(
            f"/api/blocks/{b['block_id']}/leader",
            headers=superuser.headers,
            json={"user_id": master.user_id, "expected_revision": 1},
        ).status_code
        == 200
    )
    start = datetime.now(timezone.utc) - timedelta(days=10)
    end = start + timedelta(days=40)
    r = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json={
            "title": "Тестовый",
            "type": "autumn_winter",
            "starts_at": start.isoformat(),
            "ends_at": end.isoformat(),
        },
    )
    assert r.status_code == 200, r.text
    season = r.json()
    sid = season["season_id"]
    assert (
        client.post(
            f"/api/seasons/{sid}/open",
            headers=superuser.headers,
            json={"expected_revision": 1},
        ).status_code
        == 200
    )
    task = dict(
        season_id=sid,
        scope=dict(kind="block", id=b["block_id"]),
        title="Работа",
        description=dict(format="markdown", body="Текст"),
        deadline_at=(end - timedelta(days=1)).isoformat(),
        criteria={},
        assignees=[dict(user_id=member.user_id, hours=2)],
    )
    r = client.post("/api/tasks", headers=master.headers, json=task)
    assert r.status_code == 200, r.text
    return dict(
        master=master,
        member=member,
        outside=outside,
        block=b,
        season=season,
        task=r.json(),
        payload=task,
    )


def test_task_transitions_last_submission_and_hidden_inputs(client, work, superuser):
    w = work
    t = w["task"]
    a = t["assignments"][0]
    aid = a["assignment_id"]
    assert (
        client.post(
            f"/api/assignments/{aid}/accept",
            headers=w["master"].headers,
            json={"expected_revision": 1, "evaluation": 1},
        ).status_code
        == 422  # no observed submission or authorized completion date
    )
    r = client.post(
        f"/api/assignments/{aid}/submit",
        headers=w["member"].headers,
        json={
            "expected_revision": 1,
            "text": {"format": "markdown", "body": "Готово"},
            "file_ids": [],
            "links": [],
        },
    )
    assert r.status_code == 200, r.text
    submitted = r.json()["submissions"][-1]["submitted_at"]
    r = client.post(
        f"/api/assignments/{aid}/accept",
        headers=w["master"].headers,
        json={"expected_revision": accounting_revision(client,w,aid), "evaluation": 1},
    )
    assert r.status_code == 200, r.text
    own = client.get(f"/api/tasks/{t['task_id']}", headers=w["member"].headers).json()
    assert not (
        {"hours", "evaluation", "criteria", "score", "effective_completed_at"}
        & set(own)
    )
    inputs = client.get(
        f"/api/assignments/{aid}/assessment-inputs", headers=w["master"].headers
    ).json()
    assert inputs["effective_completed_at"] == submitted
    assert (
        client.get(
            f"/api/assignments/{aid}/assessment-inputs", headers=w["member"].headers
        ).status_code
        == 403
    )
    assert (
        client.get("/api/assessments", headers=w["master"].headers).status_code == 403
    )


def test_lost_scope_cannot_submit_or_read_private_file(client, work):
    w = work
    t = w["task"]
    a = t["assignments"][0]
    assert (
        client.post(
            f"/api/blocks/{w['block']['block_id']}/leave",
            headers=w["member"].headers,
            json={},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/assignments/{a['assignment_id']}/start",
            headers=w["member"].headers,
            json={"expected_revision": 1},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/assignments/{a['assignment_id']}/submit",
            headers=w["member"].headers,
            json={"expected_revision": 1, "text": "Нет", "file_ids": [], "links": []},
        ).status_code
        == 403
    )
    notices = client.get("/api/notifications", headers=w["member"].headers).json()[
        "items"
    ]
    assert all(n["target"] is None for n in notices)


def test_dates_negative_hours_and_attachments_are_validated(client, work, superuser):
    w = work
    tid = w["task"]["task_id"]
    # Dates are moved by the chair, deputies and HR master (УВ-5); the period still binds them.
    r = client.patch(
        f"/api/tasks/{tid}/assessment-inputs",
        headers=superuser.headers,
        json={
            "expected_revision": 1,
            "deadline_at": "2099-01-01T00:00:00Z",
            "reason": "Too late",
        },
    )
    assert r.status_code == 422
    for bad in ["2026-10-01", "not-a-date"]:
        assert (
            client.patch(
                f"/api/tasks/{tid}/assessment-inputs",
                headers=w["master"].headers,
                json={"expected_revision": 1, "deadline_at": bad, "reason": "Bad"},
            ).status_code
            == 422
        )
    a = w["task"]["assignments"][0]
    assert (
        client.post(
            f"/api/assignments/{a['assignment_id']}/submit",
            headers=w["member"].headers,
            json={
                "expected_revision": 1,
                "text": "File",
                "file_ids": ["unknown"],
                "links": [],
            },
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/tasks",
            headers=w["master"].headers,
            json={
                **w["payload"],
                "assignees": [{"user_id": w["member"].user_id, "hours": -1}],
            },
        ).status_code
        == 422
    )


def test_event_merit_cannot_change_its_season(client, work, superuser):
    w = work
    sid = w["season"]["season_id"]
    r = client.post(
        "/api/events",
        headers=superuser.headers,
        json=dict(season_id=sid, title="Event", description=""),
    )
    assert r.status_code == 200, r.text
    ev = r.json()
    assert (
        client.put(
            f"/api/events/{ev['event_id']}/leaders",
            headers=superuser.headers,
            json={"expected_revision": 1, "user_ids": [w["master"].user_id]},
        ).status_code
        == 200
    )
    second = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json=dict(
            title="Next",
            type="autumn_winter",
            starts_at="2028-01-01T00:00:00Z",
            ends_at="2028-06-01T00:00:00Z",
        ),
    ).json()
    merit = dict(
        season_id=second["season_id"],
        source_kind="head_merit",
        event_id=ev["event_id"],
        title="Merit",
        description="",
        assigned_at="2026-10-01T00:00:00Z",
        deadline_at="2026-10-02T00:00:00Z",
        criteria={},
        recipients=[
            dict(
                user_id=w["outside"].user_id,
                hours=1,
                evaluation=1,
                completed_at="2026-10-02T00:00:00Z",
            )
        ],
        reason="Postfactum",
    )
    assert (
        client.post("/api/merits", headers=w["master"].headers, json=merit).status_code
        == 422
    )


# FIX_PLAN 1.1 (A-TSK-2): a final outcome changes only through assessment inputs.
def assignment_in(client, w, status):
    """A fresh assignment of the member, brought to `status` through the API."""
    task = client.post("/api/tasks", headers=w["master"].headers, json=w["payload"]).json()
    aid = task["assignments"][0]["assignment_id"]
    post = lambda command, who, **body: client.post(f"/api/assignments/{aid}/{command}", headers=w[who].headers, json=dict(expected_revision=public_revision(client,w,aid) if command=="submit" else accounting_revision(client,w,aid), **body))  # noqa: E731
    if status in ("submitted", "accepted", "not_completed"):
        assert post("submit", "member", text=dict(format="markdown", body="Готово")).status_code == 200
    if status == "accepted":
        assert post("accept", "master", evaluation=1).status_code == 200
    if status == "not_completed":
        assert post("not-complete", "master", evaluation=0, reason="Не сделано").status_code == 200
    if status == "cancelled":
        assert post("cancel", "master", reason="Отменено").status_code == 200
    return aid


def public_revision(client, w, aid):
    """The assignment revision commands expect; hidden inputs have their own (decision 32)."""
    with db._session() as s:
        tid = s.get(AssignmentORM, aid).task_id
    task = client.get(f"/api/tasks/{tid}", headers=w["master"].headers).json()
    return next(a["revision"] for a in task["assignments"] if a["assignment_id"] == aid)


def accounting_revision(client,w,aid):
    response=client.get(f'/api/assignments/{aid}/assessment-inputs',headers=w['master'].headers)
    assert response.status_code==200,response.text
    return response.json()['workflow_revision']


def audit_rows(aid):
    import json
    from database import AuditLogORM

    with db._session() as s:
        return [
            (json.loads(r.old_values_json), json.loads(r.new_values_json), r.reason)
            for r in s.query(AuditLogORM).filter_by(target_kind="assignment", target_id=aid).order_by(AuditLogORM.id)
        ]


@pytest.mark.parametrize("status", ["accepted", "not_completed", "cancelled"])
@pytest.mark.parametrize("command,body", [("not-complete", dict(evaluation=-1, reason="Переоценка")), ("cancel", dict(reason="Отмена"))])
def test_final_outcome_is_not_overwritten_by_a_decision(client, work, superuser, status, command, body):
    aid = assignment_in(client, work, status)
    inputs = client.get(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers).json()
    totals = client.get("/api/assessments", headers=superuser.headers).json()
    r = client.post(f"/api/assignments/{aid}/{command}", headers=work["master"].headers, json=dict(expected_revision=accounting_revision(client,work,aid), **body))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "conflict"
    assert client.get(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers).json() == inputs
    task = client.get(f"/api/tasks/{work['task']['task_id']}", headers=work["master"].headers)
    assert task.status_code == 200
    with db._session() as s:
        assert s.get(AssignmentORM, aid).status == status
    assert client.get("/api/assessments", headers=superuser.headers).json() == totals


def test_not_complete_and_cancel_are_audited_with_the_evaluation(client, work):
    aid = assignment_in(client, work, "submitted")
    rev = accounting_revision(client,work,aid)
    r = client.post(f"/api/assignments/{aid}/not-complete", headers=work["master"].headers, json=dict(expected_revision=rev, evaluation=-1, reason="Сорван срок"))
    assert r.status_code == 200, r.text
    old,new,reason=audit_rows(aid)[-1]
    assert (old["status"],old["evaluation"],new["status"],new["evaluation"],reason)==("assigned",None,"not_completed",-1.0,"Сорван срок")
    assert old["hours"]==new["hours"] and old["effective_completed_at"]==new["effective_completed_at"]
    # A revision request after acceptance keeps the evaluation; cancelling clears it.
    aid = assignment_in(client, work, "accepted")
    rev = accounting_revision(client,work,aid)
    assert client.post(f"/api/assignments/{aid}/request-revision", headers=work["master"].headers, json=dict(expected_revision=rev, review_note="Доделать")).status_code == 200
    rev += 1
    r = client.post(f"/api/assignments/{aid}/cancel", headers=work["master"].headers, json=dict(expected_revision=rev, reason="Не нужна"))
    assert r.status_code == 200, r.text
    old,new,reason=audit_rows(aid)[-1]
    assert (old["status"],old["evaluation"],new["status"],new["evaluation"],reason)==("needs_revision",1.0,"cancelled",None,"Не нужна")
    assert old["hours"]==new["hours"] and old["effective_completed_at"]==new["effective_completed_at"]
    assert client.get(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers).json()["evaluation"] is None


def test_assessment_inputs_cannot_score_a_cancelled_assignment(client, work, superuser):
    aid = assignment_in(client, work, "cancelled")
    inputs = client.get(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers).json()
    totals = client.get("/api/assessments", headers=superuser.headers).json()
    for evaluation in (1, 0):
        r = client.patch(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers, json=dict(expected_revision=inputs["revision"], evaluation=evaluation, reason="Переоценка"))
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["code"] == "conflict"
    assert client.get(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers).json() == inputs
    assert client.get("/api/assessments", headers=superuser.headers).json() == totals
    # Hours alone may still be corrected; the assignment stays cancelled.
    r = client.patch(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers, json=dict(expected_revision=inputs["revision"], hours=3, reason="Часы"))
    assert r.status_code == 200, r.text
    with db._session() as s:
        assert s.get(AssignmentORM, aid).status == "cancelled"


@pytest.mark.parametrize("status,evaluation,after", [("accepted", 0, "not_completed"), ("not_completed", 1.5, "accepted")])
def test_assessment_inputs_change_of_outcome_is_audited(client, work, status, evaluation, after):
    aid = assignment_in(client, work, status)
    inputs = client.get(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers).json()
    r = client.patch(f"/api/assignments/{aid}/assessment-inputs", headers=work["master"].headers, json=dict(expected_revision=inputs["revision"], evaluation=evaluation, reason="Исправление"))
    assert r.status_code == 200, r.text
    old, new, reason = audit_rows(aid)[-1]
    assert (old["status"], new["status"], new["evaluation"], reason) == (status, after, float(evaluation), "Исправление")


# FIX_PLAN 1.2 (A-KKR-1): kind, season and scope of a merit are fixed at creation.
@pytest.mark.parametrize("field,value", [("season_id", None), ("source_kind", "block_volunteer"), ("scope", None), ("event_id", None)])
def test_merit_patch_refuses_fields_fixed_at_creation(client, work, field, value):
    w = work
    merit = dict(
        season_id=w["season"]["season_id"], source_kind="block_volunteer", scope=dict(kind="block", id=w["block"]["block_id"]),
        title="Афиша", description="", assigned_at="2026-10-01T00:00:00Z", deadline_at="2026-10-02T00:00:00Z", criteria={},
        recipients=[dict(user_id=w["outside"].user_id, hours=2, evaluation=1, completed_at="2026-10-02T00:00:00Z")], reason="Постфактум",
    )
    r = client.post("/api/merits", headers=w["master"].headers, json=merit)
    assert r.status_code == 200, r.text
    created = r.json()
    patch = dict(expected_revision=created["revision"], reason="Исправление", recipients=[dict(merit["recipients"][0], hours=3)])
    r = client.patch(f"/api/merits/{created['merit_id']}", headers=w["master"].headers, json={**patch, field: merit.get(field, value)})
    assert r.status_code == 422, r.text
    assert client.get(f"/api/merits/{created['merit_id']}", headers=w["master"].headers).json()["revision"] == created["revision"]
    r = client.patch(f"/api/merits/{created['merit_id']}", headers=w["master"].headers, json=patch)
    assert r.status_code == 200, r.text
    assert (r.json()["revision"], r.json()["recipients"][0]["hours"]) == (created["revision"] + 1, 3)


def task_audit(tid):
    import json
    from database import AuditLogORM

    with db._session() as s:
        return [(json.loads(r.old_values_json), json.loads(r.new_values_json)) for r in s.query(AuditLogORM).filter_by(target_kind="task", target_id=tid).order_by(AuditLogORM.id)]


# УВ-5: area leads fill hours, evaluation and criteria; only the chair, deputies and HR master move dates.
def test_area_lead_fills_inputs_but_moves_no_dates(client, work, superuser):
    from participation import dt

    w = work
    tid = w["task"]["task_id"]
    aid = w["task"]["assignments"][0]["assignment_id"]
    url = f"/api/tasks/{tid}/assessment-inputs"
    lead = client.get(url, headers=w["master"].headers).json()
    assert "edit_assessment_inputs" in lead["capabilities"] and "edit_assessment_dates" not in lead["capabilities"]
    assert {"edit_assessment_inputs", "edit_assessment_dates"} <= set(client.get(url, headers=superuser.headers).json()["capabilities"])
    r = client.patch(url, headers=w["master"].headers, json=dict(expected_revision=lead["revision"], criteria={"creative": True}, reason="Критерии"))
    assert r.status_code == 200, r.text
    rev, deadline = r.json()["revision"], r.json()["deadline_at"]
    moved = (dt(deadline) - timedelta(days=1)).isoformat()
    r = client.patch(url, headers=w["master"].headers, json=dict(expected_revision=rev, deadline_at=moved, reason="Перенос"))
    assert r.status_code == 403, r.text
    # The same instant in another notation is no move.
    same = dt(deadline).astimezone(timezone(timedelta(hours=3))).isoformat()
    r = client.patch(url, headers=w["master"].headers, json=dict(expected_revision=rev, deadline_at=same, criteria={"creative": True, "unique": True}, reason="Критерии"))
    assert r.status_code == 200, r.text
    assert r.json()["deadline_at"] == deadline
    rev = r.json()["revision"]
    r = client.patch(url, headers=superuser.headers, json=dict(expected_revision=rev, deadline_at=moved, reason="Перенос"))
    assert r.status_code == 200, r.text
    assert dt(r.json()["deadline_at"]) == dt(moved)
    old, new = task_audit(tid)[-1]
    assert (dt(old["deadline_at"]), dt(new["deadline_at"])) == (dt(deadline), dt(moved))

    # The completion date of an assignment follows the same rule; hours stay with the lead.
    inputs_url = f"/api/assignments/{aid}/assessment-inputs"
    inputs = client.get(inputs_url, headers=w["master"].headers).json()
    assert "edit_assessment_dates" not in inputs["capabilities"]
    r = client.patch(inputs_url, headers=w["master"].headers, json=dict(expected_revision=inputs["revision"], hours=4, reason="Часы"))
    assert r.status_code == 200, r.text
    inputs = r.json()
    completed = (dt(moved) - timedelta(days=2)).isoformat()
    r = client.patch(inputs_url, headers=w["master"].headers, json=dict(expected_revision=inputs["revision"], effective_completed_at=completed, reason="Дата"))
    assert r.status_code == 403, r.text
    assert "edit_assessment_dates" in client.get(inputs_url, headers=superuser.headers).json()["capabilities"]
    r = client.patch(inputs_url, headers=superuser.headers, json=dict(expected_revision=inputs["revision"], effective_completed_at=completed, reason="Дата"))
    assert r.status_code == 200, r.text
    assert audit_rows(aid)[-1][0]["effective_completed_at"] is None
    assert dt(audit_rows(aid)[-1][1]["effective_completed_at"]) == dt(completed)
    # Once set, the same instant in another notation passes the lead's form.
    other = dt(completed).astimezone(timezone(timedelta(hours=3))).isoformat()
    r = client.patch(inputs_url, headers=w["master"].headers, json=dict(expected_revision=r.json()["revision"], hours=5, effective_completed_at=other, reason="Часы"))
    assert r.status_code == 200, r.text
    assert (r.json()["hours"], dt(r.json()["effective_completed_at"])) == (5, dt(completed))


# Decision 32 (EDITORS-05 a): hidden inputs have their own revision; the assignee's does not move.
def test_hidden_inputs_keep_the_assignees_revision(client,work):
    w=work;aid=w['task']['assignments'][0]['assignment_id'];url=f'/api/assignments/{aid}/assessment-inputs'
    seen=public_revision(client,w,aid);inputs=client.get(url,headers=w['master'].headers).json()
    r=client.patch(url,headers=w['master'].headers,json=dict(expected_revision=inputs['revision'],hours=3,reason='Часы'));assert r.status_code==200
    r=client.post('/api/assessment-inputs/bulk-hours',headers=w['master'].headers,json=dict(items=[dict(assignment_id=aid,expected_revision=r.json()['revision'])],hours=6,reason='Часы'));assert r.status_code==200
    assert public_revision(client,w,aid)==seen
    private=client.get(url,headers=w['master'].headers).json()
    r=client.post(f'/api/assignments/{aid}/submit',headers=w['member'].headers,json=dict(expected_revision=seen,text='Готово'));assert r.status_code==200,r.text
    assert client.get(url,headers=w['master'].headers).json()==private  # result does not fabricate accounting inputs
    r=client.post(f'/api/assignments/{aid}/accept',headers=w['master'].headers,json=dict(expected_revision=private['workflow_revision'],evaluation=1));assert r.status_code==200,r.text
    assert public_revision(client,w,aid)==seen+1
    current=client.get(url,headers=w['master'].headers).json();assert current['effective_completed_at']
    r=client.patch(url,headers=w['master'].headers,json=dict(expected_revision=current['revision'],evaluation=1.5,reason='Оценка'));assert r.status_code==200,r.text
    assert public_revision(client,w,aid)==seen+1
