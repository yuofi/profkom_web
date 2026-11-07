"""The service (root) account for debugging (owner, 2026-11-08; docs/SERVICE_ACCOUNT.md).

ROOT_LOGIN and the bcrypt ROOT_PASSWORD_HASH in backend/.env turn it on; without either it is
off, cannot sign in and its sessions end. One users row marked `is_service`, made and updated
only by `sync()` at startup. It holds every right (access.relations), appears in no list or
count of people (`visible()`, the one filter), can never be an assignee, member, role holder,
sender, maintainer or recipient (`refuse()`), is shown as NAME without a profile link wherever
it acted, needs no VK link and gets no VK notification. Every sign-in notifies the chair and
the master of the block named exactly IT on the site only; so do three failed ones in a row.
The password and its hash are never logged.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from errors import InvalidInput
from settings import settings

# database imports this module during its own import-time upgrades: its names are read lazily.

NAME = "Сервисный аккаунт"
# The contact row every account has; never a sign-in address (see login in main.py).
EMAIL = "service-account@system.invalid"
IT_BLOCK = "IT"  # access.IT_BLOCK: its master hears of the sign-ins
FAILURES_NOTICE = 3  # failed sign-ins in a row that notify
# Failed service sign-ins from one address in a fixed window before 429.
THROTTLE_WINDOW_S = 15 * 60
THROTTLE_LIMIT = 10
_SALT = secrets.token_bytes(32)
MOSCOW = timezone(timedelta(hours=3))


def enabled():
    return bool(settings.ROOT_LOGIN and settings.ROOT_PASSWORD_HASH)


def login_matches(login):
    """An exact, constant-time match with ROOT_LOGIN; always False while off."""
    if not enabled() or not isinstance(login, str):
        return False
    return hmac.compare_digest(login.encode("utf-8"), settings.ROOT_LOGIN.encode("utf-8"))


def is_service(user):
    """The users row or its dataclass is the service account."""
    return bool(getattr(user, "is_service", False))


def is_service_id(uid):
    """Whether account `uid` is the service account (the request-memoized users row)."""
    if not isinstance(uid, int) or isinstance(uid, bool):
        return False
    from database import db
    return is_service(db.get_user(uid))


def visible(column=None):
    """The one filter of people lists and counts: rows whose user id `column` is not the
    service account (with no column, the users rows themselves). A NULL id stays."""
    from database import UserORM
    if column is None:
        return UserORM.is_service.is_(False)
    return or_(column.is_(None), column.not_in(select(UserORM.user_id).where(UserORM.is_service.is_(True))))


def visible_ids(session, ids):
    """`ids` in their order without the service account: the same filter for ids in hand."""
    from database import UserORM
    ids = list(ids)
    if not ids:
        return ids
    hidden = set(session.execute(select(UserORM.user_id).where(UserORM.is_service.is_(True))).scalars())
    return [uid for uid in ids if uid not in hidden]


def refused(session, uid):
    """The service account cannot be chosen: assignee, member, role holder, recipient."""
    if not isinstance(uid, int) or isinstance(uid, bool):
        return False
    from database import UserORM
    user = session.get(UserORM, uid)
    return is_service(user)


def refuse(session, uid):
    """As an unknown account (it is shown nowhere): 422 unknown_user."""
    if refused(session, uid):
        raise InvalidInput(f"Unknown user {uid}", "unknown_user", user_id=uid)


def refuse_all(session, uids):
    for uid in uids:
        refuse(session, uid)


def anonymize(session, uid, old_pid, new_pid):
    """Retention callback (account_cleanup): the sign-in tables name no account (a counter
    and salted address hashes), so nothing changes."""


# ── Startup ──

def _end_sessions(session, row):
    from database import RefreshTokenORM
    row.session_version += 1
    session.query(RefreshTokenORM).filter_by(user_id=row.user_id).delete(synchronize_session=False)


def _upsert(session):
    """The service row as configured; its sessions end when the password changes."""
    from database import ContactInfoORM, UserORM
    row = session.query(UserORM).filter(UserORM.is_service.is_(True)).one_or_none()
    if row is None:
        row = UserORM(hashed_password=settings.ROOT_PASSWORD_HASH, kkr_score=0, group_number="", blocks="",
                      banned=False, super_user=False, admin=False, pgas_admin=False, account_state="active",
                      category="junior", must_change_password=False, is_service=True)
        session.add(row)
        session.flush()
    elif row.hashed_password != settings.ROOT_PASSWORD_HASH:
        row.hashed_password = settings.ROOT_PASSWORD_HASH
        _end_sessions(session, row)
    # Never a legacy flag, a ban, an archive or a temporary password: rights come from is_service.
    row.banned = row.super_user = row.admin = row.pgas_admin = row.must_change_password = False
    row.account_state, row.bot_link_state, row.blocks = "active", None, ""
    contact = session.get(ContactInfoORM, row.user_id)
    if contact is None:
        session.add(ContactInfoORM(user_id=row.user_id, surname="", name=NAME, patronymic="", kkr_name=NAME,
                                   group_number="", location="", blocks="", phone="", vk="", tg="", email=EMAIL,
                                   budget=False, in_profcom=False))
    session.flush()
    return row


def sync():
    """The idempotent startup step. Configured: makes or updates the one service row.
    Not configured: an existing row keeps no password and its sessions end. No other
    account is read or changed."""
    from database import UserORM, db
    with db.atomic(), db._session() as session:
        if enabled():
            _upsert(session)
        else:
            row = session.query(UserORM).filter(UserORM.is_service.is_(True)).one_or_none()
            if row is not None and row.hashed_password:
                row.hashed_password = ""
                _end_sessions(session, row)
        session.commit()


def session_allowed(user):
    """A service session works only while the account is configured."""
    return not is_service(user) or enabled()


# ── Sign-in ──

def client_ip(request):
    """The address the per-client limits use: uvicorn's --proxy-headers with
    --forwarded-allow-ips (entrypoint.sh) already took it from a trusted nginx only."""
    return request.client.host if request.client else "unknown"


_BROWSERS = (("YaBrowser", "Яндекс Браузер"), ("Edg", "Edge"), ("OPR", "Opera"), ("Firefox", "Firefox"),
             ("Chrome", "Chrome"), ("Version", "Safari"))
_SYSTEMS = (("iPhone", "iOS"), ("iPad", "iPadOS"), ("Android", "Android"), ("Windows", "Windows"),
            ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"))


def browser(user_agent):
    """A short summary of a User-Agent: «Chrome 130, macOS»; never the raw header."""
    agent = user_agent or ""
    name = next((f"{label} {match.group(1)}" for token, label in _BROWSERS
                 for match in [re.search(re.escape(token) + r"/(\d+)", agent)] if match
                 and (token != "Version" or "Safari/" in agent)), None)
    system = next((label for token, label in _SYSTEMS if token in agent), None)
    parts = [part for part in (name, system) if part]
    if parts:
        return ", ".join(parts)
    other = re.sub(r"[^\w./ -]", "", agent.split(" ", 1)[0])[:40]
    return other or "неизвестный браузер"


def _throttle_row(session, ip, window):
    from service_account_models import ServiceLoginThrottleORM
    key = hashlib.sha256(_SALT + ip.encode("utf-8")).hexdigest()
    row = session.get(ServiceLoginThrottleORM, key)
    if row is not None and row.window != window:
        row.window, row.count = window, 0
    return row, key


def throttled(ip, at=None):
    """THROTTLE_LIMIT failed service sign-ins from `ip` in this window: 429 before the
    password is looked at."""
    from database import db
    window = int((at or datetime.now(timezone.utc)).timestamp()) // THROTTLE_WINDOW_S
    with db._session() as session:
        row, _ = _throttle_row(session, ip, window)
        return bool(row and row.count >= THROTTLE_LIMIT)


def recipients(session):
    """The chair and the master of the block named exactly IT (without it, the chair only)."""
    from database import BlockORM, LeadershipORM
    lead = session.get(LeadershipORM, 1)
    block = session.get(BlockORM, IT_BLOCK)
    result = {lead.chair_user_id if lead else None, block.master_user_id if block else None}
    return sorted(uid for uid in result if isinstance(uid, int))


def _notify(session, kind, at, ip, agent, failures=None):
    from notifications import emit
    payload = dict(at=at.isoformat(), ip=ip, browser=browser(agent))
    if failures is not None:
        payload["failures"] = failures
    emit(session, recipients(session), kind, payload, f"{kind}:{uuid.uuid4()}")


def record(ip, agent, success, at=None):
    """One service sign-in attempt, in its own short transaction: the counters, the
    notifications and, on success, the tokens of the service row (else None)."""
    from auth import create_token_pair
    from database import db
    from service_account_models import ServiceLoginStateORM, ServiceLoginThrottleORM

    at = at or datetime.now(timezone.utc)
    with db.atomic(), db._session() as session:
        row = _upsert(session)
        state = session.get(ServiceLoginStateORM, 1)
        if state is None:
            state = ServiceLoginStateORM(state_id=1, failures=0)
            session.add(state)
        if success:
            state.failures, state.last_failed_at = 0, None
            _notify(session, "service_login", at, ip, agent)
            session.commit()
            return create_token_pair(row.user_id)
        state.failures = (state.failures or 0) + 1
        state.last_failed_at = at.isoformat()
        window = int(at.timestamp()) // THROTTLE_WINDOW_S
        throttle, key = _throttle_row(session, ip, window)
        if throttle is None:
            throttle = ServiceLoginThrottleORM(key=key, window=window, count=0)
            session.add(throttle)
        throttle.count += 1
        session.query(ServiceLoginThrottleORM).filter(ServiceLoginThrottleORM.window < window - 1).delete(
            synchronize_session=False)
        if state.failures % FAILURES_NOTICE == 0:
            _notify(session, "service_login_failed", at, ip, agent, failures=state.failures)
        session.commit()
        return None


def notice_text(kind, payload):
    """The bell's line of a sign-in notice: time in Moscow, IP and browser."""
    try:
        at = datetime.fromisoformat(payload.get("at") or "").astimezone(MOSCOW).strftime("%d.%m.%Y %H:%M")
    except (TypeError, ValueError):
        at = "время неизвестно"
    details = f"{at} МСК, IP {payload.get('ip') or 'неизвестен'}, {payload.get('browser') or 'неизвестный браузер'}"
    if kind == "service_login_failed":
        return f"Неудачные попытки входа в сервисный аккаунт ({payload.get('failures') or FAILURES_NOTICE} подряд): {details}"
    return f"Вход в сервисный аккаунт: {details}"
