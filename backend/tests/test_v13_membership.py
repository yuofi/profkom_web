from datetime import datetime, timezone, timedelta
import pytest
from database import db, BlockORM
from models import Block
from domain_models import BlockApplicationORM, MembershipORM
import membership


@pytest.fixture
def team(client, superuser, make_user):
    hr = make_user()
    master = make_user()
    u = make_user()
    db.create_block(Block(name="HR", master="", is_hr=True))
    db.create_block(Block(name="IT", master=""))
    cards = client.get("/api/blocks", headers=superuser.headers).json()
    ids = {b["name"]: b["block_id"] for b in cards}
    for bid, actor in [(ids["HR"], hr), (ids["IT"], master)]:
        r = client.put(
            f"/api/blocks/{bid}/leader",
            headers=superuser.headers,
            json={"user_id": actor.user_id, "expected_revision": 1},
        )
        assert r.status_code == 200, r.text
        assert r.json()["members"] == []
    return dict(hr=hr, master=master, user=u, ids=ids)


def join(client, u, bid):
    r = client.post("/api/block-requests", headers=u.headers, json={"block_id": bid})
    assert r.status_code == 200, r.text
    return r.json()


def command(client, r, cmd, u):
    return client.post(
        f"/api/block-requests/{r['request_id']}/{cmd}",
        headers=u.headers,
        json={"expected_revision": r["revision"]},
    )


def test_two_stage_join_and_idempotent_leave(client, team):
    t = team
    u = t["user"]
    bid = t["ids"]["IT"]
    r = join(client, u, bid)
    assert r["created_at"] == r["stage_entered_at"]
    assert command(client, r, "block-approve", t["master"]).status_code == 403
    r = command(client, r, "hr-approve", t["hr"]).json()
    assert r["state"] == "pending_block"
    r = command(client, r, "block-approve", t["master"]).json()
    assert r["state"] == "approved"
    card = client.get("/api/blocks/" + bid, headers=u.headers).json()
    assert card["members"][0]["user"]["user_id"] == u.user_id
    assert "view_tasks" in card["capabilities"]
    assert (
        client.post(
            "/api/blocks/" + bid + "/leave", headers=u.headers, json={}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/blocks/" + bid + "/leave", headers=u.headers, json={}
        ).status_code
        == 200
    )
    assert client.get("/api/blocks/" + bid, headers=u.headers).json()["members"] == []
    with db._session() as s:
        from database import NotificationORM

        assert (
            s.query(NotificationORM)
            .filter_by(user_id=t["master"].user_id, kind="block_left")
            .count()
            == 1
        )
        assert (
            s.query(MembershipORM)
            .filter_by(user_id=u.user_id, block_id=bid, left_at=None)
            .count()
            == 0
        )


def test_hr_single_stage_and_hr_deputy_has_no_global_authority(
    client, team, make_user, superuser
):
    t = team
    r = join(client, t["user"], t["ids"]["HR"])
    result = command(client, r, "hr-approve", t["hr"])
    assert result.status_code == 200, result.text
    assert result.json()["state"] == "approved"
    assert command(client, result.json(), "block-approve", t["hr"]).status_code == 409
    # An independent HR-master assignment did not create ordinary HR membership.
    assert not db.is_block_member(t["hr"].user_id, "HR")


def test_substitution_boundary_and_new_stage_clock(
    client, team, superuser, monkeypatch
):
    t = team
    r = join(client, t["user"], t["ids"]["IT"])
    start = datetime.fromisoformat(r["stage_entered_at"])
    monkeypatch.setattr(
        membership, "now_dt", lambda: start + timedelta(hours=72, microseconds=-1)
    )
    assert command(client, r, "hr-approve", superuser).status_code == 403
    monkeypatch.setattr(membership, "now_dt", lambda: start + timedelta(hours=72))
    result = command(client, r, "hr-approve", superuser)
    assert result.status_code == 200, result.text
    r = result.json()
    assert datetime.fromisoformat(r["stage_entered_at"]) == start + timedelta(hours=72)
    assert command(client, r, "block-approve", superuser).status_code == 403
    monkeypatch.setattr(membership, "now_dt", lambda: start + timedelta(hours=144))
    assert command(client, r, "block-approve", superuser).json()["state"] == "approved"


def test_block_settings_revision_and_leader_without_membership(client, team, superuser):
    t = team
    bid = t["ids"]["IT"]
    r = client.patch(
        "/api/blocks/" + bid,
        headers=t["master"].headers,
        json={
            "expected_revision": 2,
            "description": {"format": "markdown", "body": "Description"},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 3
    assert (
        client.patch(
            "/api/blocks/" + bid,
            headers=t["master"].headers,
            json={"expected_revision": 2, "community_url": "https://example.com"},
        ).status_code
        == 409
    )
    r = client.get("/api/blocks/" + bid, headers=t["master"].headers).json()
    assert r["master"]["user"]["user_id"] == t["master"].user_id and r["members"] == []
    assert "view_tasks" in r["capabilities"]


def visible_request(client, actor, request_id):
    items = client.get("/api/block-requests", headers=actor.headers).json()["items"]
    return next((r for r in items if r["request_id"] == request_id), None)


def test_rejection_reason_reaches_everyone_who_sees_the_request(client, team, make_user, superuser):
    """Decision 16: the applicant, the chair, the whole HR team and the block's leads read
    when and why a request was rejected; nobody else sees the request."""
    t = team
    hr_member, stranger = make_user(), make_user()
    joined = command(client, join(client, hr_member, t["ids"]["HR"]), "hr-approve", t["hr"])
    assert joined.json()["state"] == "approved"
    r = join(client, t["user"], t["ids"]["IT"])
    opened = visible_request(client, t["user"], r["request_id"])
    assert opened["decided_at"] is None and opened["decision_reason"] is None
    rejected = client.post(
        f"/api/block-requests/{r['request_id']}/reject",
        headers=t["hr"].headers,
        json={"expected_revision": r["revision"], "reason": "Набор в блок закрыт"},
    )
    assert rejected.status_code == 200, rejected.text
    for reader in (t["user"], superuser, t["hr"], hr_member, t["master"]):
        seen = visible_request(client, reader, r["request_id"])
        assert seen is not None, reader.user_id
        assert seen["decision_reason"] == "Набор в блок закрыт"
        assert seen["decided_at"] is not None
    assert visible_request(client, stranger, r["request_id"]) is None


def test_approval_has_a_date_but_no_reason(client, team):
    t = team
    r = command(client, join(client, t["user"], t["ids"]["HR"]), "hr-approve", t["hr"]).json()
    seen = visible_request(client, t["user"], r["request_id"])
    assert seen["state"] == "approved" and seen["decided_at"] and seen["decision_reason"] is None


def test_unchanged_category_is_not_a_new_revision(client, superuser, make_user):
    """A-ROL-12: saving the same category neither moves the revision nor writes the audit."""
    from database import AuditLogORM

    u = make_user()
    current = client.get(f"/api/participants/{u.user_id}/category", headers=superuser.headers).json()
    with db._session() as s:
        before = s.query(AuditLogORM).count()
    same = client.patch(
        f"/api/participants/{u.user_id}/category",
        headers=superuser.headers,
        json={"category": current["category"], "reason": "Проверка", "expected_revision": current["revision"]},
    )
    assert same.status_code == 200, same.text
    assert same.json()["revision"] == current["revision"]
    with db._session() as s:
        assert s.query(AuditLogORM).count() == before
    other = "activist" if current["category"] == "junior" else "junior"
    changed = client.patch(
        f"/api/participants/{u.user_id}/category",
        headers=superuser.headers,
        json={"category": other, "reason": "Проверка", "expected_revision": current["revision"]},
    )
    assert changed.status_code == 200 and changed.json()["revision"] == current["revision"] + 1
