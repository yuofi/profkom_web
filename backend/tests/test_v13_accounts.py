import json
from datetime import datetime, timezone, timedelta
from auth import create_access_token, create_refresh_token
from database import (
    db,
    UserORM,
    RoleAssignmentORM,
    LeadershipORM,
    ContributionORM,
    SeasonSummaryORM,
)
from domain_models import (
    AccountArchiveORM,
    MembershipORM,
    FormerContactORM,
    SummaryVersionORM,
)
from account_cleanup import purge, expires_at
from test_v13_tracker import work
from test_v13_season_integrity import accept, close


def test_archive_revoke_and_restore_master_conflicts(
    client, superuser, make_user, make_block
):
    old = make_user(in_profcom=True)
    new = make_user()
    b = make_block()
    db.set_block_leader(b.name, old.user_id)
    bid = client.get("/api/blocks", headers=superuser.headers).json()[0]["block_id"]
    assert (
        client.post(
            f"/api/accounts/{old.user_id}/archive",
            headers=new.headers,
            json=dict(reason="Reason"),
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/accounts/{superuser.user_id}/archive",
            headers=superuser.headers,
            json=dict(reason="Reason"),
        ).status_code
        == 409
    )
    refresh = create_refresh_token(old.user_id)
    r = client.post(
        f"/api/accounts/{old.user_id}/archive",
        headers=superuser.headers,
        json=dict(reason="Reason"),
    )
    assert r.status_code == 200, r.text
    stale = client.put(
        "/api/blocks/" + bid + "/leader",
        headers=superuser.headers,
        json=dict(expected_revision=1, user_id=new.user_id),
    )
    assert stale.status_code == 409
    assert client.get("/api/session", headers=old.headers).status_code in (401, 403)
    assert (
        client.post("/api/auth/refresh", json=dict(refresh_token=refresh)).status_code
        == 401
    )
    db.set_block_leader(b.name, new.user_id)
    conflict = client.post(
        f"/api/accounts/{old.user_id}/restore",
        headers=superuser.headers,
        json=dict(master_conflicts=[]),
    )
    assert conflict.status_code == 409, conflict.text
    assert db.get_user(old.user_id).account_state == "archived"
    restored = client.post(
        f"/api/accounts/{old.user_id}/restore",
        headers=superuser.headers,
        json=dict(master_conflicts=[dict(block_id=bid, keep_user_id=old.user_id)]),
    )
    assert restored.status_code == 200, restored.text
    assert db.is_block_master(old.user_id, b.name) and not db.is_block_master(
        new.user_id, b.name
    )
    assert client.get("/api/session", headers=old.headers).status_code == 401
    assert (
        client.get(
            "/api/session",
            headers={"Authorization": "Bearer " + create_access_token(old.user_id)},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/accounts/{old.user_id}/archive",
            headers=superuser.headers,
            json=dict(reason="Again"),
        ).status_code
        == 200
    )
    db.set_block_leader(b.name, new.user_id)
    assert (
        client.post(
            f"/api/accounts/{old.user_id}/restore",
            headers=superuser.headers,
            json=dict(master_conflicts=[dict(block_id=bid, keep_user_id=new.user_id)]),
        ).status_code
        == 200
    )
    assert not db.is_block_master(old.user_id, b.name)


def test_transferred_global_roles_never_restore(client, superuser, make_user):
    deputy = make_user()
    next_chair = make_user()
    lead = db.get_leadership()
    db.set_chair_deputies([deputy.user_id], lead.revision)
    assert (
        client.post(
            f"/api/accounts/{deputy.user_id}/archive",
            headers=superuser.headers,
            json=dict(reason="Archive"),
        ).status_code
        == 200
    )
    lead = db.get_leadership()
    db.transfer_chair(next_chair.user_id, lead.revision)
    h = {"Authorization": "Bearer " + create_access_token(next_chair.user_id)}
    r = client.post(
        f"/api/accounts/{deputy.user_id}/restore",
        headers=h,
        json=dict(master_conflicts=[]),
    )
    assert r.status_code == 200, r.text
    assert not db.is_deputy_chair(deputy.user_id)
    assert (
        client.post(
            f"/api/accounts/{superuser.user_id}/archive",
            headers=h,
            json=dict(reason="Former chair"),
        ).status_code
        == 200
    )


def test_cleanup_exact_boundary_idempotence_and_frozen_accounting(
    client, work, superuser
):
    accept(client, work)
    summary = close(client, work, superuser)
    uid = work["member"].user_id
    sid = work["season"]["season_id"]
    total = next(
        r["total_score"] for r in summary["rows"] if r["user"]["user_id"] == uid
    )
    former = client.post(
        "/api/contacts/archive",
        headers=superuser.headers,
        json=dict(
            surname="Согласованный",
            name="Контакт",
            phone="",
            email="",
            tg="",
            vk="",
            participation_periods=[],
        ),
    ).json()
    assert (
        client.post(
            f"/api/accounts/{uid}/archive",
            headers=superuser.headers,
            json=dict(reason="Archive"),
        ).status_code
        == 200
    )
    with db._session() as s:
        a = s.get(AccountArchiveORM, uid)
        a.archived_at = "2020-02-29T12:00:00+00:00"
        from registration import audit

        audit(
            s,
            "registration",
            str(uid),
            uid,
            "Historical fields",
            dict(
                name="Former name",
                surname="Former surname",
                email="old@example.com",
                group_number="101",
            ),
            dict(name="Current name", email="current@example.com"),
        )
        s.commit()
    end = expires_at("2020-02-29T12:00:00+00:00")
    assert end.isoformat() == "2023-02-28T12:00:00+00:00"
    assert purge(end - timedelta(microseconds=1), False)["purged_count"] == 0
    assert purge(end, True)["eligible_user_ids"] == [uid]
    assert db.get_user(uid).account_state == "archived"
    assert purge(end, False)["purged_count"] == 1
    assert purge(end, False)["purged_count"] == 0
    assert (
        client.post(
            f"/api/accounts/{uid}/restore",
            headers=superuser.headers,
            json=dict(master_conflicts=[]),
        ).status_code
        == 409
    )
    assert db.get_contact(uid) is None
    with db._session() as s:
        assert s.get(FormerContactORM, former["contact_id"]) is not None
        a = s.get(AccountArchiveORM, uid)
        assert a.snapshot_json == "{}"
        from database import AuditLogORM

        historical = (
            s.query(AuditLogORM)
            .filter_by(target_kind="registration", target_id=str(uid))
            .one()
        )
        assert all(v is None for v in json.loads(historical.old_values_json).values())
        assert all(v is None for v in json.loads(historical.new_values_json).values())
        for version in s.query(SummaryVersionORM).filter_by(season_id=sid):
            r = next(
                r
                for r in json.loads(version.summary_json)["rows"]
                if r["participant_id"] == a.anonymous_participant_id
            )
            assert r["user"]["user_id"] is None and r["total_score"] == total
    after = client.get(
        "/api/seasons/" + sid + "/summary", headers=superuser.headers
    ).json()
    assert any(
        r["user"]["user_id"] is None and r["total_score"] == total
        for r in after["rows"]
    )


def test_archive_membership_intervals_and_deputies_restore(
    client, superuser, make_user, make_block
):
    from domain_seed import meta_for
    from membership import set_membership
    from participation import open_interval
    from domain_models import ParticipationORM
    from accounts import Restore, restore, archive

    member = make_user(in_profcom=True)
    b = make_block()
    db.set_block_leader(b.name, member.user_id)
    with db.atomic():
        with db._session() as s:
            bid = meta_for(s, b.name).block_id
            set_membership(
                s,
                member.user_id,
                bid,
                True,
                superuser.user_id,
                "Seed approved membership",
            )
            open_interval(s, member.user_id, "2025-01-01T00:00:00+00:00")
            s.commit()
    archive(member.user_id, "Leave", superuser.user_id)
    with db._session() as s:
        assert (
            s.query(MembershipORM)
            .filter_by(user_id=member.user_id, left_at=None)
            .count()
            == 0
        )
        assert (
            s.query(ParticipationORM)
            .filter_by(user_id=member.user_id, ended_at=None)
            .count()
            == 0
        )
    restore(member.user_id, Restore(), superuser.user_id)
    with db._session() as s:
        assert (
            s.query(MembershipORM)
            .filter_by(user_id=member.user_id, left_at=None)
            .count()
            == 1
        )
        assert s.query(MembershipORM).filter_by(user_id=member.user_id).count() == 2
        assert s.query(ParticipationORM).filter_by(user_id=member.user_id).count() == 2
    assert db.is_block_master(member.user_id, b.name)


def test_cleanup_object_queue_retries_without_repeating_database_purge(
    client, superuser, make_user, monkeypatch
):
    from account_cleanup import delete_pending_objects
    from domain_models import ObjectDeletionORM
    from utils.s3_service import s3_client
    from accounts import archive

    member = make_user(
        photo_url="https://global.s3.cloud.ru/test-bucket/avatars/own.png"
    )
    archive(member.user_id, "Leave", superuser.user_id)
    with db._session() as s:
        s.get(AccountArchiveORM, member.user_id).archived_at = (
            "2020-01-01T00:00:00+00:00"
        )
        s.commit()
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 1

    def fail(**kwargs):
        raise RuntimeError("synthetic storage outage")

    monkeypatch.setattr(s3_client, "delete_object", fail)
    import pytest

    with pytest.raises(RuntimeError):
        delete_pending_objects()
    with db._session() as s:
        assert s.query(ObjectDeletionORM).filter_by(completed_at=None).count() == 1
    keys = []
    monkeypatch.setattr(s3_client, "delete_object", lambda **kw: keys.append(kw["Key"]))
    assert delete_pending_objects() == 1 and keys == ["avatars/own.png"]
    assert delete_pending_objects() == 0
