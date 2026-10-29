"""Narrow, idempotent material corrections; never infer block community addresses."""
import hashlib
import json
import re

PUBLIC_COMMUNITY_URL = "https://vk.ru/profkomvmk"
OLD_PLACEHOLDER = "Материалы блока готовятся. Обратитесь к мастеру."


def placeholder_text(session, block_id):
    from database import BlockORM
    from domain_models import BlockMetaORM
    meta = session.get(BlockMetaORM, block_id)
    block = session.get(BlockORM, meta.legacy_name) if meta else None
    contact = "Обратитесь к мастеру блока." if block and block.master_user_id else "Мастер блока пока не назначен. Обратитесь в Профком."
    text = f"Материалы блока готовятся. {contact}\n\n[Паблик Профкома]({PUBLIC_COMMUNITY_URL})"
    if meta and meta.community_url:
        # The persisted address was explicitly set through the validated block command.
        text += f"\n\n[Сообщество блока]({meta.community_url})"
    return text


def refresh_placeholders(session):
    from domain_models import MaterialORM
    for material in session.query(MaterialORM).filter_by(placeholder=True, revision=1, has_draft=False, deleted=False):
        if material.owner_block_id:
            material.published_body = placeholder_text(session, material.owner_block_id)


def migrate_kmb():
    from database import db, GuideORM
    from domain_models import MaterialORM, MigrationORM
    from datetime import datetime, timezone
    pattern = re.compile(r"(^|>)\*\* (\S[^*\n]*?)\*\*", re.M)
    with db.atomic():
        with db._session() as session:
            report = []
            for material in session.query(MaterialORM).filter_by(kind="kmb"):
                for field in ("published_body", "draft_body"):
                    source = getattr(material, field)
                    if source is not None:
                        updated, count = pattern.subn(r"\1**\2**", source)
                        if count:
                            setattr(material, field, updated)
                            report.append(dict(material_id=material.material_id, field=field, changed_lines=count, source_sha256=hashlib.sha256(source.encode()).hexdigest()))
                guide = session.get(GuideORM, material.legacy_guide_id) if material.legacy_guide_id else None
                if guide:
                    updated, count = pattern.subn(r"\1**\2**", guide.text or "")
                    if count:
                        guide.text = updated
                        report.append(dict(guide_id=guide.guide_id, field="text", changed_lines=count))
            marker = session.get(MigrationORM, "kmb-bold-spacing-20261028")
            if report:
                if marker:
                    previous = json.loads(marker.report_json)
                    report = previous + report
                else:
                    marker = MigrationORM(version="kmb-bold-spacing-20261028", completed_at=datetime.now(timezone.utc).isoformat())
                    session.add(marker)
                marker.report_json = json.dumps(report)
            refresh_placeholders(session)
            session.commit()
