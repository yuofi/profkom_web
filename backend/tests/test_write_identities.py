"""A write unit keeps loaded ORM objects alive without caching values or permissions."""
from contextlib import contextmanager

import pytest
from sqlalchemy import event, text, update

import access
from database import db, engine, UserORM, LeadershipORM
from read_context import _HELD


@contextmanager
def sql_calls():
    statements = []

    def count(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", count)


def _leadership(chair_id):
    with db._session() as s:
        row = s.get(LeadershipORM, 1)
        if row is None:
            s.add(LeadershipORM(id=1, chair_user_id=chair_id, deputies_json="[]"))
        else:
            row.chair_user_id, row.deputies_json = chair_id, "[]"
        s.commit()


def test_repeated_primary_key_reads_are_held_until_the_write_unit_ends(make_user):
    actor = make_user(password=None)
    _leadership(actor.user_id)
    with db.atomic(write=True):
        with db._session() as s:
            s.get(UserORM, actor.user_id)
            with sql_calls() as repeated:
                for _ in range(5):
                    assert s.get(UserORM, actor.user_id).user_id == actor.user_id
                    db.is_chair(actor.user_id)
            assert len([q for q in repeated if "FROM users" in q]) == 0
            assert len([q for q in repeated if "FROM leadership" in q]) == 1
            assert s.session.info.get(_HELD)
    with db._session() as s:
        assert _HELD not in s.info


@pytest.mark.parametrize("command", ["orm_bulk", "core", "driver"])
def test_core_or_driver_command_releases_held_objects(make_user, command):
    actor = make_user(password=None)
    with db.atomic(write=True):
        with db._session() as lease:
            s = lease.session
            assert s.get(UserORM, actor.user_id).group_number == "101"
            if command == "orm_bulk":
                s.query(UserORM).filter_by(user_id=actor.user_id).update({"group_number": "202"}, synchronize_session=False)
            elif command == "core":
                s.execute(update(UserORM).where(UserORM.user_id == actor.user_id).values(group_number="202")
                          .execution_options(synchronize_session=False))
            else:
                s.connection().exec_driver_sql("UPDATE users SET group_number='202' WHERE user_id=?", (actor.user_id,))
            assert _HELD not in s.info
            # Nothing references the old object any more: the next read sees the command.
            assert s.get(UserORM, actor.user_id).group_number == "202"
            # Ordinary ORM work afterwards keeps the weak, uncached behaviour.
            with sql_calls() as again:
                s.get(UserORM, actor.user_id)
            assert len(again) <= 1


def test_flush_keeps_held_objects_consistent_and_rollback_discards_them(make_user):
    actor = make_user(password=None)
    with pytest.raises(RuntimeError):
        with db.atomic(write=True):
            with db._session() as lease:
                s = lease.session
                s.get(UserORM, actor.user_id).group_number = "303"
                s.flush()
                assert _HELD in s.info
                assert s.get(UserORM, actor.user_id).group_number == "303"
                raise RuntimeError("rollback")
    with db._session() as s:
        assert s.get(UserORM, actor.user_id).group_number == "101"


def test_same_write_unit_role_change_is_seen_by_permission_checks(make_user):
    """Holding objects is not a permission cache: ACL reads the current ORM state."""
    chair = make_user(password=None)
    other = make_user(password=None)
    _leadership(chair.user_id)
    with db.atomic(write=True):
        with db._session() as s:
            assert access.allowed(chair.user_id, "season.create")
            assert not access.allowed(other.user_id, "season.create")
            s.get(LeadershipORM, 1).chair_user_id = other.user_id
            s.flush()
            assert access.allowed(other.user_id, "season.create")
            assert not access.allowed(chair.user_id, "season.create")
            # A textual command afterwards still reaches the permission check.
            s.execute(text("UPDATE leadership SET chair_user_id=:uid WHERE id=1"), {"uid": chair.user_id})
            assert access.allowed(chair.user_id, "season.create")
            assert not access.allowed(other.user_id, "season.create")
