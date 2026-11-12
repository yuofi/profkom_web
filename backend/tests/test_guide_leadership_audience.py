"""Leadership guides follow current roles, including attachment and legacy routes."""
import uuid

import pytest

from database import db, BlockORM, RoleAssignmentORM, UserORM
from domain_models import MaterialORM
from models import Block
from test_guide_audience import guide, listed
from test_service_account import configured, service as service_headers  # noqa: F401


def assign(actor, scope, role, scope_id="synthetic-scope"):
    rid = str(uuid.uuid4())
    with db._session() as s:
        s.add(RoleAssignmentORM(role_assignment_id=rid, user_id=actor.user_id,
                               scope_kind=scope, scope_id=scope_id, role=role, revision=1))
        s.commit()
    return rid


def leadership_guide(client, superuser, make_guide):
    with db._session() as s:
        has_owner = s.get(BlockORM, "Медиа") is not None
    if not has_owner:
        db.create_block(Block(name="Медиа", master="", is_hr=False))
    mid, old = guide(client, superuser.headers, make_guide)
    current = client.get(f"/api/materials/{mid}", headers=superuser.headers).json()
    result = client.put(f"/api/materials/{mid}/audience", headers=superuser.headers,
                        json={"audience": "leadership", "expected_revision": current["revision"]})
    assert result.status_code == 200, result.text
    assert result.json()["audience"] == "leadership"
    return mid, old


@pytest.mark.parametrize("scope,role", [
    ("block", "master"), ("block", "deputy_master"),
    ("event", "event_leader"), ("event", "deputy_event_leader"),
    ("subevent", "subevent_leader"), ("subevent", "deputy_subevent_leader"),
])
def test_current_lead_reads_and_loses_access_on_revocation(client, superuser, make_user, make_guide, scope, role):
    actor = make_user()
    mid, old = leadership_guide(client, superuser, make_guide)
    rid = assign(actor, scope, role)
    for path in (f"/api/materials/{mid}", f"/api/materials/legacy-guides/{old.guide_id}"):
        assert client.get(path, headers=actor.headers).status_code == 200
    assert listed(client, actor, mid)
    with db._session() as s:
        s.delete(s.get(RoleAssignmentORM, rid)); s.commit()
    for path in (f"/api/materials/{mid}", f"/api/materials/legacy-guides/{old.guide_id}"):
        assert client.get(path, headers=actor.headers).status_code == 404
    assert not listed(client, actor, mid)


def test_chair_deputy_and_service_access_but_not_members_queue_owners_or_editors(client, superuser, make_user, make_block, make_guide, configured):
    deputy, member, owner, editor = [make_user() for _ in range(4)]
    db.set_chair_deputies([deputy.user_id])
    make_block(arr_of_human=[member.user_id])
    mid, _ = leadership_guide(client, superuser, make_guide)
    assign(owner, "queue", "queue_owner")
    assign(editor, "material", "material_editor", mid)
    for actor in (superuser, deputy):
        assert client.get(f"/api/materials/{mid}", headers=actor.headers).status_code == 200
    for actor in (member, owner, editor):
        assert client.get(f"/api/materials/{mid}", headers=actor.headers).status_code == 404
        assert not listed(client, actor, mid)
        assert client.patch(f"/api/materials/{mid}", headers=actor.headers,
                            json={"title": "Hidden", "expected_revision": 2}).status_code == 404
    _, headers = service_headers(client)
    assert client.get(f"/api/materials/{mid}", headers=headers).status_code == 200
    db.set_chair_deputies([])
    assert client.get(f"/api/materials/{mid}", headers=deputy.headers).status_code == 404


def test_attachment_policy_rechecks_role_and_active_state(client, superuser, make_user, make_guide):
    from types import SimpleNamespace
    from file_access import permitted
    actor = make_user()
    mid, _ = leadership_guide(client, superuser, make_guide)
    rid = assign(actor, "event", "event_leader")
    file = SimpleNamespace(owner_kind="material", owner_id=mid, file_id="file-example")
    with db._session() as s:
        s.get(MaterialORM, mid).published_body = "[File](file:file-example)"; s.commit()
    with db._session() as s:
        assert permitted(s, file, actor.user_id)
        assert not permitted(s, file, actor.user_id, write=True)
        s.get(UserORM, actor.user_id).banned = True; s.commit()
    with db._session() as s:
        assert not permitted(s, file, actor.user_id)
        s.get(UserORM, actor.user_id).banned = False
        s.delete(s.get(RoleAssignmentORM, rid)); s.commit()
    with db._session() as s:
        assert not permitted(s, file, actor.user_id)


def test_published_file_http_and_draft_file_remain_private_after_role_revocation(
    client, superuser, make_user, make_guide, mock_s3,
):
    from test_file_delivery import upload, PDF

    actor = make_user()
    mid, _ = leadership_guide(client, superuser, make_guide)
    rid = assign(actor, "subevent", "deputy_subevent_leader")
    public_file = upload(client, superuser, mock_s3, "material", mid)
    draft_file = upload(client, superuser, mock_s3, "material", mid, name="draft.pdf")
    current = client.get(f"/api/materials/{mid}", headers=superuser.headers).json()
    saved = client.patch(f"/api/materials/{mid}", headers=superuser.headers, json={
        "expected_revision": current["revision"],
        "content": {"format": "markdown", "body": f"[Published](file:{public_file})"},
    })
    assert saved.status_code == 200, saved.text
    published = client.post(f"/api/materials/{mid}/publish", headers=superuser.headers,
                            json={"expected_revision": saved.json()["revision"]})
    assert published.status_code == 200, published.text
    draft = client.patch(f"/api/materials/{mid}", headers=superuser.headers, json={
        "expected_revision": published.json()["revision"],
        "content": {"format": "markdown", "body": f"[Draft](file:{draft_file})"},
    })
    assert draft.status_code == 200, draft.text
    assert client.get(f"/api/files/{public_file}/content", headers=actor.headers).content == PDF
    assert client.get(f"/api/files/{public_file}/download", headers=actor.headers).status_code == 200
    for endpoint in ("content", "download"):
        assert client.get(f"/api/files/{draft_file}/{endpoint}", headers=actor.headers).status_code == 404
    assert client.get(f"/api/files/{draft_file}/content", headers=superuser.headers).content == PDF

    with db._session() as s:
        s.delete(s.get(RoleAssignmentORM, rid)); s.commit()
    # The exact previously successful byte URL and metadata URL lose access immediately.
    for endpoint in ("content", "download"):
        assert client.get(f"/api/files/{public_file}/{endpoint}", headers=actor.headers).status_code == 404


def test_archived_block_lead_does_not_keep_leadership_audience(
    client, superuser, make_master, make_guide,
):
    from domain_models import BlockMetaORM
    from registration import now
    import access

    actor, block = make_master()
    mid, _ = leadership_guide(client, superuser, make_guide)
    assert client.get(f"/api/materials/{mid}", headers=actor.headers).status_code == 200
    before = access.scope_access_revision(actor.user_id)
    with db._session() as s:
        # Archival intentionally preserves the old roster/roles for historical objects.
        meta = s.query(BlockMetaORM).filter_by(legacy_name=block.name).one()
        meta.archived_at = now(); s.commit()
    assert access.scope_access_revision(actor.user_id) != before
    assert client.get(f"/api/materials/{mid}", headers=actor.headers).status_code == 404
    assert not listed(client, actor, mid)


def test_cached_rich_guide_rechecks_leadership_and_editor_on_every_route(
    client, superuser, make_user, make_guide, monkeypatch,
):
    import guide_embeds
    import material_render
    from settings import settings

    monkeypatch.setattr(settings, "GUIDE_HTML_EMBEDS_ENABLED", True)
    monkeypatch.setattr(guide_embeds, "compile_bounded", guide_embeds.compile_content)
    actor = make_user()
    mid, old = leadership_guide(client, superuser, make_guide)
    rid = assign(actor, "event", "event_leader")
    # A legacy editor assignment must not override the audience after demotion.
    assign(actor, "material", "material_editor", mid)
    source = '```profkom-html id=embed-private\n<section><h2>Private guide</h2><p>Leadership only</p></section>\n```'
    current = client.get(f"/api/materials/{mid}", headers=superuser.headers).json()
    saved = client.patch(f"/api/materials/{mid}", headers=superuser.headers, json={
        "expected_revision": current["revision"],
        "content": {"format": "markdown-embeds-v1", "body": source},
    })
    assert saved.status_code == 200, saved.text
    published = client.post(f"/api/materials/{mid}/publish", headers=superuser.headers,
                            json={"expected_revision": saved.json()["revision"]})
    assert published.status_code == 200, published.text
    material_render.clear_cache()
    for _ in range(2):
        response = client.get(f"/api/materials/{mid}", headers=actor.headers)
        assert response.status_code == 200, response.text
        assert response.json()["published_content"]["render"]["blocks"]
    version = published.json()["revision"]
    with db._session() as s:
        s.delete(s.get(RoleAssignmentORM, rid)); s.commit()
    for path in (f"/api/materials/{mid}", f"/api/materials/legacy-guides/{old.guide_id}"):
        assert client.get(path, headers=actor.headers).status_code == 404
    assert not listed(client, actor, mid)
    commands = (
        ("post", "preview", {"content": {"format": "markdown-embeds-v1", "body": source}}),
        ("post", "publish", {}),
        ("put", "audience", {"audience": "everyone"}),
    )
    for method, endpoint, payload in commands:
        response = client.request(method, f"/api/materials/{mid}/{endpoint}", headers=actor.headers,
                                  json={"expected_revision": version, **payload})
        assert response.status_code == 404, response.text
    deleted = client.request("delete", f"/api/materials/{mid}", headers=actor.headers,
                             json={"expected_revision": version})
    assert deleted.status_code == 404, deleted.text
