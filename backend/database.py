from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Text, create_engine, text
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker, joinedload

from models import (
    Block as BlockDC,
    ContactInfo as ContactInfoDC,
    Guide as GuideDC,
    PgasEntry as PgasEntryDC,
    User as UserDC,
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
    photo_url = Column(String, nullable=True)

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
            u = (
                session.query(UserORM)
                .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                .filter(ContactInfoORM.kkr_name == kkr_name)
                .first()
            )
            if u:
                is_admin = session.query(BlockORM).filter(
                    (BlockORM.master == kkr_name) | (BlockORM.hr == kkr_name)
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
            
            # Synchronize blocks
            initial_blocks = user.blocks or contact.blocks
            if initial_blocks:
                self._sync_blocks_for_user(session, u.user_id, initial_blocks)

            self._sync_admin_rights(session, {contact.kkr_name})

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
        with self._session() as session:
            u = (
                session.query(UserORM)
                .join(ContactInfoORM, ContactInfoORM.user_id == UserORM.user_id)
                .filter(ContactInfoORM.email == email)
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
            c = session.get(ContactInfoORM, user_id)
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

            if "blocks" in fields and fields["blocks"] is not None:
                new_blocks = self._sync_blocks_for_user(session, user_id, fields["blocks"])
                fields["blocks"] = new_blocks

            for k, v in fields.items():
                if v is None:
                    continue
                if hasattr(c, k):
                    setattr(c, k, v)
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
                q = q.filter(ContactInfoORM.blocks == criteria["blocks"])
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
            if c and c.kkr_name:
                master_or_hr = (
                    session.query(BlockORM.name)
                    .filter((BlockORM.master == c.kkr_name) | (BlockORM.hr == c.kkr_name))
                    .all()
                )
                for (b_name,) in master_or_hr:
                    blocks.add(b_name)
            return list(blocks)

    def get_user_master_block_names(self, user_id: int) -> list[str]:
        with self._session() as session:
            c = session.get(ContactInfoORM, user_id)
            if not c or not c.kkr_name:
                return []
            master_blocks = (
                session.query(BlockORM.name)
                .filter(BlockORM.master == c.kkr_name)
                .all()
            )
            return [b_name for (b_name,) in master_blocks]

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
            b = BlockORM(
                name=block.name,
                master=block.master,
                hr=block.hr,
                cnt_of_human=0,
                arr_of_human="[]",
            )
            session.add(b)
            session.flush()
            
            # If creating a block with humans already listed in dataclass
            arr = list(block.arr_of_human) if block.arr_of_human else []
            
            if block.master:
                u = session.query(UserORM).join(ContactInfoORM).filter(ContactInfoORM.kkr_name == block.master).first()
                if u and u.user_id not in arr:
                    arr.append(u.user_id)
                    
            if arr:
                self._sync_users_for_block(session, block.name, arr)

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
            
            if arr is not None and b.master:
                u = session.query(UserORM).join(ContactInfoORM).filter(ContactInfoORM.kkr_name == b.master).first()
                if u and u.user_id not in arr:
                    arr.append(u.user_id)

            if arr is not None:
                self._sync_users_for_block(session, name, arr)
                b.cnt_of_human = len(arr)

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
                if v is None:
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


db = Database()
