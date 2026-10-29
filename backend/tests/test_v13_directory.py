import json
from database import db, UserORM
from domain_models import FormerContactORM, MigrationORM, ProfileMetadataORM
from directory_seed import migrate_avatars
from directory import avatar_url


def test_directory_filters_and_emails_hide_unapproved(client, user, make_user):
    active = make_user(surname="Искомый", group_number="301", in_profcom=True)
    pending = make_user(surname="Искомый")
    db.update_user(pending.user_id, account_state="pending")
    r = client.get(
        "/api/contacts",
        headers=user.headers,
        params=dict(q="искомый", group_number="301"),
    )
    assert r.status_code == 200, r.text
    assert [c["user_id"] for c in r.json()] == [active.user_id]
    emails = client.get(
        "/api/contacts/emails", headers=user.headers, params=dict(q="искомый")
    ).json()["emails"]
    assert emails == [active.email]
    assert (
        client.post(
            "/api/contacts/filter", headers=user.headers, json=dict(group_number="301")
        ).status_code
        == 200
    )
    assert client.get("/api/contacts", headers=pending.headers).status_code == 403


def test_former_contact_is_separate_and_periods_validate(client, user, superuser):
    fields = dict(
        surname="Бывший",
        name="Участник",
        phone="",
        email="",
        tg="",
        vk="",
        participation_periods=[dict(from_year=2020, to_year=2022)],
    )
    assert (
        client.post(
            "/api/contacts/archive", headers=user.headers, json=fields
        ).status_code
        == 403
    )
    made = client.post("/api/contacts/archive", headers=superuser.headers, json=fields)
    assert made.status_code == 200, made.text
    cid = made.json()["contact_id"]
    assert "user_id" not in made.json()
    assert (
        client.get("/api/contacts/archive", headers=user.headers).json()["items"][0][
            "contact_id"
        ]
        == cid
    )
    fields["phone"] = "+79990000000"
    assert (
        client.patch(
            "/api/contacts/archive/" + cid, headers=superuser.headers, json={**fields, "expected_revision": made.json()["revision"]}
        ).json()["phone"]
        == fields["phone"]
    )
    fields["participation_periods"] = [dict(from_year=2022, to_year=2020)]
    assert (
        client.post(
            "/api/contacts/archive", headers=superuser.headers, json=fields
        ).status_code
        == 422
    )
    own = client.patch(
        f"/api/profile/{user.user_id}",
        headers=user.headers,
        json=dict(participation_periods=[dict(from_year=2023, to_year=2026)]),
    )
    assert own.status_code == 200, own.text
    assert client.get("/api/profile/me", headers=user.headers).json()[
        "participation_periods"
    ] == [dict(from_year=2023, to_year=2026)]


def test_avatars_presets_and_owned_completed_file(client, user, make_user, mock_s3):
    other = make_user()
    presets = client.get("/api/avatars", headers=user.headers).json()
    assert len(presets["items"]) >= 6 and presets["default_preset_id"] == "default"
    for payload in (
        {},
        {"file_id": "x", "preset_id": "leaf"},
        {"preset_id": "unknown"},
    ):
        assert (
            client.put(
                "/api/profile/me/avatar", headers=user.headers, json=payload
            ).status_code
            == 422
        )
    assert (
        client.put(
            "/api/profile/me/avatar", headers=user.headers, json=dict(preset_id="leaf")
        ).json()["photo_url"]
        == "/avatars/leaf.svg"
    )
    content = b"\x89PNG\r\n\x1a\nsynthetic"
    intent = client.post(
        "/api/files/upload-intents",
        headers=user.headers,
        json=dict(
            owner_kind="avatar",
            purpose="avatar",
            name="a.png",
            mime_type="image/png",
            size_bytes=len(content),
        ),
    ).json()
    fid = intent["file_id"]
    assert (
        client.put(
            "/api/profile/me/avatar", headers=user.headers, json=dict(file_id=fid)
        ).status_code
        == 422
    )
    mock_s3["objects"]["private/" + fid] = (content, "image/png")
    assert (
        client.post(
            "/api/files/" + fid + "/complete", headers=user.headers, json={}
        ).status_code
        == 200
    )
    assert (
        client.put(
            "/api/profile/me/avatar", headers=other.headers, json=dict(file_id=fid)
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/profile/me/avatar", headers=user.headers, json=dict(file_id=fid)
        ).json()["photo_url"]
        == f"/api/files/{fid}/content"
    )
    assert (
        client.get("/api/files/" + fid + "/download", headers=other.headers).status_code
        == 200
    )
    assert client.get(f"/api/files/{fid}/content", headers=other.headers).content == content
    client.put(
        "/api/profile/me/avatar", headers=user.headers, json=dict(preset_id="default")
    )
    # The same address stops at once for a replaced avatar (decision 23).
    for path in ("download", "content"):
        assert (
            client.get(f"/api/files/{fid}/{path}", headers=other.headers).status_code
            == 404
        )


def test_avatar_migration_never_downloads_vk_and_preserves_own(make_user, mock_s3):
    vk = make_user(photo_url="https://sun1.userapi.com/test.jpg")
    own = make_user(photo_url="https://own.example.com/photo.jpg")
    with db._session() as s:
        s.query(MigrationORM).filter_by(version="v13-avatars").delete()
        s.commit()
    migrate_avatars()
    migrate_avatars()
    assert db.get_user(vk.user_id).photo_url is None
    assert avatar_url(vk.user_id) == "/avatars/default.svg"
    assert db.get_user(own.user_id).photo_url == "https://own.example.com/photo.jpg"
    assert avatar_url(own.user_id) == db.get_user(own.user_id).photo_url
    assert mock_s3["upload"] == []
