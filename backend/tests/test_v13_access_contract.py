"""API 1.3 regressions, using the isolated DB and external mocks from conftest."""

import pytest
from database import db
from models import Guide

REGISTER = dict(
    email="new-v13@example.com",
    password="synthetic-password",
    surname="Иванов",
    name="Иван",
    group_number=101,
    tg="ivanov",
    phone="+79990000000",
    vk="https://vk.com/id1",
    funding="budget",
    residence="Москва",
)


def test_registration_is_pending_and_does_not_log_password(client, caplog):
    r = client.post("/api/auth/register", json=REGISTER)
    assert r.status_code == 201
    assert REGISTER["password"] not in caplog.text
    s = client.get(
        "/api/session", headers={"Authorization": "Bearer " + r.json()["access_token"]}
    ).json()
    assert (s["account_state"], s["registration_status"]) == ("pending", "pending")


@pytest.mark.parametrize(
    "path",
    [
        "/blocks",
        "/guides",
        "/events",
        "/seasons",
        "/reports",
        "/dashboard",
        "/calendar",
        "/notifications",
    ],
)
def test_working_content_requires_approval(client, make_user, path):
    u = make_user()
    db.update_user(u.user_id, account_state="pending")
    assert client.get("/api" + path, headers=u.headers).status_code == 403
    assert client.get("/api" + path, headers={}).status_code == 401


@pytest.mark.parametrize(
    "data",
    [
        {"blocks": "IT"},
        {"in_profcom": True},
        {"events_roles": "[]"},
        {"photo_url": "https://example.com/a"},
    ],
)
def test_self_profile_rejects_non_contact_fields(client, user, data):
    assert (
        client.patch(
            f"/api/profile/{user.user_id}", headers=user.headers, json=data
        ).status_code
        == 422
    )


def test_profile_does_not_expose_score_or_private_roles(client, user):
    for path in ["/profile/me", f"/profile/{user.user_id}"]:
        r = client.get("/api" + path, headers=user.headers)
        assert r.status_code == 200
        assert "kkr_score" not in r.json()
        assert "events_roles" not in r.json()


def test_only_owner_writes_current_contacts(client, user, superuser):
    assert (
        client.patch(
            f"/api/profile/{user.user_id}",
            headers=superuser.headers,
            json={"phone": "+79990000000"},
        ).status_code
        == 403
    )


def test_legacy_enter_cannot_bypass_application(client, user, make_block):
    b = make_block()
    assert (
        client.post(
            f"/api/blocks/{b.name}/enter", headers=user.headers, json={}
        ).status_code
        == 409
    )
    assert not db.is_block_member(user.user_id, b.name)


@pytest.mark.parametrize(
    "path",
    [
        "/seasons",
        "/events",
        "/report-series",
        "/tasks",
        "/reports",
        "/notifications",
        "/calendar",
    ],
)
def test_new_lists_use_cursor_envelope(client, user, path):
    r = client.get("/api" + path, headers=user.headers)
    assert r.status_code == 200
    assert set(r.json()) == {"items", "next_cursor"}
    assert isinstance(r.json()["items"], list)
    assert r.json()["next_cursor"] is None


def test_chair_session_uses_contract_capabilities(client, superuser):
    caps = client.get("/api/session", headers=superuser.headers).json()["capabilities"]
    assert {
        "create_event",
        "view_kkr",
        "view_summary",
        "review_registrations",
        "transfer_chair",
        "manage_chair_deputies",
    } <= set(caps)


def test_global_guide_is_private(client):
    g = db.create_guide(
        Guide(guide_id=0, title="Private", owner_block="none", text="Synthetic")
    )
    assert client.get(f"/api/guides/{g.guide_id}").status_code == 401


def test_file_limits_and_complete_ownership(client, user, make_user):
    other = make_user()
    base = dict(
        owner_kind="avatar",
        purpose="avatar",
        name="a.png",
        mime_type="image/png",
        size_bytes=4,
    )
    assert (
        client.post(
            "/api/files/upload-intents",
            headers=user.headers,
            json={**base, "size_bytes": 11 * 1024 * 1024},
        ).status_code
        == 422
    )
    r = client.post("/api/files/upload-intents", headers=user.headers, json=base)
    assert r.status_code == 200
    fid = r.json()["file_id"]
    assert (
        client.post(
            f"/api/files/{fid}/complete", headers=other.headers, json={}
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/files/{fid}/complete", headers=user.headers, json={}
        ).status_code
        == 409
    )


def test_vk_namesake_does_not_authenticate_existing_account(client, make_user, mock_vk):
    existing = make_user(name="Пётр", surname="Сидоров")
    mock_vk(user_id="987", first_name="Пётр", last_name="Сидоров")
    r = client.post("/api/auth/vk", json={"access_token": "synthetic"})
    assert r.status_code == 200
    session = client.get(
        "/api/session", headers={"Authorization": "Bearer " + r.json()["access_token"]}
    ).json()
    assert session["user_id"] != existing.user_id
    assert session["account_state"] == "pending"


def test_vk_link_requires_authenticated_owner_and_repeat_is_stable(
    client, user, mock_vk, mock_s3
):
    mock_vk(user_id="876", avatar="https://synthetic.invalid/avatar.png")
    assert (
        client.post("/api/auth/vk/link", json={"access_token": "synthetic"}).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/vk/link",
            headers=user.headers,
            json={"access_token": "synthetic"},
        ).status_code
        == 200
    )
    for _ in range(2):
        r = client.post("/api/auth/vk", json={"access_token": "synthetic"})
        assert r.status_code == 200
        s = client.get(
            "/api/session",
            headers={"Authorization": "Bearer " + r.json()["access_token"]},
        ).json()
        assert s["user_id"] == user.user_id
    assert mock_s3["upload"] == []


def test_legacy_superuser_flag_does_not_grant_domain_role(client, user):
    db.update_user(user.user_id, super_user=True)
    assert client.post(
        "/api/leadership/deputies",
        headers=user.headers,
        json={"user_ids": [], "expected_revision": 1},
    ).status_code in (403, 405)
    assert not db.is_chair(user.user_id)


def test_revoke_sessions_also_revokes_access_token(client, user):
    db.revoke_sessions(user.user_id)
    assert client.get("/api/session", headers=user.headers).status_code == 401


def test_workspace_aggregate_contract(client, user):
    r = client.get("/api/dashboard", headers=user.headers)
    assert r.status_code == 200
    assert set(r.json()) == {
        "my_tasks",
        "upcoming_meetings",
        "my_blocks",
        "my_events",
        "actionable_requests",
        "unresolved_assignments",
        "unread_notification_count",
        "pending_registration_count",
    }


def test_private_file_complete_and_download(client, user, mock_s3):
    content = b"\x89PNG\r\n\x1a\n" + b"synthetic"
    r = client.post(
        "/api/files/upload-intents",
        headers=user.headers,
        json=dict(
            owner_kind="avatar",
            purpose="avatar",
            name="a.png",
            mime_type="image/png",
            size_bytes=len(content),
        ),
    )
    assert r.status_code == 200
    intent = r.json()
    fid = intent["file_id"]
    assert "put_object" in intent["upload_url"]
    mock_s3["objects"]["private/" + fid] = (content, "image/png")
    result = client.post(f"/api/files/{fid}/complete", headers=user.headers, json={})
    assert result.status_code == 200
    assert result.json() == dict(
        file_id=fid, name="a.png", mime_type="image/png", size_bytes=len(content)
    )
    assert (
        client.post(f"/api/files/{fid}/complete", headers=user.headers, json={}).json()
        == result.json()
    )
    r = client.get(f"/api/files/{fid}/download", headers=user.headers)
    assert r.status_code == 200
    assert "get_object" in r.json()["download_url"]
