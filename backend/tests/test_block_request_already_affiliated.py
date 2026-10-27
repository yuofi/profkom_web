"""A block application is for outsiders, independent of the kind of affiliation."""

import pytest

from database import AuditLogORM, NotificationORM, db
from domain_models import BlockApplicationORM, MembershipORM, ScopeTenureORM
from models import Block
import membership


@pytest.fixture
def organization(client, superuser, make_user):
    for name, is_hr in (("HR", True), ("IT", False)):
        db.create_block(Block(name=name, master="", is_hr=is_hr))
    cards = {row["name"]: row for row in client.get("/api/blocks", headers=superuser.headers).json()}
    masters, deputies = {}, {}
    for name, card in cards.items():
        masters[name], deputies[name] = make_user(password=None), make_user(password=None)
        response = client.put(
            f"/api/blocks/{card['block_id']}/leader",
            headers=superuser.headers,
            json={"user_id": masters[name].user_id, "expected_revision": card["revision"]},
        )
        assert response.status_code == 200, response.text
        leader = response.json()["master"]
        response = client.put(
            f"/api/role-assignments/{leader['role_assignment_id']}/deputies",
            headers=masters[name].headers,
            json={"user_ids": [deputies[name].user_id], "expected_revision": leader["revision"]},
        )
        assert response.status_code == 200, response.text
    return {"cards": cards, "masters": masters, "deputies": deputies}


def request_join(client, actor, block):
    return client.post("/api/block-requests", headers=actor.headers, json={"block_id": block})


def side_effects():
    with db._session() as session:
        return {
            model.__tablename__: [
                tuple(getattr(row, column.name) for column in model.__table__.columns)
                for row in session.query(model).order_by(*model.__table__.primary_key.columns)
            ]
            for model in (BlockApplicationORM, NotificationORM, AuditLogORM, MembershipORM)
        }


def join_as_member(actor, block_id, category, chair):
    with db._session() as session:
        membership.set_membership(session, actor.user_id, block_id, True, chair.user_id, "Synthetic membership")
        session.flush()
        row = session.query(MembershipORM).filter_by(user_id=actor.user_id, block_id=block_id, left_at=None).one()
        row.category = category
        session.commit()


def assert_already_affiliated(response):
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "already_member"


@pytest.mark.parametrize("block_name", ["IT", "HR"])
@pytest.mark.parametrize("identifier", ["canonical", "legacy"])
@pytest.mark.parametrize("affiliation", ["master", "deputy", "junior", "member"])
def test_current_affiliation_rejects_without_side_effects(
    client, organization, superuser, make_user, block_name, identifier, affiliation
):
    block_id = organization["cards"][block_name]["block_id"]
    if affiliation in ("master", "deputy"):
        actor = organization["masters" if affiliation == "master" else "deputies"][block_name]
        with db._session() as session:
            assert not session.query(MembershipORM).filter_by(user_id=actor.user_id, block_id=block_id).count()
    else:
        actor = make_user(password=None)
        join_as_member(actor, block_id, affiliation, superuser)
    before = side_effects()
    assert_already_affiliated(request_join(client, actor, block_id if identifier == "canonical" else block_name))
    assert side_effects() == before


@pytest.mark.parametrize("new_role", ["master", "deputy"])
def test_existing_pending_application_does_not_bypass_a_new_service_role(
    client, organization, superuser, make_user, new_role
):
    actor = make_user(password=None)
    block_id = organization["cards"]["IT"]["block_id"]
    application = request_join(client, actor, block_id)
    assert application.status_code == 200, application.text
    card = client.get(f"/api/blocks/{block_id}", headers=superuser.headers).json()
    if new_role == "master":
        changed = client.put(
            f"/api/blocks/{block_id}/leader", headers=superuser.headers,
            json={"user_id": actor.user_id, "expected_revision": card["revision"]},
        )
    else:
        leader = card["master"]
        changed = client.put(
            f"/api/role-assignments/{leader['role_assignment_id']}/deputies",
            headers=organization["masters"]["IT"].headers,
            json={"user_ids": [actor.user_id], "expected_revision": leader["revision"]},
        )
    assert changed.status_code == 200, changed.text
    before = side_effects()
    assert_already_affiliated(request_join(client, actor, block_id))
    assert side_effects() == before


@pytest.mark.parametrize("state", ["pending_hr", "pending_block"])
def test_outsider_pending_application_remains_idempotent(client, organization, make_user, state):
    actor = make_user(password=None)
    application = request_join(client, actor, organization["cards"]["IT"]["block_id"])
    assert application.status_code == 200, application.text
    if state == "pending_block":
        application = client.post(
            f"/api/block-requests/{application.json()['request_id']}/hr-approve",
            headers=organization["masters"]["HR"].headers,
            json={"expected_revision": application.json()["revision"]},
        )
        assert application.status_code == 200, application.text
        application = client.get("/api/block-requests", headers=actor.headers)
        assert application.status_code == 200, application.text
        expected = application.json()["items"][0]
    else:
        expected = application.json()
    before = side_effects()
    repeated = request_join(client, actor, "IT")
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == expected
    assert side_effects() == before


@pytest.mark.parametrize("category", ["junior", "member"])
def test_left_member_can_rejoin_without_losing_established_category(
    client, organization, superuser, make_user, category
):
    actor = make_user(password=None)
    block_id = organization["cards"]["IT"]["block_id"]
    join_as_member(actor, block_id, category, superuser)
    left = client.post(f"/api/blocks/{block_id}/leave", headers=actor.headers, json={})
    assert left.status_code == 200, left.text
    with db._session() as session:
        previous = session.query(MembershipORM).filter_by(user_id=actor.user_id, block_id=block_id).one()
        previous_id, left_at = previous.membership_id, previous.left_at
        assert left_at is not None
    application = request_join(client, actor, block_id)
    assert application.status_code == 200, application.text
    for command, reviewer in (("hr-approve", organization["masters"]["HR"]),
                              ("block-approve", organization["masters"]["IT"])):
        application = client.post(
            f"/api/block-requests/{application.json()['request_id']}/{command}",
            headers=reviewer.headers, json={"expected_revision": application.json()["revision"]},
        )
        assert application.status_code == 200, application.text
    assert application.json()["state"] == "approved"
    with db._session() as session:
        current = session.query(MembershipORM).filter_by(user_id=actor.user_id, block_id=block_id, left_at=None).one()
        assert current.category == category and current.membership_id != previous_id
        assert session.get(MembershipORM, previous_id).left_at == left_at


@pytest.mark.parametrize("former_role", ["master", "deputy"])
def test_closed_service_tenure_does_not_block_a_new_application(
    client, organization, superuser, make_user, former_role
):
    actor = organization["masters" if former_role == "master" else "deputies"]["IT"]
    block_id = organization["cards"]["IT"]["block_id"]
    card = client.get(f"/api/blocks/{block_id}", headers=superuser.headers).json()
    if former_role == "master":
        replacement = make_user(password=None)
        changed = client.put(
            f"/api/blocks/{block_id}/leader", headers=superuser.headers,
            json={"user_id": replacement.user_id, "expected_revision": card["revision"]},
        )
    else:
        leader = card["master"]
        changed = client.put(
            f"/api/role-assignments/{leader['role_assignment_id']}/deputies",
            headers=organization["masters"]["IT"].headers,
            json={"user_ids": [], "expected_revision": leader["revision"]},
        )
    assert changed.status_code == 200, changed.text
    with db._session() as session:
        history = session.query(ScopeTenureORM).filter_by(user_id=actor.user_id, scope_kind="block", scope_id="IT").all()
        assert history and all(row.ended_at is not None for row in history)
    application = request_join(client, actor, block_id)
    assert application.status_code == 200, application.text
    assert application.json()["state"] == "pending_hr"


@pytest.mark.parametrize("actor_kind", ["chair", "other_block_master", "other_block_deputy"])
def test_global_rights_and_other_block_roles_do_not_imply_affiliation(
    client, organization, superuser, actor_kind
):
    actor = superuser if actor_kind == "chair" else organization[
        "masters" if actor_kind == "other_block_master" else "deputies"
    ]["IT"]
    application = request_join(client, actor, organization["cards"]["HR"]["block_id"])
    assert application.status_code == 200, application.text
    assert application.json()["state"] == "pending_hr"


@pytest.mark.parametrize("block_name", ["IT", "HR"])
def test_hr_deputy_reads_and_approves_hr_stage_without_ordinary_membership(
    client, organization, make_user, block_name
):
    actor = organization["deputies"]["HR"]
    with db._session() as session:
        assert not session.query(MembershipORM).filter_by(user_id=actor.user_id, left_at=None).count()
    application = request_join(client, make_user(password=None), organization["cards"][block_name]["block_id"])
    assert application.status_code == 200, application.text
    application = application.json()
    visible = client.get("/api/block-requests", headers=actor.headers)
    assert visible.status_code == 200, visible.text
    visible = next(row for row in visible.json()["items"] if row["request_id"] == application["request_id"])
    assert "hr_review_request" in visible["capabilities"]
    assert "view_block_requests" in client.get("/api/session", headers=actor.headers).json()["capabilities"]
    approved = client.post(
        f"/api/block-requests/{application['request_id']}/hr-approve", headers=actor.headers,
        json={"expected_revision": application["revision"]},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["state"] == ("approved" if block_name == "HR" else "pending_block")
    if block_name == "IT":
        before = side_effects()
        denied = client.post(
            f"/api/block-requests/{application['request_id']}/block-approve", headers=actor.headers,
            json={"expected_revision": approved.json()["revision"]},
        )
        assert denied.status_code == 403, denied.text
        assert side_effects() == before


@pytest.mark.parametrize(
    "role, expected",
    [("chair", True), ("chair_deputy", True), ("hr_master", True), ("hr_deputy", True),
     ("block_master", True), ("block_deputy", True), ("hr_member", False), ("outsider", False)],
)
def test_request_navigation_capability_follows_current_service_roles(
    client, organization, superuser, make_user, role, expected
):
    if role == "chair":
        actor = superuser
    elif role in ("hr_master", "block_master", "hr_deputy", "block_deputy"):
        actor = organization["masters" if role.endswith("master") else "deputies"][
            "HR" if role.startswith("hr_") else "IT"
        ]
    else:
        actor = make_user(password=None)
        if role == "chair_deputy":
            leadership = client.get("/api/leadership", headers=superuser.headers).json()
            assigned = client.put(
                "/api/leadership/deputies", headers=superuser.headers,
                json={"user_ids": [actor.user_id], "expected_revision": leadership["revision"]},
            )
            assert assigned.status_code == 200, assigned.text
        elif role == "hr_member":
            join_as_member(actor, organization["cards"]["HR"]["block_id"], "member", superuser)
    session = client.get("/api/session", headers=actor.headers)
    assert session.status_code == 200, session.text
    assert ("view_block_requests" in session.json()["capabilities"]) is expected


def test_ordinary_hr_membership_does_not_grant_hr_approval(
    client, organization, superuser, make_user
):
    actor = make_user(password=None)
    join_as_member(actor, organization["cards"]["HR"]["block_id"], "member", superuser)
    application = request_join(client, make_user(password=None), organization["cards"]["IT"]["block_id"])
    assert application.status_code == 200, application.text
    before = side_effects()
    denied = client.post(
        f"/api/block-requests/{application.json()['request_id']}/hr-approve", headers=actor.headers,
        json={"expected_revision": application.json()["revision"]},
    )
    assert denied.status_code == 403, denied.text
    assert side_effects() == before


def test_assigned_block_hr_can_apply_but_cannot_approve_the_application(
    client, organization, superuser, make_user
):
    actor = make_user(password=None)
    block_id = organization["cards"]["IT"]["block_id"]
    card = client.get(f"/api/blocks/{block_id}", headers=superuser.headers).json()
    assigned = client.put(
        f"/api/blocks/{block_id}/hr", headers=superuser.headers,
        json={"user_id": actor.user_id, "expected_revision": card["revision"]},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["hr"]["user_id"] == actor.user_id
    with db._session() as session:
        assert not session.query(MembershipORM).filter_by(user_id=actor.user_id, block_id=block_id).count()
    application = request_join(client, actor, block_id)
    assert application.status_code == 200, application.text
    before = side_effects()
    denied = client.post(
        f"/api/block-requests/{application.json()['request_id']}/hr-approve", headers=actor.headers,
        json={"expected_revision": application.json()["revision"]},
    )
    assert denied.status_code == 403, denied.text
    assert side_effects() == before
