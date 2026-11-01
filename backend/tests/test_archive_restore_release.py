import json

import pytest

from database import db, RoleAssignmentORM, UserORM
from domain_models import AccountArchiveORM, FormerContactORM, ScopeTenureORM
from models import Block
from test_hr_tracker_edit import hr_roles  # noqa: F401
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


def test_only_the_chair_archives_or_restores_a_chair_deputy(client, superuser, make_user):
    """PE-01: deputies share account archive/restore, but never change who the deputies are."""
    first, second, member = (make_user(in_profcom=True) for _ in range(3))
    lead = ok(client.get("/api/leadership", headers=superuser.headers))
    ok(client.put("/api/leadership/deputies", headers=superuser.headers,
        json={"user_ids": [first.user_id, second.user_id], "expected_revision": lead["revision"]}))
    deputies = lambda: [p["user_id"] for p in ok(client.get("/api/leadership", headers=superuser.headers))["deputies"]]
    for target in (second, first):
        denied = client.post(f"/api/accounts/{target.user_id}/archive", headers=first.headers, json={"reason": "probe"})
        assert denied.status_code == 403 and denied.json()["detail"]["code"] == "leadership_change_forbidden", denied.text
    assert sorted(deputies()) == sorted([first.user_id, second.user_id])
    assert client.get("/api/session", headers=second.headers).status_code == 200
    # Ordinary accounts stay within the deputies' archive rights.
    ok(client.post(f"/api/accounts/{member.user_id}/archive", headers=first.headers, json={"reason": "Synthetic leave"}))
    ok(client.post(f"/api/accounts/{member.user_id}/restore", headers=first.headers, json={"master_conflicts": []}))
    ok(client.post(f"/api/accounts/{second.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    assert deputies() == [first.user_id]
    denied = client.post(f"/api/accounts/{second.user_id}/restore", headers=first.headers, json={"master_conflicts": []})
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "leadership_change_forbidden", denied.text
    assert deputies() == [first.user_id]
    with db._session() as session:
        assert session.get(UserORM, second.user_id).account_state == "archived"
    ok(client.post(f"/api/accounts/{second.user_id}/restore", headers=superuser.headers, json={"master_conflicts": []}))
    assert sorted(deputies()) == sorted([first.user_id, second.user_id])


def test_category_reads_name_the_archive_right_per_target(client, superuser, make_user):
    """PE-01: the directory hides archiving where the server refuses it, in both read shapes."""
    deputy, member = make_user(in_profcom=True), make_user(in_profcom=True)
    lead = ok(client.get("/api/leadership", headers=superuser.headers))
    ok(client.put("/api/leadership/deputies", headers=superuser.headers,
        json={"user_ids": [deputy.user_id], "expected_revision": lead["revision"]}))
    people = [superuser.user_id, deputy.user_id, member.user_id]
    def archivable(viewer):
        items = ok(client.get("/api/participants/categories", headers=viewer.headers,
            params={"user_ids": ",".join(map(str, people))}))["items"]
        for item in items:
            assert ok(client.get(f"/api/participants/{item['user_id']}/category", headers=viewer.headers)) == item
        return {item["user_id"] for item in items if "archive_account" in item["capabilities"]}
    assert archivable(superuser) == {deputy.user_id, member.user_id}
    assert archivable(deputy) == {member.user_id}
    assert archivable(member) == set()


PE01_ROLES = ["chair", "chair_deputy", "hr_master", "hr_deputy", "block_master", "member", "outsider"]


def deputy_ids(client, chair):
    return sorted(p["user_id"] for p in ok(client.get("/api/leadership", headers=chair.headers))["deputies"])


def make_deputies(client, chair, users):
    lead = ok(client.get("/api/leadership", headers=chair.headers))
    ok(client.put("/api/leadership/deputies", headers=chair.headers,
        json={"user_ids": [u.user_id for u in users], "expected_revision": lead["revision"]}))


def account_state(uid):
    with db._session() as session:
        return session.get(UserORM, uid).account_state


@pytest.mark.parametrize("role", PE01_ROLES)
def test_only_the_chair_archives_restores_or_resets_a_chair_deputy(client, work, superuser, make_user, hr_roles, role):
    """PE-01 (owner 2026-10-31): deputies of the chair never archive or restore a deputy,
    themselves included; only the chair does. Ordinary accounts keep the deputies' rights."""
    deputy, target, ordinary = (make_user(in_profcom=True) for _ in range(3))
    make_deputies(client, superuser, [deputy, target])
    people = {"chair": superuser, "chair_deputy": deputy, "hr_master": hr_roles["master"], "hr_deputy": hr_roles["deputy"],
              "block_master": work["master"], "member": work["member"], "outsider": work["outside"]}
    actor, chair = people[role], role == "chair"
    both = sorted([deputy.user_id, target.user_id])

    # Self: the chair transfers the post first; a deputy and everyone else are refused.
    self_archive = client.post(f"/api/accounts/{actor.user_id}/archive", headers=actor.headers, json={"reason": "probe"})
    if chair:
        assert self_archive.status_code == 409 and self_archive.json()["detail"]["code"] == "chair_transfer_required"
    else:
        assert self_archive.status_code == 403, self_archive.text
        if role == "chair_deputy":
            assert self_archive.json()["detail"]["code"] == "leadership_change_forbidden"
    assert account_state(actor.user_id) == "active" and deputy_ids(client, superuser) == both

    # A temporary password for a deputy is refused to everyone (the deputy changes their own).
    reset = client.post(f"/api/accounts/{target.user_id}/temporary-password", headers=actor.headers)
    assert reset.status_code == 403, reset.text

    archived = client.post(f"/api/accounts/{target.user_id}/archive", headers=actor.headers, json={"reason": "Synthetic leave"})
    if chair:
        ok(archived)
    else:
        assert archived.status_code == 403, archived.text
        if role == "chair_deputy":
            assert archived.json()["detail"]["code"] == "leadership_change_forbidden"
        assert account_state(target.user_id) == "active" and deputy_ids(client, superuser) == both
        assert client.get("/api/session", headers=target.headers).status_code == 200
        ok(client.post(f"/api/accounts/{target.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    assert deputy_ids(client, superuser) == [deputy.user_id]
    ok(client.post(f"/api/accounts/{ordinary.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))

    # The archive listing names the restore right per account.
    listing = client.get("/api/accounts/archive", headers=actor.headers)
    if role in ("chair", "chair_deputy"):
        caps = {i["user_id"]: i["capabilities"] for i in ok(listing)["items"]}
        assert ("restore_account" in caps[target.user_id]) is chair
        assert caps[ordinary.user_id] == ["restore_account"]
    else:
        assert listing.status_code == 403, listing.text

    restored = client.post(f"/api/accounts/{target.user_id}/restore", headers=actor.headers, json={"master_conflicts": []})
    if chair:
        ok(restored)
        assert deputy_ids(client, superuser) == both and account_state(target.user_id) == "active"
    else:
        assert restored.status_code == 403, restored.text
        if role == "chair_deputy":
            assert restored.json()["detail"]["code"] == "leadership_change_forbidden"
            ok(client.post(f"/api/accounts/{ordinary.user_id}/restore", headers=actor.headers, json={"master_conflicts": []}))
        assert account_state(target.user_id) == "archived" and deputy_ids(client, superuser) == [deputy.user_id]


def test_restoring_a_deputy_chair_is_refused_before_any_conflict_prompt(client, work, superuser, make_user):
    """PE-01: a deputy is not asked to resolve a master conflict of a restore they may not do."""
    deputy, master, bid = make_user(in_profcom=True), work["master"], work["block"]["block_id"]
    make_deputies(client, superuser, [deputy, master])
    ok(client.post(f"/api/accounts/{master.user_id}/archive", headers=superuser.headers, json={"reason": "Synthetic leave"}))
    card = ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))
    replacement = make_user(in_profcom=True)
    ok(client.put(f"/api/blocks/{bid}/leader", headers=superuser.headers,
        json={"expected_revision": card["revision"], "user_id": replacement.user_id}))
    item = next(i for i in ok(client.get("/api/accounts/archive", headers=deputy.headers))["items"] if i["user_id"] == master.user_id)
    assert item["master_conflicts"] and item["capabilities"] == []
    for conflicts in ([], [{"block_id": bid, "keep_user_id": master.user_id}]):
        denied = client.post(f"/api/accounts/{master.user_id}/restore", headers=deputy.headers, json={"master_conflicts": conflicts})
        assert denied.status_code == 403 and denied.json()["detail"]["code"] == "leadership_change_forbidden", denied.text
    assert account_state(master.user_id) == "archived"
    assert ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))["master"]["user"]["user_id"] == replacement.user_id
    prompt = client.post(f"/api/accounts/{master.user_id}/restore", headers=superuser.headers, json={"master_conflicts": []})
    assert prompt.status_code == 409 and prompt.json()["detail"]["code"] == "master_conflicts", prompt.text
    ok(client.post(f"/api/accounts/{master.user_id}/restore", headers=superuser.headers,
        json={"master_conflicts": [{"block_id": bid, "keep_user_id": master.user_id}]}))
    assert deputy_ids(client, superuser) == sorted([deputy.user_id, master.user_id])
    assert ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))["master"]["user"]["user_id"] == master.user_id
