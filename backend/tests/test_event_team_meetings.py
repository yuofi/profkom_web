"""The event's team meetings in one request (audit PF-14).

GET /events/{id}/meetings replaces one GET /subevents/{sid}/meeting per team on
the event meeting page. It must answer exactly what those per-team requests
answer for the same actor: hidden teams and meetings outside their audience are
absent, and a closed season offers no current announcements. A subevent also
names its parent event, so its page no longer rereads the event for crumbs.
"""
from database import SeasonORM, db


def _world(client, superuser, user, make_user):
    other = make_user(email="team-meetings-other@test.local")
    season = client.post("/api/seasons", json={
        "title": "Сезон", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z",
    }, headers=superuser.headers).json()
    event_id = client.post("/api/events", json={"season_id": season["season_id"], "title": "Посвят"}, headers=superuser.headers).json()["event_id"]
    subs = {}
    for title, leader, starts in (("Лекции", user, "2026-03-03T19:00:00Z"), ("Квест", other, "2026-03-02T19:00:00Z"), ("Без созвона", None, None)):
        sid = client.post(f"/api/events/{event_id}/subevents", json={"title": title}, headers=superuser.headers).json()["subevent_id"]
        if leader:
            assert client.put(f"/api/subevents/{sid}/leaders", json={"user_ids": [leader.user_id], "expected_revision": 1}, headers=superuser.headers).status_code == 200
        if starts:
            assert client.put(f"/api/subevents/{sid}/meeting", json={"title": f"Созвон: {title}", "starts_at": starts, "join_url": "https://telemost.yandex.ru/1"}, headers=superuser.headers).status_code == 200
        subs[title] = sid
    # The event's own meeting is not a team meeting.
    assert client.put(f"/api/events/{event_id}/meeting", json={"title": "Главный", "starts_at": "2026-03-01T19:00:00Z", "join_url": "https://telemost.yandex.ru/2"}, headers=superuser.headers).status_code == 200
    return season["season_id"], event_id, subs, other


def _per_team(client, actor, event_id):
    """What the page used to assemble from N requests."""
    found = []
    for sub in client.get(f"/api/events/{event_id}/subevents", headers=actor.headers).json()["items"]:
        answer = client.get(f"/api/subevents/{sub['subevent_id']}/meeting", headers=actor.headers)
        if answer.status_code == 200 and answer.json():
            found.append({"subevent_id": sub["subevent_id"], "subevent_title": sub["title"], "meeting": answer.json()})
    return sorted(found, key=lambda item: (item["meeting"]["starts_at"], item["subevent_id"]))


def test_team_meetings_match_the_per_team_answers_for_every_actor(client, superuser, user, make_user):
    outsider = make_user(email="team-meetings-outsider@test.local")
    _, event_id, subs, other = _world(client, superuser, user, make_user)
    everything = client.get(f"/api/events/{event_id}/meetings", headers=superuser.headers)
    assert everything.status_code == 200
    assert [item["subevent_title"] for item in everything.json()["items"]] == ["Квест", "Лекции"]
    assert everything.json()["items"][0]["meeting"]["title"] == "Созвон: Квест"
    for actor in (superuser, user, other, outsider):
        items = client.get(f"/api/events/{event_id}/meetings", headers=actor.headers).json()["items"]
        assert items == _per_team(client, actor, event_id)
    # A team leader sees the own team's meeting, not the neighbour's.
    assert [item["subevent_id"] for item in client.get(f"/api/events/{event_id}/meetings", headers=user.headers).json()["items"]] == [subs["Лекции"]]
    assert client.get("/api/events/missing/meetings", headers=superuser.headers).status_code == 404


def test_closed_season_has_no_current_team_meetings(client, superuser, user, make_user):
    season_id, event_id, _, _ = _world(client, superuser, user, make_user)
    with db._session() as session:
        session.get(SeasonORM, season_id).state = "closed"
        session.commit()
    for actor in (superuser, user):
        items = client.get(f"/api/events/{event_id}/meetings", headers=actor.headers).json()["items"]
        assert items == _per_team(client, actor, event_id) == []


def test_subevent_names_its_parent_event(client, superuser, user, make_user):
    _, event_id, subs, _ = _world(client, superuser, user, make_user)
    assert client.get(f"/api/subevents/{subs['Квест']}", headers=user.headers).json()["event_title"] == "Посвят"
    listed = client.get(f"/api/events/{event_id}/subevents", headers=user.headers).json()["items"]
    assert {item["event_title"] for item in listed} == {"Посвят"}
