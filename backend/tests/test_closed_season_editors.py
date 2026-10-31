"""Who changes a closed season (owner decision 2026-10-31, SE-13).

The chair, the chair's deputies and the HR master edit a closed season: its marks
(отметки), summary corrections, coefficients, public task fields, assessment inputs and
dates, reviews and merits, new merits included. The HR deputy, block leads, members and
outsiders do not. A NEW assignment row in a closed season (join, take, assign,
reassignment) is added by the same circle (owner 2026-10-31, TR-05). Every capability
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


CLOSED_ASSIGN = "Only the chair, deputies and HR master add assignees in a closed season"
CLOSED_REASSIGN = "Forbidden: only the chair, deputies and HR master can reassign in a closed season"
ROSTER_CAPS = {"join": "join_task", "take": "take_task", "assign": "assign_task_participants"}


def assignees():
    with db._session() as session:
        return sorted((a.task_id, a.assignee_user_id, a.assignment_id) for a in session.query(AssignmentORM))


def junior(closed, superuser, make_user):
    """An ordinary member of the closed task's block who is not its assignee."""
    import membership
    person = make_user()
    with db._session() as session:
        membership.set_membership(session, person.user_id, closed["block_id"], True, superuser.user_id, "Synthetic membership")
        session.commit()
    return person


def roster_command(client, closed, actor, command, target):
    task = client.get(f"/api/tasks/{closed['task_id']}", headers=actor.headers).json()
    path = f"/api/tasks/{closed['task_id']}/assignees/{target.user_id}/add" if command == "assign" else \
        f"/api/tasks/{closed['task_id']}/{command}"
    return task, client.post(path, headers=actor.headers, json={"expected_revision": task["revision"]})


@pytest.mark.parametrize("command", ["join", "take", "assign"])
def test_hr_master_adds_closed_season_assignees(client, closed, command):
    """TR-05 (owner 2026-10-31): the closed-season circle, the HR master included, adds an
    assignee there; each command writes exactly one new accounting row."""
    actor = closed["people"]["hr_master"]
    target = closed["people"]["block_master"] if command == "assign" else actor
    before = assignees()
    task, response = roster_command(client, closed, actor, command, target)
    assert ROSTER_CAPS[command] in task["capabilities"], task["capabilities"]
    assert response.status_code == 200, response.text
    assert target.user_id in [user["user_id"] for user in response.json()["assignees"]]
    added = sorted(set(assignees()) - set(before))
    assert len(assignees()) == len(before) + 1 and [row[:2] for row in added] == [(closed["task_id"], target.user_id)]


@pytest.mark.parametrize("role", ["hr_deputy", "block_master", "junior"])
@pytest.mark.parametrize("command", ["join", "take", "assign"])
def test_closed_season_new_assignees_are_refused_outside_the_circle(client, closed, superuser, make_user, role, command):
    """The HR deputy, the block master and an ordinary member add no assignee to a closed
    season's task; the capability is absent exactly as the command is refused."""
    actor = junior(closed, superuser, make_user) if role == "junior" else closed["people"][role]
    target = closed["people"]["outsider"] if role == "block_master" else closed["people"]["block_master"]
    before = ledger()
    task, response = roster_command(client, closed, actor, command, actor if command != "assign" else target)
    assert ROSTER_CAPS[command] not in task["capabilities"], task["capabilities"]
    if command == "assign":  # changing other people needs the closed task's public editor
        assert response.status_code == 403, response.text
    else:
        detail = response.json()["detail"]
        assert response.status_code == 409 and (detail["code"], detail["message"]) == ("season_closed", CLOSED_ASSIGN), response.text
    assert ledger() == before


@pytest.mark.parametrize("role", ["chair", "chair_deputy", "hr_master", "hr_deputy", "block_master"])
def test_closed_season_reassignment_follows_the_circle(client, closed, role):
    """A reassignment is a new row too: the capability and the command's right check agree."""
    actor, editor = closed["people"][role], role in EDITORS
    task = client.get(f"/api/tasks/{closed['task_id']}", headers=actor.headers).json()
    assignment = next(a for a in task["assignments"] if a["assignment_id"] == closed["aid"])
    assert ("reassign_assignment" in assignment["capabilities"]) is editor
    assert ("join_task" in task["capabilities"]) is editor
    response = client.post(f"/api/assignments/{closed['aid']}/reassign", headers=actor.headers, json={
        "expected_revision": BAD, "new_assignee_user_id": closed["people"]["block_master"].user_id, "hours": 1,
        "previous_outcome": "cancelled", "reason": "probe"})
    if editor:  # the right is checked before the stale revision
        assert response.status_code == 409, response.text
    else:
        assert response.status_code == 403 and response.json()["detail"]["message"] == CLOSED_REASSIGN, response.text


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
