"""The administration cabinet: PGAS admins and temporary passwords (АВ-34, АВ-52, decision 14)."""
import json

import pytest

from database import db, AuditLogORM


def bearer(token):
    return {"Authorization": "Bearer " + token}


def caps(client, actor_headers):
    return client.get("/api/session", headers=actor_headers).json()["capabilities"]


@pytest.fixture
def deputy(client, superuser, make_user):
    d = make_user(in_profcom=True)
    lead = client.get("/api/leadership", headers=superuser.headers).json()
    r = client.put("/api/leadership/deputies", headers=superuser.headers,
                   json={"user_ids": [d.user_id], "expected_revision": lead["revision"]})
    assert r.status_code == 200, r.text
    return d


def audit_rows(target_id, reason):
    with db._session() as s:
        return [(json.loads(a.old_values_json), json.loads(a.new_values_json), a.changed_by_user_id)
                for a in s.query(AuditLogORM).filter_by(target_kind="user", target_id=str(target_id), reason=reason)]


def test_chair_and_deputies_give_and_take_pgas_admin(client, superuser, deputy, user, make_user):
    assert "grant_pgas_admin" in caps(client, superuser.headers)
    assert "manage_pgas" not in caps(client, user.headers)
    given = client.put(f"/api/users/{user.user_id}/pgas-admin", headers=deputy.headers, json={"pgas_admin": True})
    assert given.status_code == 200, given.text
    assert given.json() == {"user_id": user.user_id, "pgas_admin": True}
    assert "manage_pgas" in caps(client, user.headers)
    listed = client.get("/api/pgas-admins", headers=superuser.headers).json()["items"]
    assert [a["user_id"] for a in listed] == [user.user_id]
    # Saving the same value again is no new audit record.
    client.put(f"/api/users/{user.user_id}/pgas-admin", headers=superuser.headers, json={"pgas_admin": True})
    assert audit_rows(user.user_id, "pgas_admin") == [({"pgas_admin": False}, {"pgas_admin": True}, deputy.user_id)]
    taken = client.put(f"/api/users/{user.user_id}/pgas-admin", headers=superuser.headers, json={"pgas_admin": False})
    assert taken.status_code == 200 and taken.json()["pgas_admin"] is False
    assert "manage_pgas" not in caps(client, user.headers)
    assert client.get("/api/pgas-admins", headers=superuser.headers).json()["items"] == []


def test_a_pgas_admin_cannot_hand_the_right_on(client, pgas_admin, user):
    assert "manage_pgas" in caps(client, pgas_admin.headers)
    assert "grant_pgas_admin" not in caps(client, pgas_admin.headers)
    for actor in (pgas_admin, user):
        assert client.put(f"/api/users/{user.user_id}/pgas-admin", headers=actor.headers, json={"pgas_admin": True}).status_code == 403
        assert client.get("/api/pgas-admins", headers=actor.headers).status_code == 403
    assert client.put("/api/users/999999/pgas-admin", headers=pgas_admin.headers, json={"pgas_admin": True}).status_code == 403


def test_pgas_admin_needs_an_active_account(client, superuser):
    assert client.put("/api/users/999999/pgas-admin", headers=superuser.headers, json={"pgas_admin": True}).status_code == 404


def test_temporary_password_must_be_changed_before_any_work(client, superuser, user):
    """АВ-52 (а): the chair hands a one-time password; old sessions end; the account works
    again only after its own new password."""
    issued = client.post(f"/api/accounts/{user.user_id}/temporary-password", headers=superuser.headers, json={})
    assert issued.status_code == 200, issued.text
    body = issued.json()
    assert body["user_id"] == user.user_id and body["email"] == user.email and len(body["temporary_password"]) >= 12
    # The old access token and the old password stop working.
    assert client.get("/api/profile/me", headers=user.headers).status_code == 401
    assert client.post("/api/auth/login", json={"email": user.email, "password": user.password}).status_code == 401
    login = client.post("/api/auth/login", json={"email": user.email, "password": body["temporary_password"]})
    assert login.status_code == 200, login.text
    h = bearer(login.json()["access_token"])
    session = client.get("/api/session", headers=h).json()
    assert session["password_change_required"] is True and session["capabilities"] == []
    blocked = client.get("/api/contacts", headers=h)
    assert blocked.status_code == 403
    changed = client.post("/api/auth/change-password", headers=h,
                          json={"old_password": body["temporary_password"], "new_password": "Own-New-Pass-2026"})
    assert changed.status_code == 200, changed.text
    again = client.post("/api/auth/login", json={"email": user.email, "password": "Own-New-Pass-2026"})
    h = bearer(again.json()["access_token"])
    assert client.get("/api/session", headers=h).json()["password_change_required"] is False
    assert client.get("/api/contacts", headers=h).status_code == 200
    # The audit says who reset it, never the password.
    rows = audit_rows(user.user_id, "temporary_password")
    assert rows == [({"has_password": True}, {"must_change_password": True}, superuser.user_id)]
    with db._session() as s:
        stored = " ".join(a.old_values_json + a.new_values_json for a in s.query(AuditLogORM))
    assert body["temporary_password"] not in stored


def test_a_vk_only_account_gets_its_first_password(client, superuser, make_user):
    vk_only = make_user(password=None)
    assert client.get("/api/profile/me", headers=vk_only.headers).json()["has_password"] is False
    issued = client.post(f"/api/accounts/{vk_only.user_id}/temporary-password", headers=superuser.headers, json={})
    assert issued.status_code == 200
    assert audit_rows(vk_only.user_id, "temporary_password")[0][0] == {"has_password": False}


def test_nobody_takes_over_the_chair_or_a_deputy(client, superuser, deputy, user, make_user):
    for target in (superuser, deputy):
        for actor in (superuser, deputy):
            r = client.post(f"/api/accounts/{target.user_id}/temporary-password", headers=actor.headers, json={})
            assert r.status_code == 403, (actor.user_id, target.user_id)
    assert client.post(f"/api/accounts/{superuser.user_id}/temporary-password", headers=user.headers, json={}).status_code == 403
    assert "reset_password" not in caps(client, user.headers)
    other = make_user()
    assert client.post(f"/api/accounts/{other.user_id}/temporary-password", headers=user.headers, json={}).status_code == 403
    assert client.post("/api/accounts/999999/temporary-password", headers=deputy.headers, json={}).status_code == 404


def test_new_chair_keeps_their_sessions_after_the_transfer(client, superuser, make_user):
    """Decision 25 (REVOCATION-08): the transfer ends the former leadership's sessions only."""
    successor = make_user(in_profcom=True)
    lead = client.get("/api/leadership", headers=superuser.headers).json()
    r = client.post("/api/leadership/transfer", headers=superuser.headers,
                    json={"new_chair_user_id": successor.user_id, "expected_revision": lead["revision"]})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    kept = client.post("/api/auth/refresh", headers={"Cookie": "refresh_token=" + successor.refresh_token})
    assert kept.status_code == 200, kept.text
    ended = client.post("/api/auth/refresh", headers={"Cookie": "refresh_token=" + superuser.refresh_token})
    assert ended.status_code == 401
