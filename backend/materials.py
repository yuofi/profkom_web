"""Material drafts, publication, per-object editors and old-ID resolution."""

import json, re, uuid
from typing import Literal
from pydantic import Field
from fastapi import Body, Depends, HTTPException
from database import db, GuideORM, RoleAssignmentORM, UserORM
from domain_models import MaterialORM, BlockMetaORM
from models import User
from auth import get_current_user, recheck_current_user
from registration import Revision, audit, now, version, fail
import access
from validation import Command
from api_contract import Page
from domain_contract import Material as MaterialOut, EditorAssignment, MaterialContent
from settings import settings
import material_render


class RichText(Command):
    format: Literal["markdown", "markdown-embeds-v1", "journal-v1"] = "markdown"
    body: str


class Create(Command):
    kind: Literal["guide", "general", "kmb"]
    owner_block_id: str | None = None
    title: str
    description: str = ""
    content: RichText
    original_link: str | None = None


class Patch(Revision):
    catalog_section: Literal["guide", "general"] | None = None
    title: str | None = None
    description: str | None = None
    content: RichText | None = None
    original_link: str | None = None


class Preview(Revision):
    content: RichText


class Editors(Revision):
    user_ids: list[int]


class Audience(Revision):
    audience: Literal["block", "everyone", "leadership"]


def row(s, id):
    m = s.get(MaterialORM, id)
    if not m or m.deleted:
        fail(404, "Material not found")
    return m


def can_edit(id, uid):
    with db._session() as s:
        m = s.get(MaterialORM, id)
        if not m or m.deleted:
            return False
        if m.audience == "leadership" and not access.allowed(uid, "material.read_leadership_guide"):
            return False
    return access.allowed(uid, "material.edit", "material", id)


def require_edit(id, uid):
    """A command on a material the user cannot read is a 404 like its GET; a reader
    without the editor right gets the 403 (GL-24)."""
    if not can_edit(id, uid):
        if not can_read(id, uid):
            fail(404, "Material not found")
        fail(403, "Material editor required")


def block_only(m):
    return m.kind == "guide" and bool(m.owner_block_id) and m.audience != "everyone"


def can_read(id, uid):
    u = db.get_user(uid)
    if not u or u.account_state != "active" or u.banned:
        return False
    with db._session() as s:
        m = s.get(MaterialORM, id)
        if not m or m.deleted:
            return False
        if can_edit(id, uid):
            return True
        if m.published_body is None:
            return False
        if m.audience == "leadership":
            return access.allowed(uid, "material.read_leadership_guide")
        if not block_only(m):
            return True
        # A guide of its block: the block's members and leads, the chair's team (2026-10-25).
        meta = s.get(BlockMetaORM, m.owner_block_id)
        return bool(meta) and access.allowed(uid, "material.read_block_guide", "block", meta.legacy_name)


def stored(s, body, material_id, published, format="markdown"):
    """Text to store: no new links into the bucket, own attachments as file:<id> (0.2)."""
    # Journal's JSON source is never rewritten as legacy Markdown. Its compiler
    # checks every visible/hidden file reference and refuses external images.
    if format == material_render.JOURNAL:
        return body
    from legacy_files import bucket_keys, own_attachments, stored_text

    return stored_text(body, own_attachments(s, material_id), bucket_keys(published))


def dto(s, m, uid, *, detail=True):
    from legacy_files import read_text

    edit = can_edit(m.material_id, uid)
    draft = edit and m.has_draft
    from material_updates import placeholder_text
    published_body = placeholder_text(s, m.owner_block_id) if m.placeholder and m.revision == 1 and not m.has_draft and m.owner_block_id else m.published_body
    rendered = (material_render.artifacts(s, m.material_id) if detail and (
        m.published_format in material_render.FORMATS or (draft and m.draft_format in material_render.FORMATS)
    ) else {})
    def content(body, format, slot):
        if format in material_render.FORMATS:
            result = dict(format=format, body=(body or "") if detail else "")
            if detail:
                result["render"] = material_render.load_model(rendered.get(slot), body, format)
            return result
        return dict(format="markdown", body=read_text(body) if slot == "published" else (body or ""))
    data = dict(
        material_id=m.material_id,
        kind=m.kind,
        owner_block_id=m.owner_block_id,
        title=m.draft_title if draft and m.draft_title is not None else m.title,
        description=(
            m.draft_description
            if draft and m.draft_description is not None
            else m.description
        ),
        original_link=m.draft_original_link if draft else m.original_link,
        published_content=(
            content(published_body, m.published_format, "published")
            if m.published_body is not None
            else None
        ),
        revision=m.revision,
        placeholder=m.placeholder,
        published_at=m.published_at if m.published_body is not None else None,
        community_url=(s.get(BlockMetaORM, m.owner_block_id).community_url if m.owner_block_id and s.get(BlockMetaORM, m.owner_block_id) else None),
        capabilities=[],
    )
    if m.kind == "guide" and m.owner_block_id:
        data["audience"] = m.audience if m.audience in {"everyone", "leadership"} else "block"
    if m.catalog_section is not None:
        data["catalog_section"] = m.catalog_section
    if edit:
        data["capabilities"] += ["edit_material", "publish_material", "delete_material"]
        if settings.GUIDE_HTML_EMBEDS_ENABLED and m.kind == "guide":
            data["capabilities"].append("edit_html_material")
        if m.kind == "guide" and m.owner_block_id:
            data["capabilities"].append("edit_audience")
        if draft:
            data["draft_content"] = content(m.draft_body, m.draft_format, "draft")
        # The editor always starts from the stored text, never from signed links (A-MAT-1).
        data["source_content"] = dict(
            format=m.draft_format if m.has_draft else m.published_format,
            body=((m.draft_body or "") if m.has_draft else (m.published_body or ""))
                if detail or (m.draft_format if m.has_draft else m.published_format) == "markdown" else "",
        )
    if access.allowed(uid, "material.manage_editors"):
        data["capabilities"].append("manage_material_editors")
        from read_context import orm_rows
        data["editor_user_ids"] = [
            r.user_id
            for r in orm_rows(s, "material.editors", m.material_id, lambda: s.query(RoleAssignmentORM).filter_by(
                scope_kind="material", scope_id=m.material_id, role="material_editor"
            ).all())
        ]
    return data


def require_format(kind, content):
    if content.format in material_render.FORMATS:
        try:
            content.body.encode("utf-8")
        except UnicodeEncodeError:
            fail(422, "Текст содержит недопустимый символ Unicode", "guide_invalid_unicode")
        if kind != "guide":
            fail(422, "Расширенное оформление доступно в гайдах блоков", "guide_format_kind")
        if not settings.GUIDE_HTML_EMBEDS_ENABLED:
            fail(409, "Редактирование расширенного оформления пока выключено", "guide_embeds_disabled")


def compile_source(content):
    if content.format == "markdown":
        return None
    from guide_embeds import compile_bounded, EmbedCompileBusy, EmbedCompileTimeout
    if content.format == material_render.JOURNAL:
        from journal import compile_bounded
    try:
        return compile_bounded(content.body)
    except EmbedCompileBusy:
        fail(429, "Проверка вставок занята. Повторите через несколько секунд", "guide_compile_busy")
    except EmbedCompileTimeout:
        fail(422, "Проверка вставок превысила лимит времени. Разделите большой блок", "guide_compile_timeout")


def prepare_content(material_id, payload, cur):
    """Read ACL/source, release the DB, then do bounded CPU work in this worker thread."""
    with db.atomic(write=False):
        recheck_current_user(cur, working=True)
        with db._session() as s:
            m = row(s, material_id)
            require_edit(material_id, cur.user_id)
            version(m, payload.expected_revision)
            if payload.content is None:
                return None, None
            require_format(m.kind, payload.content)
            content = payload.content.model_copy(update={
                "body": stored(s, payload.content.body, material_id, m.published_body, payload.content.format)
            })
    return content, compile_source(content)


def check_render_files(s, material_id, uid, render):
    if render and not render["diagnostics"]:
        from file_access import check_attachments
        check_attachments(s, render["file_ids"], "material", material_id, uid)
        material_render.check_images(s, render)


def require_create(s, payload, cur):
    if payload.owner_block_id:
        meta = s.get(BlockMetaORM, payload.owner_block_id)
        if not meta:
            fail(404, "Block not found")
        permitted = access.allowed(cur.user_id, "material.create_guide", "block", meta.legacy_name)
    else:
        permitted = access.allowed(cur.user_id, "material.create_general")
    if not permitted:
        fail(403, "Material creator required")
    require_format(payload.kind, payload.content)


def _prime_editors(s, materials):
    """The listing's editor rows in one read; several editors keep the original query."""
    from read_context import prime_rows, reusable
    from sqlalchemy import literal_column
    if not reusable(s):
        return
    by_material = {}
    for r in s.query(RoleAssignmentORM).filter_by(scope_kind="material", role="material_editor").order_by(
            literal_column("role_assignments.rowid")):
        by_material.setdefault(r.scope_id, []).append(r)
    for m in materials:
        rows = by_material.get(m.material_id, [])
        if len(rows) <= 1:
            prime_rows(s, "material.editors", m.material_id, rows)


def deleted_dto(m):
    data = dict(
        material_id=m.material_id,
        kind=m.kind,
        owner_block_id=m.owner_block_id,
        title=m.title,
        description=m.description,
        original_link=m.original_link,
        published_content=None,
        revision=m.revision,
        capabilities=["restore_material"],
        deleted_at=m.deleted_at,
    )
    if m.catalog_section is not None:
        data["catalog_section"] = m.catalog_section
    return data


def block_material_id(s, bid):
    """The block's current guide, read-only: GET never creates a placeholder (GL-05).
    Block creation, startup and deletion of the last guide keep one in place."""
    m = (
        s.query(MaterialORM)
        .filter_by(owner_block_id=bid, deleted=False)
        .order_by(MaterialORM.published_body.is_(None), MaterialORM.placeholder, MaterialORM.created_at)
        .first()
    )
    return m.material_id if m else None


def ensure_block_guide(s, bid):
    """Inside a write transaction: a placeholder guide when the block has no live material."""
    m = (
        s.query(MaterialORM)
        .filter_by(owner_block_id=bid, deleted=False)
        .order_by(MaterialORM.published_body.is_(None), MaterialORM.placeholder, MaterialORM.created_at)
        .first()
    )
    if not m:
        meta = s.get(BlockMetaORM, bid)
        from material_updates import placeholder_text
        m = MaterialORM(
            material_id=str(uuid.uuid4()),
            kind="guide",
            owner_block_id=bid,
            title="Гайд " + meta.legacy_name,
            description="Материалы блока",
            published_body=placeholder_text(s, bid),
            has_draft=False,
            revision=1,
            placeholder=True,
            deleted=False,
            created_at=now(),
        )
        s.add(m)
        s.flush()
    return m.material_id


def publish(s, m, uid):
    if m.has_draft:
        import re
        from file_access import check_attachments

        m.draft_body = stored(s, m.draft_body, m.material_id, m.published_body, m.draft_format)
        rendered = None
        if m.draft_format in material_render.FORMATS:
            require_format(m.kind, RichText(format=m.draft_format, body=m.draft_body or ""))
            rendered = material_render.load(material_render.artifacts(s, m.material_id).get("draft"), m.draft_body, m.draft_format)
            if not rendered or rendered["diagnostics"]:
                fail(422, "Исправьте ошибки оформления и сохраните черновик перед публикацией", "guide_embeds_invalid")
            ids = rendered["file_ids"]
            material_render.check_images(s, rendered)
        else:
            ids = re.findall(r"file:(file-[\w-]+)", m.draft_body or "")
        check_attachments(s, list(dict.fromkeys(ids)), "material", m.material_id, uid)
        if not (m.draft_body or "").strip() and not m.draft_original_link:
            fail(422, "Material content or original link is required")
        m.title = m.draft_title or m.title
        m.description = m.draft_description or ""
        m.original_link = m.draft_original_link
        m.published_body = m.draft_body or ""
        m.published_format = m.draft_format
        material_render.save(s, m.material_id, "published", m.published_body, rendered, m.published_format)
        material_render.save(s, m.material_id, "draft", "", None)
        from domain_seed import now as published_now
        m.published_at = published_now()
        m.has_draft = False
        m.draft_body = None
        m.draft_format = "markdown"
        m.draft_title = None
        m.draft_description = None
        m.draft_original_link = None
        m.revision += 1
        m.placeholder = False
        g = (
            s.get(GuideORM, m.legacy_guide_id)
            if m.legacy_guide_id is not None
            else None
        )
        if not g:
            g = GuideORM(
                title=m.title,
                owner_block=(
                    s.get(BlockMetaORM, m.owner_block_id).legacy_name
                    if m.owner_block_id
                    else "none"
                ),
                text=m.published_body,
                description=m.description,
                original_link=m.original_link,
            )
            s.add(g)
            s.flush()
            m.legacy_guide_id = g.guide_id
        else:
            g.title = m.title
            g.text = m.published_body
            g.description = m.description
            g.original_link = m.original_link
        audit(
            s,
            "material",
            m.material_id,
            uid,
            "Material published",
            {},
            dict(revision=m.revision),
        )
    s.commit()
    return dto(s, m, uid)


def legacy_mapping(s, guide_id):
    m = s.query(MaterialORM).filter_by(legacy_guide_id=guide_id).first()
    if m:
        return m
    g = s.get(GuideORM, guide_id)
    if not g:
        fail(404, "Guide not found")
    from legacy_markup import to_markdown
    from domain_seed import meta_for
    from database import BlockORM

    owner = (g.owner_block or "").strip()
    from sqlalchemy import func

    matches = [b for b in s.query(BlockORM) if b.name.casefold() == owner.casefold()]
    block = matches[0] if len(matches) == 1 else None
    m = MaterialORM(
        material_id=str(
            uuid.uuid5(uuid.NAMESPACE_URL, "profkom:guide:" + str(guide_id))
        ),
        legacy_guide_id=guide_id,
        kind=(
            "guide"
            if block
            else "kmb" if g.title.strip().lower() == "кмб" else "general"
        ),
        owner_block_id=meta_for(s, block.name).block_id if block else None,
        title=g.title,
        description=g.description or "",
        original_link=g.original_link,
        published_body=to_markdown(g.text or ""),
        has_draft=False,
        revision=1,
        placeholder=False,
        deleted=False,
        created_at=now(),
    )
    s.add(m)
    s.flush()
    return m


def register_routes(router):
    @router.get(
        "/materials",
        response_model=Page[MaterialOut],
        response_model_exclude_unset=True,
    )
    def listing(cur: User = Depends(get_current_user)):
        # Old guides are mapped at startup (scripts/preset_db.py); GET only reads (GL-05).
        with db._session() as s:
            readable = [
                m for m in s.query(MaterialORM).filter_by(deleted=False).order_by(MaterialORM.created_at)
                if can_read(m.material_id, cur.user_id)
            ]
            if access.allowed(cur.user_id, "material.manage_editors"):
                _prime_editors(s, readable)
            return Page(items=[dto(s, m, cur.user_id, detail=False) for m in readable], next_cursor=None)

    @router.get("/materials/deleted", response_model=Page[MaterialOut], response_model_exclude_unset=True)
    def deleted(cur: User = Depends(get_current_user)):
        """Deleted materials, newest first, for the chair and deputies to restore (decision 18)."""
        if not access.allowed(cur.user_id, "material.restore"):
            fail(403, "Only the chair and deputies restore materials")
        with db._session() as s:
            rows = s.query(MaterialORM).filter_by(deleted=True).order_by(MaterialORM.created_at.desc())
            return Page(items=[deleted_dto(m) for m in rows], next_cursor=None)

    @router.post(
        "/materials/{material_id}/restore",
        response_model=MaterialOut,
        response_model_exclude_unset=True,
    )
    def restore(material_id: str, payload: Revision, cur: User = Depends(get_current_user)):
        if not access.allowed(cur.user_id, "material.restore"):
            fail(403, "Only the chair and deputies restore materials")
        with db._session() as s:
            m = s.get(MaterialORM, material_id)
            if not m:
                fail(404, "Material not found")
            version(m, payload.expected_revision)
            if not m.deleted:
                fail(409, "Material is not deleted")
            from material_retention import expires_at
            from datetime import datetime, timezone
            expiry = expires_at(m.deleted_at)
            if expiry is not None and expiry <= datetime.now(timezone.utc):
                fail(404, "Material retention period has expired")
            m.deleted = False
            m.deleted_at = None
            m.revision += 1
            audit(s, "material", material_id, cur.user_id, "Material restored", dict(deleted=True), dict(deleted=False))
            s.commit()
            return dto(s, m, cur.user_id)

    @router.get(
        "/materials/{material_id}",
        response_model=MaterialOut,
        response_model_exclude_unset=True,
    )
    def get(material_id: str, cur: User = Depends(get_current_user)):
        with db._session() as s:
            m = row(s, material_id)
            if not can_read(material_id, cur.user_id):
                fail(404, "Material not found")
            data = dto(s, m, cur.user_id)
            if m.published_format in material_render.FORMATS or m.draft_format in material_render.FORMATS:
                return material_render.detail_response(data)
            return data

    @router.post(
        "/materials", response_model=MaterialOut, response_model_exclude_unset=True
    )
    def create(payload: Create, cur: User = Depends(get_current_user)):
        if not payload.title.strip():
            fail(422, "Title required")
        if payload.kind == "guide" and not payload.owner_block_id:
            fail(422, "Guide requires a block")
        if payload.kind != "guide" and payload.owner_block_id:
            fail(422, "Only guides have an owning block")
        with db.atomic(write=False), db._session() as s:
            recheck_current_user(cur, working=True)
            require_create(s, payload, cur)
            body = stored(s, payload.content.body, None, None, payload.content.format)
        content = payload.content.model_copy(update={"body": body})
        rendered = compile_source(content)
        with db.atomic(), db._session() as s:
            recheck_current_user(cur, working=True)
            require_create(s, payload, cur)
            if payload.original_link and not payload.original_link.startswith(
                ("https://", "http://")
            ):
                fail(422, "Invalid original link")
            if ((rendered and rendered["file_ids"]) or
                    (content.format != material_render.JOURNAL and re.search(r"file:file-[\w-]+", body))):
                # A new object owns no files yet; upload after saving its draft.
                fail(422, "A new material cannot reference files; attach them after creating its draft")
            m = MaterialORM(
                material_id=str(uuid.uuid4()),
                kind=payload.kind,
                owner_block_id=payload.owner_block_id,
                title=payload.title,
                description=payload.description,
                draft_title=payload.title,
                draft_description=payload.description,
                draft_original_link=payload.original_link,
                draft_body=body,
                draft_format=content.format,
                has_draft=True,
                revision=1,
                placeholder=False,
                deleted=False,
                created_at=now(),
            )
            s.add(m)
            s.flush()
            material_render.save(s, m.material_id, "draft", body, rendered, content.format)
            audit(
                s,
                "material",
                m.material_id,
                cur.user_id,
                "Material draft created",
                {},
                dict(revision=1),
            )
            s.commit()
            return dto(s, m, cur.user_id)

    @router.patch(
        "/materials/{material_id}",
        response_model=MaterialOut,
        response_model_exclude_unset=True,
    )
    def patch(material_id: str, payload: Patch, cur: User = Depends(get_current_user)):
        if "catalog_section" in payload.model_fields_set:
            # Placement is published metadata, not a content draft. It never
            # recompiles or republishes the source, nor changes its audience.
            with db.atomic(), db._session() as s:
                recheck_current_user(cur, working=True)
                m = row(s, material_id)
                require_edit(material_id, cur.user_id)
                if not access.allowed(cur.user_id, "material.manage_editors"):
                    fail(403, "Only the chair and deputies change catalogue sections")
                version(m, payload.expected_revision)
                if m.kind != "guide":
                    fail(422, "Only a guide has a catalogue placement override")
                if payload.model_fields_set != {"expected_revision", "catalog_section"}:
                    fail(422, "Change the catalogue section separately from content")
                before = m.catalog_section
                if before != payload.catalog_section:
                    m.catalog_section = payload.catalog_section
                    m.revision += 1
                    audit(s, "material", material_id, cur.user_id, "Material catalogue section changed",
                          dict(catalog_section=before), dict(catalog_section=m.catalog_section))
                    s.commit()
                return dto(s, m, cur.user_id)
        content, rendered = prepare_content(material_id, payload, cur)
        with db.atomic(), db._session() as s:
            recheck_current_user(cur, working=True)
            m = row(s, material_id)
            require_edit(material_id, cur.user_id)
            version(m, payload.expected_revision)
            if not m.has_draft:
                m.draft_title = m.title
                m.draft_description = m.description
                m.draft_original_link = m.original_link
                m.draft_body = m.published_body or ""
                m.draft_format = m.published_format
                if m.published_format in material_render.FORMATS and content is None:
                    old_render = material_render.load(material_render.artifacts(s, material_id).get("published"), m.published_body, m.published_format)
                    material_render.save(s, material_id, "draft", m.draft_body, old_render, m.draft_format)
                m.has_draft = True
            if payload.title is not None:
                if not payload.title.strip():
                    fail(422, "Title required")
                m.draft_title = payload.title
            if payload.description is not None:
                m.draft_description = payload.description
            if "original_link" in payload.model_fields_set:
                if payload.original_link and not payload.original_link.startswith(
                    ("https://", "http://")
                ):
                    fail(422, "Invalid original link")
                m.draft_original_link = payload.original_link
            if content is not None:
                require_format(m.kind, content)
                check_render_files(s, material_id, cur.user_id, rendered)
                m.draft_body, m.draft_format = content.body, content.format
                material_render.save(s, material_id, "draft", m.draft_body, rendered, m.draft_format)
            m.revision += 1
            audit(
                s,
                "material",
                material_id,
                cur.user_id,
                "Material draft edited",
                {},
                dict(revision=m.revision),
            )
            s.commit()
            return dto(s, m, cur.user_id)

    @router.post(
        "/materials/{material_id}/publish",
        response_model=MaterialOut,
        response_model_exclude_unset=True,
    )
    def do_publish(
        material_id: str, payload: Revision, cur: User = Depends(get_current_user)
    ):
        with db.atomic(), db._session() as s:
            recheck_current_user(cur, working=True)
            m = row(s, material_id)
            require_edit(material_id, cur.user_id)
            version(m, payload.expected_revision)
            return publish(s, m, cur.user_id)

    @router.post("/materials/{material_id}/preview", response_model=MaterialContent, response_model_exclude_unset=True)
    def preview(material_id: str, payload: Preview, cur: User = Depends(get_current_user)):
        content, rendered = prepare_content(material_id, payload, cur)
        with db.atomic(write=False), db._session() as s:
            recheck_current_user(cur, working=True)
            m = row(s, material_id)
            require_edit(material_id, cur.user_id)
            version(m, payload.expected_revision)
            require_format(m.kind, content)
            check_render_files(s, material_id, cur.user_id, rendered)
            result = dict(format=content.format, body=content.body)
            if rendered is not None:
                result["render"] = rendered
            return result

    @router.delete("/materials/{material_id}")
    def remove(material_id: str, payload: Revision | None = Body(None), cur: User = Depends(get_current_user)):
        with db._session() as s:
            m = row(s, material_id)
            require_edit(material_id, cur.user_id)
            if payload is None:
                fail(422, "expected_revision is required", "invalid_input")
            # Like every other material command: a newer save by someone else is a 409 (GL-27).
            version(m, payload.expected_revision)
            m.deleted = True
            m.deleted_at = now()
            m.revision += 1
            audit(
                s,
                "material",
                material_id,
                cur.user_id,
                "Material deleted",
                {},
                dict(deleted=True),
            )
            if m.owner_block_id:
                # The block keeps a guide: its placeholder is created here, in the same
                # write, instead of by the next GET /blocks (GL-05).
                s.flush()
                ensure_block_guide(s, m.owner_block_id)
            s.commit()
            return dict(deleted=True)

    @router.put("/materials/{material_id}/editors", response_model=EditorAssignment)
    def editors(
        material_id: str, payload: Editors, cur: User = Depends(get_current_user)
    ):
        if not access.allowed(cur.user_id, "material.manage_editors"):
            fail(403, "Only the chair and deputies manage material editors")
        if len(set(payload.user_ids)) != len(payload.user_ids):
            fail(422, "Duplicate editors", "duplicate_users")
        with db._session() as s:
            m = row(s, material_id)
            version(m, payload.expected_revision)
            if m.owner_block_id:
                fail(422, "Block guides use block leadership permissions")
            from service_account import refuse_all
            refuse_all(s, payload.user_ids)  # never a role holder (owner, 2026-11-08)
            for uid in payload.user_ids:
                u = s.get(UserORM, uid)
                if not u or u.account_state != "active" or u.banned:
                    fail(422, "Editor must be active and approved", "inactive_user")
            # Per-row deletes (flushed before the new rows, which may repeat a pair the
            # unique index covers): the flush hooks see material editors, not a bulk
            # role-table command that forces every queue and control to be rechecked.
            for editor in s.query(RoleAssignmentORM).filter_by(
                scope_kind="material", scope_id=material_id, role="material_editor"
            ).all():
                s.delete(editor)
            s.flush()
            for uid in payload.user_ids:
                s.add(
                    RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        scope_kind="material",
                        scope_id=material_id,
                        role="material_editor",
                        revision=1,
                    )
                )
            m.revision += 1
            audit(
                s,
                "material_editors",
                material_id,
                cur.user_id,
                "Editors assigned",
                {},
                dict(user_ids=payload.user_ids),
            )
            s.commit()
            return dict(
                material_id=material_id,
                editor_user_ids=payload.user_ids,
                revision=m.revision,
            )

    @router.put(
        "/materials/{material_id}/audience",
        response_model=MaterialOut,
        response_model_exclude_unset=True,
    )
    def set_audience(material_id: str, payload: Audience, cur: User = Depends(get_current_user)):
        """Who reads a block guide; decided by its writers: the block leads and the chair's team."""
        with db._session() as s:
            m = row(s, material_id)
            require_edit(material_id, cur.user_id)
            if m.kind != "guide" or not m.owner_block_id:
                fail(422, "Only a block guide has an audience")
            version(m, payload.expected_revision)
            before = m.audience if m.audience in {"everyone", "leadership"} else "block"
            if before != payload.audience:
                m.audience = payload.audience
                m.revision += 1
                audit(s, "material", material_id, cur.user_id, "Material audience changed",
                      dict(audience=before), dict(audience=payload.audience))
                s.commit()
            return dto(s, m, cur.user_id)

    @router.get("/materials/legacy-guides/{guide_id}")
    def mapping(guide_id: int, cur: User = Depends(get_current_user)):
        """Resolve a bookmarked old identifier using current material visibility."""
        with db._session() as s:
            # The mapping is created at startup; resolving a bookmark never writes (GL-05).
            m = s.query(MaterialORM).filter_by(legacy_guide_id=guide_id).first()
            if not m or m.deleted or not can_read(m.material_id, cur.user_id):
                fail(404, "Guide not found")
            return dict(guide_id=guide_id, material_id=m.material_id, revision=m.revision)
