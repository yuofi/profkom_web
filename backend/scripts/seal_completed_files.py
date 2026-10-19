"""Cutover helper: freeze old completed file IDs before opening the upgraded API.

Default is read-only SQLite inspection without importing app/settings or calling
storage. --apply performs storage I/O and needs explicit environment approval.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys


def seal_completed():
    from database import db, FileRecordORM
    from file_access import ensure_sealed

    count = 0
    with db._session() as session:
        for row in session.query(FileRecordORM).filter_by(state="completed"):
            ensure_sealed(row)
            count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    path = args.database.resolve()
    if not path.is_file():
        parser.error("Database must be an existing file")
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            parser.error("Database quick_check failed")
        exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_records'").fetchone()
        count = connection.execute("SELECT count(*) FROM file_records WHERE state='completed'").fetchone()[0] if exists else 0
    if args.apply:
        os.environ["DATABASE_PATH"] = str(path)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        count = seal_completed()
    print(json.dumps(dict(mode="apply" if args.apply else "dry-run", completed=count, external_calls=args.apply)))


if __name__ == "__main__":
    main()
