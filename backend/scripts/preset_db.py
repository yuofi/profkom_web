"""Idempotent content seed and explicit bootstrap for an empty installation."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from settings import settings
from database import db, UserORM, LeadershipORM, RoleAssignmentORM
from models import ContactInfo, User, Guide
from auth import hash_password
import uuid


def preset_guides():
    existing = {g.title for g in db.list_guides()}
    for name in ("гайды", "информация", "КМБ"):
        path = Path(__file__).resolve().parents[1] / "md" / f"{name}.md"
        if name not in existing and path.is_file():
            db.create_guide(
                Guide(
                    guide_id=0,
                    title=name,
                    owner_block="none",
                    text=path.read_text(),
                    original_link=None,
                )
            )
    from materials import legacy_mapping

    with db.atomic():
        with db._session() as s:
            for guide in db.list_guides():
                legacy_mapping(s, guide.guide_id)
            s.commit()


def set_admin(superadmin=True, custom_payload=None):
    if not superadmin:
        raise ValueError("Use explicit-ID migration for domain roles")
    with db.atomic():
        with db._session() as s:
            lead = s.get(LeadershipORM, 1)
            if lead and lead.chair_user_id:
                return
            if s.query(UserORM).count():
                print(
                    "Existing accounts preserved. Map the initial chair by user_id using scripts/migrate_v13.py."
                )
                return
            if custom_payload is None:
                if not settings.ADMIN_NAME or not settings.ADMIN_PASSWORD:
                    print(
                        "Bootstrap disabled: configure ADMIN_NAME and ADMIN_PASSWORD for an empty installation."
                    )
                    return
                payload = dict(
                    name=settings.ADMIN_NAME,
                    password=settings.ADMIN_PASSWORD,
                    email=settings.ADMIN_NAME + "@example.com",
                    surname="",
                    patronymic="",
                    group_number="101",
                    tg="",
                )
            else:
                payload = custom_payload
            if len(payload["password"]) < 12:
                raise ValueError(
                    "Bootstrap password must contain at least 12 characters"
                )
            c = ContactInfo(
                user_id=0,
                name=payload["name"],
                surname=payload.get("surname", ""),
                patronymic=payload.get("patronymic", ""),
                email=payload["email"],
                kkr_name=" ".join(
                    filter(None, [payload.get("surname"), payload["name"]])
                ),
                group_number=str(payload.get("group_number", "101")),
                tg=payload.get("tg", ""),
                in_profcom=True,
            )
            u = db.create_user_with_contact(
                c,
                User(
                    user_id=0,
                    hashed_password=hash_password(payload["password"]),
                    group_number=c.group_number,
                    account_state="active",
                ),
            )
            if not lead:
                lead = LeadershipORM(id=1, deputies_json="[]", revision=1)
                s.add(lead)
            lead.chair_user_id = u.user_id
            s.add(
                RoleAssignmentORM(
                    role_assignment_id=str(uuid.uuid4()),
                    user_id=u.user_id,
                    role="chair",
                    scope_kind="global",
                    scope_id=None,
                    revision=1,
                )
            )
            from domain_seed import ensure_application, now
            from participation import open_interval

            ensure_application(s, u.user_id)
            open_interval(s, u.user_id, now())
            s.commit()
            print("Created the explicitly configured initial chair.")


if __name__ == "__main__":
    preset_guides()
    set_admin()
