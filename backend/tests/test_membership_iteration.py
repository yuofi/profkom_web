"""Approved removal rules and the deliberately small public profile resource."""
import json

import pytest

from database import db, NotificationORM, UserORM
from domain_models import MembershipORM
from membership import set_membership
from test_v13_membership import team


def member(team, actor):
    with db._session() as session:
        set_membership(session, actor.user_id, team["ids"]["IT"], True,
                       team["hr"].user_id, "Synthetic membership")
        session.commit()


def deputy(client, block_id, actor, superuser):
    leader = client.get(f"/api/blocks/{block_id}", headers=superuser.headers).json()["master"]
    response = client.put(f"/api/role-assignments/{leader['role_assignment_id']}/deputies",
                          headers=superuser.headers,
                          json={"expected_revision": leader["revision"], "user_ids": [actor.user_id]})
    assert response.status_code == 200, response.text


def test_hr_deputy_removes_members_and_actual_hr_office_holders_are_notified_once(
    client, team, make_user, superuser
):
    hr_deputy, unrelated_hr_member = make_user(), make_user()
    deputy(client, team["ids"]["HR"], hr_deputy, superuser)
    with db._session() as session:
        set_membership(session, unrelated_hr_member.user_id, team["ids"]["HR"], True,
                       team["hr"].user_id, "Synthetic membership")
        session.commit()
    member(team, team["user"])
    path = f"/api/blocks/{team['ids']['IT']}/members/{team['user'].user_id}"
    assert client.delete(path, headers=team["master"].headers).status_code == 200
    assert client.delete(path, headers=hr_deputy.headers).status_code == 200
    with db._session() as session:
        notices = session.query(NotificationORM).filter_by(kind="block_member_removed").all()
        assert {row.user_id for row in notices} == {team["hr"].user_id, hr_deputy.user_id}
        assert len(notices) == 2
        for row in notices:
            assert json.loads(row.payload_json) == dict(
                scope_kind="block", scope_id="IT", block_id=team["ids"]["IT"],
                removed_user_id=team["user"].user_id, actor_user_id=team["master"].user_id)
        assert session.query(MembershipORM).filter_by(
            user_id=team["user"].user_id, block_id=team["ids"]["IT"], left_at=None).count() == 0


def test_self_delete_and_ordinary_member_removal_are_denied(client, team, make_user):
    member(team, team["master"])
    member(team, team["user"])
    path = f"/api/blocks/{team['ids']['IT']}/members/"
    assert client.delete(path + str(team["master"].user_id), headers=team["master"].headers).status_code == 403
    assert client.post(f"/api/blocks/{team['ids']['IT']}/leave", headers=team["master"].headers).status_code == 403
    for actor in (team["user"], make_user()):
        assert client.delete(path + str(team["master"].user_id), headers=actor.headers).status_code == 403
    assert db.is_block_member(team["master"].user_id, "IT")


def test_hr_deputy_can_perform_a_real_removal_without_notifying_the_actor(client, team, make_user, superuser):
    hr_deputy = make_user()
    deputy(client, team["ids"]["HR"], hr_deputy, superuser)
    member(team, team["user"])
    removed = client.delete(f"/api/blocks/{team['ids']['IT']}/members/{team['user'].user_id}", headers=hr_deputy.headers)
    assert removed.status_code == 200
    assert not db.is_block_member(team["user"].user_id, "IT")
    with db._session() as session:
        notices = session.query(NotificationORM).filter_by(kind="block_member_removed").all()
        assert [row.user_id for row in notices] == [team["hr"].user_id]
        assert json.loads(notices[0].payload_json)["actor_user_id"] == hr_deputy.user_id


@pytest.mark.parametrize("role", ["master", "deputy"])
def test_leadership_must_be_transferred_before_membership_removal(
    client, team, make_user, superuser, role
):
    actor = team["master"] if role == "master" else make_user()
    if role == "deputy":
        deputy(client, team["ids"]["IT"], actor, superuser)
    member(team, actor)
    path = f"/api/blocks/{team['ids']['IT']}/members/{actor.user_id}"
    refused = client.delete(path, headers=team["hr"].headers)
    assert refused.status_code == 409, refused.text
    assert db.is_block_member(actor.user_id, "IT")
    if role == "master":
        block = client.get(f"/api/blocks/{team['ids']['IT']}", headers=superuser.headers).json()
        changed = client.put(f"/api/blocks/{block['block_id']}/leader", headers=superuser.headers,
                             json={"expected_revision": block["revision"], "user_id": team["user"].user_id})
    else:
        leader = client.get(f"/api/blocks/{team['ids']['IT']}", headers=superuser.headers).json()["master"]
        changed = client.put(f"/api/role-assignments/{leader['role_assignment_id']}/deputies", headers=superuser.headers,
                             json={"expected_revision": leader["revision"], "user_ids": []})
    assert changed.status_code == 200, changed.text
    assert client.delete(path, headers=team["hr"].headers).status_code == 200
    assert not db.is_block_member(actor.user_id, "IT")


def test_public_participation_allows_actual_roles_and_strips_every_working_field(client, team, monkeypatch):
    import workspace

    expected = {"blocks": [{"block_id": team["ids"]["IT"], "name": "IT", "roles": ["master"]}], "events": []}
    actual = client.get(f"/api/participants/{team['master'].user_id}/participation", headers=team["user"].headers)
    assert actual.status_code == 200 and actual.json() == expected
    monkeypatch.setattr(workspace, "participation", lambda uid: {
        "blocks": [{"block_id": "b", "name": "Public block", "roles": ["member", "secret"],
                    "tasks": ["SECRET"], "capabilities": ["edit"], "working_description": "SECRET"}],
        "events": [{"event_id": "e", "title": "Public event", "season_id": "s", "roles": ["organizer", "secret"],
                    "meetings": ["SECRET"], "reports": ["SECRET"], "requests": ["SECRET"]}],
        "private_kkr": "SECRET", "task_count": 71,
    })
    projected = client.get(f"/api/participants/{team['master'].user_id}/participation", headers=team["user"].headers)
    assert projected.status_code == 200
    assert projected.json() == {
        "blocks": [{"block_id": "b", "name": "Public block", "roles": ["member"]}],
        "events": [{"event_id": "e", "title": "Public event", "season_id": "s", "roles": ["organizer"]}],
    }


@pytest.mark.parametrize("state", ["archived", "pending", "banned"])
def test_public_participation_hides_inactive_or_unapproved_targets(client, team, state):
    from registration import ensure_application

    with db._session() as session:
        target = session.get(UserORM, team["master"].user_id)
        if state == "pending":
            ensure_application(session, target.user_id).status = "pending"
        elif state == "banned":
            target.banned = True
        else:
            target.account_state = "archived"
        session.commit()
    response = client.get(f"/api/participants/{team['master'].user_id}/participation", headers=team["user"].headers)
    assert response.status_code == 404


def test_public_participation_requires_an_approved_reader(client, team):
    from registration import ensure_application

    with db._session() as session:
        ensure_application(session, team["user"].user_id).status = "pending"
        session.commit()
    response = client.get(f"/api/participants/{team['master'].user_id}/participation", headers=team["user"].headers)
    assert response.status_code == 403
