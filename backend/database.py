from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Text, create_engine, func, text
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker, joinedload

from models import (
    Block as BlockDC,
    ContactInfo as ContactInfoDC,
    Event as EventDC,
    Guide as GuideDC,
    Leader as LeaderDC,
    Leadership as LeadershipDC,
    Meeting as MeetingDC,
    PgasEntry as PgasEntryDC,
    ReportSeries as ReportSeriesDC,
    RichText as RichTextDC,
    RoleAssignment as RoleAssignmentDC,
    Season as SeasonDC,
    SeasonCorrectionResult as SeasonCorrectionResultDC,
    SessionDC,
    Subevent as SubeventDC,
    User as UserDC,
    UserRef as UserRefDC,
)
from settings import settings

DATABASE_URL = "sqlite:///" + settings.DATABASE_PATH

engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

Base = declarative_base()


class UserORM(Base):
    __tablename__ = "users"

    user_id = Column(Integer, primary_key=True, autoincrement=True)
    hashed_password = Column(String, nullable=False, default="")
    kkr_score = Column(Integer, nullable=False)
    group_number = Column(String, nullable=False)
    blocks = Column(String, nullable=False)
    banned = Column(Boolean, default=False, nullable=False)
    super_user = Column(Boolean, default=False, nullable=False)
    admin = Column(Boolean, default=False, nullable=False)
    pgas_admin = Column(Boolean, default=False, nullable=False, server_default="0")
    events_roles = Column(Text, nullable=False, default="[]", server_default="[]")
    photo_url = Column(String, nullable=True)
    account_state = Column(String, nullable=False, default="active", server_default="active")

    contact = relationship("ContactInfoORM", back_populates="user", uselist=False)


class ContactInfoORM(Base):
    __tablename__ = "contact_info"

    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    surname = Column(String, nullable=False, default="")
    name = Column(String, nullable=False, default="")
    patronymic = Column(String, nullable=False, default="")
    kkr_name = Column(String, nullable=False)
    group_number = Column(String, nullable=False)
    location = Column(String, nullable=False)
    blocks = Column(String, nullable=False)
    phone = Column(String, nullable=False)
    vk = Column(String, nullable=False)
    tg = Column(String, nullable=False)
    email = Column(String, nullable=False, unique=True, index=True)
    budget = Column(Boolean, nullable=False)
    in_profcom = Column(Boolean, nullable=False)

    user = relationship("UserORM", back_populates="contact")


class GuideORM(Base):
    __tablename__ = "guides"

    guide_id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String, nullable=False)
    owner_block = Column(String, nullable=False)
    text = Column(Text, nullable=False)
    description = Column(String, nullable=False, default="")
    original_link = Column(String, nullable=True)


class BlockORM(Base):
    __tablename__ = "block"

    name = Column(String, primary_key=True)
    master = Column(String, nullable=False)
    hr = Column(String, nullable=False, default="")
    cnt_of_human = Column(Integer, nullable=False, default=0)
    arr_of_human = Column(Text, nullable=False, default="[]")
    is_hr = Column(Boolean, default=False, nullable=False, server_default="0")
    master_user_id = Column(Integer, nullable=True)


class PgasEntryORM(Base):
    __tablename__ = "pgas_entries"

    entry_id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String, nullable=False)
    year = Column(Integer, nullable=False, default=0)
    file_url = Column(String, nullable=False)
    file_name = Column(String, nullable=False, default="")
    file_type = Column(String, nullable=False, default="")
    created_at = Column(String, nullable=False, default="")
    uploaded_by = Column(Integer, ForeignKey("users.user_id"), nullable=True)


class RefreshTokenORM(Base):
    __tablename__ = "refresh_tokens"

    token = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False)
    expires_at = Column(String, nullable=False)


class LeadershipORM(Base):
    __tablename__ = "leadership"

    id = Column(Integer, primary_key=True, default=1)
    chair_user_id = Column(Integer, nullable=True)
    deputies_json = Column(Text, nullable=False, default="[]", server_default="[]")
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class RoleAssignmentORM(Base):
    __tablename__ = "role_assignments"

    role_assignment_id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    role = Column(String, nullable=False)
    scope_kind = Column(String, nullable=False)
    scope_id = Column(String, nullable=True)
    principal_assignment_id = Column(String, nullable=True)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class SeasonORM(Base):
    __tablename__ = "seasons"

    season_id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    sequence_number = Column(Integer, nullable=False, unique=True)
    previous_season_id = Column(String, nullable=True)
    type = Column(String, nullable=False, default="winter_spring")
    starts_at = Column(String, nullable=False, default="")
    ends_at = Column(String, nullable=False, default="")
    state = Column(String, nullable=False, default="planned")
    is_current = Column(Boolean, nullable=False, default=False)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class ReportSeriesORM(Base):
    __tablename__ = "report_series"

    series_id = Column(String, primary_key=True)
    owner_kind = Column(String, nullable=False)  # "event" | "subevent"
    title = Column(String, nullable=False)
    parent_series_id = Column(String, nullable=True)


class EventORM(Base):
    __tablename__ = "events"

    event_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    report_series_id = Column(String, nullable=False)
    starts_at = Column(String, nullable=True)
    ends_at = Column(String, nullable=True)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class SubeventORM(Base):
    __tablename__ = "subevents"

    subevent_id = Column(String, primary_key=True)
    event_id = Column(String, ForeignKey("events.event_id"), nullable=False, index=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    report_series_id = Column(String, nullable=False)
    organizer_user_ids_json = Column(Text, nullable=False, default="[]", server_default="[]")
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class MeetingORM(Base):
    __tablename__ = "meetings"

    meeting_id = Column(String, primary_key=True)
    owner_kind = Column(String, nullable=False)  # "event" | "subevent"
    owner_id = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    starts_at = Column(String, nullable=False)
    join_url = Column(String, nullable=False)
    revision = Column(Integer, nullable=False, default=1, server_default="1")


class NotificationORM(Base):
    __tablename__ = "notifications"

    notification_id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    kind = Column(String, nullable=False)
    payload_json = Column(Text, nullable=False, default="{}", server_default="{}")
    is_read = Column(Boolean, default=False, nullable=False)
    created_at = Column(String, nullable=False)


class SeasonCorrectionORM(Base):
    __tablename__ = "season_corrections"

    correction_id = Column(String, primary_key=True)
    object_kind = Column(String, nullable=False)
    object_id = Column(String, nullable=False)
    source_season_id = Column(String, nullable=False)
    target_season_id = Column(String, nullable=False)
    changed_by_user_id = Column(Integer, nullable=False)
    reason = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)


Base.metadata.create_all(bind=engine)



def _ensure_sqlite_users_password_column() -> None:
    """Add hashed_password to existing SQLite DBs created before auth."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "hashed_password" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN hashed_password VARCHAR NOT NULL DEFAULT ''")
            )


_ensure_sqlite_users_password_column()


def _ensure_sqlite_users_photo_url_column() -> None:
    """Add photo_url to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "photo_url" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN photo_url VARCHAR")
            )


_ensure_sqlite_users_photo_url_column()


def _ensure_sqlite_users_pgas_admin_column() -> None:
    """Add pgas_admin to existing SQLite DBs created before the PGAS section."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "pgas_admin" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN pgas_admin BOOLEAN NOT NULL DEFAULT 0")
            )


_ensure_sqlite_users_pgas_admin_column()


def _ensure_sqlite_users_events_roles_column() -> None:
    """Add events_roles to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "events_roles" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN events_roles TEXT NOT NULL DEFAULT '[]'")
            )


_ensure_sqlite_users_events_roles_column()


def _ensure_sqlite_pgas_entries_columns() -> None:
    """Переименовать поля ПГАС в базах, созданных до смены смысла колонок.

    full_name (ФИО) → title (название мероприятия), group_number → year.
    """
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(pgas_entries)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "full_name" in col_names and "title" not in col_names:
            conn.execute(text("ALTER TABLE pgas_entries RENAME COLUMN full_name TO title"))
        if "group_number" in col_names and "year" not in col_names:
            conn.execute(text("ALTER TABLE pgas_entries RENAME COLUMN group_number TO year"))
            conn.execute(text("UPDATE pgas_entries SET year = CAST(year AS INTEGER)"))


_ensure_sqlite_pgas_entries_columns()


def _ensure_sqlite_guides_description_column() -> None:
    """Add description to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(guides)")).fetchall()
        col_names = {r[1] for r in rows}
        if "description" not in col_names:
            conn.execute(
                text("ALTER TABLE guides ADD COLUMN description VARCHAR NOT NULL DEFAULT ''")
            )


_ensure_sqlite_guides_description_column()


def _ensure_sqlite_block_hr_column() -> None:
    """Add hr column to existing block table in SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(block)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "hr" not in col_names:
            conn.execute(
                text("ALTER TABLE block ADD COLUMN hr VARCHAR NOT NULL DEFAULT ''")
            )


_ensure_sqlite_block_hr_column()


def _ensure_sqlite_users_account_state_column() -> None:
    """Add account_state to existing SQLite DBs."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(users)")).fetchall()
        col_names = {r[1] for r in rows}
        if "account_state" not in col_names:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN account_state VARCHAR NOT NULL DEFAULT 'active'")
            )


_ensure_sqlite_users_account_state_column()


def _ensure_sqlite_block_is_hr_column() -> None:
    """Add is_hr to existing block table and mark 'HR' block if present."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(block)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "is_hr" not in col_names:
            conn.execute(
                text("ALTER TABLE block ADD COLUMN is_hr BOOLEAN NOT NULL DEFAULT 0")
            )
            conn.execute(
                text("UPDATE block SET is_hr = 1 WHERE LOWER(name) = 'hr'")
            )


_ensure_sqlite_block_is_hr_column()


def _ensure_sqlite_block_master_user_id_column() -> None:
    """Add master_user_id to existing block table."""
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(block)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "master_user_id" not in col_names:
            conn.execute(
                text("ALTER TABLE block ADD COLUMN master_user_id INTEGER")
            )


_ensure_sqlite_block_master_user_id_column()


def _split_fio(raw: str) -> tuple[str, str, str]:
    parts = [p for p in (raw or "").strip().split() if p]
    if len(parts) >= 3:
        return parts[0], parts[1], " ".join(parts[2:])
    if len(parts) == 2:
        return parts[0], parts[1], ""
    if len(parts) == 1:
        return "", parts[0], ""
    return "", "", ""


def _migrate_sqlite_contact_info_fio_to_components() -> None:
    """
    Migrate legacy `contact_info` schema:
      fio TEXT NOT NULL
    to:
      surname TEXT NOT NULL DEFAULT ''
      name TEXT NOT NULL DEFAULT ''
      patronymic TEXT NOT NULL DEFAULT ''

    SQLite can't drop/alter columns reliably; we recreate the table.
    """
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(contact_info)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "fio" not in col_names:
            return
        if {"surname", "name", "patronymic"}.issubset(col_names):
            return

        conn.execute(text("PRAGMA foreign_keys=OFF"))

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS contact_info__new (
                  user_id INTEGER PRIMARY KEY,
                  surname VARCHAR NOT NULL DEFAULT '',
                  name VARCHAR NOT NULL DEFAULT '',
                  patronymic VARCHAR NOT NULL DEFAULT '',
                  kkr_name VARCHAR NOT NULL,
                  group_number VARCHAR NOT NULL,
                  location VARCHAR NOT NULL,
                  blocks VARCHAR NOT NULL,
                  phone VARCHAR NOT NULL,
                  vk VARCHAR NOT NULL,
                  tg VARCHAR NOT NULL,
                  email VARCHAR NOT NULL,
                  budget BOOLEAN NOT NULL,
                  in_profcom BOOLEAN NOT NULL,
                  FOREIGN KEY(user_id) REFERENCES users(user_id)
                )
                """
            )
        )

        old_rows = conn.execute(
            text(
                """
                SELECT
                  user_id, fio, kkr_name, group_number, location, blocks,
                  phone, vk, tg, email, budget, in_profcom
                FROM contact_info
                """
            )
        ).fetchall()

        for r in old_rows:
            surname, name, patronymic = _split_fio(r[1])
            conn.execute(
                text(
                    """
                    INSERT INTO contact_info__new (
                      user_id, surname, name, patronymic, kkr_name, group_number,
                      location, blocks, phone, vk, tg, email, budget, in_profcom
                    ) VALUES (
                      :user_id, :surname, :name, :patronymic, :kkr_name, :group_number,
                      :location, :blocks, :phone, :vk, :tg, :email, :budget, :in_profcom
                    )
                    """
                ),
                {
                    "user_id": r[0],
                    "surname": surname,
                    "name": name,
                    "patronymic": patronymic,
                    "kkr_name": r[2],
                    "group_number": r[3],
                    "location": r[4],
                    "blocks": r[5],
                    "phone": r[6],
                    "vk": r[7],
                    "tg": r[8],
                    "email": r[9],
                    "budget": r[10],
                    "in_profcom": r[11],
                },
            )

        conn.execute(text("DROP TABLE contact_info"))
        conn.execute(text("ALTER TABLE contact_info__new RENAME TO contact_info"))

        conn.execute(text("PRAGMA foreign_keys=ON"))


_migrate_sqlite_contact_info_fio_to_components()


def _ensure_sqlite_unique_contact_email() -> None:
    """
    Ensure email is unique in `contact_info`.
    For existing SQLite DBs we add a UNIQUE index (schema-alter friendly).
    """
    with engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(contact_info)")).fetchall()
        if not rows:
            return
        col_names = {r[1] for r in rows}
        if "email" not in col_names:
            return
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_contact_info_email ON contact_info(email)"
            )
        )


_ensure_sqlite_unique_contact_email()


def _user_orm_to_dc(u: UserORM) -> UserDC:
    return UserDC(
        user_id=u.user_id,
        hashed_password=u.hashed_password,
        kkr_score=u.kkr_score,
        group_number=u.group_number,
        blocks=u.blocks,
        photo_url=u.photo_url,
        banned=u.banned,
        super_user=u.super_user,
        admin=u.admin,
        pgas_admin=u.pgas_admin,
        events_roles=u.events_roles,
        account_state=getattr(u, "account_state", "active") or "active",
    )


def _contact_orm_to_dc(c: ContactInfoORM) -> ContactInfoDC:
    return ContactInfoDC(
        user_id=c.user_id,
        surname=c.surname,
        name=c.name,
        patronymic=c.patronymic,
        kkr_name=c.kkr_name,
        group_number=c.group_number,
        location=c.location,
        blocks=c.blocks,
        phone=c.phone,
        vk=c.vk,
        tg=c.tg,
        email=c.email,
        budget=c.budget,
        in_profcom=c.in_profcom,
        photo_url=c.user.photo_url if c.user else None,
    )


def _guide_orm_to_dc(g: GuideORM) -> GuideDC:
    return GuideDC(
        guide_id=g.guide_id,
        title=g.title,
        owner_block=g.owner_block,
        text=g.text,
        description=g.description or "",
        original_link=g.original_link,
    )


def _pgas_orm_to_dc(p: PgasEntryORM) -> PgasEntryDC:
    return PgasEntryDC(
        entry_id=p.entry_id,
        title=p.title,
        year=int(p.year or 0),
        file_url=p.file_url,
        file_name=p.file_name or "",
        file_type=p.file_type or "",
        created_at=p.created_at or "",
        uploaded_by=p.uploaded_by,
    )


def _block_orm_to_dc(b: BlockORM) -> BlockDC:
    try:
        arr = json.loads(b.arr_of_human) if b.arr_of_human else []
    except json.JSONDecodeError:
        arr = []
    return BlockDC(
        name=b.name,
        master=b.master,
        hr=b.hr,
        cnt_of_human=b.cnt_of_human,
        arr_of_human=arr,
        is_hr=bool(getattr(b, "is_hr", False)),
        master_user_id=getattr(b, "master_user_id", None),
    )


def _role_assignment_orm_to_dc(r: RoleAssignmentORM) -> RoleAssignmentDC:
    return RoleAssignmentDC(
        role_assignment_id=r.role_assignment_id,
        user_id=r.user_id,
        role=r.role,
        scope_kind=r.scope_kind,
        scope_id=r.scope_id,
        principal_assignment_id=r.principal_assignment_id,
        revision=r.revision,
        capabilities=["read"],
    )


def _parse_blocks(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


def _format_blocks(items: list[str]) -> str:
    return ",".join(items)


class Database:
    """SQLAlchemy-backed database layer."""

    def __init__(self) -> None:
        self._SessionLocal = SessionLocal

    def _session(self) -> Session:
        return self._SessionLocal()

    # --- Sync Helpers ---

    def _sync_blocks_for_user(self, session: Session, user_id: int, new_blocks_raw: str) -> str:
        u = session.get(UserORM, user_id)
        c = session.get(ContactInfoORM, user_id)
        if not u and not c:
            return new_blocks_raw

        old_blocks = set(_parse_blocks(u.blocks if u else (c.blocks if c else "")))
        available_blocks = {b.name for b in session.query(BlockORM.name).all()}
        requested_blocks = set(_parse_blocks(new_blocks_raw))
        
        # Only keep blocks that exist in BlockORM
        valid_requested_blocks = requested_blocks.intersection(available_blocks)
        
        added = valid_requested_blocks - old_blocks
        removed = old_blocks - valid_requested_blocks
        
        for b_name in added:
            b_orm = session.get(BlockORM, b_name)
            if b_orm:
                try:
                    user_ids = json.loads(b_orm.arr_of_human) if b_orm.arr_of_human else []
                except json.JSONDecodeError:
                    user_ids = []
                if user_id not in user_ids:
                    user_ids.append(user_id)
                    b_orm.arr_of_human = json.dumps(user_ids)
                    b_orm.cnt_of_human = len(user_ids)

        for b_name in removed:
            b_orm = session.get(BlockORM, b_name)
            if b_orm:
                try:
                    user_ids = json.loads(b_orm.arr_of_human) if b_orm.arr_of_human else []
                except json.JSONDecodeError:
                    user_ids = []
                if user_id in user_ids:
                    user_ids.remove(user_id)
                    b_orm.arr_of_human = json.dumps(user_ids)
                    b_orm.cnt_of_human = len(user_ids)

        final_blocks_str = _format_blocks(sorted(list(valid_requested_blocks)))
        if u: u.blocks = final_blocks_str
        if c: c.blocks = final_blocks_str
        return final_blocks_str

    def _sync_users_for_block(self, session: Session, block_name: str, new_user_ids: list[int]):
        b = session.get(BlockORM, block_name)
        if not b: return
        
        try:
            old_user_ids = set(json.loads(b.arr_of_human)) if b.arr_of_human else set()
        except json.JSONDecodeError:
            old_user_ids = set()
            
        new_user_ids_set = set(new_user_ids)
        
        added = new_user_ids_set - old_user_ids
        removed = old_user_ids - new_user_ids_set
        
        for u_id in added:
            u = session.get(UserORM, u_id)
            c = session.get(ContactInfoORM, u_id)
            if u:
                bl = set(_parse_blocks(u.blocks))
                bl.add(block_name)
                u.blocks = _format_blocks(sorted(list(bl)))
                if c: c.blocks = u.blocks
            elif c:
                bl = set(_parse_blocks(c.blocks))
                bl.add(block_name)
                c.blocks = _format_blocks(sorted(list(bl)))

        for u_id in removed:
            u = session.get(UserORM, u_id)
            c = session.get(ContactInfoORM, u_id)
            if u:
                bl = set(_parse_blocks(u.blocks))
                if block_name in bl:
                    bl.remove(block_name)
                    u.blocks = _format_blocks(sorted(list(bl)))
                if c: c.blocks = u.blocks
            elif c:
                bl = set(_parse_blocks(c.blocks))
                if block_name in bl:
                    bl.remove(block_name)
                    c.blocks = _format_blocks(sorted(list(bl)))

        # Update block record itself
        b.arr_of_human = json.dumps(list(new_user_ids_set))
        b.cnt_of_human = len(new_user_ids_set)

    # --- Users & ContactInfo ---

    def _sync_admin_rights(self, session: Session, kkr_names: set[str]) -> None:
        session.flush()
        for kkr_name in kkr_names:
            if not kkr_name:
                continue
            users = (
                session.query(UserORM)
                .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                .filter(ContactInfoORM.kkr_name == kkr_name)
                .all()
            )
            for u in users:
                is_admin = session.query(BlockORM).filter(
                    (BlockORM.master_user_id == u.user_id) |
                    ((BlockORM.master_user_id == None) & (BlockORM.master == kkr_name))
                ).first() is not None
                if u.admin != is_admin:
                    u.admin = is_admin

    def create_user_with_contact(
        self,
        contact: ContactInfoDC,
        user: UserDC,
    ) -> UserDC:
        with self._session() as session:
            u = UserORM(
                hashed_password=user.hashed_password,
                kkr_score=user.kkr_score,
                group_number=user.group_number,
                blocks="",  # Set via sync
                photo_url=user.photo_url,
                banned=user.banned,
                super_user=user.super_user,
                admin=user.admin,
                events_roles=user.events_roles,
                account_state=getattr(user, "account_state", "active") or "active",
            )
            session.add(u)
            session.flush()  # assign user_id

            c = ContactInfoORM(
                user_id=u.user_id,
                surname=contact.surname,
                name=contact.name,
                patronymic=contact.patronymic,
                kkr_name=contact.kkr_name,
                group_number=contact.group_number,
                location=contact.location,
                blocks="",  # Set via sync
                phone=contact.phone,
                vk=contact.vk,
                tg=contact.tg,
                email=contact.email,
                budget=contact.budget,
                in_profcom=contact.in_profcom,
            )
            session.add(c)
            session.flush()  # ensure c is queryable by _sync_blocks_for_user
            
            # Synchronize blocks
            initial_blocks = user.blocks or contact.blocks
            if initial_blocks:
                self._sync_blocks_for_user(session, u.user_id, initial_blocks)

            # Registration or direct creation does not elevate admin privileges via string namesake
            if user.admin:
                u.admin = True

            session.commit()
            session.refresh(u)

            return _user_orm_to_dc(u)

    def get_user(self, user_id: int) -> Optional[UserDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None
            return _user_orm_to_dc(u)

    def get_user_by_name(self, kkr_name: str) -> Optional[UserDC]:
        if not kkr_name or not kkr_name.strip():
            return None
        with self._session() as session:
            u = (
                session.query(UserORM)
                .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                .filter(ContactInfoORM.kkr_name == kkr_name)
                .first()
            )
            if not u:
                return None
            return _user_orm_to_dc(u)

    def get_user_by_email(self, email: str) -> Optional[UserDC]:
        if not email or not email.strip():
            return None
        with self._session() as session:
            u = (
                session.query(UserORM)
                .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                .filter(func.lower(ContactInfoORM.email) == email.lower().strip())
                .first()
            )
            if not u:
                return None
            return _user_orm_to_dc(u)

    def get_contact(self, user_id: int) -> Optional[ContactInfoDC]:
        with self._session() as session:
            c = (
                session.query(ContactInfoORM)
                .options(joinedload(ContactInfoORM.user))
                .filter(ContactInfoORM.user_id == user_id)
                .first()
            )
            if not c:
                return None
            return _contact_orm_to_dc(c)

    def delete_user(self, user_id: int) -> None:
        with self._session() as session:
            session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == user_id).delete(
                synchronize_session=False
            )
            # Remove from all blocks
            u = session.get(UserORM, user_id)
            c = session.get(ContactInfoORM, user_id)
            kkr_name = c.kkr_name if c else ""

            # Clear master / hr links in blocks
            blocks_to_clean = session.query(BlockORM).filter(
                (BlockORM.master_user_id == user_id)
                | (BlockORM.master == kkr_name)
                | (BlockORM.hr == kkr_name)
            ).all()
            for blk in blocks_to_clean:
                if blk.master_user_id == user_id or (kkr_name and blk.master == kkr_name):
                    blk.master = ""
                    blk.master_user_id = None
                if kkr_name and blk.hr == kkr_name:
                    blk.hr = ""

            if u:
                user_blocks = _parse_blocks(u.blocks)
                for b_name in user_blocks:
                    b_orm = session.get(BlockORM, b_name)
                    if b_orm:
                        try:
                            user_ids = json.loads(b_orm.arr_of_human) if b_orm.arr_of_human else []
                        except json.JSONDecodeError:
                            user_ids = []
                        if user_id in user_ids:
                            user_ids.remove(user_id)
                            b_orm.arr_of_human = json.dumps(user_ids)
                            b_orm.cnt_of_human = len(user_ids)
                session.delete(u)
            if c:
                session.delete(c)
            session.commit()

    def update_user(self, user_id: int, **fields) -> Optional[UserDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None

            if "blocks" in fields and fields["blocks"] is not None:
                new_blocks = self._sync_blocks_for_user(session, user_id, fields["blocks"])
                fields["blocks"] = new_blocks

            for k, v in fields.items():
                if v is None:
                    continue
                elif hasattr(u, k):
                    setattr(u, k, v)
            session.commit()
            session.refresh(u)
            return _user_orm_to_dc(u)

    def update_contact(self, user_id: int, **fields) -> Optional[ContactInfoDC]:
        with self._session() as session:
            c = session.get(ContactInfoORM, user_id)
            if not c:
                return None

            old_kkr_name = c.kkr_name
            new_kkr_name = fields.get("kkr_name")

            if "blocks" in fields and fields["blocks"] is not None:
                new_blocks = self._sync_blocks_for_user(session, user_id, fields["blocks"])
                fields["blocks"] = new_blocks

            for k, v in fields.items():
                if v is None:
                    continue
                if hasattr(c, k):
                    setattr(c, k, v)

            if new_kkr_name is not None and new_kkr_name != old_kkr_name:
                blocks_to_unlink = session.query(BlockORM).filter(
                    BlockORM.master_user_id == user_id,
                    BlockORM.master == old_kkr_name
                ).all()
                for b in blocks_to_unlink:
                    b.master_user_id = None
                self._sync_admin_rights(session, {old_kkr_name, new_kkr_name})

            session.commit()
            session.refresh(c)
            return _contact_orm_to_dc(c)

    def list_contacts(self) -> List[ContactInfoDC]:
        with self._session() as session:
            rows = (
                session.query(ContactInfoORM)
                .options(joinedload(ContactInfoORM.user))
                .all()
            )
            return [_contact_orm_to_dc(c) for c in rows]

    def filter_contacts(self, **criteria) -> List[ContactInfoDC]:
        with self._session() as session:
            q = session.query(ContactInfoORM).options(joinedload(ContactInfoORM.user))
            if criteria.get("group_number") is not None:
                q = q.filter(ContactInfoORM.group_number == criteria["group_number"])
            if criteria.get("blocks") is not None:
                b_crit = criteria["blocks"]
                q = q.filter(
                    (ContactInfoORM.blocks == b_crit)
                    | (ContactInfoORM.blocks.like(f"{b_crit},%"))
                    | (ContactInfoORM.blocks.like(f"%,{b_crit}"))
                    | (ContactInfoORM.blocks.like(f"%,{b_crit},%"))
                )
            if criteria.get("in_profcom") is not None:
                q = q.filter(ContactInfoORM.in_profcom == criteria["in_profcom"])
            if criteria.get("budget") is not None:
                q = q.filter(ContactInfoORM.budget == criteria["budget"])
            rows = q.all()
            return [_contact_orm_to_dc(c) for c in rows]

    # --- Guides ---

    def list_guides(self) -> List[GuideDC]:
        with self._session() as session:
            rows = session.query(GuideORM).all()
            return [_guide_orm_to_dc(g) for g in rows]

    def get_guide(self, guide_id: int) -> Optional[GuideDC]:
        with self._session() as session:
            g = session.get(GuideORM, guide_id)
            if not g:
                return None
            return _guide_orm_to_dc(g)

    def create_guide(self, guide: GuideDC) -> GuideDC:
        with self._session() as session:
            g = GuideORM(
                title=guide.title,
                owner_block=guide.owner_block or "none",
                text=guide.text,
                description=guide.description or "",
                original_link=guide.original_link,
            )
            session.add(g)
            session.commit()
            session.refresh(g)
            return _guide_orm_to_dc(g)

    def delete_guide(self, guide_id: int) -> bool:
        with self._session() as session:
            g = session.get(GuideORM, guide_id)
            if not g:
                return False
            session.delete(g)
            session.commit()
            return True

    def get_user_block_names(self, user_id: int) -> list[str]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            c = session.get(ContactInfoORM, user_id)
            blocks: set[str] = set()
            if u and u.blocks:
                blocks.update(_parse_blocks(u.blocks))
            if c and c.blocks:
                blocks.update(_parse_blocks(c.blocks))
            # Also include blocks where user is assigned master
            mb = (
                session.query(BlockORM.name)
                .filter(BlockORM.master_user_id == user_id)
                .all()
            )
            for (b_name,) in mb:
                blocks.add(b_name)
            # Legacy master or hr fallback
            if c and c.kkr_name:
                legacy = (
                    session.query(BlockORM.name)
                    .filter(
                        ((BlockORM.master_user_id == None) & (BlockORM.master == c.kkr_name)) |
                        (BlockORM.hr == c.kkr_name)
                    )
                    .all()
                )
                for (b_name,) in legacy:
                    blocks.add(b_name)
            return list(blocks)

    def get_user_master_block_names(self, user_id: int) -> list[str]:
        with self._session() as session:
            # Check explicit master_user_id first
            master_blocks = (
                session.query(BlockORM.name)
                .filter(BlockORM.master_user_id == user_id)
                .all()
            )
            if master_blocks:
                return [b_name for (b_name,) in master_blocks]
            # Fallback for unlinked legacy blocks without master_user_id
            c = session.get(ContactInfoORM, user_id)
            if not c or not c.kkr_name:
                return []
            legacy = (
                session.query(BlockORM.name)
                .filter(BlockORM.master == c.kkr_name, BlockORM.master_user_id == None)
                .all()
            )
            return [b_name for (b_name,) in legacy]

    # --- ПГАС ---

    def list_pgas_entries(self) -> List[PgasEntryDC]:
        with self._session() as session:
            rows = (
                session.query(PgasEntryORM)
                .order_by(PgasEntryORM.entry_id.desc())
                .all()
            )
            return [_pgas_orm_to_dc(p) for p in rows]

    def get_pgas_entry(self, entry_id: int) -> Optional[PgasEntryDC]:
        with self._session() as session:
            p = session.get(PgasEntryORM, entry_id)
            if not p:
                return None
            return _pgas_orm_to_dc(p)

    def create_pgas_entry(self, entry: PgasEntryDC) -> PgasEntryDC:
        with self._session() as session:
            p = PgasEntryORM(
                title=entry.title,
                year=entry.year or 0,
                file_url=entry.file_url,
                file_name=entry.file_name or "",
                file_type=entry.file_type or "",
                created_at=entry.created_at or "",
                uploaded_by=entry.uploaded_by,
            )
            session.add(p)
            session.commit()
            session.refresh(p)
            return _pgas_orm_to_dc(p)

    def delete_pgas_entry(self, entry_id: int) -> bool:
        with self._session() as session:
            p = session.get(PgasEntryORM, entry_id)
            if not p:
                return False
            session.delete(p)
            session.commit()
            return True

    # --- Blocks ---

    def list_blocks(self) -> List[BlockDC]:
        with self._session() as session:
            rows = session.query(BlockORM).all()
            return [_block_orm_to_dc(b) for b in rows]

    def create_block(self, block: BlockDC) -> BlockDC:
        with self._session() as session:
            is_hr_val = bool(block.is_hr or (block.name and block.name.strip().lower() == "hr"))
            master_uid = block.master_user_id
            if master_uid is None and block.master:
                u = (
                    session.query(UserORM)
                    .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                    .filter(ContactInfoORM.kkr_name == block.master)
                    .first()
                )
                if u:
                    master_uid = u.user_id

            b = BlockORM(
                name=block.name,
                master=block.master,
                hr=block.hr,
                cnt_of_human=0,
                arr_of_human="[]",
                is_hr=is_hr_val,
                master_user_id=master_uid,
            )
            session.add(b)
            session.flush()

            arr = list(block.arr_of_human) if block.arr_of_human else []
            if master_uid and master_uid not in arr:
                arr.append(master_uid)
            elif block.master:
                u = (
                    session.query(UserORM)
                    .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                    .filter(ContactInfoORM.kkr_name == block.master)
                    .first()
                )
                if u and u.user_id not in arr:
                    arr.append(u.user_id)

            if arr:
                seen = set()
                unique_arr = [x for x in arr if not (x in seen or seen.add(x))]
                existing_uids = {
                    r[0]
                    for r in session.query(UserORM.user_id)
                    .filter(UserORM.user_id.in_(unique_arr))
                    .all()
                }
                real_user_ids = [uid for uid in unique_arr if uid in existing_uids]
                if real_user_ids:
                    self._sync_users_for_block(session, block.name, real_user_ids)
                else:
                    b.arr_of_human = "[]"
                    b.cnt_of_human = 0

            self._sync_admin_rights(session, {block.master, block.hr})

            session.commit()
            session.refresh(b)
            return _block_orm_to_dc(b)

    def get_block(self, name: str) -> Optional[BlockDC]:
        with self._session() as session:
            b = session.get(BlockORM, name)
            if not b:
                return None
            return _block_orm_to_dc(b)

    def update_block(self, name: str, **fields) -> Optional[BlockDC]:
        with self._session() as session:
            b = session.get(BlockORM, name)
            if not b:
                return None

            affected_kkr_names = set()
            if "master" in fields and fields["master"] is not None:
                affected_kkr_names.add(b.master)
                affected_kkr_names.add(fields["master"])
                b.master = fields["master"]
                if "master_user_id" not in fields:
                    if fields["master"]:
                        mu = (
                            session.query(UserORM)
                            .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                            .filter(ContactInfoORM.kkr_name == fields["master"])
                            .first()
                        )
                        b.master_user_id = mu.user_id if mu else None
                    else:
                        b.master_user_id = None
            if "master_user_id" in fields:
                b.master_user_id = fields["master_user_id"]
            if "is_hr" in fields and fields["is_hr"] is not None:
                b.is_hr = bool(fields["is_hr"])
            if "hr" in fields and fields["hr"] is not None:
                affected_kkr_names.add(b.hr)
                affected_kkr_names.add(fields["hr"])
                b.hr = fields["hr"]

            arr = None
            if fields.get("arr_of_human") is not None:
                arr = list(fields["arr_of_human"])
            elif "master" in fields and fields["master"] is not None:
                try:
                    arr = json.loads(b.arr_of_human) if b.arr_of_human else []
                except json.JSONDecodeError:
                    arr = []

            if arr is not None and b.master_user_id:
                if b.master_user_id not in arr:
                    arr.append(b.master_user_id)
            elif arr is not None and b.master:
                u = (
                    session.query(UserORM)
                    .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                    .filter(ContactInfoORM.kkr_name == b.master)
                    .first()
                )
                if u and u.user_id not in arr:
                    arr.append(u.user_id)

            if arr is not None:
                seen = set()
                unique_arr = [x for x in arr if not (x in seen or seen.add(x))]
                existing_uids = {
                    r[0]
                    for r in session.query(UserORM.user_id)
                    .filter(UserORM.user_id.in_(unique_arr))
                    .all()
                }
                real_arr = [uid for uid in unique_arr if uid in existing_uids]
                self._sync_users_for_block(session, name, real_arr)
                b.cnt_of_human = len(real_arr)

            if affected_kkr_names:
                self._sync_admin_rights(session, affected_kkr_names)

            session.commit()
            session.refresh(b)
            return _block_orm_to_dc(b)

    def delete_block(self, name: str) -> None:
        with self._session() as session:
            b = session.get(BlockORM, name)
            if b:
                affected_kkr_names = {b.master, b.hr}
                # Remove this block from all users
                try:
                    user_ids = json.loads(b.arr_of_human) if b.arr_of_human else []
                except json.JSONDecodeError:
                    user_ids = []
                
                for u_id in user_ids:
                    u = session.get(UserORM, u_id)
                    c = session.get(ContactInfoORM, u_id)
                    if u:
                        bl = set(_parse_blocks(u.blocks))
                        if name in bl:
                            bl.remove(name)
                            u.blocks = _format_blocks(sorted(list(bl)))
                        if c: c.blocks = u.blocks
                    elif c:
                        bl = set(_parse_blocks(c.blocks))
                        if name in bl:
                            bl.remove(name)
                            c.blocks = _format_blocks(sorted(list(bl)))

                session.delete(b)
                self._sync_admin_rights(session, affected_kkr_names)
            session.commit()

    def enter_user_to_block(self, user_id: int, block_name: str) -> Optional[BlockDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None
            
            blocks = set(_parse_blocks(u.blocks))
            blocks.add(block_name)
            self._sync_blocks_for_user(session, user_id, _format_blocks(list(blocks)))
            
            session.commit()
            return self.get_block(block_name)

    def exit_user_from_block(self, user_id: int, block_name: str) -> Optional[BlockDC]:
        with self._session() as session:
            u = session.get(UserORM, user_id)
            if not u:
                return None
            
            blocks = set(_parse_blocks(u.blocks))
            if block_name in blocks:
                blocks.remove(block_name)
            self._sync_blocks_for_user(session, user_id, _format_blocks(list(blocks)))
            
            session.commit()
            return self.get_block(block_name)

    def update_guide(self, guide_id: int, **fields) -> Optional[GuideDC]:
        with self._session() as session:
            g = session.get(GuideORM, guide_id)
            if not g:
                return None
            for k, v in fields.items():
                if v is None and k != "original_link":
                    continue
                if hasattr(g, k):
                    setattr(g, k, v)
            session.commit()
            session.refresh(g)
            return _guide_orm_to_dc(g)

    # --- Refresh tokens ---

    def save_refresh_token(self, token: str, user_id: int, expires_at: datetime) -> None:
        with self._session() as session:
            session.add(
                RefreshTokenORM(
                    token=token,
                    user_id=user_id,
                    expires_at=expires_at.isoformat(),
                )
            )
            session.commit()

    def get_refresh_token(self, token: str) -> dict | None:
        with self._session() as session:
            row = session.get(RefreshTokenORM, token)
            if not row:
                return None
            return {
                "token": row.token,
                "user_id": row.user_id,
                "expires_at": datetime.fromisoformat(row.expires_at).replace(
                    tzinfo=timezone.utc
                ),
            }

    def delete_refresh_token(self, token: str) -> None:
        with self._session() as session:
            row = session.get(RefreshTokenORM, token)
            if row:
                session.delete(row)
            session.commit()

    def delete_all_refresh_tokens(self, user_id: int) -> None:
        with self._session() as session:
            session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == user_id).delete(
                synchronize_session=False
            )
            session.commit()

    def list_user_refresh_tokens(self, user_id: int) -> list[dict]:
        with self._session() as session:
            rows = session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == user_id).all()
            return [
                {
                    "token": r.token,
                    "user_id": r.user_id,
                    "expires_at": r.expires_at,
                }
                for r in rows
            ]

    # --- Leadership and Roles ---

    def _get_user_ref(self, session: Session, user_id: Optional[int]) -> Optional[UserRefDC]:
        if user_id is None:
            return None
        u = session.get(UserORM, user_id)
        if not u:
            return None
        c = session.get(ContactInfoORM, user_id)
        display_name = ""
        if c:
            display_name = f"{c.surname} {c.name}".strip()
            if not display_name:
                display_name = c.kkr_name
        if not display_name:
            display_name = f"User #{user_id}"
        return UserRefDC(
            user_id=user_id,
            display_name=display_name,
            avatar_url=u.photo_url,
        )

    def get_leadership(self) -> LeadershipDC:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row:
                chair_uid = None
                su = session.query(UserORM).filter(UserORM.super_user == True).first()
                if su:
                    chair_uid = su.user_id
                row = LeadershipORM(
                    id=1,
                    chair_user_id=chair_uid,
                    deputies_json="[]",
                    revision=1,
                )
                session.add(row)
                session.commit()
                session.refresh(row)

            chair_ref = self._get_user_ref(session, row.chair_user_id)
            deputies_refs = []
            try:
                dep_ids = json.loads(row.deputies_json or "[]")
            except Exception:
                dep_ids = []
            for did in dep_ids:
                dref = self._get_user_ref(session, did)
                if dref:
                    deputies_refs.append(dref)

            return LeadershipDC(
                chair=chair_ref,
                deputies=deputies_refs,
                revision=row.revision,
                capabilities=["read"],
            )

    def transfer_chair(self, new_chair_user_id: int, expected_revision: Optional[int] = None) -> LeadershipDC:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row:
                row = LeadershipORM(id=1, chair_user_id=None, deputies_json="[]", revision=1)
                session.add(row)
                session.flush()

            if not row.chair_user_id:
                first_su = session.query(UserORM).filter(UserORM.super_user == True).first()
                if first_su:
                    row.chair_user_id = first_su.user_id

            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            new_chair = session.get(UserORM, new_chair_user_id)
            if not new_chair or new_chair.banned or getattr(new_chair, "account_state", "active") != "active":
                raise ValueError("Invalid new chair: user must be active and not banned")

            if row.chair_user_id == new_chair_user_id:
                raise ValueError("User is already the chair")

            former_chair_id = row.chair_user_id
            try:
                former_deputy_ids = json.loads(row.deputies_json or "[]")
            except Exception:
                former_deputy_ids = []

            row.deputies_json = "[]"
            row.chair_user_id = new_chair_user_id
            row.revision += 1

            session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "global",
                RoleAssignmentORM.role.in_(["chair", "deputy_chair"]),
            ).delete(synchronize_session=False)

            session.add(
                RoleAssignmentORM(
                    role_assignment_id=str(uuid.uuid4()),
                    user_id=new_chair_user_id,
                    role="chair",
                    scope_kind="global",
                    scope_id=None,
                    revision=1,
                )
            )

            if former_chair_id:
                fc = session.get(UserORM, former_chair_id)
                if fc:
                    fc.super_user = False
                    has_block = session.query(BlockORM).filter(BlockORM.master_user_id == former_chair_id).first() is not None
                    fc.admin = has_block
                session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == former_chair_id).delete(
                    synchronize_session=False
                )

            for dep_id in former_deputy_ids:
                dep = session.get(UserORM, dep_id)
                if dep:
                    dep.super_user = False
                    has_block = session.query(BlockORM).filter(BlockORM.master_user_id == dep_id).first() is not None
                    dep.admin = has_block
                session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == dep_id).delete(
                    synchronize_session=False
                )

            new_chair.super_user = True
            new_chair.admin = True
            session.commit()
            return self.get_leadership()

    def set_chair_deputies(self, deputy_user_ids: list[int], expected_revision: Optional[int] = None) -> LeadershipDC:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row:
                row = LeadershipORM(id=1, chair_user_id=None, deputies_json="[]", revision=1)
                session.add(row)
                session.flush()

            if not row.chair_user_id:
                first_su = session.query(UserORM).filter(UserORM.super_user == True).first()
                if first_su:
                    row.chair_user_id = first_su.user_id

            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")

            if len(deputy_user_ids) > 3:
                raise ValueError("At most 3 deputies allowed")
            if len(set(deputy_user_ids)) != len(deputy_user_ids):
                raise ValueError("Deputy user IDs must be unique")
            if row.chair_user_id and row.chair_user_id in deputy_user_ids:
                raise ValueError("Chair cannot be appointed as deputy")

            for uid in deputy_user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid deputy user {uid}: must be active and not banned")

            try:
                old_deputy_ids = set(json.loads(row.deputies_json or "[]"))
            except Exception:
                old_deputy_ids = set()

            removed_deputy_ids = old_deputy_ids - set(deputy_user_ids)
            for uid in removed_deputy_ids:
                session.query(RefreshTokenORM).filter(RefreshTokenORM.user_id == uid).delete(
                    synchronize_session=False
                )
                u = session.get(UserORM, uid)
                if u:
                    has_block = session.query(BlockORM).filter(BlockORM.master_user_id == uid).first() is not None
                    u.admin = has_block

            session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "global",
                RoleAssignmentORM.role == "deputy_chair",
            ).delete(synchronize_session=False)

            for uid in deputy_user_ids:
                session.add(
                    RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role="deputy_chair",
                        scope_kind="global",
                        scope_id=None,
                        revision=1,
                    )
                )
                u = session.get(UserORM, uid)
                if u:
                    u.admin = True

            row.deputies_json = json.dumps(deputy_user_ids)
            row.revision += 1
            session.commit()
            return self.get_leadership()

    def is_chair(self, user_id: int) -> bool:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if row and row.chair_user_id is not None:
                return row.chair_user_id == user_id
            u = session.get(UserORM, user_id)
            return bool(u and u.super_user)

    def is_deputy_chair(self, user_id: int) -> bool:
        with self._session() as session:
            row = session.get(LeadershipORM, 1)
            if not row or not row.deputies_json:
                return False
            try:
                dep_ids = json.loads(row.deputies_json)
                return user_id in dep_ids
            except Exception:
                return False

    def is_tachki(self, user_id: int) -> bool:
        return self.is_chair(user_id) or self.is_deputy_chair(user_id)

    def is_hr_master(self, user_id: int) -> bool:
        with self._session() as session:
            count = (
                session.query(BlockORM)
                .filter(
                    (BlockORM.is_hr == True) | (func.lower(BlockORM.name) == "hr"),
                    BlockORM.master_user_id == user_id,
                )
                .count()
            )
            return count > 0

    def get_user_assignments(self, user_id: int) -> list[RoleAssignmentDC]:
        with self._session() as session:
            rows = session.query(RoleAssignmentORM).filter(RoleAssignmentORM.user_id == user_id).all()
            assignments = [_role_assignment_orm_to_dc(r) for r in rows]
            existing_roles = {(a.role, a.scope_kind, a.scope_id) for a in assignments}

            if self.is_chair(user_id) and ("chair", "global", None) not in existing_roles:
                assignments.append(
                    RoleAssignmentDC(
                        role_assignment_id=f"chair-{user_id}",
                        user_id=user_id,
                        role="chair",
                        scope_kind="global",
                        scope_id=None,
                        revision=1,
                        capabilities=["chair:transfer", "deputies:manage"],
                    )
                )
            if self.is_deputy_chair(user_id) and ("deputy_chair", "global", None) not in existing_roles:
                assignments.append(
                    RoleAssignmentDC(
                        role_assignment_id=f"deputy-{user_id}",
                        user_id=user_id,
                        role="deputy_chair",
                        scope_kind="global",
                        scope_id=None,
                        revision=1,
                        capabilities=["read"],
                    )
                )

            m_blocks = session.query(BlockORM.name).filter(BlockORM.master_user_id == user_id).all()
            for (b_name,) in m_blocks:
                if ("master", "block", b_name) not in existing_roles:
                    assignments.append(
                        RoleAssignmentDC(
                            role_assignment_id=f"master-{b_name}-{user_id}",
                            user_id=user_id,
                            role="master",
                            scope_kind="block",
                            scope_id=b_name,
                            revision=1,
                            capabilities=["read", "manage"],
                        )
                    )
            return assignments

    # ─────────────────────────────────────────────────────────────
    #  BE-02: SEASONS
    # ─────────────────────────────────────────────────────────────

    def create_season(self, title: str, type: str, starts_at: str, ends_at: str) -> SeasonDC:
        with self._session() as session:
            planned = session.query(SeasonORM).filter(SeasonORM.state == "planned").first()
            if planned:
                raise ValueError("Conflict: a planned season already exists")
            max_seq = session.query(func.max(SeasonORM.sequence_number)).scalar() or 0
            seq = max_seq + 1
            prev_id = None
            if max_seq > 0:
                prev_row = session.query(SeasonORM).filter(SeasonORM.sequence_number == max_seq).first()
                if prev_row:
                    prev_id = prev_row.season_id
            season = SeasonORM(
                season_id=str(uuid.uuid4()),
                title=title,
                sequence_number=seq,
                previous_season_id=prev_id,
                type=type,
                starts_at=starts_at,
                ends_at=ends_at,
                state="planned",
                is_current=False,
                revision=1,
            )
            session.add(season)
            session.commit()
            return _season_orm_to_dc(season)

    def get_seasons(self) -> list[SeasonDC]:
        with self._session() as session:
            rows = session.query(SeasonORM).order_by(SeasonORM.sequence_number.asc()).all()
            return [_season_orm_to_dc(r) for r in rows]

    def get_season(self, season_id: str) -> Optional[SeasonDC]:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            return _season_orm_to_dc(row) if row else None

    def get_current_season(self) -> Optional[SeasonDC]:
        with self._session() as session:
            row = session.query(SeasonORM).filter(SeasonORM.is_current == True).first()
            return _season_orm_to_dc(row) if row else None

    def open_season(self, season_id: str, expected_revision: Optional[int] = None) -> SeasonDC:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.state != "planned":
                raise ValueError(f"Cannot open season with state '{row.state}'")
            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            # Atomically remove is_current from previous current season
            old_cur = session.query(SeasonORM).filter(SeasonORM.is_current == True).all()
            for o in old_cur:
                o.is_current = False
                o.revision += 1
            row.state = "open"
            row.is_current = True
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row)

    def patch_season(
        self,
        season_id: str,
        expected_revision: int,
        title: Optional[str] = None,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> SeasonDC:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if title is not None:
                row.title = title
            if starts_at is not None:
                row.starts_at = starts_at
            if ends_at is not None:
                evs = session.query(EventORM).filter(EventORM.season_id == season_id).all()
                for ev in evs:
                    if ev.ends_at and ev.ends_at > ends_at:
                        raise ValueError(f"Cannot shorten season ends_at before event '{ev.title}' deadline ({ev.ends_at})")
                row.ends_at = ends_at
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row)

    def begin_summary_season(self, season_id: str, expected_revision: Optional[int] = None) -> SeasonDC:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.state != "open":
                raise ValueError(f"Cannot begin summary on season in state '{row.state}'")
            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            row.state = "summarizing"
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row)

    def close_season(self, season_id: str, expected_revision: Optional[int] = None) -> SeasonDC:
        with self._session() as session:
            row = session.get(SeasonORM, season_id)
            if not row:
                raise LookupError("Season not found")
            if row.state != "summarizing":
                raise ValueError(f"Cannot close season in state '{row.state}'")
            if expected_revision is not None and row.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if row.previous_season_id:
                prev = session.get(SeasonORM, row.previous_season_id)
                if prev and prev.state != "closed":
                    raise ValueError("previous_season_not_closed")
            row.state = "closed"
            if row.is_current:
                row.is_current = False
            row.revision += 1
            session.commit()
            return _season_orm_to_dc(row)

    # ─────────────────────────────────────────────────────────────
    #  BE-02: REPORT SERIES
    # ─────────────────────────────────────────────────────────────

    def list_report_series(self) -> list[ReportSeriesDC]:
        with self._session() as session:
            rows = session.query(ReportSeriesORM).all()
            return [_report_series_orm_to_dc(r) for r in rows]

    def get_report_series(self, series_id: str) -> Optional[ReportSeriesDC]:
        with self._session() as session:
            row = session.get(ReportSeriesORM, series_id)
            return _report_series_orm_to_dc(row) if row else None

    def create_report_series(
        self,
        title: str,
        owner_kind: str,
        parent_series_id: Optional[str] = None,
        series_id: Optional[str] = None,
    ) -> ReportSeriesDC:
        with self._session() as session:
            sid = series_id or str(uuid.uuid4())
            rs = ReportSeriesORM(
                series_id=sid,
                owner_kind=owner_kind,
                title=title,
                parent_series_id=parent_series_id,
            )
            session.add(rs)
            session.commit()
            return _report_series_orm_to_dc(rs)

    # ─────────────────────────────────────────────────────────────
    #  BE-02: EVENTS & SUBEVENTS
    # ─────────────────────────────────────────────────────────────

    def create_event(
        self,
        season_id: str,
        title: str,
        description: str,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
        report_series_id: Optional[str] = None,
    ) -> EventDC:
        with self._session() as session:
            season = session.get(SeasonORM, season_id)
            if not season:
                raise LookupError("Season not found")
            if season.state in ("summarizing", "closed"):
                raise ValueError(f"Cannot create event in {season.state} season")
            if report_series_id:
                rs = session.get(ReportSeriesORM, report_series_id)
                if not rs or rs.owner_kind != "event":
                    raise ValueError("Invalid report_series_id for event")
            else:
                rs = ReportSeriesORM(
                    series_id=str(uuid.uuid4()),
                    owner_kind="event",
                    title=title,
                    parent_series_id=None,
                )
                session.add(rs)
                session.flush()
                report_series_id = rs.series_id

            ev = EventORM(
                event_id=str(uuid.uuid4()),
                season_id=season_id,
                title=title,
                description=description,
                report_series_id=report_series_id,
                starts_at=starts_at,
                ends_at=ends_at,
                revision=1,
            )
            session.add(ev)
            session.commit()
            return _event_orm_to_dc(session, ev)

    def get_event(self, event_id: str) -> Optional[EventDC]:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            return _event_orm_to_dc(session, ev) if ev else None

    def list_events(self, season_id: Optional[str] = None) -> list[EventDC]:
        with self._session() as session:
            q = session.query(EventORM)
            if season_id:
                q = q.filter(EventORM.season_id == season_id)
            return [_event_orm_to_dc(session, ev) for ev in q.all()]

    def patch_event(
        self,
        event_id: str,
        expected_revision: int,
        title: Optional[str] = None,
        description: Optional[str] = None,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
    ) -> EventDC:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            if not ev:
                raise LookupError("Event not found")
            if ev.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if title is not None:
                ev.title = title
            if description is not None:
                ev.description = description
            if starts_at is not None:
                ev.starts_at = starts_at
            if ends_at is not None:
                ev.ends_at = ends_at
            ev.revision += 1
            session.commit()
            return _event_orm_to_dc(session, ev)

    def create_subevent(
        self,
        event_id: str,
        title: str,
        description: str,
        report_series_id: Optional[str] = None,
    ) -> SubeventDC:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            if not ev:
                raise LookupError("Event not found")
            season = session.get(SeasonORM, ev.season_id)
            if season and season.state in ("summarizing", "closed"):
                raise ValueError(f"Cannot create subevent in {season.state} season")
            if report_series_id:
                rs = session.get(ReportSeriesORM, report_series_id)
                if not rs or rs.owner_kind != "subevent" or rs.parent_series_id != ev.report_series_id:
                    raise ValueError("Invalid report_series_id for subevent: must be child series of parent event")
            else:
                rs = ReportSeriesORM(
                    series_id=str(uuid.uuid4()),
                    owner_kind="subevent",
                    title=title,
                    parent_series_id=ev.report_series_id,
                )
                session.add(rs)
                session.flush()
                report_series_id = rs.series_id

            sub = SubeventORM(
                subevent_id=str(uuid.uuid4()),
                event_id=event_id,
                title=title,
                description=description,
                report_series_id=report_series_id,
                organizer_user_ids_json="[]",
                revision=1,
            )
            session.add(sub)
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def get_subevent(self, subevent_id: str) -> Optional[SubeventDC]:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            return _subevent_orm_to_dc(session, sub) if sub else None

    def list_subevents(self, event_id: str) -> list[SubeventDC]:
        with self._session() as session:
            rows = session.query(SubeventORM).filter(SubeventORM.event_id == event_id).all()
            return [_subevent_orm_to_dc(session, s) for s in rows]

    def patch_subevent(
        self,
        subevent_id: str,
        expected_revision: int,
        title: Optional[str] = None,
        description: Optional[str] = None,
    ) -> SubeventDC:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub:
                raise LookupError("Subevent not found")
            if sub.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if title is not None:
                sub.title = title
            if description is not None:
                sub.description = description
            sub.revision += 1
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def copy_event_structure(
        self,
        source_event_id: str,
        target_season_id: str,
        title: str,
        starts_at: Optional[str] = None,
        ends_at: Optional[str] = None,
    ) -> tuple[EventDC, list[SubeventDC]]:
        with self._session() as session:
            ev = session.get(EventORM, source_event_id)
            if not ev:
                raise LookupError("Event not found")
            target_season = session.get(SeasonORM, target_season_id)
            if not target_season:
                raise LookupError("Target season not found")
            if target_season.state not in ("planned", "open"):
                raise ValueError(f"Cannot copy event to season with state '{target_season.state}'")

            new_ev = EventORM(
                event_id=str(uuid.uuid4()),
                season_id=target_season_id,
                title=title,
                description=ev.description,
                report_series_id=ev.report_series_id,
                starts_at=starts_at,
                ends_at=ends_at,
                revision=1,
            )
            session.add(new_ev)
            session.flush()

            subs = session.query(SubeventORM).filter(SubeventORM.event_id == source_event_id).all()
            new_sub_dcs = []
            for s in subs:
                new_sub = SubeventORM(
                    subevent_id=str(uuid.uuid4()),
                    event_id=new_ev.event_id,
                    title=s.title,
                    description=s.description,
                    report_series_id=s.report_series_id,
                    organizer_user_ids_json="[]",
                    revision=1,
                )
                session.add(new_sub)
                session.flush()
                new_sub_dcs.append(_subevent_orm_to_dc(session, new_sub))

            session.commit()
            return _event_orm_to_dc(session, new_ev), new_sub_dcs

    # ─────────────────────────────────────────────────────────────
    #  BE-02: LEADERS, DEPUTIES, ORGANIZERS
    # ─────────────────────────────────────────────────────────────

    def set_event_leaders(self, event_id: str, user_ids: list[int], expected_revision: int) -> EventDC:
        with self._session() as session:
            ev = session.get(EventORM, event_id)
            if not ev:
                raise LookupError("Event not found")
            if ev.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            for uid in user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            existing = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "event",
                RoleAssignmentORM.scope_id == event_id,
                RoleAssignmentORM.role == "event_leader",
            ).all()
            existing_by_uid = {r.user_id: r for r in existing}

            # Remove leaders not in user_ids and their deputies
            for uid, r in existing_by_uid.items():
                if uid not in user_ids:
                    session.query(RoleAssignmentORM).filter(
                        RoleAssignmentORM.principal_assignment_id == r.role_assignment_id
                    ).delete(synchronize_session=False)
                    session.delete(r)

            # Add newly assigned leaders
            for uid in user_ids:
                if uid not in existing_by_uid:
                    session.add(RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role="event_leader",
                        scope_kind="event",
                        scope_id=event_id,
                        revision=1,
                    ))
                    session.add(NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=uid,
                        kind="event_leader_assignment",
                        payload_json=json.dumps({"event_id": event_id, "title": ev.title}),
                        is_read=False,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    ))

            ev.revision += 1
            session.commit()
            return _event_orm_to_dc(session, ev)

    def set_subevent_leaders(self, subevent_id: str, user_ids: list[int], expected_revision: int) -> SubeventDC:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub:
                raise LookupError("Subevent not found")
            if sub.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            for uid in user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            existing = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "subevent",
                RoleAssignmentORM.scope_id == subevent_id,
                RoleAssignmentORM.role == "subevent_leader",
            ).all()
            existing_by_uid = {r.user_id: r for r in existing}

            for uid, r in existing_by_uid.items():
                if uid not in user_ids:
                    session.query(RoleAssignmentORM).filter(
                        RoleAssignmentORM.principal_assignment_id == r.role_assignment_id
                    ).delete(synchronize_session=False)
                    session.delete(r)

            for uid in user_ids:
                if uid not in existing_by_uid:
                    session.add(RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role="subevent_leader",
                        scope_kind="subevent",
                        scope_id=subevent_id,
                        revision=1,
                    ))
                    session.add(NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=uid,
                        kind="subevent_leader_assignment",
                        payload_json=json.dumps({"subevent_id": subevent_id, "title": sub.title}),
                        is_read=False,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    ))

            sub.revision += 1
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def set_subevent_organizers(self, subevent_id: str, user_ids: list[int], expected_revision: int) -> SubeventDC:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub:
                raise LookupError("Subevent not found")
            if sub.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            for uid in user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            old_ids = set()
            try:
                old_ids = set(json.loads(sub.organizer_user_ids_json or "[]"))
            except Exception:
                pass
            new_ids = set(user_ids) - old_ids
            for uid in new_ids:
                session.add(NotificationORM(
                    notification_id=str(uuid.uuid4()),
                    user_id=uid,
                    kind="subevent_organizer_assignment",
                    payload_json=json.dumps({"subevent_id": subevent_id, "title": sub.title}),
                    is_read=False,
                    created_at=datetime.now(timezone.utc).isoformat(),
                ))

            sub.organizer_user_ids_json = json.dumps(user_ids)
            sub.revision += 1
            session.commit()
            return _subevent_orm_to_dc(session, sub)

    def set_block_leader(self, block_name: str, user_id: int, expected_revision: Optional[int] = None) -> BlockDC:
        with self._session() as session:
            b = session.get(BlockORM, block_name)
            if not b:
                raise LookupError(f"Block '{block_name}' not found")
            u = session.get(UserORM, user_id)
            if not u or u.banned or getattr(u, "account_state", "active") != "active":
                raise ValueError(f"Invalid user {user_id}: must be active and approved")

            old_a = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "block",
                RoleAssignmentORM.scope_id == block_name,
                RoleAssignmentORM.role == "master",
            ).first()
            if old_a and old_a.user_id != user_id:
                session.query(RoleAssignmentORM).filter(
                    RoleAssignmentORM.principal_assignment_id == old_a.role_assignment_id
                ).delete(synchronize_session=False)
                session.delete(old_a)

            b.master_user_id = user_id
            c = session.get(ContactInfoORM, user_id)
            display_name = ""
            if c:
                parts = [c.surname, c.name, c.patronymic]
                display_name = " ".join([p for p in parts if p]).strip() or c.kkr_name
            b.master = display_name or f"User #{user_id}"

            if not old_a or old_a.user_id != user_id:
                session.add(RoleAssignmentORM(
                    role_assignment_id=str(uuid.uuid4()),
                    user_id=user_id,
                    role="master",
                    scope_kind="block",
                    scope_id=block_name,
                    revision=1,
                ))
            session.commit()
            return self.get_block(block_name)

    def set_deputies(self, role_assignment_id: str, deputy_user_ids: list[int], expected_revision: int) -> LeaderDC:
        with self._session() as session:
            assignment = session.get(RoleAssignmentORM, role_assignment_id)
            if not assignment:
                raise LookupError("Role assignment not found")
            if assignment.revision != expected_revision:
                raise ValueError("Conflict: revision mismatch")
            if len(deputy_user_ids) > 2:
                raise ValueError("At most 2 deputies allowed per leader")
            if len(set(deputy_user_ids)) != len(deputy_user_ids):
                raise ValueError("Deputy user IDs must be unique")
            if assignment.user_id in deputy_user_ids:
                raise ValueError("Leader cannot be appointed as own deputy")
            for uid in deputy_user_ids:
                u = session.get(UserORM, uid)
                if not u or u.banned or getattr(u, "account_state", "active") != "active":
                    raise ValueError(f"Invalid user {uid}: must be active and approved")

            existing = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.principal_assignment_id == role_assignment_id
            ).all()
            existing_by_uid = {d.user_id: d for d in existing}

            for uid, d in existing_by_uid.items():
                if uid not in deputy_user_ids:
                    session.delete(d)

            deputy_role = f"deputy_{assignment.role}"
            for uid in deputy_user_ids:
                if uid not in existing_by_uid:
                    session.add(RoleAssignmentORM(
                        role_assignment_id=str(uuid.uuid4()),
                        user_id=uid,
                        role=deputy_role,
                        scope_kind=assignment.scope_kind,
                        scope_id=assignment.scope_id,
                        principal_assignment_id=role_assignment_id,
                        revision=1,
                    ))
                    session.add(NotificationORM(
                        notification_id=str(uuid.uuid4()),
                        user_id=uid,
                        kind=f"{deputy_role}_assignment",
                        payload_json=json.dumps({"scope_kind": assignment.scope_kind, "scope_id": assignment.scope_id}),
                        is_read=False,
                        created_at=datetime.now(timezone.utc).isoformat(),
                    ))

            assignment.revision += 1
            session.commit()

            u = session.get(UserORM, assignment.user_id)
            display_name = f"User {assignment.user_id}"
            photo_url = None
            if u and u.contact:
                parts = [u.contact.surname, u.contact.name, u.contact.patronymic]
                display_name = " ".join([p for p in parts if p]).strip() or u.contact.kkr_name or display_name
                photo_url = u.photo_url
            elif u:
                photo_url = u.photo_url

            user_ref = UserRefDC(user_id=assignment.user_id, display_name=display_name, avatar_url=photo_url)
            return LeaderDC(
                role_assignment_id=assignment.role_assignment_id,
                user=user_ref,
                deputy_user_ids=deputy_user_ids,
                revision=assignment.revision,
                capabilities=["manage_deputies"],
            )

    # ─────────────────────────────────────────────────────────────
    #  BE-02: MEETINGS (СОЗВОНЫ)
    # ─────────────────────────────────────────────────────────────

    def get_meeting(self, owner_kind: str, owner_id: str) -> Optional[MeetingDC]:
        with self._session() as session:
            row = session.query(MeetingORM).filter(
                MeetingORM.owner_kind == owner_kind,
                MeetingORM.owner_id == owner_id,
            ).first()
            return _meeting_orm_to_dc(row) if row else None

    def set_meeting(
        self,
        owner_kind: str,
        owner_id: str,
        title: str,
        starts_at: str,
        join_url: str,
        expected_revision: Optional[int] = None,
    ) -> MeetingDC:
        with self._session() as session:
            row = session.query(MeetingORM).filter(
                MeetingORM.owner_kind == owner_kind,
                MeetingORM.owner_id == owner_id,
            ).first()
            if row:
                if expected_revision is not None and row.revision != expected_revision:
                    raise ValueError("Conflict: revision mismatch")
                row.title = title
                row.starts_at = starts_at
                row.join_url = join_url
                row.revision += 1
            else:
                row = MeetingORM(
                    meeting_id=str(uuid.uuid4()),
                    owner_kind=owner_kind,
                    owner_id=owner_id,
                    title=title,
                    starts_at=starts_at,
                    join_url=join_url,
                    revision=1,
                )
                session.add(row)
            session.commit()
            return _meeting_orm_to_dc(row)

    def delete_meeting(self, owner_kind: str, owner_id: str) -> bool:
        with self._session() as session:
            deleted = session.query(MeetingORM).filter(
                MeetingORM.owner_kind == owner_kind,
                MeetingORM.owner_id == owner_id,
            ).delete()
            session.commit()
            return deleted > 0

    # ─────────────────────────────────────────────────────────────
    #  BE-02: SEASON CORRECTIONS
    # ─────────────────────────────────────────────────────────────

    def correct_season(
        self,
        object_kind: str,
        object_id: str,
        expected_revision: int,
        target_season_id: str,
        reason: str,
        user_id: int,
    ) -> SeasonCorrectionResultDC:
        with self._session() as session:
            target_season = session.get(SeasonORM, target_season_id)
            if not target_season:
                raise LookupError("Target season not found")
            if target_season.state == "closed":
                raise ValueError("Target season cannot be closed")
            if not reason or not reason.strip():
                raise ValueError("Reason is required")

            if object_kind == "event":
                ev = session.get(EventORM, object_id)
                if not ev:
                    raise LookupError("Event not found")
                if ev.revision != expected_revision:
                    raise ValueError("Conflict: revision mismatch")
                if ev.season_id == target_season_id:
                    raise ValueError("Target season must differ from current season")
                source_season = session.get(SeasonORM, ev.season_id)
                if source_season and source_season.state == "closed":
                    raise ValueError("Source season cannot be closed")
                if target_season.ends_at and ev.ends_at and ev.ends_at > target_season.ends_at:
                    raise ValueError("Event deadline exceeds target season ends_at")

                source_sid = ev.season_id
                ev.season_id = target_season_id
                ev.revision += 1

                sc = SeasonCorrectionORM(
                    correction_id=str(uuid.uuid4()),
                    object_kind="event",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    changed_by_user_id=user_id,
                    reason=reason,
                    created_at=datetime.now(timezone.utc).isoformat(),
                )
                session.add(sc)
                session.commit()
                return SeasonCorrectionResultDC(
                    object_kind="event",
                    object_id=object_id,
                    source_season_id=source_sid,
                    target_season_id=target_season_id,
                    revision=ev.revision,
                )
            else:
                raise ValueError(f"Unsupported object_kind '{object_kind}'")

    # ─────────────────────────────────────────────────────────────
    #  BE-02: ROLE & PERMISSION HELPERS
    # ─────────────────────────────────────────────────────────────

    def is_event_leader(self, user_id: int, event_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "event",
                RoleAssignmentORM.scope_id == event_id,
                RoleAssignmentORM.role == "event_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_event_leader_deputy(self, user_id: int, event_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "event",
                RoleAssignmentORM.scope_id == event_id,
                RoleAssignmentORM.role == "deputy_event_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_subevent_leader(self, user_id: int, subevent_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "subevent",
                RoleAssignmentORM.scope_id == subevent_id,
                RoleAssignmentORM.role == "subevent_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_subevent_leader_deputy(self, user_id: int, subevent_id: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "subevent",
                RoleAssignmentORM.scope_id == subevent_id,
                RoleAssignmentORM.role == "deputy_subevent_leader",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0

    def is_subevent_organizer(self, user_id: int, subevent_id: str) -> bool:
        with self._session() as session:
            sub = session.get(SubeventORM, subevent_id)
            if not sub or not sub.organizer_user_ids_json:
                return False
            try:
                org_ids = json.loads(sub.organizer_user_ids_json)
                return user_id in org_ids
            except Exception:
                return False

    def is_block_master_deputy(self, user_id: int, block_name: str) -> bool:
        with self._session() as session:
            count = session.query(RoleAssignmentORM).filter(
                RoleAssignmentORM.scope_kind == "block",
                RoleAssignmentORM.scope_id == block_name,
                RoleAssignmentORM.role == "deputy_master",
                RoleAssignmentORM.user_id == user_id,
            ).count()
            return count > 0


def _season_orm_to_dc(orm: SeasonORM) -> SeasonDC:
    caps = []
    if orm.state == "planned":
        caps = ["open_season", "edit_season"]
    elif orm.state == "open":
        caps = ["edit_season", "begin_summary"]
    elif orm.state == "summarizing":
        caps = ["close_season"]
    return SeasonDC(
        season_id=orm.season_id,
        title=orm.title,
        sequence_number=orm.sequence_number,
        previous_season_id=orm.previous_season_id,
        type=orm.type,
        starts_at=orm.starts_at,
        ends_at=orm.ends_at,
        state=orm.state,
        is_current=bool(orm.is_current),
        revision=orm.revision,
        capabilities=caps,
    )


def _report_series_orm_to_dc(orm: ReportSeriesORM) -> ReportSeriesDC:
    return ReportSeriesDC(
        series_id=orm.series_id,
        owner_kind=orm.owner_kind,
        title=orm.title,
        parent_series_id=orm.parent_series_id,
    )


def _meeting_orm_to_dc(orm: MeetingORM) -> MeetingDC:
    return MeetingDC(
        meeting_id=orm.meeting_id,
        owner_kind=orm.owner_kind,
        owner_id=orm.owner_id,
        title=orm.title,
        starts_at=orm.starts_at,
        join_url=orm.join_url,
        revision=orm.revision,
        capabilities=["edit_meeting", "delete_meeting"],
    )


def _load_leaders(session: Session, scope_kind: str, scope_id: str, role: str) -> list[LeaderDC]:
    rows = session.query(RoleAssignmentORM).filter(
        RoleAssignmentORM.scope_kind == scope_kind,
        RoleAssignmentORM.scope_id == scope_id,
        RoleAssignmentORM.role == role,
    ).all()
    leaders = []
    for r in rows:
        dep_rows = session.query(RoleAssignmentORM).filter(
            RoleAssignmentORM.principal_assignment_id == r.role_assignment_id
        ).all()
        dep_uids = [d.user_id for d in dep_rows]
        u = session.get(UserORM, r.user_id)
        display_name = f"User {r.user_id}"
        photo_url = None
        if u and u.contact:
            parts = [u.contact.surname, u.contact.name, u.contact.patronymic]
            display_name = " ".join([p for p in parts if p]).strip() or u.contact.kkr_name or display_name
            photo_url = u.photo_url
        elif u:
            photo_url = u.photo_url
        user_ref = UserRefDC(user_id=r.user_id, display_name=display_name, avatar_url=photo_url)
        leaders.append(
            LeaderDC(
                role_assignment_id=r.role_assignment_id,
                user=user_ref,
                deputy_user_ids=dep_uids,
                revision=r.revision,
                capabilities=["manage_deputies"],
            )
        )
    return leaders


def _event_orm_to_dc(session: Session, orm: EventORM) -> EventDC:
    leaders = _load_leaders(session, "event", orm.event_id, "event_leader")
    return EventDC(
        event_id=orm.event_id,
        season_id=orm.season_id,
        title=orm.title,
        description=RichTextDC(format="markdown", body=orm.description or ""),
        leaders=leaders,
        report_series_id=orm.report_series_id,
        starts_at=orm.starts_at,
        ends_at=orm.ends_at,
        revision=orm.revision,
        capabilities=["create_subevent", "edit_event", "manage_leaders", "manage_deputies"],
    )


def _subevent_orm_to_dc(session: Session, orm: SubeventORM) -> SubeventDC:
    leaders = _load_leaders(session, "subevent", orm.subevent_id, "subevent_leader")
    org_ids = []
    try:
        org_ids = json.loads(orm.organizer_user_ids_json or "[]")
    except Exception:
        pass
    return SubeventDC(
        subevent_id=orm.subevent_id,
        event_id=orm.event_id,
        title=orm.title,
        description=RichTextDC(format="markdown", body=orm.description or ""),
        leaders=leaders,
        organizer_user_ids=org_ids,
        report_series_id=orm.report_series_id,
        revision=orm.revision,
        capabilities=["edit_subevent", "manage_leaders", "manage_organizers", "create_task"],
    )



db = Database()

