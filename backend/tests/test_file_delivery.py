"""Files served by the API with the access check of every request (step 8 of release 1).

Decision 23 and АВ-9: no signed storage link reaches a client; GET /api/files/{id}/content
checks access and then streams the bytes, or behind nginx answers with X-Accel-Redirect.
A-MAT-15 (the file name), A-MAT-9 (no storage call to list people), A-MAT-16 (today's
avatars in snapshots), A-MAT-3, A-MAT-4, A-MAT-8, A-MAT-14 (old guides) and АВ-10 (the
old public uploads adopted as files).
"""

import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import quote

import pytest
from botocore.exceptions import EndpointConnectionError

from database import db, FileRecordORM, SeasonSummaryORM, UserORM
from domain_models import MaterialORM, ObjectDeletionORM, ProfileMetadataORM, SummaryVersionORM
from settings import settings
from test_v13_season_integrity import accept, close
from test_v13_tracker import work  # noqa: F401  (fixture)

BUCKET = settings.S3_BUCKET_NAME
PDF = b"%PDF-1.7 synthetic"
PNG = b"\x89PNG\r\n\x1a\nsynthetic"
ADOPT = Path(__file__).resolve().parents[1] / "scripts/adopt_legacy_files.py"


def upload(client, actor, mock_s3, kind, owner_id=None, name="a.pdf", data=PDF, mime="application/pdf"):
    intent = client.post("/api/files/upload-intents", headers=actor.headers, json=dict(
        owner_kind=kind, owner_id=owner_id, purpose=kind, name=name, mime_type=mime, size_bytes=len(data)))
    assert intent.status_code == 200, intent.text
    fid = intent.json()["file_id"]
    mock_s3["objects"]["private/" + fid] = (data, mime)
    done = client.post(f"/api/files/{fid}/complete", headers=actor.headers, json={})
    assert done.status_code == 200, done.text
    return fid


def avatar(client, actor, mock_s3):
    fid = upload(client, actor, mock_s3, "avatar", name="me.png", data=PNG, mime="image/png")
    r = client.put("/api/profile/me/avatar", headers=actor.headers, json=dict(file_id=fid))
    assert r.status_code == 200, r.text
    return fid


def published(client, actor, body):
    m = client.post("/api/materials", headers=actor.headers, json=dict(
        kind="general", title="Памятка", description="", content=dict(format="markdown", body=body))).json()
    r = client.post(f"/api/materials/{m['material_id']}/publish", headers=actor.headers,
                    json=dict(expected_revision=m["revision"]))
    assert r.status_code == 200, r.text
    return r.json()


def content(fid):
    return f"/api/files/{fid}/content"


@pytest.fixture
def storage_calls(mock_s3, monkeypatch):
    """Counts every call into the storage client (the fakes of mock_s3)."""
    from utils.s3_service import s3_client

    calls = Counter()
    for name in ("head_object", "get_object", "put_object", "generate_presigned_url"):
        def counted(*args, _name=name, _original=getattr(s3_client, name), **kwargs):
            calls[_name] += 1
            return _original(*args, **kwargs)

        monkeypatch.setattr(s3_client, name, counted)
    return calls


@pytest.fixture
def storage_down(mock_s3, monkeypatch):
    from utils.s3_service import s3_client

    def down(*args, **kwargs):
        raise EndpointConnectionError(endpoint_url="https://s3.test.local")

    def on():
        for name in ("head_object", "get_object", "put_object", "generate_presigned_url"):
            monkeypatch.setattr(s3_client, name, down)

    return on


# ── Every request is checked; nothing signed reaches a client (decision 23, АВ-9) ──

def test_every_request_is_checked_and_stops_at_once(client, superuser, user, mock_s3):
    m = published(client, superuser, "Текст")
    fid = upload(client, superuser, mock_s3, "material", m["material_id"])
    body = f"[Файл](file:{fid})"
    draft = client.patch("/api/materials/" + m["material_id"], headers=superuser.headers, json=dict(
        expected_revision=m["revision"], content=dict(format="markdown", body=body))).json()
    # A draft attachment stays closed to readers, the editor reads it.
    assert client.get(content(fid), headers=user.headers).status_code == 404
    assert client.get(content(fid), headers=superuser.headers).content == PDF
    client.post(f"/api/materials/{m['material_id']}/publish", headers=superuser.headers,
                json=dict(expected_revision=draft["revision"])).raise_for_status()
    served = client.get(content(fid), headers=user.headers)
    assert served.status_code == 200 and served.content == PDF
    assert served.headers["content-type"] == "application/pdf"
    assert served.headers["cache-control"] == "private, no-cache"
    assert served.headers["x-content-type-options"] == "nosniff"
    assert served.headers["content-security-policy"] == "sandbox"
    # The same address stops for this reader once the link is gone from the material.
    current = client.get("/api/materials/" + m["material_id"], headers=superuser.headers).json()
    edit = client.patch("/api/materials/" + m["material_id"], headers=superuser.headers, json=dict(
        expected_revision=current["revision"], content=dict(format="markdown", body="Без файла"))).json()
    client.post(f"/api/materials/{m['material_id']}/publish", headers=superuser.headers,
                json=dict(expected_revision=edit["revision"])).raise_for_status()
    assert client.get(content(fid), headers=user.headers).status_code == 404
    # And for an archived account at once, with the token it still holds.
    pgas = upload(client, superuser, mock_s3, "pgas")
    assert client.get(content(pgas), headers=user.headers).status_code == 200
    from accounts import archive
    archive(user.user_id, "Проверка", superuser.user_id)
    assert client.get(content(pgas), headers=user.headers).status_code in (401, 403)


def test_an_image_tag_signs_in_with_the_session_cookie_only_here(client, user, mock_s3):
    fid = avatar(client, user, mock_s3)
    client.cookies.clear()
    assert client.get(content(fid)).status_code == 401
    client.cookies.set("access_token", user.access_token)
    try:
        r = client.get(content(fid))
        assert r.status_code == 200 and r.content == PNG
        # Everything else still needs the Authorization header.
        assert client.get("/api/profile/me").status_code == 401
        assert client.get(f"/api/files/{fid}/download").status_code == 401
        assert client.post(content(fid)).status_code in (401, 405)
    finally:
        client.cookies.clear()


@pytest.mark.parametrize("name", ["Заявление на ПГАС.pdf", 'Отчёт "итог"\\2026.pdf', "plain name.pdf"])
def test_the_download_keeps_the_original_name(client, pgas_admin, mock_s3, name):
    """A-MAT-15: RFC 6266 with an ASCII fallback and the UTF-8 name, nothing injectable."""
    fid = upload(client, pgas_admin, mock_s3, "pgas", name="safe.pdf")
    with db._session() as s:
        s.get(FileRecordORM, fid).name = name  # names come from browsers as they are
        s.commit()
    r = client.get(content(fid), headers=pgas_admin.headers)
    clean = name.replace('"', "").replace("\\", "")
    fallback = "".join(c if 32 <= ord(c) < 127 else "_" for c in clean)
    assert r.headers["content-disposition"] == (
        f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(clean, safe='')}"
    )


def test_pictures_open_in_place_documents_download(client, user, mock_s3):
    fid = avatar(client, user, mock_s3)
    r = client.get(content(fid), headers=user.headers)
    assert r.headers["content-type"] == "image/png"
    assert r.headers["content-disposition"].startswith('inline; filename="me.png"')


def test_behind_nginx_the_backend_sends_no_bytes(client, user, mock_s3, storage_calls):
    fid = avatar(client, user, mock_s3)
    storage_calls.clear()
    r = client.get(content(fid), headers={**user.headers, "X-File-Delivery": "accel"})
    assert r.status_code == 200 and r.content == b""
    assert r.headers["x-accel-redirect"] == "/_storage"
    # nginx fetches sealed/<id> with a signature that lives a minute.
    assert r.headers["x-storage-url"].startswith(f"https://s3.test.local/sealed/{fid}?operation=get_object")
    assert r.headers["x-storage-url"].endswith("&expires=60")
    assert r.headers["content-type"] == "image/png"
    assert r.headers["content-disposition"].startswith("inline;")
    # Signing is local: no storage request at all for a sealed record (A-MAT-9).
    assert storage_calls == Counter(generate_presigned_url=1)
    # Without access nginx gets nothing to fetch.
    other = client.get(content("file-missing"), headers={**user.headers, "X-File-Delivery": "accel"})
    assert other.status_code == 404 and "x-accel-redirect" not in other.headers


def test_the_download_route_gives_the_checked_address(client, user, mock_s3):
    fid = avatar(client, user, mock_s3)
    r = client.get(f"/api/files/{fid}/download", headers=user.headers)
    assert r.json() == dict(download_url=content(fid), expires_at=None)


# ── No storage call to list people or read texts (A-MAT-9) ──

def test_lists_make_no_storage_call(client, superuser, make_user, mock_s3, storage_calls):
    people = [make_user() for _ in range(3)]
    for p in people:
        avatar(client, p, mock_s3)
    storage_calls.clear()
    contacts = client.get("/api/contacts", headers=superuser.headers).json()
    photos = {c["user_id"]: c["photo_url"] for c in contacts}
    with db._session() as s:
        avatars = {p.user_id: s.get(ProfileMetadataORM, p.user_id).avatar_file_id for p in people}
    assert all(photos[uid] == content(fid) for uid, fid in avatars.items())
    assert sum(storage_calls.values()) == 0
    client.get("/api/profile/me", headers=people[0].headers).raise_for_status()
    client.get("/api/leadership", headers=superuser.headers).raise_for_status()
    assert sum(storage_calls.values()) == 0
    # A sealed record is read with one GET: no HEAD and no copy (A-MAT-9).
    assert client.get(content(avatars[people[1].user_id]), headers=people[0].headers).content == PNG
    assert storage_calls == Counter(get_object=1)


def test_reads_survive_a_storage_outage(client, superuser, pgas_admin, user, make_guide, mock_s3, storage_down):
    avatar(client, user, mock_s3)
    pgas = upload(client, pgas_admin, mock_s3, "pgas")
    client.post("/api/pgas", headers=pgas_admin.headers, json=dict(
        title="ПГАС", year=2026, file_url="file:" + pgas, file_name="a.pdf", file_type="application/pdf")).raise_for_status()
    m = published(client, superuser, "Текст")
    fid = upload(client, superuser, mock_s3, "material", m["material_id"])
    draft = client.patch("/api/materials/" + m["material_id"], headers=superuser.headers, json=dict(
        expected_revision=m["revision"], content=dict(format="markdown", body=f"![](file:{fid})"))).json()
    client.post(f"/api/materials/{m['material_id']}/publish", headers=superuser.headers,
                json=dict(expected_revision=draft["revision"])).raise_for_status()
    make_guide(text="# Гайд")
    storage_down()
    for path in ("/api/contacts", "/api/contacts/emails", "/api/profile/me", "/api/leadership",
                 "/api/pgas", "/api/materials"):
        assert client.get(path, headers=superuser.headers).status_code == 200, path
    assert client.get("/api/profile/me", headers=user.headers).status_code == 200
    # Only the bytes themselves wait for the storage.
    assert client.get(content(pgas), headers=user.headers).status_code == 503


# ── Old guides (A-MAT-3, A-MAT-4, A-MAT-8, A-MAT-14) ──

def test_a_new_guide_cannot_reference_files(client, superuser, make_master, mock_s3):
    """A-MAT-8: a master links a submission of their block in a new guide."""
    master, block = make_master()
    bid=client.get('/api/blocks/'+block.name,headers=master.headers).json()['block_id']
    fid = upload(client, superuser, mock_s3, "pgas")
    for text in (f"[файл](file:{fid})", f"![](file:{fid})"):
        r = client.post("/api/materials", headers=master.headers, json=dict(kind="guide",title="Гайд",description="",owner_block_id=bid,content=dict(format="markdown",body=text)))
        assert r.status_code == 422, r.text


def test_an_unreadable_file_costs_only_its_link(client, superuser, make_user, mock_s3):
    """A-MAT-8: the lists do not fail for a reader who may not open one file."""
    outsider = make_user()
    hidden = upload(client, superuser, mock_s3, "material", published(client, superuser, "Черновик")["material_id"])
    m = published(client, superuser, "Текст")
    with db._session() as s:
        s.get(MaterialORM, m["material_id"]).published_body = f"Смотрите [файл](file:{hidden})"
        s.commit()
    listing = client.get("/api/materials", headers=outsider.headers)
    assert listing.status_code == 200
    item = next(i for i in listing.json()["items"] if i["material_id"] == m["material_id"])
    assert item["published_content"]["body"] == f"Смотрите [файл]({content(hidden)})"
    assert client.get(content(hidden), headers=outsider.headers).status_code == 404


def test_an_html_guide_is_shown_as_markdown(client, user, make_guide):
    """A-MAT-14: the old guide screens get the material's Markdown, not the HTML source."""
    g = make_guide(text="<p>Абзац <strong>Жирный</strong></p><ul><li>пункт</li></ul>")
    mid=client.get(f"/api/materials/legacy-guides/{g.guide_id}",headers=user.headers).json()['material_id']
    text = client.get(f"/api/materials/{mid}", headers=user.headers).json()["published_content"]['body']
    assert "**Жирный**" in text and "- пункт" in text and "<" not in text


def test_markdown_with_a_few_tags_keeps_its_formatting():
    """A-MAT-4: only real HTML is converted; tags inside code do not count."""
    from legacy_markup import to_markdown

    assert to_markdown("**Ж** и *к*<br>x") == "**Ж** и *к*  \nx"
    html_block = "```html\n<p>…</p>\n```"
    assert to_markdown(html_block) == html_block
    assert to_markdown("Код `<br>` и<br/>дальше") == "Код `<br>` и  \nдальше"
    assert to_markdown("<p>Абзац <b>HTML</b></p>") == "Абзац **HTML**"


def test_saving_the_shown_text_does_not_convert_it_again(client, superuser, make_guide):
    """A-MAT-4: an old editor sends back what it was shown. Converted again, the escaped
    «<br>» of this text would become a line break."""
    g = make_guide(text="<p>Тег &lt;br&gt; словами</p>")
    mid=client.get(f"/api/materials/legacy-guides/{g.guide_id}",headers=superuser.headers).json()['material_id']
    shown = client.get(f"/api/materials/{mid}", headers=superuser.headers).json()
    with db._session() as s:
        before = s.query(MaterialORM).filter_by(legacy_guide_id=g.guide_id).one().published_body
    assert before == "Тег <br> словами" == shown["source_content"]['body']
    r = client.patch(f"/api/materials/{mid}", headers=superuser.headers,
                   json=dict(expected_revision=shown["revision"], content=shown["source_content"]))
    assert r.status_code == 200, r.text
    r=client.post(f"/api/materials/{mid}/publish",headers=superuser.headers,json=dict(expected_revision=r.json()['revision']))
    assert r.status_code == 200,r.text
    with db._session() as s:
        assert s.query(MaterialORM).filter_by(legacy_guide_id=g.guide_id).one().published_body == before


# ── Snapshots show today's avatars (A-MAT-16) ──

def test_a_closed_summary_shows_todays_avatars(client, work, superuser, mock_s3):  # noqa: F811
    w = work
    accept(client, w)
    sid = w["season"]["season_id"]
    close(client, w, superuser)
    member = w["member"].user_id
    stale = "https://s3.test.local/sealed/file-old?X-Amz-Signature=expired"

    def spoil(data):
        if isinstance(data, list):
            return [spoil(x) for x in data]
        if isinstance(data, dict):
            return {k: stale if k == "avatar_url" else spoil(v) for k, v in data.items()}
        return data

    with db._session() as s:
        row = s.query(SeasonSummaryORM).filter_by(season_id=sid).one()
        row.rows_json = json.dumps(spoil(json.loads(row.rows_json)))
        for v in s.query(SummaryVersionORM).filter_by(season_id=sid):
            v.summary_json = json.dumps(spoil(json.loads(v.summary_json)))
        s.commit()
    fid = avatar(client, w["member"], mock_s3)
    summary = client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()
    mine = next(r for r in summary["rows"] if r["user"]["user_id"] == member)
    assert mine["user"]["avatar_url"] == content(fid)
    versions = client.get(f"/api/seasons/{sid}/summary/versions", headers=superuser.headers).json()["items"]
    assert versions
    for v in versions:
        shown = client.get(f"/api/seasons/{sid}/summary/versions/{v['version']}", headers=superuser.headers)
        assert shown.status_code == 200, shown.text
        assert "X-Amz" not in shown.text and content(fid) in shown.text
    with db._session() as s:
        s.get(UserORM, member).account_state = "purged"
        s.commit()
    summary = client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers).json()
    assert all(r["user"]["avatar_url"] is None for r in summary["rows"] if r["user"]["user_id"] == member)


# ── The old public uploads become files (АВ-10) ──

def run_adopt(*flags):
    result = subprocess.run([sys.executable, str(ADOPT), "--database", settings.DATABASE_PATH, *flags],
                            capture_output=True, text=True, check=True, cwd=ADOPT.parents[1])
    return result.stdout, json.loads(result.stdout)


def bucket(key):
    return f"https://global.s3.cloud.ru/{BUCKET}/{key}"


def test_old_uploads_are_adopted_in_place(client, superuser, user, make_user, make_guide, mock_s3):
    from models import PgasEntry

    old_avatar = make_user(photo_url=bucket("avatars/old.png"))
    # The v13 migration keeps an own photo (preset None); a preset chosen later wins.
    chose_preset = make_user(photo_url=bucket("avatars/other.png"))
    with db._session() as s:
        s.add(ProfileMetadataORM(user_id=chose_preset.user_id, participation_periods_json="[]", preset_id="leaf"))
        s.commit()
    foreign = make_user(photo_url=bucket("sealed/file-someone-else"))
    entry = db.create_pgas_entry(PgasEntry(
        entry_id=0, title="Старый", year=2025, file_url=bucket("pgas/%D0%97%D0%B0%D1%8F%D0%B2%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5.pdf"),
        file_name="Заявление.pdf", file_type="application/pdf", created_at="", uploaded_by=superuser.user_id))
    picture = bucket("gallery/0a1b2c3d-0000-4000-8000-000000000001.png")
    text = (f"```gallery\n{picture}|Подпись\n```\n\nСм. {bucket('guides/plan.pdf')}.\n\n"
            f"[чужое]({bucket('sealed/file-someone-else')})")
    g = make_guide(text=text)
    mid = client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=superuser.headers).json()["material_id"]
    mock_s3["objects"].update({
        "avatars/old.png": (PNG, "image/png"),
        "pgas/Заявление.pdf": (PDF, "application/pdf"),
        "gallery/0a1b2c3d-0000-4000-8000-000000000001.png": (PNG, "image/png"),
        "guides/plan.pdf": (PDF, "text/html"),  # whatever an old upload claimed
    })
    path = Path(settings.DATABASE_PATH)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    out, report = run_adopt()
    assert report["mode"] == "dry_run" and report["external_calls"] is False
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    for secret in (BUCKET, "old.png", "Заявление", "plan", "file-someone-else", mid, "Подпись"):
        assert secret not in out
    assert report["avatars"] == dict(adopted=1, kept_sealed=1, superseded=1)
    assert report["pgas"] == dict(adopted=1)
    assert report["texts"]["materials.published_body"] == dict(rows_changed=1, links_adopted=2, kept_sealed=1)
    assert report["texts"]["guides.text"] == dict(rows_changed=1, links_adopted=2, kept_sealed=1)
    assert report["file_records_created"] == 4
    _, applied = run_adopt("--apply")
    assert applied["avatars"] == report["avatars"] and applied["texts"] == report["texts"]
    _, again = run_adopt("--apply")
    assert again["file_records_created"] == 0 and again["avatars"]["already"] == 1
    assert all(t["rows_changed"] == 0 for t in again["texts"].values())
    assert again["pgas"] == dict(already=1)

    # The avatar: served by the API from its own key; others see it too.
    photo = client.get("/api/profile/me", headers=old_avatar.headers).json()["photo_url"]
    assert photo.startswith("/api/files/file-") and photo.endswith("/content")
    r = client.get(photo, headers=user.headers)
    assert r.content == PNG and r.headers["content-type"] == "image/png"
    assert client.get("/api/profile/me", headers=chose_preset.headers).json()["photo_url"] == "/avatars/leaf.svg"
    assert client.get("/api/profile/me", headers=foreign.headers).json()["photo_url"] != photo
    # PGAS keeps its name and type.
    pgas = next(e for e in client.get("/api/pgas", headers=user.headers).json() if e["entry_id"] == entry.entry_id)
    r = client.get(pgas["file_url"], headers=user.headers)
    assert r.content == PDF and "filename*=UTF-8''" + quote("Заявление.pdf", safe="") in r.headers["content-disposition"]
    # The material: captions and punctuation stay outside the link (A-MAT-3).
    with db._session() as s:
        body = s.get(MaterialORM, mid).published_body
    assert db.get_guide(g.guide_id).text == body
    shown = client.get("/api/materials/" + mid, headers=user.headers).json()["published_content"]["body"]
    lines = shown.split("\n")
    assert lines[1].startswith("/api/files/file-") and lines[1].endswith("/content|Подпись")
    assert lines[4].startswith("См. /api/files/file-") and lines[4].endswith("/content.")
    assert f"[чужое]({bucket('sealed/file-someone-else')})" in shown
    assert client.get(lines[1].removesuffix("|Подпись"), headers=user.headers).content == PNG
    plan = client.get(lines[4].removeprefix("См. ").removesuffix("."), headers=user.headers)
    assert plan.content == PDF and plan.headers["content-type"] == "application/pdf"
    assert plan.headers["content-disposition"].startswith('attachment; filename="plan.pdf"')
    # The editor gets the stored references back.
    source = client.get("/api/materials/" + mid, headers=superuser.headers).json()["source_content"]["body"]
    assert source == body and source.count("file:file-") == 2


def test_an_adopted_avatar_is_deleted_with_its_account_unless_shared(client, superuser, make_user, make_guide, mock_s3):
    from accounts import archive
    from account_cleanup import purge
    from domain_models import AccountArchiveORM

    alone = make_user(photo_url=bucket("avatars/alone.png"))
    shared = make_user(photo_url=bucket("avatars/shared.png"))
    g = make_guide(text=f"![]({bucket('avatars/shared.png')})")
    client.get(f"/api/materials/legacy-guides/{g.guide_id}", headers=superuser.headers).raise_for_status()
    run_adopt("--apply")
    for victim in (alone, shared):
        archive(victim.user_id, "Leave", superuser.user_id)
        with db._session() as s:
            s.get(AccountArchiveORM, victim.user_id).archived_at = "2020-01-01T00:00:00+00:00"
            s.commit()
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 2
    with db._session() as s:
        keys = {r.object_key for r in s.query(ObjectDeletionORM)}
    assert "avatars/alone.png" in keys and "avatars/shared.png" not in keys


def test_adoption_needs_the_v13_schema(tmp_path):
    import sqlite3

    path = tmp_path / "old.db"
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE users(user_id INTEGER PRIMARY KEY, photo_url TEXT)")
    result = subprocess.run([sys.executable, str(ADOPT), "--database", str(path)],
                            capture_output=True, text=True, cwd=ADOPT.parents[1])
    assert result.returncode != 0 and "v13 schema" in result.stderr
