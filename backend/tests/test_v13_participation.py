from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
import uuid
import pytest
from database import db, UserORM, BlockORM
from domain_models import ParticipationORM, MembershipORM, MigrationORM
from participation import participation_seconds, promote
from models import Block

START = datetime(2026, 1, 1, tzinfo=timezone.utc)
END = START + timedelta(days=10)
S = SimpleNamespace(
    starts_at=START.isoformat(), ends_at=END.isoformat(), season_id="synthetic-season"
)


def interval(s, u, a, b=None):
    s.add(
        ParticipationORM(
            interval_id=str(uuid.uuid4()),
            participant_id=f"participant-{u.user_id}",
            user_id=u.user_id,
            started_at=a.isoformat(),
            ended_at=b.isoformat() if b else None,
        )
    )


@pytest.mark.parametrize(
    "offset,expected",
    [
        (timedelta(days=5, microseconds=-1), "activist"),
        (timedelta(days=5), "activist"),
        (timedelta(days=5, microseconds=1), "junior"),
    ],
)
def test_half_season_threshold(make_user, offset, expected):
    u = make_user()
    with db.atomic():
        with db._session() as s:
            interval(s, u, START + offset)
            s.flush()
            promote(s, S, END.isoformat())
            s.commit()
    assert db.get_user(u.user_id).category == expected


def test_archived_and_future_days_do_not_count(make_user):
    u = make_user()
    with db.atomic():
        with db._session() as s:
            interval(s, u, START, START + timedelta(days=2))
            interval(s, u, START + timedelta(days=8))
            s.flush()
            assert (
                participation_seconds(
                    s,
                    f"participant-{u.user_id}",
                    S.starts_at,
                    S.ends_at,
                    END.isoformat(),
                )
                == 4 * 86400
            )
            promote(s, S, (START + timedelta(days=2)).isoformat())
            s.commit()
    assert db.get_user(u.user_id).category == "junior"


def test_block_newcomer_and_global_category_are_independent(
    client, make_user, superuser
):
    from membership import block_id_for

    u = make_user()
    db.update_user(u.user_id, category="activist")
    db.create_block(Block(name="IT", master="", arr_of_human=[u.user_id]))
    bid = block_id_for("IT")
    with db.atomic():
        with db._session() as s:
            interval(s, u, START)
            s.add(
                MembershipORM(
                    membership_id=str(uuid.uuid4()),
                    participant_id=f"participant-{u.user_id}",
                    user_id=u.user_id,
                    block_id=bid,
                    joined_at=(START + timedelta(days=6)).isoformat(),
                    category="junior",
                )
            )
            s.flush()
            promote(s, S, END.isoformat())
            s.commit()
    assert db.get_user(u.user_id).category == "activist"
    with db._session() as s:
        assert (
            s.query(MembershipORM).filter_by(user_id=u.user_id).first().category
            == "junior"
        )


def test_manual_category_requires_authority_reason_and_revision(
    client, user, superuser
):
    url = f"/api/participants/{user.user_id}/category"
    assert (
        client.patch(
            url,
            headers=user.headers,
            json={"expected_revision": 1, "category": "activist", "reason": "self"},
        ).status_code
        == 403
    )
    r = client.patch(
        url,
        headers=superuser.headers,
        json={"expected_revision": 1, "category": "activist", "reason": "Подтверждено"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 2
    assert (
        client.patch(
            url,
            headers=superuser.headers,
            json={"expected_revision": 1, "category": "junior", "reason": "conflict"},
        ).status_code
        == 409
    )


def test_migration_preserves_membership_without_invented_dates(make_user):
    from migrations_v13 import migrate_core

    u = make_user(in_profcom=True)
    pending = make_user(in_profcom=False)
    db.create_block(
        Block(name="Legacy", master="Ambiguous Name", arr_of_human=[u.user_id])
    )
    with db._session() as s:
        s.query(MigrationORM).filter_by(version="v13-membership").delete()
        s.commit()
    migrate_core()
    migrate_core()
    assert db.get_user(u.user_id).account_state == "active"
    assert db.get_user(pending.user_id).account_state == "pending"
    with db._session() as s:
        assert s.query(MembershipORM).filter_by(user_id=u.user_id).count() == 1
        assert (
            s.query(MembershipORM).filter_by(user_id=u.user_id).one().joined_at is None
        )
        assert s.query(ParticipationORM).count() == 0
        assert s.get(BlockORM, "Legacy").master_user_id is None


def test_unknown_legacy_dates_count_only_after_first_observation(make_user):
    import json
    from domain_seed import meta_for, seed_members
    from observed_participation_seed import seed_observed_participation, VERSION

    u = make_user(in_profcom=True)
    db.create_block(Block(name="Observed", master="", arr_of_human=[u.user_id]))
    with db.atomic():
        with db._session() as s:
            s.query(MigrationORM).filter_by(version=VERSION).delete()
            b = s.get(BlockORM, "Observed")
            meta = meta_for(s, b.name)
            seed_members(s, b, meta)
            bid = meta.block_id
            s.commit()
    seed_observed_participation(START.isoformat())
    seed_observed_participation((START + timedelta(days=2)).isoformat())
    with db.atomic():
        with db._session() as s:
            member = (
                s.query(MembershipORM).filter_by(user_id=u.user_id, block_id=bid).one()
            )
            assert member.joined_at is None
            assert (
                participation_seconds(
                    s,
                    f"participant-{u.user_id}",
                    (START - timedelta(days=10)).isoformat(),
                    START.isoformat(),
                    END.isoformat(),
                    bid,
                )
                == 0
            )
            assert (
                participation_seconds(
                    s,
                    f"participant-{u.user_id}",
                    START.isoformat(),
                    END.isoformat(),
                    END.isoformat(),
                    bid,
                )
                == 10 * 86400
            )
            promote(s, S, END.isoformat())
            s.commit()
            assert (
                s.get(UserORM, u.user_id).category == "activist"
                and member.category == "member"
            )
