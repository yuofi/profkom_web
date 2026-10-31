"""A subevent tells who reads its reports (audit EV-14).

The subevent's HR curator has working access (tasks) in an open season, but neither
its meeting nor its reports: the report list is filtered to nothing for them. The
`view_reports` capability lets the UI refuse instead of saying there are no reports.
"""
from api_helpers import post_season


def _team(client, superuser, make_user):
    season = client.post("/api/seasons", json={
        "title": "Сезон", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z",
    }, headers=superuser.headers).json()
    assert post_season(client, f"/api/seasons/{season['season_id']}/open", headers=superuser.headers).json()["state"] == "open"
    event_id = client.post("/api/events", json={"season_id": season["season_id"], "title": "Посвят"}, headers=superuser.headers).json()["event_id"]
    sub = client.post(f"/api/events/{event_id}/subevents", json={"title": "Лекции"}, headers=superuser.headers).json()
    sid = sub["subevent_id"]
    leader, organizer, hr = make_user(), make_user(), make_user()
    assert client.put(f"/api/subevents/{sid}/leaders", json={"user_ids": [leader.user_id], "expected_revision": 1}, headers=superuser.headers).status_code == 200
    revision = client.get(f"/api/subevents/{sid}", headers=superuser.headers).json()["revision"]
    assert client.put(f"/api/subevents/{sid}/organizers", json={"user_ids": [organizer.user_id], "expected_revision": revision}, headers=superuser.headers).status_code == 200
    revision = client.get(f"/api/subevents/{sid}", headers=superuser.headers).json()["revision"]
    assert client.put(f"/api/subevents/{sid}/hr", json={"user_id": hr.user_id, "expected_revision": revision}, headers=superuser.headers).status_code == 200
    report = client.post("/api/reports", json={"owner_kind": "subevent", "owner_id": sid, "kind": "regular", "title": "Регулярный отчёт", "content": "Текст", "file_ids": []}, headers=leader.headers)
    assert report.status_code in (200, 201), report.text
    assert client.post(f"/api/reports/{report.json()['report_id']}/publish", json={"expected_revision": 1}, headers=leader.headers).status_code == 200
    return sid, report.json()["report_id"], {"chair": superuser, "leader": leader, "organizer": organizer, "hr": hr}


def test_view_reports_matches_the_filtered_report_list(client, superuser, make_user):
    sid, report_id, actors = _team(client, superuser, make_user)
    for name, actor in actors.items():
        sub = client.get(f"/api/subevents/{sid}", headers=actor.headers).json()
        listed = [item["report_id"] for item in client.get("/api/reports", params={"owner_kind": "subevent", "owner_id": sid}, headers=actor.headers).json()["items"]]
        assert ("view_reports" in sub["capabilities"]) == (listed == [report_id]), name
        assert ("view_reports" in sub["capabilities"]) == (name != "hr"), name


def test_hr_curator_works_on_tasks_without_meeting_or_reports(client, superuser, make_user):
    sid, report_id, actors = _team(client, superuser, make_user)
    hr = actors["hr"]
    sub = client.get(f"/api/subevents/{sid}", headers=hr.headers).json()
    # Working access with other capabilities: an open season, not a closed one.
    assert sub["working_access"] is True and "view_tasks" in sub["capabilities"]
    assert not {"view_meeting", "view_reports"} & set(sub["capabilities"])
    assert client.get(f"/api/reports/{report_id}", headers=hr.headers).status_code == 404
