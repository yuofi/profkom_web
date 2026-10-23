"""Adopt the old public uploads as files the API serves (АВ-10, decision 23).

Run from backend/ after the v13 migration and repair_storage_links.py:
    python scripts/adopt_legacy_files.py --database /abs/db [--apply]

The old site saved public bucket links: users.photo_url, pgas_entries.file_url and links
in guide texts. Each old upload gets a completed file record that keeps the object's own
key (`storage_key`, nothing is copied), and the link becomes `file:<id>`: an avatar
becomes profile_metadata.avatar_file_id, a PGAS entry and a material text refer to
`file:<id>`. The API then serves these bytes with the access check of every request,
and the bucket can be made private. Links to other bucket keys (sealed/, private/ of
someone else, unknown) are never adopted: that would open them (A-SEC-2); they are
counted. Nothing here calls the storage: the size of an adopted object is stored as 0,
its type comes from the extension. The default mode opens the database read-only. Only
numbers are printed: no text, URL, name or ID. A second --apply changes 0 rows.
"""

import argparse
import json
import sqlite3
import sys
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from file_types import mime_for  # noqa: E402
from legacy_files import LINK, legacy_key, storage_key  # noqa: E402
from settings import settings  # noqa: E402

AVATAR_TYPES = ("image/png", "image/jpeg", "image/webp")
TEXTS = (("materials", "published_body"), ("materials", "draft_body"))
REQUIRED = ("users", "file_records", "profile_metadata", "materials")


class Files:
    """File records of adopted keys, reused per owner so that a rerun adds none."""

    def __init__(self, c, apply):
        self.c, self.apply, self.created = c, apply, 0
        columns = {r[1] for r in c.execute("PRAGMA table_info(file_records)")}
        self.known = {}
        if "storage_key" in columns:
            for fid, kind, owner, key in c.execute(
                "SELECT file_id, owner_kind, owner_id, storage_key FROM file_records"
                " WHERE storage_key IS NOT NULL AND state='completed'"
            ):
                self.known[(kind, owner, key)] = fid

    def find(self, kind, owner, key):
        return self.known.get((kind, owner, key))

    def adopt(self, kind, owner, key, name, mime, uploaded_by):
        fid = self.find(kind, owner, key)
        if fid:
            return fid
        fid = f"file-{uuid.uuid4()}"
        self.known[(kind, owner, key)] = fid
        self.created += 1
        if self.apply:
            now = datetime.now(timezone.utc).isoformat()
            self.c.execute(
                "INSERT INTO file_records (file_id, owner_kind, owner_id, purpose, name, mime_type,"
                " size_bytes, uploaded_by_user_id, state, created_at, expires_at, storage_key)"
                " VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'completed', ?, ?, ?)",
                (fid, kind, owner, kind, name, mime, uploaded_by or 0, now, now, key),
            )
        return fid


def base_name(key):
    return unquote(key.rpartition("/")[2]) or "file"


def outside(key):
    folder = key.partition("/")[0].lower()
    return folder if folder in ("sealed", "private") else "other"


def adopt_avatars(c, files, apply):
    counts = Counter()
    for uid, url in c.execute(
        "SELECT user_id, photo_url FROM users WHERE photo_url IS NOT NULL AND account_state != 'purged'"
    ).fetchall():
        key = legacy_key(url)
        if not key:
            if storage_key(url):
                counts["kept_" + outside(storage_key(url))] += 1
            continue
        meta = c.execute(
            "SELECT avatar_file_id, preset_id FROM profile_metadata WHERE user_id=?", (uid,)
        ).fetchone()
        mime = mime_for(key)
        if meta and meta[0] and meta[0] == files.find("avatar", str(uid), key):
            counts["already"] += 1
        elif meta and (meta[0] or meta[1]):
            counts["superseded"] += 1  # a new avatar or a preset chosen since
        elif mime not in AVATAR_TYPES:
            counts["not_an_image"] += 1
        else:
            fid = files.adopt("avatar", str(uid), key, base_name(key), mime, uid)
            counts["adopted"] += 1
            if apply:
                if meta:
                    c.execute("UPDATE profile_metadata SET avatar_file_id=? WHERE user_id=?", (fid, uid))
                else:
                    c.execute(
                        "INSERT INTO profile_metadata (user_id, participation_periods_json, avatar_file_id)"
                        " VALUES (?, '[]', ?)",
                        (uid, fid),
                    )
    return dict(sorted(counts.items()))


def adopt_pgas(c, files, apply):
    counts = Counter()
    for entry_id, url, name, uploaded_by in c.execute(
        "SELECT entry_id, file_url, file_name, uploaded_by FROM pgas_entries"
    ).fetchall():
        if url.startswith("file:"):
            counts["already"] += 1
            continue
        key = legacy_key(url)
        if not key:
            counts["kept_" + (outside(storage_key(url)) if storage_key(url) else "external")] += 1
            continue
        name = name or base_name(key)
        mime = mime_for(name) or mime_for(key) or "application/octet-stream"
        owner = str(uploaded_by) if uploaded_by is not None else None
        fid = files.adopt("pgas", owner, key, name, mime, uploaded_by)
        counts["adopted"] += 1
        if apply:
            c.execute("UPDATE pgas_entries SET file_url=? WHERE entry_id=?", ("file:" + fid, entry_id))
    return dict(sorted(counts.items()))


def adopt_text(body, material_id, files, counts):
    def fix(m):
        url = m[0]
        key = legacy_key(url)
        if not key:
            if storage_key(url):
                counts["kept_" + outside(storage_key(url))] += 1
            return url
        counts["links_adopted"] += 1
        name = base_name(key)
        mime = mime_for(name) or "application/octet-stream"
        return "file:" + files.adopt("material", material_id, key, name, mime, None)

    return LINK.sub(fix, body)


def adopt_texts(c, files, apply, tables):
    report = {}
    for table, column in TEXTS:
        counts, changed = Counter(), 0
        for material_id, body in c.execute(f'SELECT material_id, "{column}" FROM materials').fetchall():
            if body is None:
                continue
            new = adopt_text(body, material_id, files, counts)
            if new != body:
                changed += 1
                if apply:
                    c.execute(f'UPDATE materials SET "{column}"=? WHERE material_id=?', (new, material_id))
        report[f"{table}.{column}"] = dict(rows_changed=changed, **dict(sorted(counts.items())))
    if "guides" in tables:
        # The old guide keeps the text of its material (materials.publish writes it too).
        mapping = dict(c.execute(
            "SELECT legacy_guide_id, material_id FROM materials WHERE legacy_guide_id IS NOT NULL"
        ))
        counts, changed = Counter(), 0
        for guide_id, body in c.execute("SELECT guide_id, text FROM guides").fetchall():
            if body is None:
                continue
            if guide_id not in mapping:
                counts["without_material"] += 1
                continue
            new = adopt_text(body, mapping[guide_id], files, counts)
            if new != body:
                changed += 1
                if apply:
                    c.execute("UPDATE guides SET text=? WHERE guide_id=?", (new, guide_id))
        report["guides.text"] = dict(rows_changed=changed, **dict(sorted(counts.items())))
    return report


def adopt(c, apply):
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = [t for t in REQUIRED if t not in tables]
    if missing:
        raise SystemExit("The v13 schema is required (missing: " + ", ".join(missing) + ")")
    if apply:
        columns = {r[1] for r in c.execute("PRAGMA table_info(file_records)")}
        for name in ("sealed_at", "storage_key"):
            if name not in columns:  # as the upgraded backend adds them on start
                c.execute(f"ALTER TABLE file_records ADD COLUMN {name} VARCHAR")
    files = Files(c, apply)
    report = dict(avatars=adopt_avatars(c, files, apply))
    if "pgas_entries" in tables:
        report["pgas"] = adopt_pgas(c, files, apply)
    report["texts"] = adopt_texts(c, files, apply, tables)
    report["file_records_created"] = files.created
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="Create the records and rewrite the links; otherwise only count")
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
        report = adopt(c, args.apply)
        if args.apply:
            c.execute("COMMIT")
    finally:
        c.close()
    print(json.dumps(dict(mode="apply" if args.apply else "dry_run", external_calls=False, **report), indent=2))


if __name__ == "__main__":
    main()
