import pytest
from database import db
from test_v13_access_contract import REGISTER


def signup(client):
    r = client.post("/api/auth/register", json=REGISTER)
    assert r.status_code == 201
    h = {"Authorization": "Bearer " + r.json()["access_token"]}
    return h, client.get("/api/registrations/me", headers=h).json()


def test_registration_approval_and_contact_preservation(client, superuser):
    h, r = signup(client)
    assert r["attempts_used"] == 1 and r["status"] == "pending"
    assert client.get("/api/registrations", headers=h).status_code == 403
    a = client.post(
        f"/api/registrations/{r['user_id']}/approve",
        headers=superuser.headers,
        json={"expected_revision": r["revision"]},
    )
    assert a.status_code == 200, a.text
    assert a.json()["status"] == "approved"
    assert client.get("/api/session", headers=h).json()["account_state"] == "active"
    p = client.get("/api/profile/me", headers=h).json()
    assert p["phone"] == REGISTER["phone"] and p["in_profcom"] is True
    assert client.get("/api/contacts", headers=h).status_code == 200


def test_registration_resubmissions_limit_and_reset(client, superuser):
    h, r = signup(client)
    uid = r["user_id"]
    for n in range(1, 6):
        assert r["attempts_used"] == n
        r = client.post(
            f"/api/registrations/{uid}/reject",
            headers=superuser.headers,
            json={"expected_revision": r["revision"], "reason": "Уточнить"},
        ).json()
        if n < 5:
            old = r["revision"]
            r = client.post(
                "/api/registrations/me/resubmit",
                headers=h,
                json={"expected_revision": old},
            ).json()
            assert r["total_submissions"] == n + 1
            assert (
                client.post(
                    "/api/registrations/me/resubmit",
                    headers=h,
                    json={"expected_revision": old},
                ).status_code
                == 409
            )
    assert (
        client.post(
            "/api/registrations/me/resubmit",
            headers=h,
            json={"expected_revision": r["revision"]},
        ).status_code
        == 409
    )
    reset = client.post(
        f"/api/registrations/{uid}/reset-attempts",
        headers=superuser.headers,
        json={"expected_revision": r["revision"], "reason": "Исправлена ошибка"},
    ).json()
    assert (
        reset["attempts_used"] == 0
        and reset["total_submissions"] == 5
        and reset["status"] == "rejected"
    )
    assert (
        client.get("/api/session", headers=h).json()["registration_status"]
        == "rejected"
    )


def test_incomplete_application_cannot_be_approved(client, superuser):
    payload = {
        k: v
        for k, v in REGISTER.items()
        if k not in ("phone", "vk", "funding", "residence")
    }
    r = client.post("/api/auth/register", json=payload)
    h = {"Authorization": "Bearer " + r.json()["access_token"]}
    a = client.get("/api/registrations/me", headers=h).json()
    assert (
        client.post(
            f"/api/registrations/{a['user_id']}/approve",
            headers=superuser.headers,
            json={"expected_revision": a["revision"]},
        ).status_code
        == 422
    )
    assert client.get("/api/session", headers=h).json()["account_state"] == "pending"
