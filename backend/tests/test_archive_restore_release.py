import json

import pytest

from database import db, RoleAssignmentORM
from domain_models import AccountArchiveORM, FormerContactORM, ScopeTenureORM
from models import Block
from test_v13_tracker import work


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def leader_context(client, chair, work, kind):
    sid = work["season"]["season_id"]
    if kind == "block":
        path, field = f"/api/blocks/{work['block']['block_id']}", "master"
    else:
        event = ok(client.post("/api/events", headers=chair.headers,
            json={"season_id": sid, "title": "Restore event", "description": ""}))
        event = ok(client.put(f"/api/events/{event['event_id']}/leaders", headers=chair.headers,
            json={"expected_revision": event["revision"], "user_ids": [work["master"].user_id]}))
        if kind == "event":
            path = f"/api/events/{event['event_id']}"
        else:
            sub = ok(client.post(f"/api/events/{event['event_id']}/subevents", headers=chair.headers,
                json={"title": "Restore team", "description": ""}))
            ok(client.put(f"/api/subevents/{sub['subevent_id']}/leaders", headers=chair.headers,
                json={"expected_revision": sub["revision"], "user_ids": [work["master"].user_id]}))
            path = f"/api/subevents/{sub['subevent_id']}"
        field = "leaders"
    def current():
        data = ok(client.get(path, headers=chair.headers))
        return data[field] if field == "master" else data[field][0]
    return current


@pytest.mark.parametrize("kind", ["block", "event", "subevent"])
def test_restoring_deputy_advances_principal_revision_and_rejects_old_roster(client, work, superuser, make_user, kind):
    deputy, other = make_user(password=None), make_user(password=None)
    current = leader_context(client, superuser, work, kind)
    principal = current()
    ok(client.put(f"/api/role-assignments/{principal['role_assignment_id']}/deputies", headers=superuser.headers,
        json={"expected_revision": principal["revision"], "user_ids": [deputy.user_id, other.user_id]}))
    before_archive = current()["revision"]
    ok(client.post(f"/api/accounts/{deputy.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    archived_revision = current()["revision"]
    assert archived_revision > before_archive
    ok(client.post(f"/api/accounts/{deputy.user_id}/restore", headers=superuser.headers, json={"master_conflicts": []}))
    assert current()["revision"] > archived_revision
    stale = client.put(f"/api/role-assignments/{principal['role_assignment_id']}/deputies", headers=superuser.headers,
        json={"expected_revision": archived_revision, "user_ids": [other.user_id]})
    assert stale.status_code == 409, stale.text
    assert set(current()["deputy_user_ids"]) == {deputy.user_id, other.user_id}


@pytest.mark.parametrize("kind", ["block", "event", "subevent"])
def test_restoring_principal_defers_archived_deputy_until_their_own_restore(client, work, superuser, make_user, kind):
    deputy, other = make_user(password=None), make_user(password=None)
    current = leader_context(client, superuser, work, kind)
    principal = current()
    ok(client.put(f"/api/role-assignments/{principal['role_assignment_id']}/deputies", headers=superuser.headers,
        json={"expected_revision": principal["revision"], "user_ids": [deputy.user_id, other.user_id]}))
    for actor in (work["master"], deputy):
        ok(client.post(f"/api/accounts/{actor.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    ok(client.post(f"/api/accounts/{work['master'].user_id}/restore", headers=superuser.headers, json={"master_conflicts": []}))
    assert current()["deputy_user_ids"] == [other.user_id]
    with db._session() as session:
        assert session.query(RoleAssignmentORM).filter_by(user_id=deputy.user_id).count() == 0
        assert session.query(ScopeTenureORM).filter_by(user_id=deputy.user_id, ended_at=None).count() == 0
    revision = current()["revision"]
    ok(client.post(f"/api/accounts/{deputy.user_id}/restore", headers=superuser.headers, json={"master_conflicts": []}))
    assert set(current()["deputy_user_ids"]) == {deputy.user_id, other.user_id}
    assert current()["revision"] > revision


def test_archived_master_survives_rename_and_reused_old_name_with_explicit_conflict(client, work, superuser, make_user):
    uid, bid = work["master"].user_id, work["block"]["block_id"]
    ok(client.post(f"/api/accounts/{uid}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    card = ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))
    card = ok(client.patch(f"/api/blocks/{bid}", headers=superuser.headers,
        json={"expected_revision": card["revision"], "name": "Renamed source"}))
    db.create_block(Block(name="IT", master=""))
    replacement = make_user(password=None)
    ok(client.put(f"/api/blocks/{bid}/leader", headers=superuser.headers,
        json={"expected_revision": card["revision"], "user_id": replacement.user_id}))
    denied = client.post(f"/api/accounts/{uid}/restore", headers=superuser.headers, json={"master_conflicts": []})
    assert denied.status_code == 409, denied.text
    conflict = denied.json()["detail"]["fields"]["master_conflicts"][0]
    assert conflict["block_id"] == bid and conflict["block_name"] == "Renamed source"
    ok(client.post(f"/api/accounts/{uid}/restore", headers=superuser.headers,
        json={"master_conflicts": [{"block_id": bid, "keep_user_id": uid}]}))
    assert ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))["master"]["user"]["user_id"] == uid
    reused = ok(client.get("/api/blocks/IT", headers=superuser.headers))
    assert reused["master"] is None and reused["block_id"] != bid
    # Both identities can independently acquire and restore their own holder.
    ok(client.put(f"/api/blocks/{reused['block_id']}/leader", headers=superuser.headers,
        json={"expected_revision": reused["revision"], "user_id": replacement.user_id}))
    for actor in (work["master"], replacement):
        ok(client.post(f"/api/accounts/{actor.user_id}/archive", headers=superuser.headers, json={"reason": "Separate identity"}))
    for actor in (replacement, work["master"]):
        ok(client.post(f"/api/accounts/{actor.user_id}/restore", headers=superuser.headers, json={"master_conflicts": []}))
    assert ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))["master"]["user"]["user_id"] == uid
    assert ok(client.get(f"/api/blocks/{reused['block_id']}", headers=superuser.headers))["master"]["user"]["user_id"] == replacement.user_id


def test_legacy_archive_without_scope_provenance_requires_an_explicit_mapping(client, work, superuser):
    uid, bid = work["master"].user_id, work["block"]["block_id"]
    ok(client.post(f"/api/accounts/{uid}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    with db._session() as session:
        archive = session.get(AccountArchiveORM, uid)
        value = json.loads(archive.snapshot_json)
        role = next(role for role in value["roles"] if role["role"] == "master")
        role.pop("scope_block_id");role["scope_id"] = "Unproved legacy label"
        identity = role["role_assignment_id"]
        archive.snapshot_json = json.dumps(value);session.commit()
    denied = client.post(f"/api/accounts/{uid}/restore", headers=superuser.headers, json={"master_conflicts": []})
    assert denied.status_code == 409 and denied.json()["detail"]["code"] == "archive_scope_mapping_required"
    ok(client.post(f"/api/accounts/{uid}/restore", headers=superuser.headers,
        json={"master_conflicts": [], "block_scope_mappings": [{"role_assignment_id": identity, "block_id": bid}]}))
    assert ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))["master"]["user"]["user_id"] == uid


def test_automatic_former_card_is_unique_and_revisioned_without_overwriting_editor(client, superuser, make_user):
    actor = make_user(password=None)
    ok(client.post(f"/api/accounts/{actor.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    cards = ok(client.get("/api/contacts/archive", headers=superuser.headers))["items"]
    assert len(cards) == 1 and cards[0]["revision"] == 1
    old = cards[0]
    fields = {key: value for key, value in old.items() if key not in {"contact_id", "revision", "capabilities"}}
    url = f"/api/contacts/archive/{old['contact_id']}"
    assert client.patch(url, headers=superuser.headers, json=fields).status_code == 422
    edited = ok(client.patch(url, headers=superuser.headers,
        json={**fields, "phone": "independent edited contact", "expected_revision": old["revision"]}))
    assert edited["revision"] == 2
    assert client.patch(url, headers=superuser.headers, json={**fields, "expected_revision": 1}).status_code == 409
    ok(client.post(f"/api/accounts/{actor.user_id}/restore", headers=superuser.headers, json={"master_conflicts": []}))
    ok(client.post(f"/api/accounts/{actor.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic second leave"}))
    cards = ok(client.get("/api/contacts/archive", headers=superuser.headers))["items"]
    assert len(cards) == 1 and cards[0]["phone"] == edited["phone"] and cards[0]["revision"] == 2


def test_rename_never_binds_an_unproved_legacy_snapshot_by_name(client, work, superuser):
    uid, bid = work["master"].user_id, work["block"]["block_id"]
    ok(client.post(f"/api/accounts/{uid}/archive", headers=superuser.headers, json={"reason": "Synthetic legacy"}))
    with db._session() as session:
        row = session.get(AccountArchiveORM, uid)
        value = json.loads(row.snapshot_json)
        for role in value["roles"]:
            role.pop("scope_block_id", None)
        row.snapshot_json = json.dumps(value)
        tenures_before = [(row.tenure_id, row.scope_id, row.started_at, row.ended_at) for row in session.query(ScopeTenureORM)]
        session.commit()
    card = ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))
    ok(client.patch(f"/api/blocks/{bid}", headers=superuser.headers,
        json={"expected_revision": card["revision"], "name": "Renamed without guessed provenance"}))
    with db._session() as session:
        roles = json.loads(session.get(AccountArchiveORM, uid).snapshot_json)["roles"]
        assert all(role["scope_id"] == "IT" and "scope_block_id" not in role for role in roles)
        assert [(row.tenure_id, row.scope_id, row.started_at, row.ended_at) for row in session.query(ScopeTenureORM)] == tenures_before
    denied = client.post(f"/api/accounts/{uid}/restore", headers=superuser.headers, json={"master_conflicts": []})
    assert denied.status_code == 409 and denied.json()["detail"]["code"] == "archive_scope_mapping_required"
