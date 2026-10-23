"""Explicit-ID operator migration. Default mode is genuinely read-only.

Both modes report `unresolved`: what the operator still has to map or accept before the
site opens (MIGRATION_V13.md). After --apply it is the current state of the database;
`initial_report` keeps the state the first apply found, before any mapping.
"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migration_report  # noqa: E402

CATEGORIES = ("junior", "activist")


def inspect_database(path):
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as c:
        tables = {
            r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        counts = {
            name: c.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            for name in sorted(tables)
            if not name.startswith("sqlite_")
        }
        return dict(
            integrity=c.execute("PRAGMA quick_check").fetchone()[0], counts=counts
        )


def review(path):
    """The operator's sections, read without changing the database."""
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as c:
        return dict(
            unresolved=migration_report.unresolved(c),
            guides=migration_report.guides(c),
            categories=migration_report.categories(c),
        )


def schema_gaps(path):
    """Columns and indexes of the current code that the migrated database lacks."""
    import database
    from integrity_migration import INDEXES

    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as c:
        missing_columns = {}
        for table in database.Base.metadata.sorted_tables:
            have = migration_report.columns(c, table.name)
            lack = sorted(col.name for col in table.columns if col.name not in have)
            if lack:
                missing_columns[table.name] = lack
        present = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    wanted = {
        index.name
        for table in database.Base.metadata.sorted_tables
        for index in table.indexes
        if index.name
    } | set(INDEXES) | {"uq_notification_event", "ux_contact_info_email", "v13_contact_email_lower"}
    return dict(missing_columns=missing_columns, missing_indexes=sorted(wanted - present))


def echo(mapping):
    """The applied mapping by IDs only: a category reason stays in the audit log."""
    out = {k: v for k, v in mapping.items() if k != "categories"}
    if "categories" in mapping:
        out["categories"] = [
            dict(user_id=v["user_id"], category=v["category"]) for v in mapping["categories"]
        ]
    return out


def apply_mapping(mapping):
    from database import (
        db,
        UserORM,
        LeadershipORM,
        RoleAssignmentORM,
        ExternalIdentityORM,
        BlockORM,
    )
    from domain_models import BlockMetaORM, CategoryRevisionORM, ProfileMetadataORM
    from database import FileRecordORM
    from legacy_files import legacy_key
    from registration import audit, now
    from participation import dt
    import uuid

    allowed = {
        "chair_user_id",
        "deputy_chair_user_ids",
        "hr_block_id",
        "block_masters",
        "vk_identities",
        "participation_intervals",
        "categories",
        "reset_avatars",
    }
    if set(mapping) - allowed:
        raise ValueError(
            "Unknown mapping fields: " + str(sorted(set(mapping) - allowed))
        )
    with db.atomic():
        with db._session() as s:

            def active(uid):
                u = s.get(UserORM, uid)
                if not u or u.account_state != "active" or u.banned:
                    raise ValueError(f"User {uid} must be approved and active")
                return u

            def current(uid):
                # A VK login opens a pending application too: the old VK login created
                # accounts before their approval.
                u = s.get(UserORM, uid)
                if not u or u.banned or u.account_state in ("archived", "purged"):
                    raise ValueError(f"User {uid} must be a current account")
                return u

            if mapping.get("chair_user_id") is not None:
                uid = mapping["chair_user_id"]
                active(uid)
                lead = s.get(LeadershipORM, 1)
                if lead and lead.chair_user_id not in (None, uid):
                    raise ValueError(
                        "Existing chair differs; use the normal transfer command"
                    )
                if not lead:
                    lead = LeadershipORM(id=1, deputies_json="[]", revision=1)
                    s.add(lead)
                lead.chair_user_id = uid
                if (
                    not s.query(RoleAssignmentORM)
                    .filter_by(scope_kind="global", role="chair", user_id=uid)
                    .first()
                ):
                    s.add(
                        RoleAssignmentORM(
                            role_assignment_id=str(uuid.uuid4()),
                            user_id=uid,
                            scope_kind="global",
                            role="chair",
                            scope_id=None,
                            revision=1,
                        )
                    )
                s.flush()
            if "deputy_chair_user_ids" in mapping:
                lead = s.get(LeadershipORM, 1)
                if not lead or not lead.chair_user_id:
                    raise ValueError("Map a chair before deputies")
                desired = mapping["deputy_chair_user_ids"]
                if sorted(json.loads(lead.deputies_json or "[]")) != sorted(desired):
                    db.set_chair_deputies(desired, lead.revision)
            if mapping.get("hr_block_id"):
                meta = s.get(BlockMetaORM, mapping["hr_block_id"])
                if not meta:
                    raise ValueError("Unknown HR block ID")
                for block in s.query(BlockORM):
                    block.is_hr = block.name == meta.legacy_name
            for value in mapping.get("block_masters", []):
                if set(value) != {"block_id", "user_id"}:
                    raise ValueError("Invalid block master mapping")
                meta = s.get(BlockMetaORM, value["block_id"])
                active(value["user_id"])
                if not meta:
                    raise ValueError("Unknown block ID")
                b = s.get(BlockORM, meta.legacy_name)
                if b.master_user_id != value["user_id"]:
                    db.set_block_leader(b.name, value["user_id"])
            for value in mapping.get("vk_identities", []):
                if (
                    set(value) != {"vk_user_id", "user_id"}
                    or not str(value["vk_user_id"]).isdigit()
                    or int(value["vk_user_id"]) <= 0
                ):
                    raise ValueError("Invalid verified VK mapping")
                current(value["user_id"])
                subject = "vk:" + str(value["vk_user_id"])
                existing = s.get(ExternalIdentityORM, subject)
                other = (
                    s.query(ExternalIdentityORM)
                    .filter_by(user_id=value["user_id"])
                    .first()
                )
                if (existing and existing.user_id != value["user_id"]) or (
                    other and other.subject != subject
                ):
                    raise ValueError("VK identity mapping conflict")
                if not existing:
                    s.add(
                        ExternalIdentityORM(subject=subject, user_id=value["user_id"])
                    )
                    s.flush()
            from domain_models import ParticipationORM

            for value in mapping.get("participation_intervals", []):
                if set(value) - {"user_id", "started_at", "ended_at"} or not {
                    "user_id",
                    "started_at",
                } <= set(value):
                    raise ValueError("Invalid participation interval")
                uid = value["user_id"]
                active(uid)
                start = dt(value["started_at"])
                end = dt(value["ended_at"]) if value.get("ended_at") else None
                if end and end <= start:
                    raise ValueError("Invalid participation interval order")
                normalized = dict(
                    user_id=uid,
                    started_at=start.isoformat(),
                    ended_at=end.isoformat() if end else None,
                )
                if s.query(ParticipationORM).filter_by(**normalized).first():
                    continue
                rows = s.query(ParticipationORM).filter_by(user_id=uid).all()
                overlaps = [
                    r
                    for r in rows
                    if (end is None or dt(r.started_at) < end)
                    and (not r.ended_at or start < dt(r.ended_at))
                ]
                from domain_models import MigrationORM

                observation = s.get(MigrationORM, "v13-observed-participation")
                observed = (
                    json.loads(observation.report_json).get("observed_interval_ids", {})
                    if observation
                    else {}
                )
                if (
                    len(overlaps) == 1
                    and end is None
                    and overlaps[0].ended_at is None
                    and overlaps[0].interval_id == observed.get(str(uid))
                    and start <= dt(overlaps[0].started_at)
                ):
                    # The operator supplied a verified earlier date for the continuous
                    # observed interval; this never shortens known participation.
                    overlaps[0].started_at = start.isoformat()
                    s.flush()
                    continue
                if overlaps:
                    raise ValueError("Overlapping participation interval")
                s.add(
                    ParticipationORM(
                        interval_id=str(uuid.uuid4()),
                        participant_id=f"participant-{uid}",
                        **normalized,
                    )
                )
                s.flush()
            for value in mapping.get("categories", []):
                if (
                    set(value) != {"user_id", "category", "reason"}
                    or value["category"] not in CATEGORIES
                    or not str(value["reason"]).strip()
                ):
                    raise ValueError("Invalid category mapping")
                u = active(value["user_id"])
                if u.category == value["category"]:
                    continue
                rev = s.get(CategoryRevisionORM, u.user_id)
                if rev:
                    rev.revision += 1
                else:
                    s.add(CategoryRevisionORM(user_id=u.user_id, revision=2))
                audit(
                    s,
                    "participant_category",
                    u.user_id,
                    0,
                    str(value["reason"]).strip(),
                    dict(category=u.category),
                    dict(category=value["category"]),
                )
                u.category = value["category"]
                s.flush()
            # Decision 34: the operator resets by ID a photo the old VK login may have copied.
            # A photo chosen since then stays; the old object is not deleted.
            for uid in mapping.get("reset_avatars", []):
                u = s.get(UserORM, uid) if isinstance(uid, int) else None
                if not u:
                    raise ValueError("Invalid avatar reset")
                if not u.photo_url:
                    continue
                meta = s.get(ProfileMetadataORM, uid)
                if not meta:
                    meta = ProfileMetadataORM(user_id=uid, participation_periods_json="[]")
                    s.add(meta)
                adopted = s.get(FileRecordORM, meta.avatar_file_id) if meta.avatar_file_id else None
                if adopted and adopted.storage_key and adopted.storage_key == legacy_key(u.photo_url):
                    meta.avatar_file_id = None
                if not meta.avatar_file_id:
                    meta.preset_id = "default"
                audit(s, "avatar", uid, 0, "Possible copy of a VK photo", dict(legacy_photo=True), dict(preset="default"))
                u.photo_url = None
                s.flush()
            # Mapping is idempotent; audit contains IDs, never passwords or OAuth tokens.
            audit(
                s,
                "migration",
                "v13-explicit-ids",
                0,
                "Explicit operator mapping",
                {},
                mapping,
            )
            s.commit()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--mapping", type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.database.is_absolute() or not args.database.is_file():
        parser.error("Use an existing absolute database path")
    report = dict(
        mode="apply" if args.apply else "dry_run",
        before=inspect_database(args.database),
        source_sha256=hashlib.sha256(args.database.read_bytes()).hexdigest(),
    )
    mapping = json.loads(args.mapping.read_text()) if args.mapping else {}
    if args.apply:
        os.environ["DATABASE_PATH"] = str(args.database)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import database
        from domain_models import MigrationORM, BlockMetaORM

        # The state the startup migration leaves before the first mapping (A-DIR-17).
        with database.db.atomic(), database.db._session() as s:
            if not s.get(MigrationORM, "v13-initial-report"):
                s.add(
                    MigrationORM(
                        version="v13-initial-report",
                        completed_at=datetime.now(timezone.utc).isoformat(),
                        report_json=json.dumps(review(args.database)["unresolved"], ensure_ascii=False),
                    )
                )
                s.commit()
        apply_mapping(mapping)
        with database.db._session() as s:
            # What each step recorded when it ran; the current state is `unresolved`.
            report["migrations"] = [
                dict(version=m.version, completed_at=m.completed_at, report=json.loads(m.report_json))
                for m in s.query(MigrationORM)
                if m.version != "v13-initial-report"
            ]
            first = s.get(MigrationORM, "v13-initial-report")
            report["initial_report"] = dict(
                completed_at=first.completed_at, unresolved=json.loads(first.report_json)
            )
            report["blocks"] = [
                dict(block_id=m.block_id, legacy_name=m.legacy_name)
                for m in s.query(BlockMetaORM)
            ]
        report["applied_mapping"] = echo(mapping)
        report.update(review(args.database))
        report["schema"] = schema_gaps(args.database)
        report["after"] = inspect_database(args.database)
    else:
        report["mapping_fields"] = sorted(mapping)
        report.update(review(args.database))
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            dict(mode=report["mode"], report=str(args.report)), ensure_ascii=False
        )
    )


if __name__ == "__main__":
    main()
