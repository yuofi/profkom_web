"""GET /materials reads roles and editor lists in batches.

The reference is the same HTTP request with the read UOW's caches switched off
(every per-material role and editor query of the original path). The listing must
be byte-identical for every reader: material editors (one or several), block leads
and members, readers of shared material, the chair's team and a banned account.
GET maps no legacy guide (GL-05): the startup preset maps a new one once and never
re-creates a deleted mapping.
"""
from contextlib import contextmanager

import pytest
from sqlalchemy import event

import read_context
from database import db, engine, GuideORM, RoleAssignmentORM
from domain_models import MaterialORM
from membership import set_membership
from models import Block
from scripts.preset_db import preset_guides


@contextmanager
def uncached(monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(read_context.ReadContext, "usable", lambda self: False)
        yield


@contextmanager
def sql_calls():
    statements = []
    def count(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", count)


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def create(client, actor, publish=True, **fields):
    body = dict(kind="general", title="Материал", description="", content=dict(format="markdown", body="Текст"))
    m = ok(client.post("/api/materials", headers=actor.headers, json={**body, **fields}))
    if publish:
        m = ok(client.post("/api/materials/" + m["material_id"] + "/publish", headers=actor.headers,
                           json=dict(expected_revision=m["revision"])))
    return m


@pytest.fixture
def library(client, superuser, make_user):
    people = {name: make_user() for name in ("first", "second", "reader", "master", "member")}
    people["banned"] = make_user(banned=True)
    for name in ("IT", "Медиа"):
        db.create_block(Block(name=name, master="", is_hr=False))
    blocks = {b["name"]: b for b in ok(client.get("/api/blocks", headers=superuser.headers))}
    ok(client.put("/api/blocks/" + blocks["IT"]["block_id"] + "/leader", headers=superuser.headers,
                  json={"user_id": people["master"].user_id, "expected_revision": blocks["IT"]["revision"]}))
    with db.atomic():
        with db._session() as s:
            set_membership(s, people["member"].user_id, blocks["IT"]["block_id"], True, superuser.user_id, "Synthetic")
    shared = create(client, superuser, title="Общий")
    pair = create(client, superuser, title="Два редактора")
    draft = create(client, superuser, publish=False, title="Черновик")
    for m, editors in ((shared, ["first"]), (pair, ["second", "first"]), (draft, ["first"])):
        ok(client.put("/api/materials/" + m["material_id"] + "/editors", headers=superuser.headers,
                      json=dict(expected_revision=m["revision"], user_ids=[people[n].user_id for n in editors])))
    guides = {item["owner_block_id"]: item for item in ok(client.get("/api/materials", headers=superuser.headers))["items"]
              if item["kind"] == "guide"}
    it_guide = guides[blocks["IT"]["block_id"]]
    ok(client.put("/api/materials/" + it_guide["material_id"] + "/audience", headers=superuser.headers,
                  json=dict(expected_revision=it_guide["revision"], audience="block")))
    with db._session() as s:
        legacy = GuideORM(title="Старый", owner_block="IT", text="Старый текст", description="", original_link=None)
        gone = GuideORM(title="Удалённый", owner_block="none", text="", description="", original_link=None)
        s.add_all([legacy, gone])
        s.commit()
        legacy_id, gone_id = legacy.guide_id, gone.guide_id
    preset_guides()  # the startup preset maps both legacy guides once
    with db._session() as s:
        row = s.query(MaterialORM).filter_by(legacy_guide_id=gone_id).one()
        row.deleted = True
        s.commit()
    return dict(people=people, superuser=superuser, blocks=blocks, legacy_id=legacy_id, gone_id=gone_id)


def readers(w):
    return [w["superuser"], *w["people"].values()]


def test_listing_equals_the_uncached_per_material_path(client, library, monkeypatch):
    w = library
    for actor in readers(w):
        with uncached(monkeypatch):
            expected = client.get("/api/materials", headers=actor.headers)
        r = client.get("/api/materials", headers=actor.headers)
        assert (r.status_code, r.content) == (expected.status_code, expected.content)
    listed = ok(client.get("/api/materials", headers=w["superuser"].headers))["items"]
    editors = {m["title"]: m["editor_user_ids"] for m in listed}
    assert editors["Два редактора"] == [w["people"]["second"].user_id, w["people"]["first"].user_id]
    assert "Черновик" not in {m["title"] for m in ok(client.get("/api/materials", headers=w["people"]["reader"].headers))["items"]}
    assert "Черновик" in {m["title"] for m in ok(client.get("/api/materials", headers=w["people"]["first"].headers))["items"]}


def test_new_legacy_guides_are_mapped_once_by_the_preset_and_deleted_mappings_stay(client, library, monkeypatch):
    w = library
    with db._session() as s:
        fresh = GuideORM(title="Новый старый", owner_block="Медиа", text="Текст", description="", original_link=None)
        s.add(fresh)
        s.commit()
        fresh_id = fresh.guide_id
    first = client.get("/api/materials", headers=w["people"]["reader"].headers)
    with uncached(monkeypatch):
        expected = client.get("/api/materials", headers=w["people"]["reader"].headers)
    assert (first.status_code, first.content) == (expected.status_code, expected.content)
    with db._session() as s:
        assert s.query(MaterialORM).filter_by(legacy_guide_id=fresh_id).count() == 0
    preset_guides()
    preset_guides()
    for actor in (w["people"]["reader"], w["superuser"]):
        first = client.get("/api/materials", headers=actor.headers)
        with uncached(monkeypatch):
            expected = client.get("/api/materials", headers=actor.headers)
        assert (first.status_code, first.content) == (expected.status_code, expected.content)
    assert "Новый старый" in {m["title"] for m in first.json()["items"]}
    with db._session() as s:
        for guide_id in (fresh_id, w["legacy_id"], w["gone_id"]):
            assert s.query(MaterialORM).filter_by(legacy_guide_id=guide_id).count() == 1
        assert s.query(MaterialORM).filter_by(legacy_guide_id=w["gone_id"]).one().deleted


def test_listing_reads_roles_and_mappings_once(client, library):
    w = library
    with sql_calls() as statements:
        ok(client.get("/api/materials", headers=w["superuser"].headers))
    roles = [x for x in statements if "FROM role_assignments" in x]
    mappings = [x for x in statements if "FROM materials" in x and "legacy_guide_id =" in x]
    # The role snapshot, the editor batch and the one original query for two editors.
    assert len(roles) <= 3, roles
    assert not mappings, mappings
    with db._session() as s:
        assert s.query(RoleAssignmentORM).filter_by(scope_kind="material", role="material_editor").count() == 4
