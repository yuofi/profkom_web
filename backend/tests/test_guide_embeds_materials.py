"""Rich guide writes preserve publication, revisions and contextual private files."""
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import event

from database import db, engine, FileRecordORM, _active_session
from domain_models import MaterialORM, MaterialRenderArtifactORM
from models import Block
from settings import settings

FORMAT = "markdown-embeds-v1"
SOURCE = '## Обычный раздел\n\n```profkom-html id=embed-example\n<section class="guide-card guide-tone-info"><h3>Заголовок</h3><a class="guide-button" href="/blocks">Блоки</a></section>\n```'


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def rich(monkeypatch):
    import guide_embeds
    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", True)
    # The compiler's own tests cover its isolated process/deadline. Domain tests stay fast.
    monkeypatch.setattr(guide_embeds, "compile_bounded", guide_embeds.compile_content)


@pytest.fixture
def guide(client, superuser):
    db.create_block(Block(name="HTML synthetic", master="", is_hr=False))
    return next(m for m in ok(client.get("/api/materials", headers=superuser.headers))["items"] if m["kind"] == "guide")


def save(client, actor, guide, source=SOURCE, format=FORMAT):
    return client.patch(f"/api/materials/{guide['material_id']}", headers=actor.headers,
                        json={"expected_revision": guide["revision"], "content": {"format": format, "body": source}})


def publish(client, actor, guide):
    return client.post(f"/api/materials/{guide['material_id']}/publish", headers=actor.headers,
                       json={"expected_revision": guide["revision"]})


def test_compile_outside_transaction_and_draft_publication_separation(client, superuser, guide, rich, monkeypatch):
    import guide_embeds
    compile = guide_embeds.compile_content
    calls = []
    def check(source):
        assert _active_session.get() is None
        calls.append(source)
        return compile(source)
    monkeypatch.setattr(guide_embeds, "compile_bounded", check)
    saved = ok(save(client, superuser, guide))
    assert saved["source_content"] == {"format": FORMAT, "body": SOURCE}
    assert saved["draft_content"]["render"]["blocks"]
    assert saved["published_content"] == guide["published_content"]
    assert calls == [SOURCE]
    published = ok(publish(client, superuser, saved))
    assert published["published_content"]["format"] == FORMAT
    assert published["published_content"]["render"]["diagnostics"] == []
    assert "draft_content" not in published
    assert calls == [SOURCE]  # publish reuses its verified source-matched artifact


def test_invalid_draft_is_saved_but_cannot_replace_publication(client, superuser, guide, rich):
    good = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    source = '```profkom-html id=embed-bad\n<script>alert(1)</script>\n```'
    bad = ok(save(client, superuser, good, source))
    assert bad["source_content"]["body"] == source
    assert bad["draft_content"]["render"]["diagnostics"]
    assert publish(client, superuser, bad).status_code == 422
    current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert current["published_content"] == good["published_content"]


def test_preview_requires_editor_and_current_revision_and_never_writes(client, superuser, user, guide, rich):
    mid = guide["material_id"]
    payload = {"expected_revision": guide["revision"], "content": {"format": FORMAT, "body": SOURCE}}
    # Hidden block guide remains hidden even to a caller sending valid rich HTML.
    assert client.post(f"/api/materials/{mid}/preview", headers=user.headers, json=payload).status_code == 404
    statements = []
    def record(_c, _cur, statement, _p, _context, _many):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", record)
    try:
        result = ok(client.post(f"/api/materials/{mid}/preview", headers=superuser.headers, json=payload))
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert result["render"]["blocks"] and not result["render"]["diagnostics"]
    assert not any(s.lstrip().split()[0].upper() in {"UPDATE", "INSERT", "DELETE"} for s in statements)
    assert client.post(f"/api/materials/{mid}/preview", headers=superuser.headers,
                       json={**payload, "expected_revision": guide["revision"] + 1}).status_code == 409
    with db._session() as s:
        assert s.query(MaterialRenderArtifactORM).count() == 0


def test_preview_uses_real_isolated_compiler(client, superuser, guide, monkeypatch):
    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", True)
    result = ok(client.post(f"/api/materials/{guide['material_id']}/preview", headers=superuser.headers,
                            json={"expected_revision": guide["revision"], "content": {"format": FORMAT, "body": SOURCE}}))
    assert result["render"]["blocks"] and not result["render"]["diagnostics"]


@pytest.mark.parametrize("change", ["revision", "permissions", "session"])
def test_rechecks_after_compilation_and_rolls_back(client, superuser, guide, rich, monkeypatch, change):
    import guide_embeds
    from database import UserORM
    compile = guide_embeds.compile_content
    def intervening(source):
        result = compile(source)
        with db.atomic(), db._session() as s:
            if change == "revision":
                s.get(MaterialORM, guide["material_id"]).revision += 1
            elif change == "permissions":
                s.get(MaterialORM, guide["material_id"]).deleted = True
            else:
                s.get(UserORM, superuser.user_id).session_version += 1
        return result
    monkeypatch.setattr(guide_embeds, "compile_bounded", intervening)
    assert save(client, superuser, guide).status_code == {"revision": 409, "permissions": 404, "session": 401}[change]
    with db._session() as s:
        assert not s.query(MaterialRenderArtifactORM).count()
        assert s.get(MaterialORM, guide["material_id"]).draft_body is None


def test_read_never_compiles_and_catalog_omits_rich_source(client, superuser, guide, rich, monkeypatch):
    import guide_embeds
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    monkeypatch.setattr(guide_embeds, "compile_content", lambda *_: pytest.fail("GET compiled"))
    monkeypatch.setattr(guide_embeds, "compile_bounded", lambda *_: pytest.fail("GET compiled"))
    statements = []
    def record(_c, _cur, statement, _p, _context, _many): statements.append(statement)
    event.listen(engine, "before_cursor_execute", record)
    try:
        detailed = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
        listed = next(m for m in ok(client.get("/api/materials", headers=superuser.headers))["items"] if m["material_id"] == guide["material_id"])
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert detailed["published_content"] == saved["published_content"]
    assert listed["published_content"] == {"format": FORMAT, "body": ""}
    assert listed["source_content"] == {"format": FORMAT, "body": ""}
    assert not any(s.lstrip().split()[0].upper() in {"UPDATE", "INSERT", "DELETE"} for s in statements)


def test_typed_render_keeps_one_validation_and_writer_copies_are_independent(client, superuser, guide, rich):
    import material_render
    from domain_contract import Material as MaterialOut
    import materials
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    with db.atomic(write=False), db._session() as s:
        m = s.get(MaterialORM, guide["material_id"])
        data = materials.dto(s, m, superuser.user_id)
        typed = data["published_content"]["render"]
        validated = MaterialOut.model_validate(data)
        assert validated.published_content.render is typed  # no dict→model revalidation
        assert validated.model_dump(mode="json", exclude_unset=True)["published_content"] == saved["published_content"]
        artifact = s.get(MaterialRenderArtifactORM, (guide["material_id"], "published"))
        writer_copy = material_render.load(artifact, m.published_body)
        writer_copy["blocks"][0]["nodes"].clear()
        assert material_render.load(artifact, m.published_body)["blocks"][0]["nodes"]
        assert typed.blocks[0].nodes
    first = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    first["published_content"]["render"]["blocks"][0]["nodes"].clear()
    assert ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))["published_content"] == saved["published_content"]


@pytest.mark.parametrize("cached", [True, False])
def test_optimized_detail_matches_contract_and_escapes_source(client, superuser, guide, rich, monkeypatch, cached):
    import material_render
    import materials
    from domain_contract import Material as MaterialOut
    # Quotes, backslashes, Unicode and JSON-shaped author text stay ordinary text.
    source = SOURCE + '\n\nТекст \"render\":null, \"capabilities\":[\"forged\"] \\ <script>not executed</script>'
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide, source))))
    saved = ok(save(client, superuser, saved, SOURCE.replace("Заголовок", "Черновик")))
    material_render.clear_cache()
    if not cached:
        monkeypatch.setattr(material_render, "_CACHE_BYTES", 1)
    with db.atomic(write=False), db._session() as session:
        data = materials.dto(session, session.get(MaterialORM, guide["material_id"]), superuser.user_id)
        expected = MaterialOut.model_validate(data).model_dump(mode="json", exclude_unset=True)
        response = material_render.detail_response(data)
    assert json.loads(response.body) == expected
    assert response.media_type == "application/json"
    assert "forged" not in expected["capabilities"]
    assert expected["published_content"]["body"] == source
    assert expected["draft_content"]["render"]["blocks"]
    actual = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert actual == expected


def test_warm_detail_skips_tree_serialization_but_rechecks_metadata(client, superuser, guide, rich, monkeypatch):
    import material_render
    from domain_contract import GuideRender
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    path = f"/api/materials/{guide['material_id']}"
    material_render.clear_cache()
    warm = ok(client.get(path, headers=superuser.headers))
    with db.atomic(), db._session() as session:
        session.get(MaterialORM, guide["material_id"]).description = "Свежие метаданные"
    monkeypatch.setattr(GuideRender, "model_dump_json", lambda *_a, **_k: pytest.fail("Warm tree was serialized again"))
    monkeypatch.setattr(GuideRender, "model_dump", lambda *_a, **_k: pytest.fail("Warm tree was traversed again"))
    current = ok(client.get(path, headers=superuser.headers))
    assert current["published_content"] == warm["published_content"]
    assert current["description"] == "Свежие метаданные"
    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", False)
    assert "edit_html_material" not in ok(client.get(path, headers=superuser.headers))["capabilities"]
    assert saved["published_content"] == current["published_content"]


def artifact_fixture(source):
    from types import SimpleNamespace
    from guide_embeds import compile_content
    render = compile_content(source)
    return SimpleNamespace(source_hash=render["source_hash"], render_json=json.dumps(render, ensure_ascii=False))


def test_artifact_cache_is_immutable_and_warm_read_skips_validation(monkeypatch):
    import material_render
    from domain_contract import GuideRender
    from pydantic import ValidationError
    material_render.clear_cache()
    artifact = artifact_fixture(SOURCE)
    first = material_render.load_model(artifact, SOURCE)
    assert first and isinstance(first.blocks, tuple) and isinstance(first.blocks[0].nodes, tuple)
    with pytest.raises(ValidationError):
        first.source_hash = "changed"
    with pytest.raises(ValidationError):
        first.blocks[0].nodes[0].attrs.classes += ("new-class",)
    with pytest.raises(AttributeError):
        first.blocks[0].nodes.clear()
    monkeypatch.setattr(GuideRender, "model_validate_json", lambda *_: pytest.fail("Warm artifact was reparsed"))
    assert material_render.load_model(artifact, SOURCE) is first
    plain = material_render.load(artifact, SOURCE)
    plain["blocks"].clear()
    assert material_render.load_model(artifact, SOURCE).blocks
    assert material_render.load_model(artifact, SOURCE + "changed") is None
    monkeypatch.setattr(material_render, "POLICY_VERSION", 2)
    # A changed policy must never hit the previous cached entry. Restore parser for rejection.
    monkeypatch.undo()
    monkeypatch.setattr(material_render, "POLICY_VERSION", 2)
    assert material_render.load_model(artifact, SOURCE) is None
    material_render.clear_cache()


def test_artifact_cache_entry_and_serialized_byte_budgets(monkeypatch):
    import material_render
    material_render.clear_cache()
    for i in range(10):
        source = SOURCE.replace("Заголовок", f"Заголовок {i}")
        assert material_render.load_model(artifact_fixture(source), source)
    assert len(material_render._cache) == 8
    assert material_render._cache_bytes <= 2 * 1024 * 1024
    material_render.clear_cache()
    first = artifact_fixture(SOURCE)
    material_render.load_model(first, SOURCE)
    size = material_render._cache_bytes
    material_render.clear_cache()
    monkeypatch.setattr(material_render, "_CACHE_BYTES", size + 10)
    material_render.load_model(first, SOURCE)
    second_source = SOURCE.replace("Заголовок", "Заголовок 2")
    second = artifact_fixture(second_source)
    material_render.load_model(second, second_source)
    assert len(material_render._cache) == 1
    assert material_render._cache_bytes <= size + 10
    material_render.clear_cache()
    monkeypatch.setattr(material_render, "_CACHE_BYTES", 1)
    assert material_render.load_model(first, SOURCE)
    assert not material_render._cache


def test_cached_tree_never_caches_reader_acl_or_old_source(client, superuser, user, guide, rich):
    guide = ok(client.put(f"/api/materials/{guide['material_id']}/audience", headers=superuser.headers,
                          json={"expected_revision": guide["revision"], "audience": "everyone"}))
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    path = f"/api/materials/{guide['material_id']}"
    assert ok(client.get(path, headers=user.headers))["published_content"]["render"]
    private = ok(client.put(path + "/audience", headers=superuser.headers,
                            json={"expected_revision": saved["revision"], "audience": "block"}))
    assert client.get(path, headers=user.headers).status_code == 404
    replacement = SOURCE.replace("Заголовок", "Новая публикация")
    changed = ok(publish(client, superuser, ok(save(client, superuser, private, replacement))))
    assert changed["published_content"]["render"]["source_hash"] != saved["published_content"]["render"]["source_hash"]
    assert ok(client.get(path, headers=superuser.headers))["published_content"] == changed["published_content"]


def test_stale_or_unknown_artifact_fails_closed_without_repair(client, superuser, guide, rich):
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    with db.atomic(), db._session() as s:
        artifact = s.get(MaterialRenderArtifactORM, (guide["material_id"], "published"))
        render = json.loads(artifact.render_json)
        render["policy_version"] = 999
        artifact.render_json = json.dumps(render)
    current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert current["published_content"]["body"] == saved["published_content"]["body"]
    assert current["published_content"]["render"] is None


def test_disabled_flag_blocks_new_rich_writes_but_keeps_reading(client, superuser, guide, rich, monkeypatch):
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", False)
    current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert "edit_html_material" not in current["capabilities"]
    assert current["published_content"]["render"]
    assert save(client, superuser, saved).status_code == 409


def test_invalid_unicode_source_is_a_controlled_error(client, superuser, guide, rich):
    # JSON may encode a lone surrogate; SQLite cannot store it as UTF-8.
    payload = json.dumps({"expected_revision": guide["revision"], "content": {"format": FORMAT, "body": "bad\ud800"}})
    response = client.patch(f"/api/materials/{guide['material_id']}", headers={**superuser.headers, "Content-Type": "application/json"}, content=payload)
    assert response.status_code == 422


def test_markdown_fence_stays_code_and_general_material_cannot_enable_format(client, superuser, guide, rich):
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide, format="markdown"))))
    assert saved["published_content"] == {"format": "markdown", "body": SOURCE}
    response = client.post("/api/materials", headers=superuser.headers, json={"kind": "general", "title": "General", "content": {"format": FORMAT, "body": SOURCE}})
    assert response.status_code == 422


def upload(client, actor, material_id, mock_s3, mime="image/png", complete=True):
    data = b"\x89PNG\r\n\x1a\nSynthetic guide image" if mime == "image/png" else b"%PDF-1.7 synthetic"
    item = ok(client.post("/api/files/upload-intents", headers=actor.headers, json={
        "owner_kind": "material", "owner_id": material_id, "purpose": "material",
        "name": "image.png" if mime == "image/png" else "file.pdf", "mime_type": mime, "size_bytes": len(data),
    }))
    mock_s3["objects"]["private/" + item["file_id"]] = (data, mime)
    if complete:
        ok(client.post(f"/api/files/{item['file_id']}/complete", headers=actor.headers, json={}))
    return item["file_id"], data


def image_source(fid):
    return f'```profkom-html id=embed-image\n<figure><img src="file:{fid}" alt="Синтетическое изображение" width="400" height="300"><figcaption>Подпись</figcaption></figure>\n```'


def test_image_bytes_private_until_publish_and_revoked_when_removed(client, superuser, user, guide, rich, mock_s3):
    guide = ok(client.put(f"/api/materials/{guide['material_id']}/audience", headers=superuser.headers,
                          json={"expected_revision": guide["revision"], "audience": "everyone"}))
    fid, data = upload(client, superuser, guide["material_id"], mock_s3)
    draft = ok(save(client, superuser, guide, image_source(fid)))
    assert draft["draft_content"]["render"]["file_ids"] == [fid]
    url = f"/api/files/{fid}/content"
    assert client.get(url, headers=user.headers).status_code == 404
    assert client.get(url, headers=superuser.headers).content == data
    published = ok(publish(client, superuser, draft))
    response = client.get(url, headers=user.headers)
    assert response.status_code == 200 and response.content == data
    removed = ok(publish(client, superuser, ok(save(client, superuser, published, SOURCE))))
    assert removed["published_content"]["render"]["file_ids"] == []
    assert client.get(url, headers=user.headers).status_code == 404
    # Editors still own and can reinsert their retained attachment.
    assert client.get(url, headers=superuser.headers).status_code == 200


@pytest.mark.parametrize("failure", ["foreign", "unfinished", "wrong_mime"])
def test_invalid_image_reference_refused_without_partial_draft(client, superuser, guide, rich, mock_s3, failure):
    owner = guide["material_id"]
    if failure == "foreign":
        other = ok(client.post("/api/materials", headers=superuser.headers, json={
            "kind": "general", "title": "Other", "content": {"format": "markdown", "body": "Other"},
        }))
        owner = other["material_id"]
    fid, _ = upload(client, superuser, owner, mock_s3, mime="application/pdf" if failure == "wrong_mime" else "image/png", complete=failure != "unfinished")
    assert save(client, superuser, guide, image_source(fid)).status_code == (422 if failure == "wrong_mime" else 403)
    current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert current["revision"] == guide["revision"]
    assert "draft_content" not in current


@pytest.mark.parametrize("format", ["markdown", FORMAT])
def test_rich_code_examples_do_not_grant_files_and_legacy_policy_is_preserved(client, superuser, user, guide, rich, mock_s3, format):
    guide = ok(client.put(f"/api/materials/{guide['material_id']}/audience", headers=superuser.headers,
                          json={"expected_revision": guide["revision"], "audience": "everyone"}))
    fid, _ = upload(client, superuser, guide["material_id"], mock_s3)
    source = f"Код-пример: `file:{fid}`\n\n```html\n<img src=\"file:{fid}\">\n```"
    ok(publish(client, superuser, ok(save(client, superuser, guide, source, format))))
    # The old Markdown source-reference policy is intentionally preserved; rich guides
    # grant readers only actual rendered references, not a code example.
    assert client.get(f"/api/files/{fid}/content", headers=user.headers).status_code == (200 if format == "markdown" else 404)


def test_material_retention_removes_derived_artifacts(client, superuser, guide, rich):
    from material_retention import purge_expired
    saved = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    ok(client.request("DELETE", f"/api/materials/{guide['material_id']}", headers=superuser.headers,
                      json={"expected_revision": saved["revision"]}))
    with db.atomic(), db._session() as s:
        s.get(MaterialORM, guide["material_id"]).deleted_at = "2020-01-01T00:00:00Z"
        assert s.query(MaterialRenderArtifactORM).count() == 1
    assert purge_expired(dry_run=False)["material_ids"] == [guide["material_id"]]
    with db._session() as s:
        assert not s.query(MaterialRenderArtifactORM).count()


def test_schema_upgrade_twice_preserves_existing_text_and_rows(tmp_path):
    path = tmp_path / "old-materials.db"
    with sqlite3.connect(path) as c:
        c.execute('''CREATE TABLE materials (
          material_id VARCHAR PRIMARY KEY, legacy_guide_id INTEGER, kind VARCHAR NOT NULL,
          owner_block_id VARCHAR, title VARCHAR NOT NULL, description TEXT NOT NULL,
          original_link VARCHAR, published_body TEXT, draft_title VARCHAR,
          draft_description TEXT, draft_original_link VARCHAR, draft_body TEXT,
          has_draft BOOLEAN NOT NULL, revision INTEGER NOT NULL, placeholder BOOLEAN NOT NULL,
          deleted BOOLEAN NOT NULL, deleted_at VARCHAR, created_at VARCHAR NOT NULL,
          published_at VARCHAR, audience VARCHAR NOT NULL DEFAULT 'block')''')
        c.execute("INSERT INTO materials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  ("kept-material", None, "general", None, "Original", "Description", None,
                   "Original ```profkom-html source", None, None, None, "Unpublished", 1, 7, 0, 0, None, "2026-01-01", None, "everyone"))
        before = c.execute("SELECT * FROM materials").fetchall()
    env = {**os.environ, "DATABASE_PATH": str(path), "SQLITE_JOURNAL_MODE": "DELETE", "ROOT_LOGIN": "", "ROOT_PASSWORD_HASH": ""}
    for _ in range(2):
        subprocess.run([sys.executable, "-c", "import database; database.engine.dispose()"],
                       cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, check=True)
        with sqlite3.connect(path) as c:
            row = c.execute("SELECT * FROM materials WHERE material_id='kept-material'").fetchone()
            assert row[:20] == before[0]
            assert row[20:] == ("markdown", "markdown", None)
            assert c.execute("SELECT count(*) FROM material_render_artifacts").fetchone()[0] == 0
            assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert c.execute("PRAGMA foreign_key_check").fetchall() == []
