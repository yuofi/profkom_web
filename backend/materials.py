"""Material drafts, publication, per-object editors and legacy-guide adapters."""

import json, re, uuid
from typing import Literal
from pydantic import Field
from fastapi import Depends, HTTPException
from database import db, GuideORM, RoleAssignmentORM, UserORM
from domain_models import MaterialORM, BlockMetaORM
from models import User
from auth import get_current_user
from registration import Revision, audit, now, version, fail
import access
from validation import Command
from api_contract import Page
from domain_contract import Material as MaterialOut, EditorAssignment


class RichText(Command):
    format: Literal["markdown"] = "markdown"
    body: str


class Create(Command):
    kind: Literal["guide", "general", "kmb"]
    owner_block_id: str | None = None
    title: str
    description: str = ""
    content: RichText
    original_link: str | None = None


class Patch(Revision):
    title: str | None = None
    description: str | None = None
    content: RichText | None = None
    original_link: str | None = None


class Editors(Revision):
    user_ids: list[int]


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
    return access.allowed(uid, "material.edit", "material", id)


def can_read(id, uid):
    u = db.get_user(uid)
    if not u or u.account_state != "active" or u.banned:
        return False
    with db._session() as s:
        m = s.get(MaterialORM, id)
        return bool(
            m and not m.deleted and (m.published_body is not None or can_edit(id, uid))
        )


def stored(s, body, material_id, published):
    """Text to store: no new links into the bucket, own attachments as file:<id> (0.2)."""
    from legacy_files import bucket_keys, own_attachments, stored_text

    return stored_text(body, own_attachments(s, material_id), bucket_keys(published))


def dto(s, m, uid):
    from legacy_files import read_text

    edit = can_edit(m.material_id, uid)
    draft = edit and m.has_draft
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
            dict(format="markdown", body=read_text(m.published_body))
            if m.published_body is not None
            else None
        ),
        revision=m.revision,
        capabilities=[],
    )
    if edit:
        data["capabilities"] += ["edit_material", "publish_material", "delete_material"]
        if draft:
            data["draft_content"] = dict(format="markdown", body=m.draft_body or "")
        # The editor always starts from the stored text, never from signed links (A-MAT-1).
        data["source_content"] = dict(
            format="markdown",
            body=(m.draft_body or "") if m.has_draft else (m.published_body or ""),
        )
    if access.allowed(uid, "material.manage_editors"):
        data["capabilities"].append("manage_material_editors")
        data["editor_user_ids"] = [
            r.user_id
            for r in s.query(RoleAssignmentORM).filter_by(
                scope_kind="material", scope_id=m.material_id, role="material_editor"
            )
        ]
    return data


def deleted_dto(m):
    return dict(
        material_id=m.material_id,
        kind=m.kind,
        owner_block_id=m.owner_block_id,
        title=m.title,
        description=m.description,
        original_link=m.original_link,
        published_content=None,
        revision=m.revision,
        capabilities=["restore_material"],
    )


def block_material_id(s, bid):
    from material_seed import seed_materials

    # New blocks are not created through HTTP; this also supports isolated fixtures.
    m = (
        s.query(MaterialORM)
        .filter_by(owner_block_id=bid, deleted=False)
        .order_by(MaterialORM.placeholder, MaterialORM.created_at)
        .first()
    )
    if not m:
        meta = s.get(BlockMetaORM, bid)
        m = MaterialORM(
            material_id=str(uuid.uuid4()),
            kind="guide",
            owner_block_id=bid,
            title="Гайд " + meta.legacy_name,
            description="Материалы блока",
            published_body="Материалы блока готовятся. Обратитесь к мастеру.",
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

        m.draft_body = stored(s, m.draft_body, m.material_id, m.published_body)
        ids = re.findall(r"file:(file-[\w-]+)", m.draft_body or "")
        check_attachments(s, list(dict.fromkeys(ids)), "material", m.material_id, uid)
        if not (m.draft_body or "").strip() and not m.draft_original_link:
            fail(422, "Material content or original link is required")
        m.title = m.draft_title or m.title
        m.description = m.draft_description or ""
        m.original_link = m.draft_original_link
        m.published_body = m.draft_body or ""
        m.has_draft = False
        m.draft_body = None
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


def guide_text(g, m):
    """What the old guide screens show: the material's Markdown, never the raw old
    source, which may be HTML (A-MAT-14)."""
    from legacy_files import read_text
    from legacy_markup import to_markdown

    if m.published_body is not None:
        return read_text(m.published_body)
    return read_text(to_markdown(g.text or ""))


def guide_dto(g, uid):
    with db._session() as s:
        m = legacy_mapping(s, g.guide_id)
        if m.deleted or not can_read(m.material_id, uid):
            fail(404, "Guide not found")
        s.commit()
        return dict(
            guide_id=g.guide_id,
            title=g.title,
            owner_block=g.owner_block,
            text=guide_text(g, m),
            description=g.description,
            original_link=g.original_link,
            material_id=m.material_id,
            revision=m.revision,
            capabilities=dto(s, m, uid)["capabilities"],
        )


def register_routes(router):
    @router.get(
        "/materials",
        response_model=Page[MaterialOut],
        response_model_exclude_unset=True,
    )
    def listing(cur: User = Depends(get_current_user)):
        with db._session() as s:
            for g in s.query(GuideORM):
                legacy_mapping(s, g.guide_id)
            s.commit()
            return Page(
                items=[
                    dto(s, m, cur.user_id)
                    for m in s.query(MaterialORM)
                    .filter_by(deleted=False)
                    .order_by(MaterialORM.created_at)
                    if can_read(m.material_id, cur.user_id)
                ],
                next_cursor=None,
            )

    @router.get("/materials/deleted", response_model=Page[MaterialOut])
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
            m.deleted = False
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
            return dto(s, m, cur.user_id)

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
        with db._session() as s:
            if payload.owner_block_id:
                meta = s.get(BlockMetaORM, payload.owner_block_id)
                if not meta:
                    fail(404, "Block not found")
                allowed = access.allowed(cur.user_id, "material.create_guide", "block", meta.legacy_name)
            else:
                allowed = access.allowed(cur.user_id, "material.create_general")
            if not allowed:
                fail(403, "Material creator required")
            if payload.original_link and not payload.original_link.startswith(
                ("https://", "http://")
            ):
                fail(422, "Invalid original link")
            body = stored(s, payload.content.body, None, None)
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
                has_draft=True,
                revision=1,
                placeholder=False,
                deleted=False,
                created_at=now(),
            )
            s.add(m)
            s.flush()
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
        with db._session() as s:
            m = row(s, material_id)
            if not can_edit(material_id, cur.user_id):
                fail(403, "Material editor required")
            version(m, payload.expected_revision)
            if not m.has_draft:
                m.draft_title = m.title
                m.draft_description = m.description
                m.draft_original_link = m.original_link
                m.draft_body = m.published_body or ""
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
            if payload.content is not None:
                m.draft_body = stored(
                    s, payload.content.body, material_id, m.published_body
                )
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
        with db._session() as s:
            m = row(s, material_id)
            if not can_edit(material_id, cur.user_id):
                fail(403, "Material editor required")
            version(m, payload.expected_revision)
            return publish(s, m, cur.user_id)

    @router.delete("/materials/{material_id}")
    def remove(material_id: str, cur: User = Depends(get_current_user)):
        with db._session() as s:
            m = row(s, material_id)
            if not can_edit(material_id, cur.user_id):
                fail(403, "Material editor required")
            m.deleted = True
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
            for uid in payload.user_ids:
                u = s.get(UserORM, uid)
                if not u or u.account_state != "active" or u.banned:
                    fail(422, "Editor must be active and approved", "inactive_user")
            s.query(RoleAssignmentORM).filter_by(
                scope_kind="material", scope_id=material_id, role="material_editor"
            ).delete(synchronize_session=False)
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

    @router.get("/guides/{guide_id}/material")
    def mapping(guide_id: int, cur: User = Depends(get_current_user)):
        with db._session() as s:
            m = legacy_mapping(s, guide_id)
            if m.deleted:
                fail(404, "Guide not found")
            s.commit()
            return dict(
                guide_id=guide_id, material_id=m.material_id, revision=m.revision
            )


def legacy_create(payload, uid):
    from membership import legacy_name
    from domain_seed import meta_for
    from database import BlockORM

    with db._session() as s:
        owner = (payload.owner_block or "none").strip()
        if owner.lower() not in ("none", "all", ""):
            name = legacy_name(owner)
            if not access.allowed(uid, "material.create_guide", "block", name):
                fail(403, "Owning block editor required")
            owner = name
        elif not access.allowed(uid, "material.create_general"):
            fail(403, "Global material creator required")
        if payload.original_link and not payload.original_link.startswith(
            ("http://", "https://")
        ):
            fail(422, "Invalid original link")
        stored(s, payload.text, None, None)
        if re.search(r"file:file-[\w-]+", payload.text or ""):
            # A new guide owns no files yet; they are attached in the material editor (A-MAT-8).
            fail(422, "A new guide cannot reference files; attach them in the material editor")
        g = GuideORM(
            title=payload.title,
            owner_block=owner,
            text=payload.text or "",
            description=payload.description or "",
            original_link=payload.original_link,
        )
        s.add(g)
        s.flush()
        m = legacy_mapping(s, g.guide_id)
        if not (payload.text or "").strip() and not payload.original_link:
            m.published_body = None
            m.draft_body = ""
            m.draft_title = m.title
            m.draft_description = m.description
            m.has_draft = True
        audit(
            s,
            "material",
            m.material_id,
            uid,
            "Legacy guide published",
            {},
            dict(revision=m.revision),
        )
        s.commit()
        return guide_dto(db.get_guide(g.guide_id), uid)


def legacy_update(guide_id, payload, uid):
    with db._session() as s:
        m = legacy_mapping(s, guide_id)
        if m.deleted:
            fail(404, "Guide not found")
        if not can_edit(m.material_id, uid):
            fail(403, "Material editor required")
        if payload.expected_revision is None:
            fail(409, "Open the mapped material or send expected_revision")
        version(m, payload.expected_revision)
        if m.has_draft:
            fail(409, "A shared draft exists; continue in the material editor")
        g = s.get(GuideORM, guide_id)
        if payload.owner_block is not None and payload.owner_block != g.owner_block:
            fail(422, "Material ownership cannot be changed through legacy guide save")
        from legacy_markup import to_markdown

        m.draft_title = payload.title if payload.title is not None else m.title
        m.draft_description = (
            payload.description if payload.description is not None else m.description
        )
        m.draft_original_link = (
            payload.original_link
            if "original_link" in payload.model_fields_set
            else m.original_link
        )
        if m.draft_original_link and not m.draft_original_link.startswith(
            ("http://", "https://")
        ):
            fail(422, "Invalid original link")
        # The text as it was shown comes back unchanged: it is not converted again (A-MAT-4).
        m.draft_body = (
            to_markdown(payload.text)
            if payload.text is not None and payload.text not in (g.text, guide_text(g, m))
            else m.published_body or ""
        )
        m.has_draft = True
        m.revision += 1
        publish(s, m, uid)
        return guide_dto(db.get_guide(guide_id), uid)


def legacy_delete(guide_id, uid):
    with db._session() as s:
        m = legacy_mapping(s, guide_id)
        if m.deleted:
            fail(404, "Guide not found")
        if not can_edit(m.material_id, uid):
            fail(403, "Material editor required")
        m.deleted = True
        m.revision += 1
        audit(
            s,
            "material",
            m.material_id,
            uid,
            "Legacy guide deleted",
            {},
            dict(deleted=True),
        )
        s.commit()
        return dict(deleted=True)
