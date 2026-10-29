"""Disposable old SQLite schemas: preserve independent cards and reject ambiguous sources."""
import pytest
from sqlalchemy import create_engine, text
import database


def test_old_former_schema_upgrades_twice_without_inferred_identity(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "old-former.db"))
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE former_contacts (contact_id VARCHAR PRIMARY KEY, fields_json TEXT NOT NULL)"))
        conn.execute(text("INSERT INTO former_contacts VALUES ('first', '{\"name\":\"Same namesake\"}'), ('second', '{\"name\":\"Same namesake\"}')"))
    monkeypatch.setattr(database, "engine", engine)
    for _ in range(2):
        database._ensure_sqlite_former_contact_columns()
    with engine.connect() as conn:
        assert conn.execute(text("SELECT contact_id,fields_json,revision,source_user_id FROM former_contacts ORDER BY contact_id")).all() == [
            ("first", '{"name":"Same namesake"}', 1, None), ("second", '{"name":"Same namesake"}', 1, None)]
        indexes = conn.execute(text("PRAGMA index_list(former_contacts)")).all()
        assert sum(row[1] == "uq_former_contact_source_user" and row[2] == 1 for row in indexes) == 1
    engine.dispose()


def test_duplicate_source_cards_require_explicit_repair_without_merging(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "duplicate-former.db"))
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE former_contacts (contact_id VARCHAR PRIMARY KEY, fields_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, source_user_id INTEGER)"))
        conn.execute(text("INSERT INTO former_contacts VALUES ('first','{}',2,7), ('second','{\"phone\":\"independent\"}',4,7)"))
    monkeypatch.setattr(database, "engine", engine)
    with engine.connect() as conn:
        before = conn.execute(text("SELECT * FROM former_contacts ORDER BY contact_id")).all()
    for _ in range(2):
        with pytest.raises(RuntimeError, match="explicit repair"):
            database._ensure_sqlite_former_contact_columns()
    with engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM former_contacts ORDER BY contact_id")).all() == before
        assert not any(row[1] == "uq_former_contact_source_user" for row in conn.execute(text("PRAGMA index_list(former_contacts)")))
    engine.dispose()


def test_old_scope_tenures_upgrade_twice_without_guessing_identity_or_dates(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "old-tenures.db"))
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE scope_tenures (tenure_id VARCHAR PRIMARY KEY, scope_kind VARCHAR, scope_id VARCHAR, started_at VARCHAR, ended_at VARCHAR)"))
        conn.execute(text("INSERT INTO scope_tenures VALUES ('old','block','Reused name','2020-01-01',NULL)"))
    monkeypatch.setattr(database, "engine", engine)
    for _ in range(2):
        database._ensure_sqlite_scope_tenure_provenance()
    with engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM scope_tenures")).one() == ("old", "block", "Reused name", "2020-01-01", None, None)
    engine.dispose()
