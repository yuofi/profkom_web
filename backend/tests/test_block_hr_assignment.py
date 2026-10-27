import os
import sqlite3
import subprocess
import sys

import pytest

from database import db, UserORM, AuditLogORM
from domain_models import BlockMetaORM, MembershipORM
from models import Block


def card(client, actor, name="Target"):
    return client.get(f"/api/blocks/{name}", headers=actor.headers).json()


def assign(client, actor, block, user_id, revision=None):
    return client.put(f"/api/blocks/{block['block_id']}/hr", headers=actor.headers,
                      json={"user_id": user_id, "expected_revision": revision or block["revision"]})


def test_explicit_hr_assignment_is_audited_revisioned_and_not_membership(client, superuser, make_user):
    curator = make_user()
    db.create_block(Block(name="Target", master="", hr=curator.kkr_name))
    block = card(client, superuser)
    assert block["hr"] is None  # A legacy display name is never an identity mapping.
    assert "assign_block_hr" in block["capabilities"]
    result = assign(client, superuser, block, curator.user_id)
    assert result.status_code == 200, result.text
    updated = result.json()
    assert updated["hr"]["user_id"] == curator.user_id
    assert updated["revision"] == block["revision"] + 1
    assert updated["members"] == []
    assert not db.is_block_member(curator.user_id, "Target")
    same = assign(client, superuser, updated, curator.user_id)
    assert same.status_code == 200 and same.json()["revision"] == updated["revision"]
    with db._session() as session:
        assert session.get(BlockMetaORM, block["block_id"]).hr_user_id == curator.user_id
        assert session.query(MembershipORM).filter_by(user_id=curator.user_id).count() == 0
        assert session.query(AuditLogORM).filter_by(target_kind="block_hr").count() == 1
    stale = assign(client, superuser, updated, None, revision=block["revision"])
    assert stale.status_code == 409
    assert card(client, superuser)["hr"]["user_id"] == curator.user_id


def test_hr_master_can_assign_replace_and_clear(client, superuser, make_hr, make_user):
    hr_master, _ = make_hr(block_name="HR")
    first, second = make_user(), make_user()
    db.create_block(Block(name="Target", master=""))
    block = card(client, hr_master)
    for target in [first.user_id, second.user_id, None]:
        response = assign(client, hr_master, block, target)
        assert response.status_code == 200, response.text
        block = response.json()
        assert (block["hr"] or {}).get("user_id") == target


def test_ordinary_block_lead_member_and_curator_cannot_assign_hr(client, superuser, make_user):
    master, member, curator = make_user(), make_user(), make_user()
    db.create_block(Block(name="Target", master="", arr_of_human=[member.user_id]))
    db.set_block_leader("Target", master.user_id)
    block = assign(client, superuser, card(client, superuser), curator.user_id).json()
    for actor in [master, member, curator]:
        assert "assign_block_hr" not in card(client, actor)["capabilities"]
        response = assign(client, actor, block, actor.user_id)
        assert response.status_code == 403
    assert card(client, superuser)["revision"] == block["revision"]


@pytest.mark.parametrize("state", ["pending", "archived", "banned", "missing"])
def test_invalid_hr_target_does_not_change_assignment_or_audit(client, superuser, make_user, state):
    db.create_block(Block(name="Target", master=""))
    target = make_user()
    with db._session() as session:
        user = session.get(UserORM, target.user_id)
        if state == "banned":
            user.banned = True
        elif state != "missing":
            user.account_state = state
        session.commit()
    block = card(client, superuser)
    response = assign(client, superuser, block, 2147483647 if state == "missing" else target.user_id)
    assert response.status_code == (422 if state == "missing" else 409), response.text
    assert card(client, superuser)["revision"] == block["revision"]
    with db._session() as session:
        assert session.query(AuditLogORM).filter_by(target_kind="block_hr").count() == 0


def test_existing_metadata_migration_is_nullable_idempotent_and_preserves_legacy_text(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as connection:
        connection.execute("create table block_metadata (block_id varchar primary key, legacy_name varchar not null unique, description text not null, community_url varchar, avatar_file_id varchar, revision integer not null)")
        connection.execute("insert into block_metadata values ('stable-id','Legacy','Kept markdown',null,null,7)")
    env = {**os.environ, "DATABASE_PATH": str(path), "APP_ENV": "test"}
    code = "import database; database._ensure_sqlite_block_hr_assignment_column()"
    for _ in range(2):
        process = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
        assert process.returncode == 0, process.stderr
        with sqlite3.connect(path) as connection:
            columns = {row[1]: row for row in connection.execute("pragma table_info(block_metadata)")}
            assert columns["hr_user_id"][3] == 0
            assert connection.execute("select block_id,legacy_name,description,revision,hr_user_id from block_metadata").fetchone() == ("stable-id", "Legacy", "Kept markdown", 7, None)
