#!/usr/bin/env python3
"""Dry-run reads IDs/counts only. --apply requires an explicit complete ID mapping.

Mapping JSON: {"actor_user_id": 1, "bindings": [{"queue_id": "queue-ID",
"source_kind": "block|event|subevent|chair", "source_id": "stable-ID",
"expected_revision": 1, "expected_task_count": 0}]}.
Use a server-side backup before applying to the explicitly authorized test DB.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--mapping", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    path = args.database.resolve(strict=True)
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
        queues = [dict(queue_id=row[0], revision=row[1], task_count=row[2]) for row in connection.execute(
            "SELECT q.queue_id, q.revision, COUNT(t.task_id) FROM task_queues q "
            "LEFT JOIN tasks t ON t.scope_kind='queue' AND t.scope_id=q.queue_id "
            "WHERE q.scope_kind='queue' AND q.scope_id=q.queue_id GROUP BY q.queue_id,q.revision ORDER BY q.queue_id")]
    if not args.apply:
        print(json.dumps(dict(apply=False, independent_queues=queues)))
        return
    if not args.mapping:
        parser.error("--apply requires --mapping")
    data = json.loads(args.mapping.read_text())
    if not isinstance(data.get("actor_user_id"), int) or not isinstance(data.get("bindings"), list):
        parser.error("Mapping must include actor_user_id and bindings")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    os.environ["DATABASE_PATH"] = str(path)
    from queue_rebinding import apply_bindings
    result = apply_bindings(data["bindings"], data["actor_user_id"])
    print(json.dumps(dict(apply=True, queues=result)))


if __name__ == "__main__":
    main()
