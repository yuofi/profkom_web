"""Run from backend/: python scripts/cleanup_accounts.py --database /abs/db [--apply]."""

import argparse
import os
import sys
import json
import sqlite3
import calendar
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser(
    description="Clear archived accounts after three calendar years"
)
parser.add_argument("--database", required=True, type=Path)
parser.add_argument("--as-of", help="Aware ISO timestamp, for deterministic rehearsal")
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--apply", action="store_true", help="Apply database cleanup and enqueue owned objects; no storage calls")
mode.add_argument("--delete-pending", action="store_true", help="Explicitly drain the previously committed object-deletion queue")
args = parser.parse_args()
if not args.database.is_absolute() or not args.database.is_file():
    parser.error("Select an existing absolute database path")
if not args.apply and not args.delete_pending:
    # Do not import the application: startup migrations must not write during dry-run.
    stamp = (
        datetime.fromisoformat(args.as_of.replace("Z", "+00:00"))
        if args.as_of
        else datetime.now(timezone.utc)
    )
    if stamp.tzinfo is None:
        parser.error("--as-of requires a timezone")
    with sqlite3.connect(args.database.as_uri() + "?mode=ro", uri=True) as c:
        if not c.execute(
            "SELECT 1 FROM sqlite_master WHERE name='account_archives'"
        ).fetchone():
            print(
                json.dumps(
                    dict(
                        eligible_user_ids=[],
                        purged_count=0,
                        dry_run=True,
                        schema="not_migrated",
                    )
                )
            )
            sys.exit(0)
        ids = []
        for uid, archived in c.execute(
            "SELECT a.user_id,a.archived_at FROM account_archives a JOIN users u ON u.user_id=a.user_id "
            "WHERE a.restored_at IS NULL AND a.purged_at IS NULL AND u.account_state='archived'"
        ):
            at = datetime.fromisoformat(archived.replace("Z", "+00:00"))
            expiry = at.replace(
                year=at.year + 3,
                day=min(at.day, calendar.monthrange(at.year + 3, at.month)[1]),
            )
            if expiry <= stamp:
                ids.append(uid)
    print(json.dumps(dict(eligible_user_ids=ids, purged_count=0, dry_run=True)))
    sys.exit(0)
os.environ["DATABASE_PATH"] = str(args.database)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_cleanup import purge, delete_pending_objects

result = (dict(deleted_objects=delete_pending_objects()) if args.delete_pending
          else purge(args.as_of, dry_run=False))
print(json.dumps(result, ensure_ascii=False))
