"""Approved directory, independent former-contact cards and owned avatars."""

import json
import uuid
from urllib.parse import urlsplit
from pydantic import Field, model_validator
from fastapi import Depends
from database import db, UserORM, FileRecordORM
from domain_models import ProfileMetadataORM, FormerContactORM, MigrationORM
from auth import get_current_user
from models import User
from api_contract import Page
from domain_contract import FormerContact as FormerOut
from validation import Command
from registration import audit, now, fail

PRESETS = {
    "default": "По умолчанию",
    "leaf": "Лист",
    "moon": "Луна",
    "mountain": "Горы",
    "star": "Звезда",
    "sun": "Солнце",
    "wave": "Волна",
}


class Period(Command):
    from_year: int = Field(ge=1900, le=2200)
    to_year: int = Field(ge=1900, le=2200)

    @model_validator(mode="after")
    def ordered(self):
        if self.from_year > self.to_year:
            raise ValueError("Participation period is reversed")
        return self


class Former(Command):
    surname: str = Field(min_length=1)
    name: str = Field(min_length=1)
    patronymic: str | None = None
    phone: str = ""
    email: str = ""
    tg: str = ""
    vk: str = ""
    participation_periods: list[Period] = []


class Avatar(Command):
    preset_id: str | None = None
    file_id: str | None = None

    @model_validator(mode="after")
    def exactly_one(self):
        if len(self.model_fields_set) != 1 or bool(self.preset_id) == bool(
            self.file_id
        ):
            raise ValueError("Choose exactly one preset_id or file_id")
        return self


def metadata(s, uid):
    m = s.get(ProfileMetadataORM, uid)
    if not m:
        m = ProfileMetadataORM(
            user_id=uid, participation_periods_json="[]", preset_id="default"
        )
        s.add(m)
        s.flush()
    return m


def is_vk_photo(url):
    host = (urlsplit(url or "").hostname or "").lower()
    return any(
        host == h or host.endswith("." + h)
        for h in (
            "vk.com",
            "vk.ru",
            "vkuserphoto.ru",
            "userapi.com",
            "vk-cdn.net",
            "vkuser.net",
        )
    )


def avatar_url(uid):
    with db._session() as s:
        u = s.get(UserORM, uid)
        if not u:
            return "/avatars/default.svg"
        m = s.get(ProfileMetadataORM, uid)
        if m and m.avatar_file_id:
            fr = s.get(FileRecordORM, m.avatar_file_id)
            if fr and fr.state == "completed":
                from file_access import key
                from settings import settings
                from utils.s3_service import s3_client

                return s3_client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": settings.S3_BUCKET_NAME, "Key": key(fr.file_id)},
                    ExpiresIn=300,
                )
        if m and m.preset_id:
            return "/avatars/" + m.preset_id + ".svg"
        if u.photo_url and not is_vk_photo(u.photo_url):
            from legacy_files import read_url

            return read_url(u.photo_url, uid)
        return "/avatars/default.svg"


def contact_data(c):
    with db._session() as s:
        m = s.get(ProfileMetadataORM, c.user_id)
        return {
            **c.__dict__,
            "photo_url": avatar_url(c.user_id),
            "participation_periods": (
                json.loads(m.participation_periods_json or "[]") if m else []
            ),
        }


def contacts(q=None, group_number=None, blocks=None, in_profcom=None, budget=None):
    result = []
    from database import BlockORM

    wanted = [x.strip() for x in (blocks or "").split(",") if x.strip()]
    with db._session() as s:
        names = {b.name for b in s.query(BlockORM)}
        from domain_models import BlockMetaORM

        aliases = {m.block_id: m.legacy_name for m in s.query(BlockMetaORM)}
    wanted = [aliases.get(x, x) for x in wanted]
    if any(x not in names for x in wanted):
        return []
    for c in db.list_contacts():
        u = db.get_user(c.user_id)
        if not u or u.account_state != "active" or u.banned:
            continue
        if group_number is not None and c.group_number != str(group_number):
            continue
        if in_profcom is not None and c.in_profcom != in_profcom:
            continue
        if budget is not None and c.budget != budget:
            continue
        if any(not db.is_block_member(c.user_id, x) for x in wanted):
            continue
        if (
            q
            and q.casefold()
            not in " ".join(
                str(getattr(c, k, ""))
                for k in ("surname", "name", "patronymic", "phone", "email", "tg", "vk")
            ).casefold()
        ):
            continue
        result.append(contact_data(c))
    return result


def register_routes(router):
    @router.get("/contacts/emails")
    def emails(
        q: str | None = None,
        group_number: str | None = None,
        blocks: str | None = None,
        in_profcom: bool | None = None,
        budget: bool | None = None,
        cur: User = Depends(get_current_user),
    ):
        return dict(
            emails=sorted(
                {
                    c["email"].strip()
                    for c in contacts(q, group_number, blocks, in_profcom, budget)
                    if c["email"].strip()
                }
            )
        )

    @router.get("/contacts/archive", response_model=Page[FormerOut])
    def former(q: str | None = None, cur: User = Depends(get_current_user)):
        with db._session() as s:
            cards = [
                dict(contact_id=c.contact_id, **json.loads(c.fields_json))
                for c in s.query(FormerContactORM).order_by(FormerContactORM.created_at)
            ]
            return Page(
                items=[
                    c
                    for c in cards
                    if not q
                    or q.casefold() in " ".join(str(v) for v in c.values()).casefold()
                ]
            )

    def save(payload, uid, cid=None):
        if not (db.is_tachki(uid) or db.is_hr_master(uid)):
            fail(403, "Former-contact editor required")
        with db._session() as s:
            c = s.get(FormerContactORM, cid) if cid else None
            if cid and not c:
                fail(404, "Former contact not found")
            old = json.loads(c.fields_json) if c else {}
            if not c:
                c = FormerContactORM(contact_id=str(uuid.uuid4()), created_at=now())
                s.add(c)
            c.fields_json = payload.model_dump_json()
            c.updated_at = now()
            audit(
                s,
                "former_contact",
                c.contact_id,
                uid,
                "Former contact saved",
                old,
                payload.model_dump(),
            )
            s.commit()
            return dict(contact_id=c.contact_id, **payload.model_dump())

    @router.post("/contacts/archive", response_model=FormerOut)
    def create(payload: Former, cur: User = Depends(get_current_user)):
        return save(payload, cur.user_id)

    @router.patch("/contacts/archive/{contact_id}", response_model=FormerOut)
    def patch(contact_id: str, payload: Former, cur: User = Depends(get_current_user)):
        return save(payload, cur.user_id, contact_id)

    @router.get("/avatars")
    def presets(cur: User = Depends(get_current_user)):
        return dict(
            items=[
                dict(preset_id=id, title=title, image_url="/avatars/" + id + ".svg")
                for id, title in PRESETS.items()
            ],
            default_preset_id="default",
        )

    @router.put("/profile/me/avatar")
    def avatar(payload: Avatar, cur: User = Depends(get_current_user)):
        with db._session() as s:
            if payload.preset_id and payload.preset_id not in PRESETS:
                fail(422, "Unknown avatar preset")
            if payload.file_id:
                fr = s.get(FileRecordORM, payload.file_id)
                if (
                    not fr
                    or fr.owner_kind != "avatar"
                    or fr.owner_id != str(cur.user_id)
                    or fr.uploaded_by_user_id != cur.user_id
                    or fr.state != "completed"
                ):
                    fail(422, "Completed own avatar file required")
            m = metadata(s, cur.user_id)
            m.preset_id = payload.preset_id
            m.avatar_file_id = payload.file_id
            s.get(UserORM, cur.user_id).photo_url = None
            audit(
                s,
                "avatar",
                str(cur.user_id),
                cur.user_id,
                "Avatar changed",
                {},
                dict(preset_id=m.preset_id, file_id=m.avatar_file_id),
            )
            s.commit()
        return contact_data(db.get_contact(cur.user_id))
