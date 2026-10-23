"""Idempotent domain migration; string names and legacy flags never grant roles."""

import json, uuid
from database import db, UserORM, ContactInfoORM, BlockORM, RoleAssignmentORM
from domain_models import MigrationORM
from domain_seed import ensure_application, now


def migrate_core():
    from domain_seed import meta_for, seed_members

    with db.atomic():
        with db._session() as s:
            if s.get(MigrationORM, "v13-membership"):
                return
            report = {
                "users": 0,
                "blocks": 0,
                "unmapped_block_ids": [],
                "unknown_participation_dates": [],
                "incomplete_user_ids": [],
            }
            for u in s.query(UserORM):
                c = s.get(ContactInfoORM, u.user_id)
                if not c:
                    # A row without contacts is not a participant (A-DIR-16, decision 35).
                    if u.account_state != "archived":
                        u.account_state = "pending"
                    report["incomplete_user_ids"].append(u.user_id)
                    continue
                if u.account_state != "archived":
                    u.account_state = (
                        "active" if c.in_profcom and not u.banned else "pending"
                    )
                ensure_application(s, u.user_id)
                report["users"] += 1
                if u.account_state == "active":
                    report["unknown_participation_dates"].append(u.user_id)
            categorize(s)
            for b in s.query(BlockORM):
                m = meta_for(s, b.name)
                seed_members(s, b, m, migrated=True)
                report["blocks"] += 1
                if b.master and not b.master_user_id:
                    report["unmapped_block_ids"].append(m.block_id)
                if b.master_user_id and s.get(UserORM, b.master_user_id):
                    if (
                        not s.query(RoleAssignmentORM)
                        .filter_by(scope_kind="block", scope_id=b.name, role="master")
                        .first()
                    ):
                        s.add(
                            RoleAssignmentORM(
                                role_assignment_id=str(uuid.uuid4()),
                                user_id=b.master_user_id,
                                role="master",
                                scope_kind="block",
                                scope_id=b.name,
                                revision=1,
                            )
                        )
            s.add(
                MigrationORM(
                    version="v13-membership",
                    completed_at=now(),
                    report_json=json.dumps(report),
                )
            )
            s.commit()


def categorize(s):
    """Approved accounts of the old site, which called them all activists, keep that
    category: they are not demoted for lack of old dates (CODEX_BACKEND.md:2141,
    decision 36). Only the accounts that got the default of the new column change."""
    from database import AuditLogORM
    from domain_models import CategoryRevisionORM

    column = s.get(MigrationORM, "v13-category-column")
    if not column or s.get(MigrationORM, "v13-categories"):
        return
    decided = {"activist": [], "junior": []}
    for uid in json.loads(column.report_json)["defaulted_user_ids"]:
        u = s.get(UserORM, uid)
        if not u or u.account_state != "active" or u.banned or u.category != "junior":
            decided["junior"].append(uid)
            continue
        u.category = "activist"
        rev = s.get(CategoryRevisionORM, uid)
        if rev:
            rev.revision += 1
        else:
            s.add(CategoryRevisionORM(user_id=uid, revision=2))
        # registration.audit, which this startup step cannot import yet.
        s.add(
            AuditLogORM(
                target_kind="participant_category",
                target_id=str(uid),
                changed_by_user_id=0,
                reason="Approved participant of the old site",
                old_values_json=json.dumps(dict(category="junior")),
                new_values_json=json.dumps(dict(category="activist")),
                created_at=now(),
            )
        )
        decided["activist"].append(uid)
    s.add(
        MigrationORM(
            version="v13-categories", completed_at=now(), report_json=json.dumps(decided)
        )
    )
    s.flush()


def preserve_closed_summaries():
    """Seed immutable history from stored totals, never from today's roster or formula."""
    from database import SeasonORM, SeasonSummaryORM, ContributionORM, MasterBonusORM
    from domain_models import SummaryVersionORM, BlockMetaORM

    with db.atomic():
        with db._session() as s:
            blocks = {m.legacy_name: m.block_id for m in s.query(BlockMetaORM)}
            for summary in s.query(SeasonSummaryORM).filter_by(state="approved"):
                if (
                    s.query(SummaryVersionORM)
                    .filter_by(season_id=summary.season_id, version=summary.version)
                    .first()
                ):
                    continue
                rows = json.loads(summary.rows_json or "[]")
                for row in rows:
                    for block in row.get("blocks", []):
                        block["block_id"] = blocks.get(
                            block.get("block_id"), block.get("block_id")
                        )
                    for source in row.get("source_scores", []):
                        if source.get("source_kind") in (
                            "block_task",
                            "block_volunteer",
                            "master_bonus",
                        ):
                            source["source_id"] = blocks.get(
                                source.get("source_id"), source.get("source_id")
                            )
                summary.rows_json = json.dumps(rows, ensure_ascii=False)
                season = s.get(SeasonORM, summary.season_id)
                previous = (
                    s.query(SeasonSummaryORM)
                    .filter_by(season_id=season.previous_season_id)
                    .first()
                    if season and season.previous_season_id
                    else None
                )
                ledger = [
                    dict(
                        contribution_id=c.contribution_id,
                        participant_id=c.participant_id,
                        source_kind=c.source_kind,
                        source_id=(
                            blocks.get(c.source_id, c.source_id)
                            if c.source_kind
                            in ("block_task", "block_volunteer", "master_bonus")
                            else c.source_id
                        ),
                        source_title=c.source_title,
                        score=c.score,
                        calculation_version=c.calculation_version,
                    )
                    for c in s.query(ContributionORM).filter_by(
                        season_id=summary.season_id
                    )
                ]
                bonuses = [
                    dict(
                        bonus_id=b.bonus_id,
                        recipient_participant_id=b.recipient_participant_id,
                        basis=json.loads(b.basis_json or "[]"),
                        amount=b.amount,
                        calculation_version=b.calculation_version,
                    )
                    for b in s.query(MasterBonusORM).filter_by(
                        season_id=summary.season_id
                    )
                ]
                s.add(
                    SummaryVersionORM(
                        snapshot_id=str(uuid.uuid4()),
                        season_id=summary.season_id,
                        version=summary.version,
                        summary_json=json.dumps(
                            dict(
                                season_id=summary.season_id,
                                state="approved",
                                version=summary.version,
                                approved_at=summary.approved_at,
                                rows=rows,
                                capabilities=["view_summary"],
                            ),
                            ensure_ascii=False,
                        ),
                        contributions_json=json.dumps(ledger, ensure_ascii=False),
                        bonuses_json=json.dumps(bonuses, ensure_ascii=False),
                        previous_summary_version=previous.version if previous else None,
                        changed_by_user_id=None,
                        reason="Утверждённая сводная перенесена со старого сайта",
                        created_at=now(),
                    )
                )
            s.commit()
