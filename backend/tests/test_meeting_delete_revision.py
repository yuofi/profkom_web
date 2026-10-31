"""Removing a meeting announcement checks the confirmed revision (audit EV-05).

The UI asks before removing an announcement; the command then carries the
revision the user saw. A newer announcement is refused with 409 and stays,
while older clients without a body keep the previous behaviour.
"""


def _subevent_with_leader(client, superuser, user):
    season = client.post("/api/seasons", json={
        "title": "Сезон", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z",
    }, headers=superuser.headers).json()
    event_id = client.post("/api/events", json={"season_id": season["season_id"], "title": "Посвят"}, headers=superuser.headers).json()["event_id"]
    sub_id = client.post(f"/api/events/{event_id}/subevents", json={"title": "Квест"}, headers=superuser.headers).json()["subevent_id"]
    assert client.put(f"/api/subevents/{sub_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers).status_code == 200
    return event_id, sub_id


MEETING = {"title": "Синхрон", "starts_at": "2026-03-02T19:00:00Z", "join_url": "https://telemost.yandex.ru/1"}


def test_meeting_delete_refuses_a_changed_announcement_and_accepts_the_seen_one(client, superuser, user):
    event_id, sub_id = _subevent_with_leader(client, superuser, user)
    for path in (f"/api/subevents/{sub_id}/meeting", f"/api/events/{event_id}/meeting"):
        first = client.put(path, json=MEETING, headers=superuser.headers).json()
        changed = client.put(path, json={**MEETING, "title": "Перенесли", "expected_revision": first["revision"]}, headers=superuser.headers).json()
        assert changed["revision"] == first["revision"] + 1
        stale = client.request("DELETE", path, json={"expected_revision": first["revision"]}, headers=superuser.headers)
        assert stale.status_code == 409
        assert client.get(path, headers=superuser.headers).json()["title"] == "Перенесли"
        removed = client.request("DELETE", path, json={"expected_revision": changed["revision"]}, headers=superuser.headers)
        assert removed.status_code == 200
        assert client.get(path, headers=superuser.headers).json() is None
        # Already removed: repeating the confirmed command is harmless.
        assert client.request("DELETE", path, json={"expected_revision": changed["revision"]}, headers=superuser.headers).status_code == 200


def test_meeting_delete_without_revision_keeps_compatibility_and_access(client, superuser, user, make_user):
    outsider = make_user(email="outsider-meeting@test.local")
    _, sub_id = _subevent_with_leader(client, superuser, user)
    path = f"/api/subevents/{sub_id}/meeting"
    assert client.put(path, json=MEETING, headers=user.headers).status_code == 200
    assert client.request("DELETE", path, json={"expected_revision": 1}, headers=outsider.headers).status_code == 403
    assert client.request("DELETE", path, json={"expected_revision": 1, "extra": 1}, headers=user.headers).status_code == 422
    assert client.delete(path, headers=user.headers).status_code == 200
    assert client.get(path, headers=user.headers).json() is None
