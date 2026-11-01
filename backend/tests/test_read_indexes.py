"""PB-33: startup adds read indexes idempotently, on fresh and old SQLite schemas.

The notification feed reads a keyset on (created_at DESC, notification_id DESC) through
GL-16's ix_notifications_feed; its order is total, so no index can change it."""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine

import database
from database import engine

NAMES = {name: table for name, table, _columns in database._READ_INDEXES}
HOT = {
    "role_assignments": "SELECT * FROM role_assignments WHERE principal_assignment_id=?",
    "block": "SELECT * FROM block WHERE master_user_id=?",
    "task_access_grants": "SELECT * FROM task_access_grants WHERE user_id=? AND active=1",
    "task_queue_members": "SELECT * FROM task_queue_members WHERE user_id=?",
    "notifications": "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC, notification_id DESC",
    "submissions": "SELECT * FROM submissions WHERE assignment_id=? ORDER BY submitted_at",
    "task_comments": "SELECT * FROM task_comments WHERE task_id=? ORDER BY created_at",
    "task_queue_requests": "SELECT * FROM task_queue_requests WHERE queue_id=? AND user_id=? ORDER BY created_at DESC",
}


def _indexes(connection):
    return {row[0]: row[1] for row in connection.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index'")}


def test_fresh_schema_reads_use_indexes_without_temporary_sort():
    with sqlite3.connect(engine.url.database) as connection:
        assert NAMES.items() <= _indexes(connection).items()
        for table, sql in HOT.items():
            plan = " ".join(row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + sql, [1] * sql.count("?")))
            assert "USING INDEX" in plan and "SCAN" not in plan and "TEMP B-TREE" not in plan, (table, plan)


OLD = """
CREATE TABLE block(name VARCHAR PRIMARY KEY, master VARCHAR NOT NULL, hr VARCHAR NOT NULL DEFAULT '',
  cnt_of_human INTEGER NOT NULL DEFAULT 0, arr_of_human TEXT NOT NULL DEFAULT '[]');
CREATE TABLE notifications(notification_id VARCHAR PRIMARY KEY, user_id INTEGER NOT NULL, kind VARCHAR NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}', is_read BOOLEAN NOT NULL DEFAULT 0, created_at VARCHAR NOT NULL);
CREATE INDEX custom_notification_index ON notifications(user_id);
CREATE TABLE task_comments(comment_id TEXT PRIMARY KEY, task_id TEXT, author_user_id INTEGER, content_json TEXT,
  history_json TEXT, created_at TEXT, updated_at TEXT);
INSERT INTO block(name, master) VALUES ('Старый', 'Мастер');
INSERT INTO notifications VALUES ('n1', 7, 'kind', '{}', 0, 'same'), ('n2', 7, 'kind', '{}', 1, 'same'),
  ('n3', 7, 'kind', '{}', 0, 'later');
INSERT INTO task_comments VALUES ('c2', 'task-old', 7, '{}', '[]', 'same', NULL), ('c1', 'task-old', 7, '{}', '[]', 'same', NULL);
"""


def test_old_schema_gains_indexes_twice_and_keeps_rows_and_tie_order(tmp_path):
    path = tmp_path / "old-read-indexes.db"
    with sqlite3.connect(path) as connection:
        connection.executescript(OLD)
        rows = {table: connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
                for table in ("block", "notifications", "task_comments")}
        ordered = [
            "SELECT notification_id FROM notifications WHERE user_id=7 ORDER BY created_at DESC, notification_id DESC",
            "SELECT comment_id FROM task_comments WHERE task_id='task-old' ORDER BY created_at",
        ]
        before = [connection.execute(sql).fetchall() for sql in ordered]
    # The whole startup chain: block.master_user_id is added before its index.
    for _ in range(2):
        result = subprocess.run([sys.executable, "-c", "import database"], cwd=Path(__file__).resolve().parents[1],
                                env={**os.environ, "DATABASE_PATH": str(path)}, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        with sqlite3.connect(path) as connection:
            indexes = _indexes(connection)
            assert NAMES.items() <= indexes.items() and indexes["custom_notification_index"] == "notifications"
            assert indexes["ix_notifications_feed"] == "notifications"
            for table, old in rows.items():
                current = connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
                assert [row[:len(old[0])] for row in current] == old
            # Equal timestamps keep the order the former temporary sort produced.
            assert [connection.execute(sql).fetchall() for sql in ordered] == before
            plan = " ".join(row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + ordered[0]))
            assert "ix_notifications_feed" in plan and "TEMP B-TREE" not in plan, plan


def test_missing_table_or_column_is_skipped(tmp_path):
    path = tmp_path / "partial.db"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE block(name VARCHAR PRIMARY KEY, master VARCHAR NOT NULL)")
    partial = create_engine(f"sqlite:///{path}")
    try:
        for _ in range(2):
            database._ensure_sqlite_read_indexes(partial)
    finally:
        partial.dispose()
    with sqlite3.connect(path) as connection:
        assert not set(NAMES) & set(_indexes(connection))
