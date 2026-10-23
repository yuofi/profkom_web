"""What the operator still has to decide before the upgraded site opens (A-DIR-13, A-DIR-17).

Plain SQLite reads that work on the schema of the old site (6eb9dea) and on a migrated
database alike, so a dry-run needs no application import. Only IDs, VK IDs from the
saved links and the legacy master string are reported: no e-mails, phones or tokens.
"""

import json
import re
import uuid
from collections import defaultdict
from urllib.parse import urlsplit

# The old VK login saved these (6eb9dea main.py:470, :493); vk_auth.VK_LINK reads the same link.
VK_LINK = re.compile(r"https?://(?:www\.|m\.)?vk\.(?:com|ru)/id(\d+)/?", re.IGNORECASE)
VK_EMAIL = re.compile(r"vk_(\d+)@vk\.com", re.IGNORECASE)
# The hosts directory_seed.is_vk_photo replaces at migration; other photos are kept.
VK_HOSTS = ("vk.com", "vk.ru", "vkuserphoto.ru", "userapi.com", "vk-cdn.net", "vkuser.net")


def tables(c):
    return {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def columns(c, table):
    return {r[1] for r in c.execute(f'PRAGMA table_info("{table}")')}


def block_id(name):
    # The stable ID domain_seed.meta_for gives a legacy block.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "profkom:block:" + name))


def vk_id(link=None, email=None):
    pattern, value = (VK_LINK, link) if link is not None else (VK_EMAIL, email)
    match = pattern.fullmatch((value or "").strip())
    return match.group(1) if match else None


def vk_host(url):
    host = (urlsplit(url or "").hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in VK_HOSTS)


def _name(value):
    return " ".join((value or "").split()).casefold()


def people(c):
    """Accounts with the state the migration gives them (migrations_v13.migrate_core)."""
    migrated = "account_state" in columns(c, "users")
    state = "u.account_state" if migrated else "NULL"
    rows = c.execute(
        f"""SELECT u.user_id, u.hashed_password, u.banned, u.super_user, u.admin, u.photo_url, {state},
                   ci.user_id IS NOT NULL, ci.in_profcom, ci.email, ci.vk, ci.kkr_name, ci.name, ci.surname
            FROM users u LEFT JOIN contact_info ci ON ci.user_id = u.user_id ORDER BY u.user_id"""
    ).fetchall()
    result = []
    for uid, password, banned, su, admin, photo, st, contact, in_profcom, email, link, kkr, name, surname in rows:
        if not migrated:
            st = "active" if contact and in_profcom and not banned else "pending"
        result.append(
            dict(
                user_id=uid, password=bool(password), banned=bool(banned), super_user=bool(su),
                admin=bool(admin), photo_url=photo, state=st, contact=bool(contact), email=email,
                link=link, names={_name(kkr), _name(f"{name} {surname}"), _name(f"{surname} {name}")} - {""},
            )
        )
    return result


def unresolved(c):
    have = tables(c)
    everyone = people(c)
    current = [p for p in everyone if p["state"] not in ("archived", "purged")]
    identities = (
        dict(c.execute("SELECT user_id, subject FROM external_identities")) if "external_identities" in have else {}
    )
    linked = {s.removeprefix("vk:"): uid for uid, s in identities.items()}

    vk_only, by_vk = [], defaultdict(set)
    for p in current:
        from_link, from_email = vk_id(link=p["link"]), vk_id(email=p["email"])
        if from_link:
            by_vk[from_link].add(p["user_id"])
        if p["password"] or not p["contact"] or p["user_id"] in identities:
            continue
        if from_link and from_email and from_link != from_email:
            found, evidence = None, "conflicting"
        elif from_link:
            found, evidence = from_link, "vk_link_and_email" if from_email else "vk_link"
        elif from_email:
            found, evidence = from_email, "vk_email"
        else:
            found, evidence = None, "none"
        if found:
            by_vk[found].add(p["user_id"])
        vk_only.append(dict(user_id=p["user_id"], state=p["state"], vk_user_id=found, evidence=evidence))
    for vk, uid in linked.items():
        by_vk[vk].add(uid)
    shared = [dict(vk_user_id=k, user_ids=sorted(v)) for k, v in sorted(by_vk.items()) if len(v) > 1]

    groups = [
        sorted(int(x) for x in ids.split(","))
        for (ids,) in c.execute(
            "SELECT group_concat(user_id) FROM contact_info GROUP BY lower(email) HAVING COUNT(*) > 1"
        )
    ]

    blocks = c.execute("SELECT name, master FROM block ORDER BY name").fetchall()
    meta = dict(c.execute("SELECT legacy_name, block_id FROM block_metadata")) if "block_metadata" in have else {}
    masters = (
        {r[0] for r in c.execute("SELECT scope_id FROM role_assignments WHERE scope_kind='block' AND role='master'")}
        if "role_assignments" in have
        else set()
    )
    unmapped = [
        dict(
            block_id=meta.get(name, block_id(name)),
            legacy_name=name,
            legacy_master=master,
            candidate_user_ids=[p["user_id"] for p in current if master and _name(master) in p["names"]],
        )
        for name, master in blocks
        if name not in masters
    ]
    hr_mapped = "is_hr" in columns(c, "block") and c.execute("SELECT 1 FROM block WHERE is_hr").fetchone() is not None

    chair = None
    if "leadership" in have:
        row = c.execute("SELECT chair_user_id FROM leadership WHERE id=1").fetchone()
        chair = row[0] if row else None

    undocumented = []
    if "participation_intervals" in have:
        marker = c.execute(
            "SELECT completed_at, report_json FROM domain_migrations WHERE version='v13-observed-participation'"
        ).fetchone()
        stamp, observed = (marker[0], json.loads(marker[1]).get("observed_interval_ids", {})) if marker else (None, {})
        intervals = defaultdict(list)
        for uid, iid, started in c.execute("SELECT user_id, interval_id, started_at FROM participation_intervals"):
            intervals[uid].append((iid, started))
        for p in current:
            if p["state"] == "active" and not p["banned"]:
                own = intervals.get(p["user_id"], [])
                if not own or all(iid == observed.get(str(p["user_id"])) and started == stamp for iid, started in own):
                    undocumented.append(p["user_id"])
    else:
        undocumented = [p["user_id"] for p in current if p["state"] == "active"]

    preset = {}
    if "profile_metadata" in have:
        preset = {
            uid: (preset_id, file_id, key)
            for uid, preset_id, file_id, key in c.execute(
                """SELECT m.user_id, m.preset_id, m.avatar_file_id, f.storage_key FROM profile_metadata m
                   LEFT JOIN file_records f ON f.file_id = m.avatar_file_id"""
            )
        }

    def legacy_photo_shown(p):
        if not p["photo_url"] or vk_host(p["photo_url"]):
            return False
        preset_id, file_id, key = preset.get(p["user_id"], (None, None, None))
        return not preset_id and (not file_id or key is not None)

    copies = [
        p["user_id"]
        for p in current
        if legacy_photo_shown(p) and (not p["password"] or vk_id(link=p["link"]) or vk_id(email=p["email"]))
    ]

    return dict(
        chair_missing=chair is None,
        legacy_super_user_ids=[p["user_id"] for p in everyone if p["super_user"]],
        legacy_admin_ids=[p["user_id"] for p in everyone if p["admin"]],
        hr_block_missing=not hr_mapped,
        hr_block_candidates=[meta.get(name, block_id(name)) for name, _ in blocks if name.casefold() == "hr"],
        vk_only=vk_only,
        vk_id_shared=shared,
        email_case_groups=groups,
        unmapped_blocks=unmapped,
        incomplete_user_ids=[p["user_id"] for p in everyone if not p["contact"]],
        ambiguous_vk_copy=copies,
        without_documented_participation=undocumented,
    )


def guides(c):
    """Blocks with their own guide and blocks that get or have a placeholder (GAP0-08)."""
    names = [r[0] for r in c.execute("SELECT name FROM block ORDER BY name")]
    if "materials" in tables(c):
        meta = dict(c.execute("SELECT legacy_name, block_id FROM block_metadata"))
        own = {
            r[0]: bool(r[1])
            for r in c.execute(
                "SELECT owner_block_id, MIN(placeholder) FROM materials WHERE owner_block_id IS NOT NULL AND NOT deleted GROUP BY owner_block_id"
            )
        }
        ids = {name: meta.get(name, block_id(name)) for name in names}
        return dict(
            with_guide=[ids[n] for n in names if ids[n] in own and not own[ids[n]]],
            placeholder=[ids[n] for n in names if own.get(ids[n], True)],
        )
    owners = {(r[0] or "").strip().casefold() for r in c.execute("SELECT owner_block FROM guides")}
    return dict(
        with_guide=[block_id(n) for n in names if n.casefold() in owners],
        placeholder=[block_id(n) for n in names if n.casefold() not in owners],
    )


def categories(c):
    """Categories by the rule of decision 36 (migrations_v13.categorize), or as decided."""
    have = tables(c)
    if "domain_migrations" in have:
        row = c.execute("SELECT completed_at, report_json FROM domain_migrations WHERE version='v13-categories'").fetchone()
        if row:
            return dict(completed_at=row[0], **json.loads(row[1]))
    if "category" in columns(c, "users"):
        return dict(rule="not applied: the category column existed before this migration")
    approved = [p["user_id"] for p in people(c) if p["state"] == "active"]
    return dict(planned=True, activist=approved, junior=[p["user_id"] for p in people(c) if p["user_id"] not in approved])
