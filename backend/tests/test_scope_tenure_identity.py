from datetime import datetime, timedelta, timezone

from database import db
from domain_models import ScopeTenureORM
from participation import in_scope_at, record_roster
from models import Block
from test_v13_tracker import work


def test_new_observation_closes_unproved_history_and_reused_name_grants_no_authority(client, work, superuser):
    uid, bid = work["master"].user_id, work["block"]["block_id"]
    with db._session() as session:
        session.query(ScopeTenureORM).filter_by(user_id=uid, scope_kind="block").delete()
        session.add(ScopeTenureORM(tenure_id="legacy-unproved", user_id=uid, scope_kind="block", scope_id="IT",
            role="master", principal_id=None, started_at="2020-01-01T00:00:00+00:00", ended_at=None))
        session.flush()
        assert not in_scope_at(session, uid, "block", "IT", "2021-01-01T00:00:00+00:00")
        record_roster(session, "block", "IT")
        session.commit()
        old = session.get(ScopeTenureORM, "legacy-unproved")
        fresh = session.query(ScopeTenureORM).filter_by(scope_block_id=bid, ended_at=None).one()
        assert old.started_at == "2020-01-01T00:00:00+00:00" and old.scope_id == "IT" and old.scope_block_id is None
        assert old.ended_at == fresh.started_at
        since = fresh.started_at
    card = client.get(f"/api/blocks/{bid}", headers=superuser.headers).json()
    renamed = client.patch(f"/api/blocks/{bid}", headers=superuser.headers,
        json={"expected_revision": card["revision"], "name": "Proven identity"})
    assert renamed.status_code == 200, renamed.text
    db.create_block(Block(name="IT", master=""))
    reused = client.get("/api/blocks/IT", headers=superuser.headers)
    assert reused.status_code == 200 and reused.json()["block_id"] != bid
    with db._session() as session:
        future = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
        assert not in_scope_at(session, uid, "block", "IT", future)
        assert in_scope_at(session, uid, "block", "Proven identity", future)
        fresh = session.query(ScopeTenureORM).filter_by(scope_block_id=bid, ended_at=None).one()
        assert fresh.started_at == since and fresh.scope_id == "IT"
        old = session.get(ScopeTenureORM, "legacy-unproved")
        assert old.scope_id == "IT" and old.scope_block_id is None and old.ended_at == since
