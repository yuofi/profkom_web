"""Repair bucket links saved into material and guide texts (FIX_PLAN 0.2, A-MAT-1).

Run from backend/: python scripts/repair_storage_links.py --database /abs/db [--apply]

Editors used to receive texts with 5-minute signed links and saved them back. This
puts every text in its stored form: a link to the material's own attachment becomes
`file:<id>`, a signed link to an old public upload becomes its canonical URL. Links
to other bucket keys (sealed/ or private/ of someone else, unknown keys) are left as
written and are no longer signed (owner decision 6); they are only counted, as are
such keys in users.photo_url (A-SEC-2). The default mode opens the database
read-only. Only numbers are printed: no text, URL or ID. A second --apply changes 0
rows.
"""

import argparse
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from legacy_files import LINK, legacy_key, storage_key, stored_text  # noqa: E402
from settings import settings  # noqa: E402

TEXTS = (
    ("materials", "material_id", "published_body"),
    ("materials", "material_id", "draft_body"),
    ("guides", "guide_id", "text"),
)


def outside(key):
    folder = key.partition("/")[0].lower()
    return folder if folder in ("sealed", "private") else "other"


def attachments(c, material_id):
    def owner(key):
        if not material_id or not key.startswith("sealed/"):
            return None
        row = c.execute(
            "SELECT file_id FROM file_records WHERE file_id=? AND state='completed'"
            " AND owner_kind='material' AND owner_id=?",
            (key[len("sealed/") :], material_id),
        ).fetchone()
        return row[0] if row else None

    return owner


def count_outside(body, counter):
    for url in LINK.findall(body or ""):
        key = storage_key(url)
        if key and not legacy_key(url):
            counter[outside(key)] += 1


def repair(c, apply):
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    report = dict(texts={}, outside_allowed={}, photo_url={})
    guide_material = (
        dict(c.execute("SELECT legacy_guide_id, material_id FROM materials WHERE legacy_guide_id IS NOT NULL"))
        if "materials" in tables
        else {}
    )
    for table, pk, column in TEXTS:
        if table not in tables:
            continue
        counts, kept = Counter(), Counter()
        changed = 0
        for row_id, body in c.execute(f'SELECT "{pk}", "{column}" FROM "{table}"').fetchall():
            if body is None:
                continue
            material_id = row_id if table == "materials" else guide_material.get(row_id)
            attachment = attachments(c, material_id) if "file_records" in tables else lambda key: None
            new = stored_text(body, attachment, counts=counts)
            count_outside(new, kept)
            if new != body:
                changed += 1
                if apply:
                    c.execute(f'UPDATE "{table}" SET "{column}"=? WHERE "{pk}"=?', (new, row_id))
        report["texts"][f"{table}.{column}"] = dict(rows_changed=changed, **dict(sorted(counts.items())))
        report["outside_allowed"][f"{table}.{column}"] = dict(sorted(kept.items()))
    if "users" in tables:
        photos = Counter()
        for (url,) in c.execute("SELECT photo_url FROM users WHERE photo_url IS NOT NULL"):
            key = storage_key(url)
            if key:
                photos["legacy" if legacy_key(url) else outside(key)] += 1
        report["photo_url"] = dict(sorted(photos.items()))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="Write the repaired texts; otherwise only count")
    args = parser.parse_args()
    if not args.database.is_absolute() or not args.database.is_file():
        parser.error("Use an existing absolute database path")
    if not settings.S3_BUCKET_NAME:
        parser.error("S3_BUCKET_NAME is required to recognise bucket links")
    mode = "rw" if args.apply else "ro"
    c = sqlite3.connect(args.database.as_uri() + f"?mode={mode}", uri=True, isolation_level=None)
    try:
        if args.apply:
            c.execute("BEGIN IMMEDIATE")
        report = repair(c, args.apply)
        if args.apply:
            c.execute("COMMIT")
    finally:
        c.close()
    print(json.dumps(dict(mode="apply" if args.apply else "dry_run", **report), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
