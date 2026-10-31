"""Who changes a closed season (owner decision 2026-10-31, SE-13).

The chair, the chair's deputies and the HR master edit a closed season: its marks
(отметки), summary corrections, coefficients, public task fields, assessment inputs and
dates, reviews and merits, new merits included. The HR deputy, block leads, members and
outsiders do not. Creating a NEW assignment row in a closed season keeps the TR-05
default (the chair and deputies) and is not widened by this decision. Every capability
follows its command.
"""
from datetime import datetime, timedelta, timezone

import pytest

import access
from database import AssignmentORM, ContributionORM, MeritORM, SeasonDecisionORM, db
from merit_rules import CREATE_ACTIONS
from test_hr_tracker_edit import hr_roles  # noqa: F401
from test_v13_season_integrity import accept, close
from test_v13_tracker import work  # noqa: F401

BAD = 999999
ROLES = ["chair", "chair_deputy", "hr_master", "hr_deputy", "block_master", "member", "outsider"]
EDITORS = {"chair", "chair_deputy", "hr_master"}
SUMMARY_READERS = EDITORS | {"hr_deputy"}
TASK_READERS = SUMMARY_READERS | {"block_master", "member"}


def stamp(days):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


@pytest.fixture
def closed(client, work, superuser, make_user, hr_roles):
    deputy = make_user()
    leadership = client.get("/api/leadership", headers=superuser.headers).json()
    response = client.put("/api/leadership/deputies", headers=superuser.headers,
                          json={"user_ids": [deputy.user_id], "expected_revision": leadership["revision"]})
    assert response.status_code == 200, response.text
    sid = work["season"]["season_id"]
    merit = client.post("/api/merits", headers=superuser.headers, json=dict(
        season_id=sid, source_kind="chair_merit", title="Заслуга сезона", description="", criteria={},
        assigned_at=stamp(-3), deadline_at=stamp(-2), reason="Фикстура",
        recipients=[{"user_id": work["member"].user_id, "hours": 1, "evaluation": 1, "completed_at": stamp(-2)}]))
    assert merit.status_code == 200, merit.text
    aid = accept(client, work)
    close(client, work, superuser)
    people = {"chair": superuser, "chair_deputy": deputy, "hr_master": hr_roles["master"], "hr_deputy": hr_roles["deputy"],
              "block_master": work["master"], "member": work["member"], "outsider": work["outside"]}
    return dict(people=people, sid=sid, aid=aid, task_id=work["task"]["task_id"], merit_id=merit.json()["merit_id"],
                block_id=work["block"]["block_id"], target=work["member"].user_id)


def ledger():
    with db._session() as session:
        return (sorted((a.assignment_id, a.status, a.hours, a.evaluation, a.inputs_revision) for a in session.query(AssignmentORM)),
                sorted((c.contribution_id, c.score) for c in session.query(ContributionORM)),
                sorted((d.user_id, d.decisions_json) for d in session.query(SeasonDecisionORM)))


def merits():
    with db._session() as session:
        return sorted((m.merit_id, m.season_id, m.source_kind) for m in session.query(MeritORM))


CLOSED_CREATE = "Forbidden: only the chair, deputies and HR master can create merits in a closed season"


def new_merit(client, actor, sid, source, recipient, **target):
    return client.post("/api/merits", headers=actor.headers, json=dict(
        season_id=sid, source_kind=source, title=f"Новая заслуга ({source})", description="", criteria={},
        assigned_at=stamp(-3), deadline_at=stamp(-2), **target,
        recipients=[{"user_id": recipient, "hours": 1, "evaluation": 1, "completed_at": stamp(-2)}]))


def refused(role):
    """A refused write: 403 for a reader of the object, 404 for anyone who cannot read it."""
    return 403 if role in TASK_READERS else 404


@pytest.mark.parametrize("role", ROLES)
def test_closed_season_is_edited_by_the_chair_deputies_and_hr_master(client, closed, superuser, role):
    actor, sid, editor = closed["people"][role], closed["sid"], role in EDITORS
    summary = client.get(f"/api/seasons/{sid}/summary", headers=actor.headers)
    if role in SUMMARY_READERS:
        assert summary.status_code == 200, summary.text
        caps = set(summary.json()["capabilities"])
        assert ("edit_decisions" in caps) is editor and ("correct_summary" in caps) is editor, caps
    else:
        assert summary.status_code == 403, summary.text
    version = client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()["version"]
    before = ledger()

    # Marks (отметки) of the closed summary: a real change for the circle, nothing for others.
    marks = client.put(f"/api/seasons/{sid}/summary/decisions/{closed['target']}", headers=actor.headers,
                       json={"expected_version": version, "decisions": ["nice"], "reason": f"Исправление ({role})"})
    if editor:
        assert marks.status_code == 200, marks.text
        assert marks.json()["version"] == version + 1
        assert next(r for r in marks.json()["rows"] if r["user"]["user_id"] == closed["target"])["decisions"] == ["nice"]
        version += 1
    else:
        assert marks.status_code == 403, marks.text
        assert ledger() == before

    # Summary correction and coefficient: the right is checked before the stale versions.
    correction = client.post(f"/api/seasons/{sid}/summary/correct", headers=actor.headers, json={
        "expected_version": BAD, "reason": "probe",
        "changes": [{"kind": "assessment_inputs", "id": closed["aid"], "expected_revision": BAD, "values": {"hours": 3}}]})
    assert correction.status_code == (409 if editor else 403), correction.text
    coefficient = client.put(f"/api/seasons/{sid}/coefficients", headers=actor.headers, json={
        "source_kind": "block", "source_id": closed["block_id"], "value": 1.5, "expected_revision": BAD,
        "reason": "probe", "expected_summary_version": version})
    assert coefficient.status_code == (409 if editor else 403), coefficient.text
    listing = client.get(f"/api/seasons/{sid}/coefficients", headers=actor.headers)
    if role in SUMMARY_READERS:
        block = next(i for i in listing.json()["items"] if i["source_kind"] == "block" and i["source_id"] == closed["block_id"])
        assert ("edit_coefficient" in block["capabilities"]) is editor
    else:
        assert listing.status_code == 403

    # The closed task: public fields, assessment inputs and dates, review.
    task = client.get(f"/api/tasks/{closed['task_id']}", headers=superuser.headers).json()
    edit = client.patch(f"/api/tasks/{closed['task_id']}", headers=actor.headers,
                        json={"expected_revision": task["revision"], "title": f"Работа ({role})"})
    assert edit.status_code == (200 if editor else refused(role)), edit.text
    if role in TASK_READERS:
        caps = set(client.get(f"/api/tasks/{closed['task_id']}", headers=actor.headers).json()["capabilities"])
        assert ("edit_task" in caps) is editor, caps
    inputs = client.patch(f"/api/assignments/{closed['aid']}/assessment-inputs", headers=actor.headers,
                          json={"expected_revision": BAD, "reason": "probe", "hours": 3})
    assert inputs.status_code == (409 if editor else refused(role)), inputs.text
    dates = client.patch(f"/api/tasks/{closed['task_id']}/assessment-inputs", headers=actor.headers,
                         json={"expected_revision": BAD, "reason": "probe", "deadline_at": stamp(1)})
    assert dates.status_code == (409 if editor else refused(role)), dates.text
    review = client.post(f"/api/assignments/{closed['aid']}/request-revision", headers=actor.headers,
                         json={"expected_revision": BAD, "review_note": "probe"})
    assert review.status_code == (409 if editor else refused(role)), review.text
    view = client.get(f"/api/assignments/{closed['aid']}/assessment-inputs", headers=actor.headers)
    if view.status_code == 200:
        caps = set(view.json()["capabilities"])
        assert ("edit_assessment_inputs" in caps) is editor and ("edit_assessment_dates" in caps) is editor, caps

    # A merit of the closed season.
    merit = client.patch(f"/api/merits/{closed['merit_id']}", headers=actor.headers,
                         json={"expected_revision": BAD, "reason": "probe"})
    assert merit.status_code == (409 if editor else 403), merit.text
    if not editor:
        assert ledger() == before


@pytest.mark.parametrize("role", ROLES)
def test_closed_season_new_merit_follows_the_season_circle(client, closed, role):
    """A new merit is a change of the closed season too: the chair, the deputies and the HR
    master add a chair merit and a block volunteer merit there; the HR deputy and the rest
    get the closed-season 403 and no row is written."""
    actor, sid, editor = closed["people"][role], closed["sid"], role in EDITORS
    outsider = closed["people"]["outsider"].user_id
    for source, target in [("chair_merit", {}), ("block_volunteer", {"scope": {"kind": "block", "id": closed["block_id"]}})]:
        before = merits()
        response = new_merit(client, actor, sid, source, outsider, **target)
        if editor:
            assert response.status_code == 200, (source, response.text)
            assert response.json()["season_id"] == sid and response.json()["source_kind"] == source
            assert len(merits()) == len(before) + 1
        else:
            assert response.status_code == 403, (source, response.text)
            assert response.json()["detail"]["message"] == CLOSED_CREATE, response.text
            assert merits() == before
        # The rule the command checks, as the capability layer reads it for this season.
        assert access.allowed(actor.user_id, CREATE_ACTIONS[source], "block" if target else None,
                              closed["block_id"] if target else None, state="closed") is editor


@pytest.mark.parametrize("role", ["hr_master", "hr_deputy", "block_master", "member"])
def test_closed_season_new_assignments_keep_the_tr05_circle(client, closed, role):
    """SE-13 does not widen TR-05: in a closed season only the chair and deputies add an
    assignment row, whether by join/take/assign or by a reassignment."""
    actor = closed["people"][role]
    task = client.get(f"/api/tasks/{closed['task_id']}", headers=actor.headers).json()
    if role != "member":  # the member is the current assignee and keeps their own row
        assert not {"join_task", "take_task", "assign_task_participants"} & set(task["capabilities"])
        before = ledger()
        joined = client.post(f"/api/tasks/{closed['task_id']}/join", headers=actor.headers,
                             json={"expected_revision": task["revision"]})
        assert joined.status_code == 409 and joined.json()["detail"]["code"] == "season_closed", joined.text
        assert ledger() == before
    assignment = next(a for a in task["assignments"] if a["assignment_id"] == closed["aid"])
    assert "reassign_assignment" not in assignment["capabilities"]


def test_chair_and_deputy_keep_closed_reassignment(client, closed):
    for role in ("chair", "chair_deputy"):
        task = client.get(f"/api/tasks/{closed['task_id']}", headers=closed["people"][role].headers).json()
        assignment = next(a for a in task["assignments"] if a["assignment_id"] == closed["aid"])
        assert "reassign_assignment" in assignment["capabilities"], role
        assert "join_task" in task["capabilities"], role


def test_closed_season_merit_of_a_closed_event_follows_the_season_circle(client, work, superuser, make_user, hr_roles):
    """A closed main event stops its heads; in a closed season the circle edits the merit
    anyway and adds new head and subevent volunteer merits there, the capability with it."""
    sid, head = work["season"]["season_id"], make_user()
    event = client.post("/api/events", headers=superuser.headers, json={"season_id": sid, "title": "Посвят", "description": ""})
    assert event.status_code == 200, event.text
    event_id = event.json()["event_id"]
    event = client.put(f"/api/events/{event_id}/leaders", headers=superuser.headers,
                       json={"user_ids": [head.user_id], "expected_revision": event.json()["revision"]})
    assert event.status_code == 200, event.text
    sub = client.post(f"/api/events/{event_id}/subevents", headers=superuser.headers, json={"title": "Лекции", "description": ""})
    assert sub.status_code == 200, sub.text
    sub_id = sub.json()["subevent_id"]
    merit = client.post("/api/merits", headers=head.headers, json=dict(
        season_id=sid, source_kind="head_merit", event_id=event_id, title="Заслуга главорга", description="",
        criteria={}, assigned_at=stamp(-3), deadline_at=stamp(-2), reason="Фикстура",
        recipients=[{"user_id": work["member"].user_id, "hours": 1, "evaluation": 1, "completed_at": stamp(-2)}]))
    assert merit.status_code == 200, merit.text
    revision = client.get(f"/api/events/{event_id}", headers=superuser.headers).json()["revision"]
    closed_event = client.post(f"/api/events/{event_id}/close", headers=superuser.headers, json={"expected_revision": revision})
    assert closed_event.status_code == 200, closed_event.text
    from database import EventORM, ReportORM, SubeventORM
    with db._session() as session:  # published final reports, so the season really closes
        for kind, row, owner_id in [("event", session.get(EventORM, event_id), event_id), ("subevent", session.get(SubeventORM, sub_id), sub_id)]:
            session.add(ReportORM(report_id=f"final-{kind}", owner_kind=kind, owner_id=owner_id, season_id=sid, kind="final",
                                  report_series_id=row.report_series_id, title="Итоги", state="published",
                                  created_by_user_id=superuser.user_id, created_at=stamp(-1)))
        session.commit()
    accept(client, work)
    close(client, work, superuser)
    for actor, status in [(superuser, 409), (hr_roles["master"], 409), (hr_roles["deputy"], 403), (head, 403)]:
        response = client.patch(f"/api/merits/{merit.json()['merit_id']}", headers=actor.headers,
                                json={"expected_revision": BAD, "reason": "probe"})
        assert response.status_code == status, (actor.user_id, response.text)
    targets = [("head_merit", {"event_id": event_id}, "event", event_id, "create_head_merit"),
               ("subevent_volunteer", {"scope": {"kind": "subevent", "id": sub_id}}, "subevent", sub_id, "create_volunteer_merit")]
    for actor, editor in [(superuser, True), (hr_roles["master"], True), (hr_roles["deputy"], False), (head, False)]:
        for source, target, kind, scope_id, cap in targets:
            before = merits()
            # A closed season takes recipients from its participant snapshot: the member.
            response = new_merit(client, actor, sid, source, work["member"].user_id, **target)
            if editor:
                assert response.status_code == 200, (actor.user_id, source, response.text)
            else:
                assert response.status_code == 403, (actor.user_id, source, response.text)
                assert response.json()["detail"]["message"] == CLOSED_CREATE, response.text
                assert merits() == before
            # A role assignment's merit capability there follows the same command.
            assert (cap in access.assignment_caps(actor.user_id, kind, scope_id)) is editor, (actor.user_id, source)
