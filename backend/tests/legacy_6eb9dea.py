"""A synthetic database of the old site (6eb9dea) in the shape of the production one.

The schema is what the code of 6eb9dea creates. The counts follow the read-only check of
the production database on 2026-10-20 (owner-checks/server/SERVER_CHECKS.md): 85
accounts, one super_user among 27 admins, 79 without a password, 75 of them with the
VK link the old VK login saved (12 also with its vk_<id>@vk.com address) and 4 with
neither, 82 photos in the bucket, 20 blocks with a master string, 12 with an HR string,
12 guides (4 link the bucket), 42 PGAS entries, 304 refresh tokens. All data is invented.
"""

import json
import sqlite3
import uuid

SCHEMA = """
CREATE TABLE users (
	user_id INTEGER NOT NULL,
	hashed_password VARCHAR NOT NULL,
	kkr_score INTEGER NOT NULL,
	group_number VARCHAR NOT NULL,
	blocks VARCHAR NOT NULL,
	banned BOOLEAN NOT NULL,
	super_user BOOLEAN NOT NULL,
	admin BOOLEAN NOT NULL,
	pgas_admin BOOLEAN DEFAULT '0' NOT NULL,
	events_roles TEXT DEFAULT '[]' NOT NULL,
	photo_url VARCHAR,
	PRIMARY KEY (user_id)
);
CREATE TABLE guides (
	guide_id INTEGER NOT NULL,
	title VARCHAR NOT NULL,
	owner_block VARCHAR NOT NULL,
	text TEXT NOT NULL,
	description VARCHAR NOT NULL,
	original_link VARCHAR,
	PRIMARY KEY (guide_id)
);
CREATE TABLE block (
	name VARCHAR NOT NULL,
	master VARCHAR NOT NULL,
	hr VARCHAR NOT NULL,
	cnt_of_human INTEGER NOT NULL,
	arr_of_human TEXT NOT NULL,
	PRIMARY KEY (name)
);
CREATE TABLE contact_info (
	user_id INTEGER NOT NULL,
	surname VARCHAR NOT NULL,
	name VARCHAR NOT NULL,
	patronymic VARCHAR NOT NULL,
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
	PRIMARY KEY (user_id),
	FOREIGN KEY(user_id) REFERENCES users (user_id)
);
CREATE UNIQUE INDEX ix_contact_info_email ON contact_info (email);
CREATE TABLE pgas_entries (
	entry_id INTEGER NOT NULL,
	title VARCHAR NOT NULL,
	year INTEGER NOT NULL,
	file_url VARCHAR NOT NULL,
	file_name VARCHAR NOT NULL,
	file_type VARCHAR NOT NULL,
	created_at VARCHAR NOT NULL,
	uploaded_by INTEGER,
	PRIMARY KEY (entry_id),
	FOREIGN KEY(uploaded_by) REFERENCES users (user_id)
);
CREATE TABLE refresh_tokens (
	token VARCHAR NOT NULL,
	user_id INTEGER NOT NULL,
	expires_at VARCHAR NOT NULL,
	PRIMARY KEY (token),
	FOREIGN KEY(user_id) REFERENCES users (user_id)
);
CREATE UNIQUE INDEX ux_contact_info_email ON contact_info(email);
"""

BUCKET = "https://global.s3.cloud.ru/synthetic"
BLOCKS = (
    "HR", "IT", "Медиа", "Спорт", "Культура", "Наука", "Волонтёры", "Дизайн", "Фото", "Видео",
    "Тексты", "Event", "Партнёры", "Общежития", "Первокурсники", "Выезды", "Квизы", "Музыка",
    "Танцы", "Игры",
)
# Accounts 1–6 set a password (1 is the super_user); 7–85 came through the old VK login.
# 7–18 got the address vk_<id>@vk.com, 19–81 a VK link only, 82–85 neither.
PASSWORD_IDS = range(1, 7)
VK_EMAIL_IDS = range(7, 19)
VK_LINK_IDS = range(7, 82)
MANUAL_IDS = range(82, 86)
NO_PHOTO_IDS = (2, 3, 4)
PENDING_IDS = (5, 30, 60, 83, 85)
ADMIN_IDS = tuple(range(1, 28))


def user_ids():
    return list(range(1, 86))


def vk_id(uid):
    return str(500_000_000 + uid)


def person(uid):
    # Namesakes 40 and 41 share the FIO that is the master string of «Медиа».
    surname = "Тёзкин" if uid in (40, 41) else f"Фамилия{uid:02d}"
    name = "Тимур" if uid in (40, 41) else f"Имя{uid:02d}"
    return surname, name


def build(path, *, extra=()):
    """The database at `path`; `extra` adds rows the production base does not have:
    "orphan" — users row 900 without contact_info; "case" — a pair of addresses that
    differ only in case. Returns a manifest of IDs."""
    ids = user_ids()
    with sqlite3.connect(path) as c:
        c.executescript(SCHEMA)
        for uid in ids:
            surname, name = person(uid)
            password = "$2b$12$synthetic.hash.of.a.legacy.password.only.000000" if uid in PASSWORD_IDS else ""
            photo = None if uid in NO_PHOTO_IDS else f"{BUCKET}/avatars/{uuid.uuid5(uuid.NAMESPACE_URL, str(uid))}.jpg"
            c.execute(
                "INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (uid, password, uid * 10, str(100 + uid), "", 0, int(uid == 1), int(uid in ADMIN_IDS), 0, "[]", photo),
            )
            vk = f"https://vk.com/id{vk_id(uid)}" if uid in VK_LINK_IDS else ("" if uid % 2 else f"https://vk.com/nick{uid}")
            email = f"vk_{vk_id(uid)}@vk.com" if uid in VK_EMAIL_IDS else f"person{uid}@example.com"
            c.execute(
                "INSERT INTO contact_info VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (uid, surname, name, "", f"{name} {surname}", str(100 + uid), "", "", f"+7000000{uid:04d}",
                 vk, "", email, 1, int(uid not in PENDING_IDS)),
            )
        rosters = {}
        for i, block in enumerate(BLOCKS):
            members = [uid for uid in ids if uid % len(BLOCKS) == i][:6]
            rosters[block] = members
            if block == "Медиа":
                master = "Тимур Тёзкин"
            elif block in ("Танцы", "Игры"):
                master = f"Мастер Блока{i}"  # nobody of this name
            else:
                master = " ".join(reversed(person(members[0])))
            hr = " ".join(reversed(person(members[-1]))) if i < 12 else ""
            c.execute("INSERT INTO block VALUES (?,?,?,?,?)", (block, master, hr, len(members), json.dumps(members)))
        for block, members in rosters.items():
            for uid in members:
                c.execute("UPDATE users SET blocks = trim(blocks || ',' || ?, ',') WHERE user_id = ?", (block, uid))
                c.execute("UPDATE contact_info SET blocks = trim(blocks || ',' || ?, ',') WHERE user_id = ?", (block, uid))
        guides = [(1, "КМБ", "none", "# КМБ\n\n**Добро пожаловать** в профком.", "Курс молодого бойца")]
        for n, block in enumerate(BLOCKS[:11], start=2):
            text = f"## {block}\n\n*Гайд блока* {block}."
            if n <= 5:
                text += f"\n\nФайл: {BUCKET}/guides/Положение%20{n}.pdf"
            guides.append((n, f"Гайд {block}", block, text, f"Описание {n}"))
        c.executemany("INSERT INTO guides VALUES (?,?,?,?,?,NULL)", guides)
        c.executemany(
            "INSERT INTO pgas_entries VALUES (?,?,?,?,?,?,?,?)",
            [
                (n, f"Мероприятие {n}", 2024 + n % 2, f"{BUCKET}/pgas/document-{n}.pdf", f"document-{n}.pdf",
                 "application/pdf", "2026-09-01T00:00:00", 1)
                for n in range(1, 43)
            ],
        )
        c.executemany(
            "INSERT INTO refresh_tokens VALUES (?,?,?)",
            [(f"synthetic-refresh-{n}", ids[n % len(ids)], "2026-11-01T00:00:00") for n in range(304)],
        )
        if "orphan" in extra:
            c.execute("INSERT INTO users VALUES (900,'',0,'0','',0,0,0,0,'[]',NULL)")
        if "case" in extra:
            c.execute("UPDATE contact_info SET email='Person20@Example.com' WHERE user_id=20")
            c.execute("UPDATE contact_info SET email='person20@example.com' WHERE user_id=21")
    return dict(rosters=rosters, ids=ids)
