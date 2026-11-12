"""Journal lifecycle, current ACL and immutable read projection over HTTP."""
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import event

from database import db, engine, UserORM, FileRecordORM, _active_session
from domain_models import MaterialORM, MaterialRenderArtifactORM
from domain_contract import JournalRender, Material as MaterialOut
from settings import settings
import journal
import material_render
import materials
from test_guide_embeds_materials import guide, ok, publish, upload, image_source, SOURCE
from test_journal_compiler import document

FORMAT = "journal-v1"


def basic_document(body="[Блоки](/blocks)"):
    value = document()
    value["sections"] = [{"id": "start", "label": "01", "title": "Начало", "blocks": [{"id": "body", "type": "text", "body": body}]}]
    return value


def source(value=None):
    return json.dumps(value if value is not None else basic_document(), ensure_ascii=False)


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", True)
    monkeypatch.setattr(journal, "compile_bounded", journal.compile_content)


def save(client, actor, guide, body=None):
    return client.patch(f"/api/materials/{guide['material_id']}", headers=actor.headers, json={
        "expected_revision": guide["revision"], "content": {"format": FORMAT, "body": source() if body is None else body},
    })


def preview(client, actor, guide, body=None):
    return client.post(f"/api/materials/{guide['material_id']}/preview", headers=actor.headers, json={
        "expected_revision": guide["revision"], "content": {"format": FORMAT, "body": source() if body is None else body},
    })


def test_preview_save_and_publish_compile_outside_transaction(client, superuser, guide, enabled, monkeypatch):
    calls = []
    def compile(body):
        assert _active_session.get() is None
        calls.append(body)
        return journal.compile_content(body)
    monkeypatch.setattr(journal, "compile_bounded", compile)
    assert ok(preview(client, superuser, guide))["render"]["document"] == basic_document()
    saved = ok(save(client, superuser, guide))
    assert saved["source_content"] == {"format": FORMAT, "body": source()}
    assert saved["published_content"] == guide["published_content"]
    published = ok(publish(client, superuser, saved))
    assert published["published_content"]["render"]["document"] == basic_document()
    assert calls == [source(), source()]


@pytest.mark.parametrize("body", ["{", source(basic_document("[сломано](#missing)"))])
def test_invalid_draft_survives_edit_but_cannot_publish(client, superuser, guide, enabled, body):
    good = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    bad = ok(save(client, superuser, good, body))
    assert bad["source_content"]["body"] == body
    assert bad["draft_content"]["render"]["document"] is None
    assert bad["draft_content"]["render"]["diagnostics"]
    assert publish(client, superuser, bad).status_code == 422
    assert ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))["published_content"] == good["published_content"]


@pytest.mark.parametrize("field", ["title", "body"])
def test_escaped_surrogate_uses_real_bounded_compiler_and_saves_invalid_draft(client, superuser, guide, monkeypatch, field):
    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", True)
    value = basic_document()
    if field == "title":
        value["sections"][0]["title"] = "bad\ud800"
    else:
        value["sections"][0]["blocks"][0]["body"] = "bad\ud800"
    raw = json.dumps(value, ensure_ascii=True)
    assert raw.isascii()
    expected = journal.compile_content(raw)
    assert expected["document"] is None
    assert expected["diagnostics"][0]["code"] == "journal_invalid_unicode"
    # No compiler stub: HTTP dispatch crosses the real isolated-process boundary.
    saved = ok(save(client, superuser, guide, raw))
    assert saved["source_content"]["body"] == raw
    assert saved["draft_content"]["render"] == expected
    assert publish(client, superuser, saved).status_code == 422
    current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert current["source_content"]["body"] == raw
    assert current["published_content"] == guide["published_content"]


@pytest.mark.parametrize("operation", [save, preview])
@pytest.mark.parametrize("change", ["revision", "permissions", "session", "feature"])
def test_rechecks_after_compile(client, superuser, guide, enabled, monkeypatch, change, operation):
    def intervene(body):
        result = journal.compile_content(body)
        with db.atomic(), db._session() as s:
            if change == "revision":
                s.get(MaterialORM, guide["material_id"]).revision += 1
            elif change == "permissions":
                s.get(MaterialORM, guide["material_id"]).deleted = True
            elif change == "session":
                s.get(UserORM, superuser.user_id).session_version += 1
            else:
                monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", False)
        return result
    monkeypatch.setattr(journal, "compile_bounded", intervene)
    assert operation(client, superuser, guide).status_code == {"revision": 409, "permissions": 404, "session": 401, "feature": 409}[change]
    with db._session() as s:
        assert s.query(MaterialRenderArtifactORM).count() == 0
        assert s.get(MaterialORM, guide["material_id"]).draft_body is None


def test_read_and_metadata_edit_never_compile_and_reads_do_not_write(client, superuser, guide, enabled, monkeypatch):
    published = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    monkeypatch.setattr(journal, "compile_content", lambda *_: pytest.fail("Read compiled source"))
    monkeypatch.setattr(journal, "compile_bounded", lambda *_: pytest.fail("Read compiled source"))
    statements = []
    def record(_c, _cur, sql, *_args): statements.append(sql)
    event.listen(engine, "before_cursor_execute", record)
    try:
        current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
        listed = next(m for m in ok(client.get("/api/materials", headers=superuser.headers))["items"] if m["material_id"] == guide["material_id"])
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert current["published_content"] == published["published_content"]
    assert listed["published_content"] == {"format": FORMAT, "body": ""}
    assert not any(sql.lstrip().split()[0].upper() in {"UPDATE", "INSERT", "DELETE"} for sql in statements)
    renamed = ok(client.patch(f"/api/materials/{guide['material_id']}", headers=superuser.headers,
                             json={"expected_revision": current["revision"], "title": "Новое название"}))
    assert renamed["draft_content"] == published["published_content"]
    assert ok(publish(client, superuser, renamed))["title"] == "Новое название"


def test_preview_is_editor_only_and_revisioned(client, superuser, user, guide, enabled):
    assert preview(client, user, guide).status_code == 404
    assert preview(client, superuser, {**guide, "revision": guide["revision"] + 1}).status_code == 409
    assert ok(preview(client, superuser, guide))["render"]["document"]
    with db._session() as s:
        assert s.query(MaterialRenderArtifactORM).count() == 0


@pytest.mark.parametrize("location", ["cover", "image", "hidden", "gallery", "legacy"])
@pytest.mark.parametrize("failure", ["foreign", "unfinished", "mime"])
def test_all_hidden_file_acl_and_image_mime_checked(client, superuser, guide, enabled, mock_s3, location, failure):
    owner = guide["material_id"]
    if failure == "foreign":
        owner = ok(client.post("/api/materials", headers=superuser.headers, json={
            "kind": "general", "title": "Другой", "content": {"format": "markdown", "body": "Текст"},
        }))["material_id"]
    fid, _ = upload(client, superuser, owner, mock_s3, mime="application/pdf" if failure == "mime" else "image/png", complete=failure != "unfinished")
    value = basic_document()
    if location == "cover":
        value["cover"] = {"kind": "image", "file_id": fid, "alt": "Обложка", "caption": "", "width": 400, "height": 300}
    elif location == "image":
        value["sections"][0]["blocks"].append({"id": "pic", "type": "image", "file_id": fid, "alt": "Фото", "caption": "", "width": 400, "height": 300, "collapsed": True})
    elif location == "hidden":
        value["sections"][0]["blocks"].append({"id": "switch", "type": "switcher", "title": "Случай", "options": [
            {"id": "a", "label": "Первый", "body": "Текст"}, {"id": "b", "label": "Второй", "body": f"![Фото](file:{fid})"}]})
    elif location == "gallery":
        value["sections"][0]["blocks"].append({"id": "hidden", "type": "disclosure", "title": "Скрыто", "body": f"```gallery\nfile:{fid}|Фото\n```"})
    else:
        value["sections"][0]["blocks"].append({"id": "legacy", "type": "legacy", "body": image_source(fid)})
    for operation in (preview, save):
        assert operation(client, superuser, guide, source(value)).status_code == (422 if failure == "mime" else 403)
    current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert current["revision"] == guide["revision"] and "draft_content" not in current


def test_pdf_link_is_allowed_and_file_bytes_follow_current_publication(client, superuser, user, guide, enabled, mock_s3):
    guide = ok(client.put(f"/api/materials/{guide['material_id']}/audience", headers=superuser.headers,
                          json={"expected_revision": guide["revision"], "audience": "everyone"}))
    fid, data = upload(client, superuser, guide["material_id"], mock_s3, mime="application/pdf")
    draft = ok(save(client, superuser, guide, source(basic_document(f"[PDF](file:{fid})"))))
    assert draft["draft_content"]["render"]["file_ids"] == [fid]
    assert draft["draft_content"]["render"]["image_file_ids"] == []
    path = f"/api/files/{fid}/content"
    assert client.get(path, headers=user.headers).status_code == 404
    pub = ok(publish(client, superuser, draft))
    assert client.get(path, headers=user.headers).content == data
    ok(publish(client, superuser, ok(save(client, superuser, pub))))
    assert client.get(path, headers=user.headers).status_code == 404


@pytest.mark.parametrize("stage", ["compile", "publish"])
@pytest.mark.parametrize("change", ["state", "mime_type"])
def test_file_change_is_checked_after_compile_and_again_at_publication(client, superuser, guide, enabled, mock_s3, monkeypatch, stage, change):
    fid, _ = upload(client, superuser, guide["material_id"], mock_s3)
    body = source(basic_document(f"![Фото](file:{fid})"))
    def revoke():
        with db.atomic(), db._session() as s:
            setattr(s.get(FileRecordORM, fid), change, "pending" if change == "state" else "application/pdf")
    if stage == "compile":
        def intervening(raw):
            result = journal.compile_content(raw)
            revoke()
            return result
        monkeypatch.setattr(journal, "compile_bounded", intervening)
        result = save(client, superuser, guide, body)
    else:
        saved = ok(save(client, superuser, guide, body))
        revoke()
        result = publish(client, superuser, saved)
    assert result.status_code == (403 if change == "state" else 422)
    current = ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))
    assert current["published_content"] == guide["published_content"]
    assert current["revision"] == (guide["revision"] if stage == "compile" else saved["revision"])


def test_legacy_import_preserves_v1_source_and_flag_only_gates_writes(client, superuser, guide, enabled, monkeypatch):
    import guide_embeds
    monkeypatch.setattr(guide_embeds, "compile_bounded", guide_embeds.compile_content)
    from test_guide_embeds_materials import save as save_v1
    old = ok(publish(client, superuser, ok(save_v1(client, superuser, guide))))
    value = basic_document()
    value["sections"][0]["blocks"] = [{"id": "old", "type": "legacy", "body": SOURCE}]
    draft = ok(save(client, superuser, old, source(value)))
    assert draft["published_content"] == old["published_content"]
    imported = ok(publish(client, superuser, draft))
    assert imported["published_content"]["render"]["legacy"][0]["render"] == old["published_content"]["render"]
    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", False)
    assert save(client, superuser, imported).status_code == 409
    assert ok(client.get(f"/api/materials/{guide['material_id']}", headers=superuser.headers))["published_content"] == imported["published_content"]


def test_journal_requires_guide_and_new_material_cannot_borrow_files(client, superuser, guide, enabled):
    assert client.post("/api/materials", headers=superuser.headers, json={
        "kind": "general", "title": "Запрещено", "content": {"format": FORMAT, "body": source()},
    }).status_code == 422
    value = basic_document("[Файл](file:file-borrowed)")
    assert client.post("/api/materials", headers=superuser.headers, json={
        "kind": "guide", "owner_block_id": guide["owner_block_id"], "title": "Новый", "content": {"format": FORMAT, "body": source(value)},
    }).status_code == 422


def test_cache_is_frozen_format_separated_and_source_matched(monkeypatch):
    material_render.clear_cache()
    body = source()
    result = journal.compile_content(body)
    artifact = SimpleNamespace(source_hash=result["source_hash"], render_json=json.dumps(result, ensure_ascii=False))
    model = material_render.load_model(artifact, body, FORMAT)
    assert model is not None and isinstance(model.document.sections, tuple)
    with pytest.raises(ValidationError):
        model.document.sections[0].title = "Changed"
    monkeypatch.setattr(JournalRender, "model_validate_json", lambda *_: pytest.fail("Warm parse"))
    assert material_render.load_model(artifact, body, FORMAT) is model
    assert material_render.load_model(artifact, body) is None
    assert material_render.load_model(artifact, body + " ", FORMAT) is None
    plain = material_render.load(artifact, body, FORMAT)
    plain["document"]["sections"].clear()
    assert model.document.sections
    material_render.clear_cache()


@pytest.mark.parametrize("cached", [True, False])
def test_detailed_response_matches_contract_and_metadata_is_fresh(client, superuser, user, guide, enabled, monkeypatch, cached):
    guide = ok(client.put(f"/api/materials/{guide['material_id']}/audience", headers=superuser.headers,
                          json={"expected_revision": guide["revision"], "audience": "everyone"}))
    published = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    path = f"/api/materials/{guide['material_id']}"
    material_render.clear_cache()
    if not cached:
        monkeypatch.setattr(material_render, "_CACHE_BYTES", 1)
    with db.atomic(write=False), db._session() as s:
        data = materials.dto(s, s.get(MaterialORM, guide["material_id"]), superuser.user_id)
        expected = MaterialOut.model_validate(data).model_dump(mode="json", exclude_unset=True)
        assert json.loads(material_render.detail_response(data).body) == expected
    assert ok(client.get(path, headers=user.headers))["published_content"] == published["published_content"]
    with db.atomic(), db._session() as s:
        s.get(MaterialORM, guide["material_id"]).description = "Новые метаданные"
    if cached:
        monkeypatch.setattr(JournalRender, "model_dump_json", lambda *_a, **_k: pytest.fail("Warm serialization"))
        monkeypatch.setattr(JournalRender, "model_dump", lambda *_a, **_k: pytest.fail("Warm traversal"))
    assert ok(client.get(path, headers=superuser.headers))["description"] == "Новые метаданные"
    with db.atomic(), db._session() as s:
        s.get(MaterialORM, guide["material_id"]).audience = "block"
    assert client.get(path, headers=user.headers).status_code == 404
    material_render.clear_cache()
