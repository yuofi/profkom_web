"""Support lists page in SQL without screenshots and read receipts in batches.

The reference is the former algorithm: every report loaded, sorted and sliced by
cursor_page in memory, one receipt() (task + tracker queries) per row. Every
staff page, the reporter's own list and unusual cursors must be identical.
"""
import base64
import json
from contextlib import contextmanager

import pytest
from sqlalchemy import event

import api_contract
from database import db, engine
from support import receipt
from support_models import FeedbackORM
from test_website_support import ok, req, setup_support


def report(client, actor=None, **values):
    import uuid
    payload = dict(kind="bug", title="Синтетический дефект", body="Шаги\nОжидание\nРезультат", idempotency_key=str(uuid.uuid4()))
    return req(client, actor, "post", "/feedback", {**payload, **values}), payload


@contextmanager
def sql_calls():
    statements = []
    def count(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", count)


def staff_reference(cursor=None):
    key = lambda row: (row.created_at, row.report_id)
    with db._session() as s:
        page = api_contract.cursor_page(s.query(FeedbackORM).all(), key, cursor, descending=True)
        return dict(items=[dict(**receipt(s, row), title=row.title, body=row.body, contact=row.contact, created_at=row.created_at)
                           for row in page.items], next_cursor=page.next_cursor)


def mine_reference(uid):
    with db._session() as s:
        rows = s.query(FeedbackORM).filter_by(user_id=uid).order_by(FeedbackORM.created_at.desc()).all()
        return dict(items=[dict(**receipt(s, row), title=row.title, body=row.body, created_at=row.created_at) for row in rows],
                    next_cursor=None)


def cursor_of(values):
    return base64.urlsafe_b64encode(json.dumps(values).encode()).decode()


@pytest.fixture
def tickets(client, superuser, make_user):
    author, other = make_user(), make_user()
    early = [ok(report(client, author, title=f"До настройки {n}")[0]) for n in range(2)]
    master, settings = setup_support(client, superuser, make_user)
    later = [ok(report(client, actor, title=f"Обращение {n}", contact="tg")[0])
             for n, actor in enumerate([author, other, None, author, other])]
    with db._session() as s:
        rows = {row.report_id: row for row in s.query(FeedbackORM)}
        # Equal timestamps are ordered by report_id; one report carries a large screenshot.
        rows[later[1]["report_id"]].created_at = rows[later[2]["report_id"]].created_at
        rows[later[3]["report_id"]].screenshot = "data:image/png;base64," + "A" * 200_000
        s.commit()
    return dict(author=author, other=other, master=master, superuser=superuser, reports=early + later)


def test_staff_pages_equal_the_in_memory_pages(client, tickets, monkeypatch):
    w = tickets
    monkeypatch.setattr(api_contract, "PAGE_SIZE", 2)
    cursor, pages = None, 0
    while True:
        params = {"cursor": cursor} if cursor else {}
        page = ok(client.get("/api/support/reports", headers=w["master"].headers, params=params))
        assert page == staff_reference(cursor)
        pages += 1
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert pages == 4
    monkeypatch.setattr(api_contract, "PAGE_SIZE", 100)
    full = ok(client.get("/api/support/reports", headers=w["master"].headers))
    assert len(full["items"]) == 7 and full == staff_reference()
    assert {item["task_key"] for item in full["items"]} >= {"WEBSUPPORT-1", "WEBSUPPORT-7"}


def test_unusual_cursors_keep_the_original_answers(client, tickets):
    w = tickets
    stamp = staff_reference()["items"][3]["created_at"]
    for values in ([stamp], [stamp, "zzzz"], [stamp, ""], ["9999"], []):
        r = client.get("/api/support/reports", headers=w["master"].headers, params={"cursor": cursor_of(values)})
        assert r.status_code == 200 and r.json() == staff_reference(cursor_of(values)), values
    for bad in ("broken", cursor_of([1, 2]), cursor_of({"a": 1}), cursor_of([True, "x"])):
        assert client.get("/api/support/reports", headers=w["master"].headers, params={"cursor": bad}).status_code == 422
    assert client.get("/api/support/reports", headers=w["author"].headers).status_code == 403


def test_own_reports_equal_the_per_row_receipts(client, tickets):
    w = tickets
    for actor in (w["author"], w["other"], w["master"]):
        assert ok(client.get("/api/feedback/mine", headers=actor.headers)) == mine_reference(actor.user_id)


def test_lists_skip_screenshots_and_receipts_are_batched(client, tickets):
    w = tickets
    with sql_calls() as statements:
        ok(client.get("/api/support/reports", headers=w["master"].headers))
        ok(client.get("/api/feedback/mine", headers=w["author"].headers))
    listed = [x for x in statements if "FROM feedback_reports" in x]
    assert listed and not [x for x in listed if "feedback_reports.screenshot" in x]
    assert len([x for x in statements if "FROM task_tracker" in x]) <= 2
