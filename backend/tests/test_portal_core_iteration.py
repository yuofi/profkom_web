"""Core integration for explicit lifecycle, source repair and undated scoring."""
import math
import pytest

from database import (db, calculate_kkr_score, TaskORM, TaskQueueORM, TaskTrackerORM,
                      AssignmentORM, AuditLogORM)
from errors import NotFound
from test_v13_tracker import work  # noqa: F401
from test_event_workspace import setup_event  # noqa: F401


@pytest.mark.parametrize("evaluation", [-1, 0, 1, 1.5])
@pytest.mark.parametrize("completion", [None, "2999-12-31T23:59:59Z"])
def test_undated_formula_has_no_urgency_or_lateness(evaluation, completion):
    result = calculate_kkr_score("2026-01-01T00:00:00Z", None,
                                 {"creative": True, "unique": True}, 4, evaluation, completion)
    assert result == pytest.approx(4 * evaluation * 1.3 * 1.2)


def test_dated_formula_keeps_urgency_and_late_penalty():
    before = calculate_kkr_score("2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z", {}, 4, 1,
                                "2026-01-05T00:00:00Z")
    assert before == pytest.approx(4 * (1 + 1 / math.sqrt(4)) * (1 - 1 / 3))


def test_explicit_event_closure_only_chair_revisions_and_merit_acl(client, setup_event, superuser):
    from merit_rules import can_create
    event = setup_event["event"]
    head = setup_event["head"]
    path = "/api/events/" + event["event_id"]
    # Dates and public announcements do not close the event.
    current = client.get(path, headers=head.headers).json()
    assert not current["is_closed"]
    assert "close_event" not in current["capabilities"]
    assert can_create(head.user_id, "head_merit", event["event_id"], None)
    assert client.post(path + "/close", headers=head.headers,
                       json={"expected_revision": current["revision"]}).status_code == 403
    assert client.post(path + "/close", headers=superuser.headers,
                       json={"expected_revision": current["revision"] - 1}).status_code in {409, 422}
    result = client.post(path + "/close", headers=superuser.headers,
                         json={"expected_revision": current["revision"]})
    assert result.status_code == 200, result.text
    closed = result.json()
    assert closed["is_closed"] and closed["closed_at"] and closed["revision"] == current["revision"] + 1
    assert not can_create(head.user_id, "head_merit", event["event_id"], None)
    assert not can_create(head.user_id, "subevent_volunteer", None, setup_event["child"]["subevent_id"])
    assert "create_head_merit" not in client.get(path, headers=head.headers).json()["capabilities"]
    duplicate = client.post(path + "/close", headers=superuser.headers,
                            json={"expected_revision": closed["revision"]})
    assert duplicate.status_code == 200 and duplicate.json()["revision"] == closed["revision"]
    assert client.post(path + "/reopen", headers=head.headers,
                       json={"expected_revision": closed["revision"]}).status_code == 403
    reopened = client.post(path + "/reopen", headers=superuser.headers,
                            json={"expected_revision": closed["revision"]})
    assert reopened.status_code == 200 and not reopened.json()["is_closed"]
    assert reopened.json()["closed_at"] is None
    assert can_create(head.user_id, "head_merit", event["event_id"], None)


def legacy_queue(work):
    """Existing persisted independent queues, no longer accepted by creation API."""
    from registration import now
    with db._session() as session:
        queue = TaskQueueORM(queue_id="legacy-rebind", name="Legacy", key="LEGACY", scope_kind="queue",
                             scope_id="legacy-rebind", owner_user_id=work["master"].user_id,
                             next_task_number=2, revision=1, is_private=False, is_default=False, created_at=now())
        session.add(queue)
        original = session.get(TaskORM, work["task"]["task_id"])
        original.scope_kind, original.scope_id = "queue", queue.queue_id
        session.query(TaskTrackerORM).filter_by(task_id=original.task_id).one().queue_id = queue.queue_id
        session.commit()
        return queue.queue_id, original.task_id


def test_legacy_queue_explicit_rebinding_preserves_ids_inputs_and_is_repeatable(work, superuser):
    from queue_rebinding import apply_bindings
    qid, tid = legacy_queue(work)
    with db._session() as session:
        task = session.get(TaskORM, tid)
        before = (task.title, task.description_json, task.criteria_json, task.deadline_at)
        assessments = [(a.assignment_id, a.status, a.hours, a.evaluation, a.effective_completed_at)
                       for a in session.query(AssignmentORM).filter_by(task_id=tid)]
    mapping = [dict(queue_id=qid, source_kind="block", source_id=work["block"]["block_id"],
                    expected_revision=1, expected_task_count=1)]
    result = apply_bindings(mapping, superuser.user_id)
    assert result == [dict(queue_id=qid, changed=True, tasks=1)]
    assert apply_bindings(mapping, superuser.user_id) == [dict(queue_id=qid, changed=False, tasks=0)]
    with db._session() as session:
        task = session.get(TaskORM, tid)
        assert (task.scope_kind, task.scope_id) == ("block", "IT")
        assert before == (task.title, task.description_json, task.criteria_json, task.deadline_at)
        assert assessments == [(a.assignment_id, a.status, a.hours, a.evaluation, a.effective_completed_at)
                               for a in session.query(AssignmentORM).filter_by(task_id=tid)]
        assert session.query(AuditLogORM).filter_by(target_kind="task_queue", target_id=qid).count() == 1


def test_legacy_repair_is_atomic_for_bad_mapping(work, superuser):
    from queue_rebinding import apply_bindings
    qid, tid = legacy_queue(work)
    mapping = [dict(queue_id=qid, source_kind="chair", source_id="chair", expected_revision=1),
               dict(queue_id="missing-queue", source_kind="chair", source_id="chair", expected_revision=1)]
    with pytest.raises(NotFound):
        apply_bindings(mapping, superuser.user_id)
    with db._session() as session:
        assert session.get(TaskORM, tid).scope_kind == "queue"
        assert session.get(TaskQueueORM, qid).scope_kind == "queue"
        assert session.query(AuditLogORM).filter_by(target_kind="task_queue", target_id=qid).count() == 0


@pytest.mark.parametrize("kind", ["event", "chair"])
def test_bound_new_sources_support_undated_accounting_and_keep_private_roles(client, setup_event, superuser, kind):
    from database import ContributionORM
    context = setup_event
    actor = context["head"] if kind == "event" else superuser
    recipient = context["organizer"] if kind == "event" else superuser
    sid = context["event"]["season_id"]
    scope = dict(kind=kind, id=context["event"]["event_id"] if kind == "event" else "chair")
    response = client.post("/api/task-queues", headers=actor.headers,
                           json=dict(name="Bound source", key="EVENTWORK" if kind == "event" else "CHAIRWORK", scope=scope))
    assert response.status_code == 200, response.text
    queue = response.json()
    response = client.post("/api/tasks", headers=actor.headers, json=dict(queue_id=queue["queue_id"],
        season_id=sid, title="Undated task", description="Details", deadline_at=None,
        assignees=[dict(user_id=recipient.user_id)], criteria={}))
    assert response.status_code == 200, response.text
    task = response.json()
    assert task["deadline_at"] is None
    path = "/api/tasks/" + task["task_id"]
    closed = client.post(path + "/status", headers=actor.headers,
                         json=dict(expected_revision=task["revision"], status="closed"))
    assert closed.status_code == 200, closed.text
    value = client.get(path + "/accounting-batch", headers=actor.headers)
    assert value.status_code == 200, value.text
    data = value.json()
    response = client.put(path + "/accounting-batch", headers=actor.headers, json=dict(
        expected_public_revision=data["public_revision"], expected_revision=data["revision"], criteria=data["criteria"],
        assignments=[dict(assignment_id=row["assignment_id"], expected_revision=row["revision"], hours=4, evaluation=1, excluded=False)
                     for row in data["assignments"]]))
    assert response.status_code == 200, response.text
    with db._session() as session:
        credit = session.query(ContributionORM).filter_by(assignment_id=task["assignments"][0]["assignment_id"]).one()
        assert credit.source_kind == kind + "_task" and credit.score == pytest.approx(4)
        assert credit.source_id == scope["id"]
    assert client.get(path + "/accounting-batch", headers=context["outsider"].headers).status_code == 404
    assert client.get("/api/tasks", headers=actor.headers, params=dict(scope_kind=kind, scope_id=scope["id"])).status_code == 200
