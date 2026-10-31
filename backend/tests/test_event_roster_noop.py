"""Saving an unchanged event/subevent roster is a no-op (audit EV-02).

A repeated PUT with the same leaders or organizers must not raise the owner's
revision: other open forms of the same event keep their baseline instead of
receiving a 409. A stale revision is still refused, and a real change still
advances the revision.
"""


def _event_with_subevent(client, superuser):
    season = client.post("/api/seasons", json={
        "title": "Сезон", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z",
    }, headers=superuser.headers).json()
    event = client.post("/api/events", json={"season_id": season["season_id"], "title": "Посвят"}, headers=superuser.headers).json()
    sub = client.post(f"/api/events/{event['event_id']}/subevents", json={"title": "Квест"}, headers=superuser.headers).json()
    return event["event_id"], sub["subevent_id"]


def _notifications(client, actor):
    return len(client.get("/api/notifications", headers=actor.headers).json()["items"])


def test_same_event_leaders_keep_revision_and_send_nothing(client, superuser, user, make_user):
    other = make_user(email="other-leader@test.local")
    event_id, _ = _event_with_subevent(client, superuser)
    first = client.put(f"/api/events/{event_id}/leaders", json={"user_ids": [user.user_id, other.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert first.status_code == 200 and first.json()["revision"] == 2
    seen = _notifications(client, user)
    again = client.put(f"/api/events/{event_id}/leaders", json={"user_ids": [other.user_id, user.user_id], "expected_revision": 2}, headers=superuser.headers)
    assert again.status_code == 200
    assert again.json()["revision"] == 2
    assert {leader["user"]["user_id"] for leader in again.json()["leaders"]} == {user.user_id, other.user_id}
    assert client.get(f"/api/events/{event_id}", headers=superuser.headers).json()["revision"] == 2
    assert _notifications(client, user) == seen
    # A stale baseline is still refused even when nothing would change.
    assert client.put(f"/api/events/{event_id}/leaders", json={"user_ids": [user.user_id, other.user_id], "expected_revision": 1}, headers=superuser.headers).status_code == 409
    changed = client.put(f"/api/events/{event_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 2}, headers=superuser.headers)
    assert changed.status_code == 200 and changed.json()["revision"] == 3


def test_same_subevent_leaders_and_organizers_keep_revision(client, superuser, user, make_user):
    organizer = make_user(email="organizer@test.local")
    second = make_user(email="organizer2@test.local")
    _, sub_id = _event_with_subevent(client, superuser)
    led = client.put(f"/api/subevents/{sub_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert led.status_code == 200 and led.json()["revision"] == 2
    same = client.put(f"/api/subevents/{sub_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 2}, headers=superuser.headers)
    assert same.status_code == 200 and same.json()["revision"] == 2
    staffed = client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [organizer.user_id, second.user_id], "expected_revision": 2}, headers=superuser.headers)
    assert staffed.status_code == 200 and staffed.json()["revision"] == 3
    unchanged = client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [organizer.user_id, second.user_id], "expected_revision": 3}, headers=superuser.headers)
    assert unchanged.status_code == 200 and unchanged.json()["revision"] == 3
    assert unchanged.json()["organizer_user_ids"] == [organizer.user_id, second.user_id]
    assert client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [organizer.user_id, second.user_id], "expected_revision": 2}, headers=superuser.headers).status_code == 409
    # The saved order is part of the roster: a reordering is a real change.
    reordered = client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [second.user_id, organizer.user_id], "expected_revision": 3}, headers=superuser.headers)
    assert reordered.status_code == 200 and reordered.json()["revision"] == 4
    assert client.get(f"/api/subevents/{sub_id}", headers=superuser.headers).json()["revision"] == 4
