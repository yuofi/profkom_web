"""FIX_PLAN 0.2: bucket links in material and guide texts (A-SEC-2, A-MAT-1).

Nothing is signed when a text is read (decision 23): `file:<id>` becomes the API
address /api/files/<id>/content, checked on every request, and a bucket link stays
as written. Old public uploads become `file:<id>` by scripts/adopt_legacy_files.py
(АВ-10). Editors edit the stored text (`source_content`), and a write may not add a
new link into the bucket.
"""

import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from database import db, GuideORM
from domain_models import MaterialORM
from settings import settings

BUCKET = settings.S3_BUCKET_NAME
HOSTS = ("https://global.s3.cloud.ru", settings.S3_ENDPOINT.rstrip("/"))
PDF = b"%PDF-1.7 synthetic closed"
OLD = f"https://global.s3.cloud.ru/{BUCKET}/guides/%D0%A1%D1%82%D0%B0%D1%80%D1%8B%D0%B9.pdf"
SCRIPT = Path(__file__).resolve().parents[1] / "scripts/repair_storage_links.py"


def upload(client, actor, mock_s3, owner_kind, owner_id, data=PDF):
    intent = client.post(
        "/api/files/upload-intents",
        headers=actor.headers,
        json=dict(owner_kind=owner_kind, owner_id=owner_id, purpose=owner_kind, name="a.pdf", mime_type="application/pdf", size_bytes=len(data)),
    )
    assert intent.status_code == 200, intent.text
    fid = intent.json()["file_id"]
    mock_s3["objects"]["private/" + fid] = (data, "application/pdf")
    done = client.post(f"/api/files/{fid}/complete", headers=actor.headers, json={})
    assert done.status_code == 200, done.text
    return fid


def material(client, actor, body="Текст"):
    made = client.post(
        "/api/materials",
        headers=actor.headers,
        json=dict(kind="general", title="Материал", description="", content=dict(format="markdown", body=body)),
    )
    assert made.status_code == 200, made.text
    m = made.json()
    published = client.post(f"/api/materials/{m['material_id']}/publish", headers=actor.headers, json=dict(expected_revision=m["revision"]))
    assert published.status_code == 200, published.text
    return published.json()


def store(material_id, **columns):
    """Write a text the way an earlier version could have saved it."""
    with db._session() as s:
        m = s.get(MaterialORM, material_id)
        for name, value in columns.items():
            setattr(m, name, value)
        if "published_body" in columns and m.legacy_guide_id:
            s.get(GuideORM, m.legacy_guide_id).text = columns["published_body"]
        s.commit()
        return m.legacy_guide_id


def closed_links(fid):
    return [f"{host}/{BUCKET}/{folder}/{fid}" for host in HOSTS for folder in ("sealed", "private")]


def foreign_file(client, actor, mock_s3):
    """An attachment of another material that is still a draft: nobody else may read it."""
    other = client.post(
        "/api/materials",
        headers=actor.headers,
        json=dict(kind="general", title="Черновик", description="", content=dict(format="markdown", body="Черновик")),
    ).json()
    return upload(client, actor, mock_s3, "material", other["material_id"])


def test_reading_signs_nothing(client, superuser, user, mock_s3):
    fid = foreign_file(client, superuser, mock_s3)
    assert client.get(f"/api/files/{fid}/download", headers=user.headers).status_code == 404
    m = material(client, superuser)
    avatar = f"{HOSTS[1]}/{BUCKET}/avatars/a.png"
    unknown = f"https://global.s3.cloud.ru/{BUCKET}/reports/name.pdf"
    body = "\n".join(f"[{i}]({url})" for i, url in enumerate([*closed_links(fid), OLD, avatar, unknown]))
    guide_id = store(m["material_id"], published_body=body)
    resolved = client.get(f"/api/materials/legacy-guides/{guide_id}", headers=user.headers).json()["material_id"]
    for read in (
        client.get("/api/materials/" + m["material_id"], headers=user.headers).json()["published_content"]["body"],
        client.get(f"/api/materials/{resolved}", headers=user.headers).json()["published_content"]["body"],
    ):
        # Every link as written and unsigned (decision 23, owner decision 6).
        assert read == body and "operation=get_object" not in read


@pytest.mark.parametrize("host", HOSTS)
@pytest.mark.parametrize("folder", ["sealed", "private", "guides"])
def test_new_bucket_links_are_refused_and_nothing_is_saved(client, superuser, make_master, mock_s3, host, folder):
    fid = foreign_file(client, superuser, mock_s3)
    link = f"[файл]({host}/{BUCKET}/{folder}/{fid if folder != 'guides' else 'new.pdf'})"
    m = material(client, superuser, "Опубликовано")
    mid = m["material_id"]
    patch = client.patch("/api/materials/" + mid, headers=superuser.headers, json=dict(expected_revision=m["revision"], content=dict(format="markdown", body=link)))
    assert patch.status_code == 422, patch.text
    assert client.get("/api/materials/" + mid, headers=superuser.headers).json()["source_content"]["body"] == "Опубликовано"
    count = len(client.get("/api/materials", headers=superuser.headers).json()["items"])
    create = client.post("/api/materials", headers=superuser.headers, json=dict(kind="general", title="Новый", description="", content=dict(format="markdown", body=link)))
    assert create.status_code == 422
    assert len(client.get("/api/materials", headers=superuser.headers).json()["items"]) == count
    # A draft saved before the fix is checked again at publication.
    store(mid, draft_body=link, has_draft=True)
    publish = client.post(f"/api/materials/{mid}/publish", headers=superuser.headers, json=dict(expected_revision=m["revision"]))
    assert publish.status_code == 422
    with db._session() as s:
        assert s.get(MaterialORM, mid).published_body == "Опубликовано"
    master, block = make_master()
    guides = len(db.list_guides())
    bid = client.get('/api/blocks/'+block.name,headers=master.headers).json()['block_id']
    scoped = client.post("/api/materials", headers=master.headers, json=dict(kind="guide", title="Гайд", description="", owner_block_id=bid, content=dict(format="markdown",body=link)))
    assert scoped.status_code == 422, scoped.text
    assert len(db.list_guides()) == guides
    own = client.post("/api/materials", headers=master.headers, json=dict(kind="guide", title="Гайд", description="", owner_block_id=bid, content=dict(format="markdown",body="Свой гайд")))
    assert own.status_code == 200, own.text
    own = own.json()
    r = client.patch(f"/api/materials/{own['material_id']}", headers=master.headers, json=dict(expected_revision=own["revision"], content=dict(format="markdown",body=link)))
    assert r.status_code == 422, r.text
    assert client.get(f"/api/materials/{own['material_id']}", headers=master.headers).json()['source_content']['body'] == "Свой гайд"


def test_editor_round_trips_the_stored_source(client, superuser, user, make_guide, mock_s3):
    g = make_guide(text=f"Старый [файл]({OLD})")
    mid = client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=superuser.headers).json()["material_id"]
    fid = upload(client, superuser, mock_s3, "material", mid)
    source = f"Старый [файл]({OLD})\n\n[Вложение](file:{fid})"
    m = client.get("/api/materials/" + mid, headers=superuser.headers).json()
    m = client.patch("/api/materials/" + mid, headers=superuser.headers, json=dict(expected_revision=m["revision"], content=dict(format="markdown", body=source))).json()
    m = client.post(f"/api/materials/{mid}/publish", headers=superuser.headers, json=dict(expected_revision=m["revision"])).json()
    got = client.get("/api/materials/" + mid, headers=superuser.headers).json()
    assert got["source_content"]["body"] == source
    assert got["published_content"]["body"] == source.replace(f"file:{fid}", f"/api/files/{fid}/content")
    assert "source_content" not in client.get("/api/materials/" + mid, headers=user.headers).json()
    # Saving the source without changes and publishing keeps it byte for byte.
    m = client.patch("/api/materials/" + mid, headers=superuser.headers, json=dict(expected_revision=got["revision"], content=got["source_content"])).json()
    assert m["draft_content"]["body"] == source
    client.post(f"/api/materials/{mid}/publish", headers=superuser.headers, json=dict(expected_revision=m["revision"])).raise_for_status()
    with db._session() as s:
        assert s.get(MaterialORM, mid).published_body == source
    assert db.get_guide(g.guide_id).text == source
    assert client.get(f"/api/files/{fid}/download", headers=user.headers).status_code == 200


def test_links_sent_back_are_stored_as_references(client, superuser, make_guide, mock_s3):
    g = make_guide(text=f"Старый [файл]({OLD})")
    mid = client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=superuser.headers).json()["material_id"]
    fid = upload(client, superuser, mock_s3, "material", mid)
    source = f"Старый [файл]({OLD})\n\n[Вложение](file:{fid})"
    m = client.get("/api/materials/" + mid, headers=superuser.headers).json()
    m = client.patch("/api/materials/" + mid, headers=superuser.headers, json=dict(expected_revision=m["revision"], content=dict(format="markdown", body=source))).json()
    client.post(f"/api/materials/{mid}/publish", headers=superuser.headers, json=dict(expected_revision=m["revision"])).raise_for_status()
    # An old source copied from a rendered screen still resolves its own file IDs.
    shown = client.get(f"/api/materials/{mid}", headers=superuser.headers).json()
    assert shown["published_content"]["body"] == source.replace(f"file:{fid}", f"/api/files/{fid}/content")
    edited = shown["published_content"]["body"] + "\n\nДополнение"
    saved = client.patch(f"/api/materials/{mid}", headers=superuser.headers, json=dict(expected_revision=shown["revision"], content=dict(format="markdown",body=edited)))
    assert saved.status_code == 200, saved.text
    saved = client.post(f"/api/materials/{mid}/publish",headers=superuser.headers,json=dict(expected_revision=saved.json()['revision']))
    assert saved.status_code == 200, saved.text
    assert db.get_guide(g.guide_id).text == source + "\n\nДополнение"
    # A text saved from a screen of the earlier version, with its signed links (A-MAT-1).
    sign = "?X-Amz-Expires=300&X-Amz-Signature=fake"
    signed_text = f"Старый [файл]({OLD}{sign})\n\n[Вложение]({HOSTS[1]}/{BUCKET}/sealed/{fid}{sign})"
    saved = client.patch(f"/api/materials/{mid}", headers=superuser.headers, json=dict(expected_revision=saved.json()["revision"], content=dict(format="markdown",body=signed_text)))
    assert saved.status_code == 200, saved.text
    saved = client.post(f"/api/materials/{mid}/publish",headers=superuser.headers,json=dict(expected_revision=saved.json()['revision']))
    assert saved.status_code == 200, saved.text
    assert db.get_guide(g.guide_id).text == source
    m = client.get("/api/materials/" + mid, headers=superuser.headers).json()
    shown = client.patch("/api/materials/" + mid, headers=superuser.headers, json=dict(expected_revision=m["revision"], content=m["published_content"]))
    assert shown.status_code == 200, shown.text
    assert shown.json()["draft_content"]["body"] == source


def test_guide_rename_without_text_keeps_the_source(client, superuser, make_guide, mock_s3):
    mixed = f"# Гайд\n\n<p>Абзац <b>HTML</b></p>\n\n**Markdown** [файл]({OLD})"
    g = make_guide(text=mixed)
    current = client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=superuser.headers).json()
    mid=current['material_id']
    with db._session() as s:
        before = s.query(MaterialORM).filter_by(legacy_guide_id=g.guide_id).one().published_body
    r = client.patch(f"/api/materials/{mid}", headers=superuser.headers, json=dict(expected_revision=current["revision"], title="Новое имя"))
    assert r.status_code == 200, r.text
    r=client.post(f"/api/materials/{mid}/publish",headers=superuser.headers,json=dict(expected_revision=r.json()['revision']))
    assert r.status_code == 200, r.text
    with db._session() as s:
        assert s.query(MaterialORM).filter_by(legacy_guide_id=g.guide_id).one().published_body == before
    assert db.get_guide(g.guide_id).text == before and db.get_guide(g.guide_id).title == "Новое имя"


def test_cleanup_deletes_old_avatars_only(client, superuser, make_user):
    from account_cleanup import purge
    from accounts import archive
    from domain_models import ObjectDeletionORM, AccountArchiveORM

    old = make_user(photo_url=f"https://global.s3.cloud.ru/{BUCKET}/avatars/old.png")
    sealed = make_user(photo_url=f"https://global.s3.cloud.ru/{BUCKET}/sealed/file-someone-else")
    for victim in (old, sealed):
        archive(victim.user_id, "Leave", superuser.user_id)
        with db._session() as s:
            s.get(AccountArchiveORM, victim.user_id).archived_at = "2020-01-01T00:00:00+00:00"
            s.commit()
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 2
    with db._session() as s:
        keys = {r.object_key for r in s.query(ObjectDeletionORM)}
    assert "avatars/old.png" in keys
    assert not any(k.startswith("sealed/file-someone-else") for k in keys)


def run_repair(path, *flags):
    result = subprocess.run([sys.executable, str(SCRIPT), "--database", str(path), *flags], capture_output=True, text=True, check=True, cwd=SCRIPT.parents[1])
    return result.stdout, json.loads(result.stdout)


def test_repair_restores_damaged_texts_and_prints_only_numbers(client, superuser, user, make_guide, mock_s3, tmp_path):
    fid = foreign_file(client, superuser, mock_s3)
    g = make_guide(text=f"[файл]({OLD})")
    mid = client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=superuser.headers).json()["material_id"]
    own = upload(client, superuser, mock_s3, "material", mid)
    sign = "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=deadbeef"
    damaged = f"[своё]({HOSTS[1]}/{BUCKET}/sealed/{own}{sign})\n[старое]({OLD}{sign})\n[чужое]({HOSTS[0]}/{BUCKET}/sealed/{fid}{sign})"
    repaired = f"[своё](file:{own})\n[старое]({OLD})\n[чужое]({HOSTS[0]}/{BUCKET}/sealed/{fid}{sign})"
    store(mid, published_body=damaged, draft_body=damaged, has_draft=True)
    path = Path(settings.DATABASE_PATH)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    out, report = run_repair(path)
    assert report["mode"] == "dry_run" and hashlib.sha256(path.read_bytes()).hexdigest() == before
    for secret in (own, fid, mid, "deadbeef", BUCKET, "старое"):
        assert secret not in out
    assert report["texts"]["materials.published_body"] == dict(rows_changed=1, attachment_fixed=1, legacy_fixed=1, other_kept=1)
    assert report["texts"]["materials.draft_body"]["rows_changed"] == 1
    assert report["texts"]["guides.text"]["rows_changed"] == 1
    assert report["outside_allowed"]["materials.published_body"] == dict(sealed=1)
    _, applied = run_repair(path, "--apply")
    assert applied["texts"] == report["texts"]
    with db._session() as s:
        m = s.get(MaterialORM, mid)
        assert m.published_body == repaired and m.draft_body == repaired
    assert db.get_guide(g.guide_id).text == repaired
    _, again = run_repair(path, "--apply")
    assert all(t["rows_changed"] == 0 for t in again["texts"].values())
    # The repaired attachment still works for readers after A-SEC-2.
    m = client.get("/api/materials/" + mid, headers=superuser.headers).json()
    client.post(f"/api/materials/{mid}/publish", headers=superuser.headers, json=dict(expected_revision=m["revision"])).raise_for_status()
    assert client.get(f"/api/files/{own}/download", headers=user.headers).status_code == 200
    read = client.get("/api/materials/" + mid, headers=user.headers).json()["published_content"]["body"]
    assert read == repaired.replace(f"file:{own}", f"/api/files/{own}/content")


def test_repair_counts_on_a_database_before_v13(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as c:
        c.executescript(
            "CREATE TABLE guides(guide_id INTEGER PRIMARY KEY, text TEXT);"
            "CREATE TABLE users(user_id INTEGER PRIMARY KEY, photo_url TEXT);"
        )
        c.execute("INSERT INTO guides VALUES (1, ?)", (f"[a]({OLD}?X-Amz-Signature=x) [b](https://global.s3.cloud.ru/{BUCKET}/private/file-x)",))
        c.executemany("INSERT INTO users VALUES (?, ?)", [(1, f"https://global.s3.cloud.ru/{BUCKET}/avatars/a.png"), (2, f"https://global.s3.cloud.ru/{BUCKET}/sealed/file-y"), (3, "https://vk.com/photo")])
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    _, report = run_repair(path)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    assert report["texts"] == {"guides.text": dict(rows_changed=1, legacy_fixed=1, other_kept=1)}
    assert report["outside_allowed"] == {"guides.text": dict(private=1)}
    assert report["photo_url"] == dict(legacy=1, sealed=1)
