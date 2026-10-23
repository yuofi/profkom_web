import pytest
from database import db, GuideORM
from models import Guide
from legacy_markup import to_markdown


def test_material_draft_publish_and_per_object_editors(client, superuser, make_user):
    editor = make_user()
    reader = make_user()
    first = client.post(
        "/api/materials",
        headers=superuser.headers,
        json=dict(
            kind="general",
            title="Guide",
            description="Description",
            content=dict(format="markdown", body="Old text"),
        ),
    )
    assert first.status_code == 200, first.text
    m = first.json()
    mid = m["material_id"]
    assert (
        client.get("/api/materials/" + mid, headers=reader.headers).status_code == 404
    )
    m = client.post(
        "/api/materials/" + mid + "/publish",
        headers=superuser.headers,
        json=dict(expected_revision=1),
    ).json()
    r = client.put(
        "/api/materials/" + mid + "/editors",
        headers=superuser.headers,
        json=dict(expected_revision=m["revision"], user_ids=[editor.user_id]),
    )
    assert r.status_code == 200, r.text
    assert (
        client.patch(
            "/api/materials/" + mid,
            headers=reader.headers,
            json=dict(
                expected_revision=r.json()["revision"],
                content=dict(format="markdown", body="No"),
            ),
        ).status_code
        == 403
    )
    update = client.patch(
        "/api/materials/" + mid,
        headers=editor.headers,
        json=dict(
            expected_revision=r.json()["revision"],
            content=dict(format="markdown", body="New text"),
        ),
    )
    assert update.status_code == 200, update.text
    viewed = client.get("/api/materials/" + mid, headers=reader.headers).json()
    assert (
        viewed["published_content"]["body"] == "Old text"
        and "draft_content" not in viewed
    )
    assert (
        client.post(
            "/api/materials/" + mid + "/publish",
            headers=editor.headers,
            json=dict(expected_revision=update.json()["revision"]),
        ).status_code
        == 200
    )
    assert (
        client.get("/api/materials/" + mid, headers=reader.headers).json()[
            "published_content"
        ]["body"]
        == "New text"
    )
    other = client.post(
        "/api/materials",
        headers=superuser.headers,
        json=dict(
            kind="general",
            title="Other",
            description="",
            content=dict(format="markdown", body="Other"),
        ),
    ).json()
    assert (
        client.patch(
            "/api/materials/" + other["material_id"],
            headers=editor.headers,
            json=dict(expected_revision=1, title="Wrong"),
        ).status_code
        == 403
    )
    assert (
        client.put(
            "/api/materials/" + mid + "/editors",
            headers=editor.headers,
            json=dict(expected_revision=4, user_ids=[]),
        ).status_code
        == 403
    )


def test_legacy_id_mapping_markup_preservation_and_draft_conflict(
    client, superuser, user
):
    source = '<p><strong>Жирный</strong> и <em>курсив</em><br>Строка</p><ul><li><a href="https://example.com">Ссылка</a></li></ul>'
    g = db.create_guide(Guide(guide_id=0, title="Old", owner_block="none", text=source))
    legacy = client.get(f"/api/guides/{g.guide_id}", headers=user.headers).json()
    mid = legacy["material_id"]
    assert (
        client.get(f"/api/guides/{g.guide_id}/material", headers=user.headers).json()[
            "material_id"
        ]
        == mid
    )
    with db._session() as s:
        assert s.get(GuideORM, g.guide_id).text == source
    material = client.get("/api/materials/" + mid, headers=user.headers).json()
    assert (
        "**Жирный**" in material["published_content"]["body"]
        and "*курсив*" in material["published_content"]["body"]
    )
    assert "[Ссылка](https://example.com)" in material["published_content"]["body"]
    draft = client.patch(
        "/api/materials/" + mid,
        headers=superuser.headers,
        json=dict(
            expected_revision=material["revision"],
            content=dict(format="markdown", body="Draft"),
        ),
    ).json()
    assert (
        client.post(
            f"/api/guides/{g.guide_id}",
            headers=superuser.headers,
            json=dict(expected_revision=draft["revision"], text="Overwrite"),
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/materials/" + mid + "/publish",
            headers=superuser.headers,
            json=dict(expected_revision=draft["revision"]),
        ).status_code
        == 200
    )
    assert (
        client.get(f"/api/guides/{g.guide_id}", headers=user.headers).json()["text"]
        == "Draft"
    )
    assert (
        client.delete("/api/materials/" + mid, headers=superuser.headers).status_code
        == 200
    )
    assert (
        client.get(f"/api/guides/{g.guide_id}", headers=user.headers).status_code == 404
    )


def test_markdown_gallery_is_unchanged_and_unsafe_html_does_not_execute():
    source = "# Гайд\n\n```gallery\n/img/a.png|Подпись\n```"
    assert to_markdown(source) == source
    safe = to_markdown(
        '<p>Текст</p><script>alert(1)</script><a href="javascript:alert(1)">Ссылка</a>'
    )
    assert "<script" not in safe and "javascript:" not in safe


def test_pgas_private_upload_and_legacy_storage_adaptation(
    client, superuser, user, mock_s3
):
    from models import PgasEntry
    from settings import settings

    data = b"%PDF-1.7 synthetic"
    intent = client.post(
        "/api/files/upload-intents",
        headers=superuser.headers,
        json=dict(
            owner_kind="pgas",
            purpose="pgas",
            name="old.pdf",
            mime_type="application/pdf",
            size_bytes=len(data),
        ),
    ).json()
    fid = intent["file_id"]
    mock_s3["objects"]["private/" + fid] = (data, "application/pdf")
    payload = dict(
        title="ПГАС",
        year=2026,
        file_url="file:" + fid,
        file_name="old.pdf",
        file_type="application/pdf",
    )
    assert (
        client.post("/api/pgas", headers=superuser.headers, json=payload).status_code
        == 422
    )
    assert (
        client.post(
            "/api/files/" + fid + "/complete", headers=superuser.headers, json={}
        ).status_code
        == 200
    )
    saved = client.post("/api/pgas", headers=superuser.headers, json=payload)
    assert saved.status_code == 200, saved.text
    assert "get_object" in saved.json()["file_url"]
    assert (
        client.get("/api/files/" + fid + "/download", headers=user.headers).status_code
        == 200
    )
    legacy = "https://global.s3.cloud.ru/" + settings.S3_BUCKET_NAME + "/pgas/old.pdf"
    old = db.create_pgas_entry(
        PgasEntry(
            entry_id=0,
            title="Старый",
            year=2025,
            file_url=legacy,
            file_name="old.pdf",
            file_type="application/pdf",
            created_at="",
            uploaded_by=superuser.user_id,
        )
    )
    result = client.get("/api/pgas", headers=user.headers).json()
    assert all("get_object" in e["file_url"] for e in result)
    assert db.get_pgas_entry(old.entry_id).file_url == legacy


def test_material_draft_file_is_private_until_publish(client, superuser, user, mock_s3):
    made = client.post(
        "/api/materials",
        headers=superuser.headers,
        json=dict(
            kind="general",
            title="Files",
            description="",
            content=dict(format="markdown", body="Published"),
        ),
    ).json()
    mid = made["material_id"]
    published = client.post(
        "/api/materials/" + mid + "/publish",
        headers=superuser.headers,
        json=dict(expected_revision=made["revision"]),
    ).json()
    data = b"%PDF-1.7 synthetic"
    intent = client.post(
        "/api/files/upload-intents",
        headers=superuser.headers,
        json=dict(
            owner_kind="material",
            owner_id=mid,
            purpose="material",
            name="a.pdf",
            mime_type="application/pdf",
            size_bytes=len(data),
        ),
    ).json()
    fid = intent["file_id"]
    mock_s3["objects"]["private/" + fid] = (data, "application/pdf")
    assert (
        client.post(
            "/api/files/" + fid + "/complete", headers=superuser.headers, json={}
        ).status_code
        == 200
    )
    draft = client.patch(
        "/api/materials/" + mid,
        headers=superuser.headers,
        json=dict(
            expected_revision=published["revision"],
            content=dict(format="markdown", body="[Файл](file:" + fid + ")"),
        ),
    ).json()
    assert (
        client.get("/api/files/" + fid + "/download", headers=user.headers).status_code
        == 404
    )
    assert (
        client.post(
            "/api/materials/" + mid + "/publish",
            headers=superuser.headers,
            json=dict(expected_revision=draft["revision"]),
        ).status_code
        == 200
    )
    assert (
        client.get("/api/files/" + fid + "/download", headers=user.headers).status_code
        == 200
    )
    read = client.get("/api/materials/" + mid, headers=user.headers)
    assert (
        read.status_code == 200
        and "get_object" in read.json()["published_content"]["body"]
    )


def test_deleted_material_is_listed_and_restored_by_the_chair_and_deputies(client, superuser, make_user):
    """Decision 18: an editor's delete is reversible; only the chair and deputies list and restore."""
    editor, reader, deputy = make_user(), make_user(), make_user()
    lead = client.get("/api/leadership", headers=superuser.headers).json()
    assert client.put("/api/leadership/deputies", headers=superuser.headers,
                      json=dict(user_ids=[deputy.user_id], expected_revision=lead["revision"])).status_code == 200
    m = client.post("/api/materials", headers=superuser.headers, json=dict(
        kind="general", title="Памятка", description="", content=dict(format="markdown", body="Текст"))).json()
    mid = m["material_id"]
    m = client.post(f"/api/materials/{mid}/publish", headers=superuser.headers, json=dict(expected_revision=m["revision"])).json()
    client.put(f"/api/materials/{mid}/editors", headers=superuser.headers,
               json=dict(user_ids=[editor.user_id], expected_revision=m["revision"]))
    assert client.delete(f"/api/materials/{mid}", headers=editor.headers).status_code == 200
    assert client.get(f"/api/materials/{mid}", headers=reader.headers).status_code == 404
    restore = f"/api/materials/{mid}/restore"
    for who in (editor, reader):
        assert client.get("/api/materials/deleted", headers=who.headers).status_code == 403
        assert client.post(restore, headers=who.headers, json=dict(expected_revision=1)).status_code == 403
        assert "restore_material" not in client.get("/api/session", headers=who.headers).json()["capabilities"]
    assert "restore_material" in client.get("/api/session", headers=deputy.headers).json()["capabilities"]
    item = next(x for x in client.get("/api/materials/deleted", headers=deputy.headers).json()["items"] if x["material_id"] == mid)
    assert item["capabilities"] == ["restore_material"] and item["published_content"] is None
    assert client.post(restore, headers=deputy.headers, json=dict(expected_revision=item["revision"] - 1)).status_code == 409
    restored = client.post(restore, headers=deputy.headers, json=dict(expected_revision=item["revision"]))
    assert restored.status_code == 200, restored.text
    assert restored.json()["revision"] == item["revision"] + 1
    assert client.get(f"/api/materials/{mid}", headers=reader.headers).json()["published_content"]["body"] == "Текст"
    assert client.post(restore, headers=deputy.headers, json=dict(expected_revision=restored.json()["revision"])).status_code == 409
    assert all(x["material_id"] != mid for x in client.get("/api/materials/deleted", headers=superuser.headers).json()["items"])
