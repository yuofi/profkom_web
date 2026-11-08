"""The season journal of merit record edits (B9 variant В, owner 2026-11-08): GET /merits/history.

Visibility is the reader's: the records GET /merits lists, and for each record exactly the entries
GET /history?target_kind=merit shows (private inputs, hidden versions, can_hide), creation excluded.
"""
from contextlib import contextmanager

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import event

import main as main_module
from database import AuditLogORM, db, engine
from models import Block
from test_merit_create_without_reason import close_season, merit_context, request  # noqa: F401


def journal(client, actor, season_id, **params):
    response = client.get("/api/merits/history", headers=actor.headers, params={"season_id": season_id, **params})
    assert response.status_code == 200, response.text
    return response.json()


def every_page(client, actor, season_id, **params):
    pages, cursor = [], None
    while True:
        page = journal(client, actor, season_id, **params, **({"cursor": cursor} if cursor else {}))
        pages.append(page)
        cursor = page["next_cursor"]
        if not cursor:
            return pages


def record_history(client, actor, merit_id):
    response = client.get("/api/history", headers=actor.headers, params=dict(target_kind="merit", target_id=merit_id))
    assert response.status_code == 200, response.text
    return response.json()["items"]


def creations():
    with db._session() as session:
        return {f"audit:{row.id}" for row in session.query(AuditLogORM).filter_by(target_kind="merit")
                if row.old_values_json in (None, "", "{}")}


def lines(entry):
    """(label, recipient user id or None) of each change, as the journal shows it."""
    return [(change["label"], ((change["after"] or change["before"] or {}).get("user") or {}).get("user_id")
             if change["field"] == "recipients" else None) for change in entry["changes"]]


@pytest.fixture
def world(client, merit_context, make_user):
    """Records of every team: the chair's, two blocks', the event's and the subevent's. `head`
    leads the event, its subevent and the first block; `master` leads only the second block."""
    context = merit_context
    chair, head, sid = context["chair"], context["head"], context["season"]["season_id"]
    db.create_block(Block(name="Journal block", master=""))
    other = next(block for block in request(client, chair, "GET", "/blocks") if block["name"] == "Journal block")
    master = make_user(password=None)
    request(client, chair, "PUT", f"/blocks/{other['block_id']}/leader",
            {"user_id": master.user_id, "expected_revision": other["revision"]})
    people = [make_user(password=None, surname=f"Получатель{n}") for n in range(4)]
    done = context["deadline_at"]

    def recipient(person, hours=2, evaluation=1):
        return {"user_id": person.user_id, "hours": hours, "evaluation": evaluation, "completed_at": done}

    def create(actor, kind, title, recipients, **target):
        payload = {"season_id": sid, "source_kind": kind, "title": title,
                   "description": {"format": "markdown", "body": "Сделано"},
                   "assigned_at": context["assigned_at"], "deadline_at": done, "criteria": {},
                   "recipients": recipients, **target}
        return request(client, actor, "POST", "/merits", payload)

    records = {
        "chair": create(chair, "chair_merit", "Отчёт для ректората", [recipient(people[0]), recipient(people[1])]),
        "block": create(chair, "block_volunteer", "Помощь блоку", [recipient(people[0])],
                        scope={"kind": "block", "id": context["block"]["block_id"]}),
        "other": create(chair, "block_volunteer", "Помощь второму блоку", [recipient(people[2])],
                        scope={"kind": "block", "id": other["block_id"]}),
        "event": create(head, "head_merit", "Ведущие вечера", [recipient(people[1])],
                        event_id=context["event"]["event_id"]),
        "subevent": create(head, "subevent_volunteer", "Волонтёры лекции", [recipient(people[0])],
                           scope={"kind": "subevent", "id": context["subevent"]["subevent_id"]}),
    }
    return dict(context, master=master, people=people, other=other, records=records, sid=sid,
                recipient_of=recipient)


def edit(client, actor, merit, reason, **values):
    current = request(client, actor, "GET", f"/merits/{merit['merit_id']}")
    return request(client, actor, "PATCH", f"/merits/{merit['merit_id']}",
                   {"expected_revision": current["revision"], "reason": reason, **values})


def edit_all(client, world):
    chair, head, people, records, recipient = world["chair"], world["head"], world["people"], world["records"], world["recipient_of"]
    edit(client, chair, records["chair"], "Часы по табелю", recipients=[recipient(people[0], hours=3), recipient(people[1])])
    edit(client, chair, records["chair"], "Уточнили название", title="Отчёт профкома для ректората")
    edit(client, chair, records["block"], "Забыли второго", recipients=[recipient(people[0]), recipient(people[3], hours=4)])
    edit(client, chair, records["other"], "Нужно было к утру", criteria={"urgent": True})
    edit(client, head, records["event"], "Вели два часа", recipients=[recipient(people[1], evaluation=1.5)])
    edit(client, head, records["subevent"], "Дубль", recipients=[recipient(people[2])])


def test_lists_every_edit_newest_first_without_the_creations(client, world):
    edit_all(client, world)
    body = journal(client, world["chair"], world["sid"])
    entries = [item["entry"] for item in body["items"]]
    assert [entry["reason"] for entry in entries] == [
        "Дубль", "Вели два часа", "Нужно было к утру", "Забыли второго", "Уточнили название", "Часы по табелю"]
    assert not {entry["id"] for entry in entries} & creations()
    assert body["total"] == 6 and body["records"] == 5 and body["next_cursor"] is None
    first = body["items"][-1]
    assert first["entry"]["changed_by"]["user_id"] == world["chair"].user_id
    assert lines(first["entry"]) == [("Исходные поля получателя", world["people"][0].user_id)]
    renamed = body["items"][-2]
    assert renamed["merit"] == {"merit_id": world["records"]["chair"]["merit_id"], "title": "Отчёт профкома для ректората",
                                "source_kind": "chair_merit", "team": {"kind": "chair", "id": None, "title": None}}
    teams = {item["merit"]["merit_id"]: item["merit"]["team"] for item in body["items"]}
    records = world["records"]
    assert teams[records["block"]["merit_id"]] == {"kind": "block", "id": world["block"]["block_id"], "title": "Merit block"}
    assert teams[records["other"]["merit_id"]] == {"kind": "block", "id": world["other"]["block_id"], "title": "Journal block"}
    assert teams[records["event"]["merit_id"]] == {"kind": "event", "id": world["event"]["event_id"], "title": "Synthetic event"}
    assert teams[records["subevent"]["merit_id"]] == {"kind": "subevent", "id": world["subevent"]["subevent_id"],
                                                      "title": "Synthetic team"}
    # Records without edits are not in the journal; neither is a season without them.
    assert journal(client, world["chair"], "missing-season") == {"items": [], "next_cursor": None, "total": 0, "records": 0}


@pytest.mark.parametrize("viewer", ["chair", "head", "master", "outsider", "recipient"])
def test_each_record_shows_what_its_own_history_shows_to_the_same_reader(client, world, make_user, viewer):
    edit_all(client, world)
    actor = make_user() if viewer == "outsider" else world["people"][0] if viewer == "recipient" else world[viewer]
    listed = {merit["merit_id"] for merit in request(client, actor, "GET", f"/merits?season_id={world['sid']}")["items"]}
    shown = {}
    for item in journal(client, actor, world["sid"])["items"]:
        shown.setdefault(item["merit"]["merit_id"], []).append(item["entry"])
    records = world["records"]
    expected = {
        "chair": set(records), "head": {"block", "event", "subevent"}, "master": {"other"},
        "outsider": set(), "recipient": set(),
    }[viewer]
    assert set(shown) == listed == {records[name]["merit_id"] for name in expected}
    made = creations()
    for merit_id in listed:
        # Same entries, changes, reasons, hide rights and order as the record's own history.
        assert shown[merit_id] == [entry for entry in record_history(client, actor, merit_id) if entry["id"] not in made]


def test_participant_filter_keeps_their_changes_and_common_changes_of_records_they_receive(client, world):
    chair, people, records, recipient = world["chair"], world["people"], world["records"], world["recipient_of"]
    first, second, third = people[0], people[1], people[2]
    record = records["chair"]
    edit(client, chair, record, "Оба по табелю", recipients=[recipient(first, hours=3), recipient(second, hours=5)])
    edit(client, chair, record, "Срочная", criteria={"urgent": True}, title="Отчёт за октябрь")
    edit(client, chair, record, "Второй не участвовал", recipients=[recipient(first, hours=3)])
    edit(client, chair, record, "Описание", description={"format": "markdown", "body": "Подробнее"})
    edit(client, chair, records["other"], "Третьему оценка", recipients=[recipient(third, evaluation=0)])

    def shown(person):
        return [(item["entry"]["reason"], lines(item["entry"]))
                for item in journal(client, chair, world["sid"], user_id=person.user_id)["items"]]

    assert shown(first) == [
        ("Описание", [("Описание", None)]),
        ("Срочная", [("Критерии", None), ("Название", None)]),
        ("Оба по табелю", [("Исходные поля получателя", first.user_id)]),
    ]
    # Removed from the record: their own lines stay, later common changes no longer concern them.
    assert shown(second) == [
        ("Второй не участвовал", [("Убран получатель", second.user_id)]),
        ("Оба по табелю", [("Исходные поля получателя", second.user_id)]),
    ]
    assert shown(third) == [("Третьему оценка", [("Исходные поля получателя", third.user_id)])]
    filtered = journal(client, chair, world["sid"], user_id=first.user_id)
    assert (filtered["total"], filtered["records"]) == (3, 1)
    assert journal(client, chair, world["sid"], user_id=people[3].user_id)["items"] == []


def test_team_filter_keeps_one_teams_records(client, world):
    edit_all(client, world)
    chair, records = world["chair"], world["records"]

    def merit_ids(**params):
        return {item["merit"]["merit_id"] for item in journal(client, chair, world["sid"], **params)["items"]}

    assert merit_ids(scope_kind="chair") == {records["chair"]["merit_id"]}
    assert merit_ids(scope_kind="block", scope_id=world["block"]["block_id"]) == {records["block"]["merit_id"]}
    assert merit_ids(scope_kind="block", scope_id=world["other"]["block_id"]) == {records["other"]["merit_id"]}
    assert merit_ids(scope_kind="event", scope_id=world["event"]["event_id"]) == {records["event"]["merit_id"]}
    assert merit_ids(scope_kind="subevent", scope_id=world["subevent"]["subevent_id"]) == {records["subevent"]["merit_id"]}
    assert merit_ids(scope_kind="block", scope_id="unknown") == set()
    # Both filters together: the second recipient's hours did not change, the name did.
    both = journal(client, chair, world["sid"], scope_kind="chair", user_id=world["people"][1].user_id)
    assert [item["entry"]["reason"] for item in both["items"]] == ["Уточнили название"]
    for params in ({"scope_kind": "block"}, {"scope_id": "x"}, {"scope_kind": "chair", "scope_id": "x"},
                   {"scope_kind": "galaxy", "scope_id": "x"}, {"user_id": "someone"}):
        response = client.get("/api/merits/history", headers=chair.headers, params={"season_id": world["sid"], **params})
        assert response.status_code == 422, params
    # The page never sends a team without its id: no code of its own, the general input text.
    mismatch = client.get("/api/merits/history", headers=chair.headers, params={"season_id": world["sid"], "scope_kind": "block"})
    assert mismatch.json()["detail"]["code"] == "invalid_input"
    assert client.get("/api/merits/history", headers=chair.headers).status_code == 422


def test_pages_follow_the_cursor_and_count_every_page(client, world):
    edit_all(client, world)
    chair = world["chair"]
    whole = journal(client, chair, world["sid"])
    pages = every_page(client, chair, world["sid"], limit=4)
    assert [len(page["items"]) for page in pages] == [4, 2]
    assert [item for page in pages for item in page["items"]] == whole["items"]
    assert {(page["total"], page["records"]) for page in pages} == {(6, 5)}
    bad = client.get("/api/merits/history", headers=chair.headers, params={"season_id": world["sid"], "cursor": "%%%"})
    assert bad.status_code == 422
    for limit in (0, 101):
        response = client.get("/api/merits/history", headers=chair.headers, params={"season_id": world["sid"], "limit": limit})
        assert response.status_code == 422


def test_closed_season_corrections_are_in_the_journal(client, world):
    chair, sid, record = world["chair"], world["sid"], world["records"]["chair"]
    edit(client, chair, record, "До закрытия", title="Отчёт до закрытия")
    frozen = close_season(client, world)
    current = request(client, chair, "GET", f"/merits/{record['merit_id']}")
    recipients = [{**item, "hours": 4} if item["user_id"] == world["people"][1].user_id else item for item in current["recipients"]]
    request(client, chair, "POST", f"/seasons/{sid}/summary/correct", {
        "expected_version": frozen["version"], "reason": "Исправление после закрытия",
        "changes": [{"kind": "merit", "id": record["merit_id"], "expected_revision": current["revision"],
                     "values": {"recipients": recipients}}]})
    items = journal(client, chair, sid)["items"]
    assert [item["entry"]["reason"] for item in items] == ["Исправление после закрытия", "До закрытия"]
    assert lines(items[0]["entry"]) == [("Исходные поля получателя", world["people"][1].user_id)]
    assert items[0]["entry"]["changed_by"]["user_id"] == chair.user_id


def test_a_hidden_version_stays_hidden(client, world):
    chair, people, recipient = world["chair"], world["people"], world["recipient_of"]
    record = world["records"]["chair"]
    edit(client, chair, record, "Текст причины", title="Секретное название")
    edit(client, chair, record, "Часы", recipients=[recipient(people[0], hours=6), recipient(people[1])])
    target = next(item["entry"] for item in journal(client, chair, world["sid"])["items"] if item["entry"]["reason"] == "Текст причины")
    assert target["can_hide"] is True
    response = client.post(f"/api/history/{target['source_kind']}/{target['source_id']}/hide",
                           headers=chair.headers, json={"expected_revision": 1})
    assert response.status_code == 200, response.text
    items = journal(client, chair, world["sid"])["items"]
    hidden = next(item["entry"] for item in items if item["entry"]["id"] == target["id"])
    assert hidden["hidden"] is True and hidden["changes"] == [] and hidden["reason"] is None
    assert hidden["description"] == "Версия скрыта" and hidden["can_hide"] is False
    assert hidden == next(entry for entry in record_history(client, chair, record["merit_id"]) if entry["id"] == target["id"])
    # It shows no changes, so no participant filter keeps it.
    filtered = journal(client, chair, world["sid"], user_id=people[0].user_id)["items"]
    assert [item["entry"]["reason"] for item in filtered] == ["Часы"]


@contextmanager
def statements():
    seen = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", record)


def test_one_read_with_bounded_statements_and_no_writes(client, world, make_user):
    chair, head, people, records, recipient = world["chair"], world["head"], world["people"], world["records"], world["recipient_of"]
    edit_all(client, world)

    def count():
        with statements() as seen:
            journal(client, chair, world["sid"])
        assert not [s for s in seen if s.lstrip().split(" ", 1)[0].upper() in {"INSERT", "UPDATE", "DELETE", "REPLACE"}]
        return len(seen)

    before = count()
    # More edits by the same people of the same records: not one statement more.
    for hours in (3, 4, 5, 6, 7, 8):
        edit(client, chair, records["block"], f"Часы {hours}", recipients=[recipient(people[0], hours=hours), recipient(people[3], hours=4)])
        edit(client, head, records["event"], f"Оценка {hours}", recipients=[recipient(people[1], hours=hours, evaluation=1.5)])
    assert count() == before


def test_the_journal_route_comes_before_the_record_route():
    paths = [route.path for route in main_module.app.routes if isinstance(route, APIRoute)]
    assert paths.index("/api/merits/history") < paths.index("/api/merits/{merit_id}")
