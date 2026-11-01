"""GET only reads (GL-05): roster memberships, block guides, old guide mappings and
registration applications are created by their writers and the startup preset."""
import json
from contextlib import contextmanager

from sqlalchemy import event

from database import db, engine, BlockORM, GuideORM
from domain_models import MaterialORM, MembershipORM, RegistrationORM
from models import Block, Guide


@contextmanager
def writes():
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().split(" ", 1)[0].upper() in {"INSERT", "UPDATE", "DELETE", "REPLACE"}:
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


def block_id(name):
    from membership import block_id_for
    return block_id_for(name)


def guides(bid):
    with db._session() as s:
        return s.query(MaterialORM).filter_by(owner_block_id=bid, deleted=False).all()


def test_diverged_legacy_state_is_not_repaired_by_gets(client, superuser, make_user):
    from scripts.preset_db import preset_blocks

    legacy = make_user(in_profcom=True)
    db.create_block(Block(name="Legacy roster", master=""))
    bid = block_id("Legacy roster")
    with db.atomic():
        with db._session() as s:
            # State of an older version: a roster row without membership, a block without a
            # guide, an unmapped old guide and an account without an application.
            s.get(BlockORM, "Legacy roster").arr_of_human = json.dumps([legacy.user_id])
            s.query(MaterialORM).filter_by(owner_block_id=bid).delete()
            s.query(RegistrationORM).filter_by(user_id=legacy.user_id).delete()
            s.add(GuideORM(title="Unmapped", owner_block="none", text="Старый текст", description=""))
            s.commit()
    with db._session() as s:
        guide_id = s.query(GuideORM).filter_by(title="Unmapped").one().guide_id
    with writes() as statements:
        blocks = client.get("/api/blocks", headers=superuser.headers)
        card = client.get(f"/api/blocks/{bid}", headers=superuser.headers)
        listing = client.get("/api/materials", headers=superuser.headers)
        resolved = client.get(f"/api/materials/legacy-guides/{guide_id}", headers=superuser.headers)
        session = client.get("/api/session", headers=legacy.headers)
        own = client.get("/api/registrations/me", headers=legacy.headers)
    assert statements == []
    assert blocks.status_code == card.status_code == listing.status_code == 200
    assert card.json()["guide_material_id"] is None and card.json()["members"] == []
    assert resolved.status_code == 404
    assert session.status_code == 200 and own.status_code == 200
    assert own.json()["status"] == "approved" and own.json()["revision"] == 1
    with db._session() as s:
        assert s.query(MembershipORM).filter_by(user_id=legacy.user_id, block_id=bid).count() == 0
        assert s.get(RegistrationORM, legacy.user_id) is None
    # The startup preset repairs the same state, once.
    preset_blocks()
    preset_blocks()
    with db._session() as s:
        assert s.query(MembershipORM).filter_by(user_id=legacy.user_id, block_id=bid, left_at=None).count() == 1
    assert len(guides(bid)) == 1 and guides(bid)[0].placeholder
    card = client.get(f"/api/blocks/{bid}", headers=superuser.headers).json()
    assert card["guide_material_id"] == guides(bid)[0].material_id
    assert [m["user"]["user_id"] for m in card["members"]] == [legacy.user_id]


def test_roster_writers_seed_memberships_in_their_own_transaction(client, superuser, make_user):
    first, second = make_user(in_profcom=True), make_user(in_profcom=True)
    db.create_block(Block(name="Roster writer", master="", arr_of_human=[first.user_id]))
    db.enter_user_to_block(second.user_id, "Roster writer")
    bid = block_id("Roster writer")
    with db._session() as s:
        members = {m.user_id for m in s.query(MembershipORM).filter_by(block_id=bid, left_at=None)}
    assert members == {first.user_id, second.user_id}
    # A new block already has its identity and guide placeholder.
    assert len(guides(bid)) == 1
    with writes() as statements:
        card = client.get(f"/api/blocks/{bid}", headers=superuser.headers).json()
    assert statements == []
    assert {m["user"]["user_id"] for m in card["members"]} == members


def test_deleting_the_block_guide_leaves_one_placeholder_created_by_the_delete(client, superuser):
    db.create_block(Block(name="Guide delete", master=""))
    bid = block_id("Guide delete")
    original = client.get(f"/api/blocks/{bid}", headers=superuser.headers).json()["guide_material_id"]
    material = client.get(f"/api/materials/{original}", headers=superuser.headers).json()
    removed = client.request("DELETE", f"/api/materials/{original}", headers=superuser.headers,
                             json=dict(expected_revision=material["revision"]))
    assert removed.status_code == 200, removed.text
    live = guides(bid)
    assert len(live) == 1 and live[0].material_id != original and live[0].placeholder
    with writes() as statements:
        ids = {client.get("/api/blocks", headers=superuser.headers).json()[0]["guide_material_id"] for _ in range(3)}
    assert statements == []
    assert len(guides(bid)) == 1
    assert client.get(f"/api/blocks/{bid}", headers=superuser.headers).json()["guide_material_id"] == live[0].material_id
    assert ids


def test_startup_preset_removes_only_untouched_duplicate_placeholders(client, superuser):
    from scripts.preset_db import preset_blocks
    from domain_seed import now

    db.create_block(Block(name="Duplicates", master=""))
    bid = block_id("Duplicates")
    keep = guides(bid)[0].material_id
    def add(material_id, **edited):
        with db.atomic():
            with db._session() as s:
                s.add(MaterialORM(material_id=material_id, kind="guide", owner_block_id=bid,
                    title="Гайд Duplicates", description="Материалы блока", published_body="x",
                    has_draft=edited.get("has_draft", False), revision=edited.get("revision", 1),
                    placeholder=True, deleted=False, created_at=now()))
                s.commit()

    add("duplicate-0")
    add("duplicate-1")
    preset_blocks()
    preset_blocks()
    # Concurrent GETs of older versions left copies: the oldest untouched one stays.
    assert {m.material_id for m in guides(bid)} == {keep}
    add("duplicate-2")
    add("duplicate-edited", has_draft=True, revision=2)
    preset_blocks()
    # A placeholder someone already edited is kept; untouched copies go.
    assert {m.material_id for m in guides(bid)} == {"duplicate-edited"}


def test_imported_old_guide_is_mapped_by_the_preset_not_by_a_get(client, superuser):
    from scripts.preset_db import preset_guides

    guide = db.create_guide(Guide(guide_id=0, title="Imported", owner_block="none", text="Текст"))
    assert client.get(f"/api/materials/legacy-guides/{guide.guide_id}", headers=superuser.headers).status_code == 404
    preset_guides()
    mapped = client.get(f"/api/materials/legacy-guides/{guide.guide_id}", headers=superuser.headers)
    assert mapped.status_code == 200
    assert mapped.json()["material_id"] in {m["material_id"] for m in client.get("/api/materials", headers=superuser.headers).json()["items"]}


def test_a_legacy_block_without_identity_is_read_without_writing_it(client, superuser):
    import uuid
    from scripts.preset_db import preset_blocks
    from domain_models import BlockMetaORM

    with db.atomic():
        with db._session() as s:
            # A block row of an older version, before block identities existed.
            s.add(BlockORM(name="No identity", master=""))
            s.commit()
    derived = str(uuid.uuid5(uuid.NAMESPACE_URL, "profkom:block:No identity"))
    with writes() as statements:
        listed = client.get("/api/blocks", headers=superuser.headers)
        card = client.get("/api/blocks/No identity", headers=superuser.headers)
    assert statements == []
    assert listed.status_code == card.status_code == 200, card.text
    assert [b["block_id"] for b in listed.json() if b["name"] == "No identity"] == [derived]
    assert card.json()["block_id"] == derived and card.json()["revision"] == 1
    with db._session() as s:
        assert s.query(BlockMetaORM).filter_by(legacy_name="No identity").first() is None
    # The startup preset makes the same identity, once.
    preset_blocks()
    preset_blocks()
    with db._session() as s:
        assert [m.block_id for m in s.query(BlockMetaORM).filter_by(legacy_name="No identity")] == [derived]
    assert client.get(f"/api/blocks/{derived}", headers=superuser.headers).json()["block_id"] == derived
