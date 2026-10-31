"""Reports name their owner event or subevent (audit EV-06).

Lists mix reports of many teams; the title of the owner lets the UI tell them
apart and link back. Titles come in one batch per owner kind.
"""
from sqlalchemy import event as sa_event

from database import db, engine


def _reports(client, superuser, user):
    season = client.post("/api/seasons", json={
        "title": "Сезон", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z",
    }, headers=superuser.headers).json()
    event_id = client.post("/api/events", json={"season_id": season["season_id"], "title": "Посвят"}, headers=superuser.headers).json()["event_id"]
    assert client.put(f"/api/events/{event_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers).status_code == 200
    ids = {}
    for title in ("Лекции", "Квест"):
        sid = client.post(f"/api/events/{event_id}/subevents", json={"title": title}, headers=superuser.headers).json()["subevent_id"]
        assert client.put(f"/api/subevents/{sid}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers).status_code == 200
        ids[title] = sid
    created = {}
    for kind, owner_id, name in (("event", event_id, "Посвят"), ("subevent", ids["Лекции"], "Лекции"), ("subevent", ids["Квест"], "Квест")):
        r = client.post("/api/reports", json={"owner_kind": kind, "owner_id": owner_id, "kind": "regular", "title": "Регулярный отчёт", "content": "Текст", "file_ids": []}, headers=user.headers)
        assert r.status_code in (200, 201), r.text
        assert r.json()["owner_title"] == name
        published = client.post(f"/api/reports/{r.json()['report_id']}/publish", json={"expected_revision": 1}, headers=user.headers)
        assert published.json()["owner_title"] == name
        created[r.json()["report_id"]] = name
    return event_id, created


def test_reports_carry_their_owner_title_everywhere(client, superuser, user):
    _, created = _reports(client, superuser, user)
    listed = client.get("/api/reports", headers=user.headers).json()["items"]
    assert {item["report_id"]: item["owner_title"] for item in listed} == created
    for report_id, name in created.items():
        assert client.get(f"/api/reports/{report_id}", headers=user.headers).json()["owner_title"] == name
    series = client.get("/api/reports/" + next(iter(created)), headers=user.headers).json()["report_series_id"]
    history = client.get("/api/report-history", params={"series_id": series}, headers=superuser.headers).json()["items"]
    assert history and all(item["owner_title"] for item in history)


def test_owner_titles_are_read_in_one_batch_per_kind(client, superuser, user):
    _reports(client, superuser, user)
    statements = []

    def count(_conn, _cursor, statement, *_args):
        if "FROM events" in statement or "FROM subevents" in statement:
            statements.append(statement)

    from main import _report_owner_titles
    reports = db.list_reports(current_user_id=user.user_id)
    sa_event.listen(engine, "before_cursor_execute", count)
    try:
        titles = _report_owner_titles(reports)
    finally:
        sa_event.remove(engine, "before_cursor_execute", count)
    assert sorted(titles.values()) == ["Квест", "Лекции", "Посвят"]
    assert len(statements) == 2
