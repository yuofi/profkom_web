"""Approval provenance is a safe, read-only projection of saved transitions."""

import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import event

from database import ContactInfoORM, UserORM, db, engine
from domain_models import BlockApplicationORM
from models import Block
import membership


@pytest.fixture
def team(client, superuser, make_user):
    actors = {name: make_user(password=None, name=name) for name in ("HR approver", "Block approver", "Applicant", "Stranger")}
    for name, is_hr in (("HR", True), ("IT", False)):
        db.create_block(Block(name=name, master="", is_hr=is_hr))
    blocks = {row["name"]: row for row in client.get("/api/blocks", headers=superuser.headers).json()}
    for name, actor in (("HR", actors["HR approver"]), ("IT", actors["Block approver"])):
        block = blocks[name]
        response = client.put(f"/api/blocks/{block['block_id']}/leader", headers=superuser.headers,
            json={"user_id": actor.user_id, "expected_revision": block["revision"]})
        assert response.status_code == 200, response.text
    return dict(hr=actors["HR approver"], master=actors["Block approver"], applicant=actors["Applicant"],
        stranger=actors["Stranger"], blocks=blocks)


def join(client, team, block="IT"):
    response = client.post("/api/block-requests", headers=team["applicant"].headers,
        json={"block_id": team["blocks"][block]["block_id"]})
    assert response.status_code == 200, response.text
    return response.json()


def approve(client, application, command, actor, reason="private approval note"):
    response = client.post(f"/api/block-requests/{application['request_id']}/{command}", headers=actor.headers,
        json={"expected_revision": application["revision"], "reason": reason})
    assert response.status_code == 200, response.text
    return response.json()


def visible(client, actor, request_id):
    response = client.get("/api/block-requests", headers=actor.headers)
    assert response.status_code == 200, response.text
    return next((item for item in response.json()["items"] if item["request_id"] == request_id), None)


def replace_history(request_id, history, *, state="approved"):
    with db._session() as session:
        row = session.get(BlockApplicationORM, request_id)
        row.history_json = history if isinstance(history, str) else json.dumps(history)
        row.state = state
        session.commit()


def saved_approval(actor, *, old="pending_hr", state="approved", **extra):
    return dict(old_state=old, state=state, actor=actor, at="2026-10-28T12:00:00+00:00", substitute=False, **extra)


def test_two_stage_approvals_use_saved_actors_and_do_not_publish_private_reasons(client, team, superuser, make_user):
    request = join(client, team)
    assert request["approvals"] == []
    hr = approve(client, request, "hr-approve", team["hr"])
    assert hr["state"] == "pending_block" and hr["decided_at"] is None
    assert [entry["stage"] for entry in hr["approvals"]] == ["hr"]
    approved = approve(client, hr, "block-approve", team["master"])
    assert [entry["stage"] for entry in approved["approvals"]] == ["hr", "block"]
    assert [entry["actor"]["user_id"] for entry in approved["approvals"]] == [team["hr"].user_id, team["master"].user_id]
    assert all(entry["at"] and entry["substitute"] is False for entry in approved["approvals"])
    assert approved["decided_at"] == approved["approvals"][-1]["at"] and approved["decision_reason"] is None
    for entry in approved["approvals"]:
        assert set(entry) == {"stage", "actor", "at", "substitute"}
        assert set(entry["actor"]) == {"user_id", "display_name", "avatar_url"}
    assert "private approval note" not in json.dumps(approved)
    # Today's master and display name are not the source of the old approval identity.
    replacement = make_user(password=None)
    block_id = team["blocks"]["HR"]["block_id"]
    block = client.get(f"/api/blocks/{block_id}", headers=superuser.headers).json()
    response = client.put(f"/api/blocks/{block_id}/leader", headers=superuser.headers,
        json={"user_id": replacement.user_id, "expected_revision": block["revision"]})
    assert response.status_code == 200, response.text
    with db._session() as session:
        contact = session.get(ContactInfoORM, team["hr"].user_id)
        contact.name = "Current safe name"
        contact.surname = "Historical actor"
        session.commit()
    seen = visible(client, team["applicant"], request["request_id"])
    assert seen["approvals"][0]["actor"]["user_id"] == team["hr"].user_id
    assert "Current safe name" in seen["approvals"][0]["actor"]["display_name"]
    assert visible(client, team["stranger"], request["request_id"]) is None


def test_hr_block_has_only_one_proven_approval(client, team):
    request = approve(client, join(client, team, "HR"), "hr-approve", team["hr"])
    assert request["state"] == "approved"
    assert len(request["approvals"]) == 1
    assert request["approvals"][0] == dict(stage="hr", actor=request["approvals"][0]["actor"], at=request["decided_at"], substitute=False)
    assert request["approvals"][0]["actor"]["user_id"] == team["hr"].user_id


def test_substitution_is_recorded_for_each_stage_not_inferred_from_current_role(client, team, superuser, monkeypatch):
    request = join(client, team)
    start = datetime.fromisoformat(request["stage_entered_at"])
    monkeypatch.setattr(membership, "now_dt", lambda: start + timedelta(hours=72))
    request = approve(client, request, "hr-approve", superuser)
    monkeypatch.setattr(membership, "now_dt", lambda: start + timedelta(hours=144))
    request = approve(client, request, "block-approve", superuser)
    assert [(entry["stage"], entry["actor"]["user_id"], entry["substitute"]) for entry in request["approvals"]] == [("hr", superuser.user_id, True), ("block", superuser.user_id, True)]


@pytest.mark.parametrize("actor_state", ["unknown", "purged", "archived"])
def test_unknown_and_anonymized_approval_actors_use_only_safe_current_refs(client, team, actor_state):
    request = join(client, team)
    actor_id = team["hr"].user_id if actor_state != "unknown" else 2**63 - 1
    replace_history(request["request_id"], [dict(saved_approval(actor_id), reason="PRIVATE REASON", actor_email="PRIVATE EMAIL", actor_name="STALE SNAPSHOT NAME")])
    if actor_state != "unknown":
        with db._session() as session:
            session.get(UserORM, actor_id).account_state = actor_state
            session.commit()
    seen = visible(client, team["applicant"], request["request_id"])
    actor = seen["approvals"][0]["actor"]
    if actor_state == "unknown":
        assert actor is None
    elif actor_state == "purged":
        assert actor == dict(user_id=None, display_name="Обезличенный участник", avatar_url=None)
    else:
        assert actor["user_id"] == actor_id and set(actor) == {"user_id", "display_name", "avatar_url"}
    assert all(marker not in json.dumps(seen) for marker in ("PRIVATE REASON", "PRIVATE EMAIL", "STALE SNAPSHOT NAME"))


@pytest.mark.parametrize("history", ["{broken", "null", "{}", "42", '"text"', '[null, 42, "invalid", []]'])
def test_malformed_legacy_history_is_a_read_only_empty_projection(client, team, history):
    request = join(client, team)
    replace_history(request["request_id"], history)
    seen = visible(client, team["applicant"], request["request_id"])
    assert seen["approvals"] == [] and seen["decided_at"] is None and seen["decision_reason"] is None
    with db._session() as session:
        assert session.get(BlockApplicationORM, request["request_id"]).history_json == history


def test_malformed_actor_ids_and_unproved_records_are_not_coerced_or_guessed(client, team):
    request = join(client, team)
    bad_ids = [None, True, False, 0, -1, float(team["hr"].user_id), str(team["hr"].user_id), {}, [], 2**100]
    history = [dict(saved_approval(actor), at={"private": "not a timestamp"}, substitute="true") for actor in bad_ids]
    history += [dict(actor=team["hr"].user_id, state="approved", at="2026-10-28T12:00:00Z"),
        saved_approval(team["hr"].user_id, old="pending_hr", state="rejected"),
        saved_approval(team["master"].user_id, old="approved", state="approved")]
    replace_history(request["request_id"], history)
    seen = visible(client, team["applicant"], request["request_id"])
    assert seen["approvals"] == [dict(stage="hr", actor=None, at=None, substitute=False) for _ in bad_ids]


def test_invalid_saved_approval_dates_are_null_and_valid_iso_strings_remain_exact(client, team):
    request = join(client, team)
    dates = [None, "", "not-a-date", "2026-99-28T12:00:00Z", "2026-10-28T12:34:56.123456+03:00", "2026-10-28T09:34:56Z"]
    history = [dict(saved_approval(team["hr"].user_id), at=at) for at in dates]
    replace_history(request["request_id"], history)
    seen = visible(client, team["applicant"], request["request_id"])
    assert [entry["at"] for entry in seen["approvals"]] == [None, None, None, None, *dates[-2:]]
    with db._session() as session:
        assert json.loads(session.get(BlockApplicationORM, request["request_id"]).history_json) == history


def test_rejection_keeps_terminal_reason_but_adds_only_prior_successful_stage(client, team):
    request = join(client, team)
    history = [dict(saved_approval(team["hr"].user_id, state="pending_block"), reason="PRIVATE APPROVAL NOTE"),
        dict(saved_approval(team["master"].user_id, old="pending_block", state="rejected"), reason="Visible terminal rejection")]
    replace_history(request["request_id"], history, state="rejected")
    seen = visible(client, team["applicant"], request["request_id"])
    assert [entry["stage"] for entry in seen["approvals"]] == ["hr"]
    assert seen["decision_reason"] == "Visible terminal rejection" and seen["decided_at"] == history[-1]["at"]
    assert "PRIVATE APPROVAL NOTE" not in json.dumps(seen)


def test_repeated_http_reads_issue_no_writes_and_leave_saved_provenance_unchanged(client, team):
    request = approve(client, join(client, team), "hr-approve", team["hr"])
    writes = []
    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "REPLACE", "ALTER", "CREATE", "DROP")):
            writes.append(statement.split()[0])
    with db._session() as session:
        row = session.get(BlockApplicationORM, request["request_id"])
        before = (row.history_json, row.revision, row.stage_entered_at, row.state)
    event.listen(engine, "before_cursor_execute", capture)
    try:
        first = visible(client, team["applicant"], request["request_id"])
        second = visible(client, team["applicant"], request["request_id"])
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert writes == [] and first == second
    with db._session() as session:
        row = session.get(BlockApplicationORM, request["request_id"])
        assert (row.history_json, row.revision, row.stage_entered_at, row.state) == before
