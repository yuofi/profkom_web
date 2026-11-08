"""Edits of a merit record are history entries (B9, owner 2026-11-08): open-season PATCH and
closed-season correction both record the changed fields, old and new, with editor and reason."""
from datetime import datetime, timedelta, timezone

from database import AuditLogORM, db
from test_merit_create_without_reason import merit_context, payload_for, request, close_season, accounting_snapshot  # noqa: F401


def history(client, actor, merit_id):
    return client.get("/api/history", headers=actor.headers, params=dict(target_kind="merit", target_id=merit_id))


def entries(client, actor, merit_id):
    response = history(client, actor, merit_id)
    assert response.status_code == 200, response.text
    return sorted(response.json()["items"], key=lambda item: (item["created_at"], item["id"]))


def by_label(entry):
    return {(change["label"], (change.get("before") or change.get("after") or {}).get("user", {}).get("user_id")
             if change["field"] == "recipients" else None): change for change in entry["changes"]}


def test_open_season_edit_records_each_changed_field_recipient_and_criterion(client, merit_context, make_user):
    context = merit_context
    chair, recipient = context["chair"], context["recipient"]
    added, removed = make_user(password=None), make_user(password=None)
    payload = payload_for(context, "chair_merit")
    payload["criteria"] = {"unique": True}
    payload["recipients"].append({"user_id": removed.user_id, "hours": 1, "evaluation": 0, "completed_at": None})
    created = request(client, chair, "POST", "/merits", payload)
    moved = (datetime.fromisoformat(context["deadline_at"]) + timedelta(hours=2)).isoformat()
    body = {
        "expected_revision": created["revision"], "reason": "Уточнили часы и состав",
        "title": "Synthetic corrected work", "description": payload["description"],
        # The same instant in another notation is not a change of the date.
        "assigned_at": datetime.fromisoformat(context["assigned_at"]).astimezone(timezone(timedelta(hours=3))).isoformat(),
        "deadline_at": moved, "criteria": {"unique": True, "creative": True},
        "recipients": [{"user_id": recipient.user_id, "hours": 5, "evaluation": 1, "completed_at": context["deadline_at"]},
                       {"user_id": added.user_id, "hours": 3, "evaluation": 1.5, "completed_at": context["deadline_at"]}],
    }
    request(client, chair, "PATCH", f"/merits/{created['merit_id']}", body)
    first, edit = entries(client, chair, created["merit_id"])
    assert first["description"] == "Изменены исходные поля ККР" and first["reason"] == "Создание записи выполненной работы"
    assert edit["changed_by"]["user_id"] == chair.user_id and edit["reason"] == "Уточнили часы и состав"
    changes = by_label(edit)
    assert set(changes) == {("Название", None), ("Дедлайн", None), ("Критерии", None),
                            ("Исходные поля получателя", recipient.user_id),
                            ("Убран получатель", removed.user_id), ("Добавлен получатель", added.user_id)}
    assert changes[("Название", None)]["before"] == "Synthetic accepted work"
    assert changes[("Название", None)]["after"] == "Synthetic corrected work"
    assert changes[("Дедлайн", None)]["after"] == moved
    # Only the criterion that changed, not all eight.
    assert (changes[("Критерии", None)]["before"], changes[("Критерии", None)]["after"]) == ({"creative": False}, {"creative": True})
    changed = changes[("Исходные поля получателя", recipient.user_id)]
    assert changed["before"] == {"user": changed["before"]["user"], "hours": 2} and changed["after"]["hours"] == 5
    assert changed["before"]["user"]["user_id"] == recipient.user_id
    gone = changes[("Убран получатель", removed.user_id)]
    assert gone["after"] is None and gone["before"]["hours"] == 1 and gone["before"]["evaluation"] == 0
    new = changes[("Добавлен получатель", added.user_id)]
    assert new["before"] is None and (new["after"]["hours"], new["after"]["evaluation"]) == (3, 1.5)


def test_an_edit_that_changes_nothing_or_is_refused_writes_no_history(client, merit_context, make_user):
    context = merit_context
    chair = context["chair"]
    created = request(client, chair, "POST", "/merits", payload_for(context, "chair_merit"))
    same = {"expected_revision": created["revision"], "reason": "Повторное сохранение", "title": created["title"],
            "recipients": created["recipients"], "criteria": created["criteria"]}
    request(client, chair, "PATCH", f"/merits/{created['merit_id']}", same)
    assert len(entries(client, chair, created["merit_id"])) == 1
    before = accounting_snapshot()
    stale = client.patch(f"/api/merits/{created['merit_id']}", headers=chair.headers,
                         json={**same, "expected_revision": created["revision"], "title": "Не сохранится"})
    assert stale.status_code == 409
    assert accounting_snapshot() == before


def test_merit_history_keeps_the_record_visibility(client, merit_context, make_user):
    context = merit_context
    head, chair = context["head"], context["chair"]
    created = request(client, head, "POST", "/merits", payload_for(context, "head_merit"))
    request(client, head, "PATCH", f"/merits/{created['merit_id']}",
            {"expected_revision": created["revision"], "reason": "Главорг поправил", "title": "Head corrected"})
    for actor in (head, chair):
        assert [entry["reason"] for entry in entries(client, actor, created["merit_id"])][-1] == "Главорг поправил"
    for actor in (context["recipient"], make_user()):
        assert history(client, actor, created["merit_id"]).status_code == 404


def test_closed_season_correction_of_a_merit_is_recorded_with_its_reason(client, merit_context):
    context = merit_context
    chair, sid = context["chair"], context["season"]["season_id"]
    created = request(client, chair, "POST", "/merits", payload_for(context, "chair_merit"))
    frozen = close_season(client, context)
    recipient = created["recipients"][0]
    values = {"recipients": [{**recipient, "hours": 4, "evaluation": 1.5}]}
    request(client, chair, "POST", f"/seasons/{sid}/summary/correct", {
        "expected_version": frozen["version"], "reason": "Исправление после закрытия",
        "changes": [{"kind": "merit", "id": created["merit_id"], "expected_revision": created["revision"], "values": values}]})
    edit = entries(client, chair, created["merit_id"])[-1]
    assert edit["reason"] == "Исправление после закрытия" and edit["changed_by"]["user_id"] == chair.user_id
    [change] = edit["changes"]
    assert change["label"] == "Исходные поля получателя"
    assert {key: value for key, value in change["before"].items() if key != "user"} == {"hours": 2, "evaluation": 1}
    assert {key: value for key, value in change["after"].items() if key != "user"} == {"hours": 4, "evaluation": 1.5}
    with db._session() as session:
        rows = session.query(AuditLogORM).filter_by(target_kind="merit", target_id=created["merit_id"]).all()
        assert len(rows) == 2 and rows[-1].changed_by_user_id == chair.user_id
