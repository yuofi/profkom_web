from datetime import datetime, timedelta, timezone
from database import db, NotificationORM
from test_v13_access_contract import REGISTER


def test_registration_reviewer_notification_is_once_per_submission(client, superuser):
    registration = client.post("/api/auth/register", json=REGISTER)
    assert registration.status_code == 201
    headers = {"Authorization": "Bearer " + registration.json()["access_token"]}
    own = client.get("/api/registrations/me", headers=headers).json()
    uid = own["user_id"]
    with db._session() as s:
        assert (
            s.query(NotificationORM)
            .filter_by(user_id=superuser.user_id, kind="registration_submitted")
            .count()
            == 1
        )
    rejected = client.post(
        f"/api/registrations/{uid}/reject",
        headers=superuser.headers,
        json=dict(expected_revision=own["revision"], reason="Fix"),
    ).json()
    r = client.post(
        "/api/registrations/me/resubmit",
        headers=headers,
        json=dict(expected_revision=rejected["revision"]),
    )
    assert r.status_code == 200, r.text
    assert (
        client.post(
            "/api/registrations/me/resubmit",
            headers=headers,
            json=dict(expected_revision=rejected["revision"]),
        ).status_code
        == 409
    )
    with db._session() as s:
        assert (
            s.query(NotificationORM)
            .filter_by(user_id=superuser.user_id, kind="registration_submitted")
            .count()
            == 2
        )


def test_event_dates_are_aware_bounded_and_explicitly_clearable(client, superuser):
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=20)
    season = client.post(
        "/api/seasons",
        headers=superuser.headers,
        json=dict(
            title="Dates",
            type="summer_autumn",
            starts_at=now.isoformat(),
            ends_at=end.isoformat(),
        ),
    ).json()
    base = dict(season_id=season["season_id"], title="Event", description="")
    for dates in (
        dict(starts_at="not-a-date"),
        dict(starts_at="2026-01-01T00:00:00"),
        dict(starts_at=(end + timedelta(days=1)).isoformat()),
        dict(starts_at=(now + timedelta(days=2)).isoformat(), ends_at=now.isoformat()),
    ):
        r = client.post(
            "/api/events", headers=superuser.headers, json={**base, **dates}
        )
        assert r.status_code == 422, r.text
    event = client.post(
        "/api/events",
        headers=superuser.headers,
        json={
            **base,
            "starts_at": now.isoformat(),
            "ends_at": (now + timedelta(days=2)).isoformat(),
        },
    ).json()
    updated = client.patch(
        "/api/events/" + event["event_id"],
        headers=superuser.headers,
        json=dict(expected_revision=event["revision"], starts_at=None, ends_at=None),
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["starts_at"] is None and updated.json()["ends_at"] is None


def test_new_validation_error_has_contract_envelope(client, superuser):
    r = client.post("/api/materials", headers=superuser.headers, json={})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "validation_error" and isinstance(detail["message"], str)
    assert any(e["loc"] == ["body", "title"] for e in detail["fields"]["errors"])
