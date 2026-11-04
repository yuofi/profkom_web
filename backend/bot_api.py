"""HereBot: the service API /api/bot/v1 and the people's routes (stages 1 to 3).

The contract is backend/docs/BOT_API.md. The bot is a client with a service token; the site
stores only its SHA-256 (settings.BOT_API_TOKEN_SHA256, two values while rotating). The token
check reads no database, so a wrong token never waits for the write lock or a unit. The
service routes are outside the user router: no JWT, account or working-access guard.
Stage 1 keeps the last heartbeat and the bot's error groups. Stage 2 links an account to its
VK: the site issues a one-time code, the bot confirms it, reports carry the VK's message and
token events (the policy without SQL is bot_link.py). Stage 3 hands out the site's
notifications queued for VK (notification_delivery_events, channel `vk`) and applies the
bot's results.
"""
import hashlib
import hmac
import json
import re
import secrets
import threading
import uuid
from collections import deque
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from fastapi.routing import APIRoute
from fastapi.security.utils import get_authorization_scheme_param
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from sqlalchemy import bindparam, case, delete, func, literal, select, text, update

import access
import bot_link
from api_contract import Page
from auth import get_current_user, unit_of_work
from bot_link import TOKEN_STATUSES, parse, stamp, state_of, utcnow
from bot_models import BotErrorORM, BotLinkCodeORM, BotLinkORM, BotStatusORM
from database import db, ContactInfoORM, ExternalIdentityORM, NotificationORM, RoleAssignmentORM, UserORM
from domain_contract import UserReference
from errors import Conflict, NotFound, PayloadTooLarge, TooManyRequests, Unauthenticated
from models import User
from profile_features import vk_on_by_default
from profile_features_models import NotificationDeliveryEventORM as DeliveryORM, NotificationPreferenceORM
from registration import audit, fail, link_changed
from settings import settings
from workspace import notification_views

PREFIX = "/api/bot/v1"
API = 1
MAX_BODY = 256 * 1024
MAX_ERRORS = 50
MESSAGE_LIMIT, TRACEBACK_LIMIT, NAME_LIMIT = 1000, 8000, 200
POLL_AFTER_MS = 3000
KEEP_GROUPS, KEEP_DAYS, CLEAN_EVERY = 500, 30, timedelta(hours=1)
CONSOLE_ERRORS = 100
ONLINE_FLOOR_S = 180
MAX_EVENTS = 500
CODE_ALPHABET, CODE_LENGTH, CODE_TTL = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", 10, timedelta(minutes=15)  # Crockford base32
CODES_PER_HOUR = 10
FAILURES_PER_VK, FAILURES_TOTAL = 10, 200  # failed confirmations in FAILURE_WINDOW
FAILURE_WINDOW = timedelta(minutes=15)
DISABLED = "Bot API is disabled"
MAX_DELIVERIES = 100  # results in one report
DELIVERY_TTL = timedelta(hours=24)  # a notification not sent by then is `expired`
RETRY_MINUTES = (1, 5, 30, 120)  # the wait after the 1st to 4th retryable failure; the 5th is final
TEXT_LIMIT = 4000
HELD_LIMIT = 1000
GONE = ("archived", "purged")  # with a ban: an account whose notifications are `cancelled`
RESULTS = ("sent", "denied", "failed")
# Literal, not bound: SQLite uses the partial index ix_delivery_vk_pending only for a query
# whose WHERE repeats the index's own terms.
PENDING_VK = text("notification_delivery_events.channel = 'vk' AND notification_delivery_events.state = 'pending'")


# ── Service token ──

def token_hashes():
    value = settings.BOT_API_TOKEN_SHA256
    return value.split(",") if value else []


async def bot_token(request: Request):
    """404 while the integration is off, 401 for a missing or wrong token; no database read."""
    hashes = token_hashes()
    if not hashes:
        raise NotFound(DISABLED, "bot_api_disabled")
    scheme, token = get_authorization_scheme_param(request.headers.get("Authorization"))
    digest = hashlib.sha256(token.encode()).hexdigest() if scheme.lower() == "bearer" and token else ""
    # Every configured hash is compared: the timing does not tell which one matched.
    if not sum(hmac.compare_digest(digest, known) for known in hashes):
        raise Unauthenticated("Bot token missing or invalid", "bot_token_invalid")


class LimitedBody(APIRoute):
    """Refuses a body over MAX_BODY before FastAPI reads it: by Content-Length, then by the
    bytes actually received (a chunked body names no length). The body is read before the
    dependencies, as FastAPI does, so never while a unit holds the write lock."""

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def limited(request: Request):
            if request.method in ("GET", "HEAD"):
                return await handler(request)
            length = request.headers.get("content-length", "")
            if length.isdigit() and int(length) > MAX_BODY:
                raise PayloadTooLarge(f"Body over {MAX_BODY} bytes", max_bytes=MAX_BODY)
            body = bytearray()
            async for chunk in request.stream():
                body += chunk
                if len(body) > MAX_BODY:
                    raise PayloadTooLarge(f"Body over {MAX_BODY} bytes", max_bytes=MAX_BODY)
            replayed = False

            async def receive():
                nonlocal replayed
                if replayed:
                    return await request.receive()
                replayed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await handler(Request(request.scope, receive))
        return limited


service_router = APIRouter(prefix=PREFIX, route_class=LimitedBody,
                           dependencies=[Depends(bot_token), Depends(unit_of_work)])


# ── Wire models ──

def clipped(limit):
    """Free text the site shortens itself instead of refusing the report."""
    return Annotated[str, AfterValidator(lambda value: value[:limit])]


class Lenient(BaseModel):
    """Unknown fields are skipped: later stages and newer bots add fields within v1."""
    model_config = ConfigDict(extra="ignore")


Key = Annotated[str, Field(min_length=1, max_length=64)]


class Heartbeat(Lenient):
    version: str = Field(max_length=64)
    commit: str = Field("", max_length=64)
    started_at: datetime
    interval_s: int = Field(ge=1, le=86400)
    stopping: bool = False
    components: dict[Key, int | float | None] = Field(default_factory=dict, max_length=32)
    longpoll_connected: bool | None = None
    database: str = Field("", max_length=32)
    counters: dict[Key, int | None] = Field(default_factory=dict, max_length=32)


class ErrorGroup(Lenient):
    fingerprint: str = Field(pattern=r"^[0-9a-f]{16}$")
    level: str = Field(min_length=1, max_length=16)
    logger: clipped(NAME_LIMIT) = ""
    where: clipped(NAME_LIMIT) = ""
    message: clipped(MESSAGE_LIMIT) = ""
    traceback: clipped(TRACEBACK_LIMIT) | None = None
    count: int = Field(1, ge=1, le=10**9)
    first_at: datetime
    last_at: datetime


VkUserId = Annotated[int, Field(gt=0, le=2**63 - 1)]


class VkEvent(Lenient):
    """message_allow or message_deny from Long Poll; another event is skipped (rules of v1)."""
    vk_user_id: VkUserId
    event: str = Field(max_length=32)
    at: datetime


class TokenEvent(Lenient):
    """The bot's last word on the user's token; an unknown status is skipped."""
    vk_user_id: VkUserId
    status: str = Field(max_length=32)
    at: datetime


class DeliveryResult(Lenient):
    """What VK answered to one delivery; another status is skipped (rules of v1)."""
    delivery_id: str = Field(min_length=1, max_length=64)
    status: str = Field(max_length=32)
    vk_message_id: int | None = Field(None, ge=0, le=2**63 - 1)
    error_code: int | clipped(64) | None = None  # VK's error code, or the bot's word for a network failure
    retryable: bool = False


class Report(Lenient):
    api: Literal[1] = API
    report_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    boot_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    heartbeat: Heartbeat | None = None
    errors: list[ErrorGroup] = Field(default_factory=list, max_length=MAX_ERRORS)
    deliveries: list[DeliveryResult] = Field(default_factory=list, max_length=MAX_DELIVERIES)
    vk_events: list[VkEvent] = Field(default_factory=list, max_length=MAX_EVENTS)
    tokens: list[TokenEvent] = Field(default_factory=list, max_length=MAX_EVENTS)


class LinkConfirm(Lenient):
    api: Literal[1] = API
    code: str = Field(min_length=1, max_length=64)
    vk_user_id: VkUserId
    messages_allowed: bool | None = None  # None: VK did not answer the check
    token_status: Literal[TOKEN_STATUSES]
    at: datetime  # when the bot checked both: the reference time of later events


class LinkConfirmed(BaseModel):
    api: int = API
    linked: bool = True
    user_id: int
    display_name: str
    state: str


class Delivery(BaseModel):
    """One notification to send with messages.send (stage 3)."""
    delivery_id: str
    peer_id: int
    text: str
    random_id: int
    created_at: str


class Work(BaseModel):
    api: int = API
    server_time: str
    poll_after_ms: int = POLL_AFTER_MS
    paused: bool = False
    deliveries: list[Delivery] = []  # stage 3
    broadcasts: list[dict] = []  # stage 4
    commands: list[dict] = []  # stage 5


class Accepted(BaseModel):
    api: int = API
    accepted: bool = True
    duplicate: bool
    server_time: str


# ── Service routes ──

@service_router.get("/work", response_model=Work)
def work(limit: int = Query(50, ge=1, le=100)):
    """Stage 3: the due VK deliveries; an idle poll is one indexed SELECT."""
    now = utcnow()
    return Work(server_time=stamp(now), deliveries=due_deliveries(limit, now))


@service_router.post("/report", response_model=Accepted)
def report(payload: Report):
    now = utcnow()
    return Accepted(duplicate=store(payload, now), server_time=stamp(now))


@service_router.post("/links/confirm", response_model=LinkConfirmed)
def links_confirm(payload: LinkConfirm):
    """Stage 2: the bot confirms the code a person sent it; a repeat answers the same."""
    return confirm_link(payload, utcnow())


def store(payload, now):
    """The report in the request's write unit; True for a repeat of the last report.

    A heartbeat-only report is one SELECT and one UPDATE of bot_status (with BEGIN, three
    statements); error groups add one SELECT and their writes; the retention runs when the
    report adds a group or an hour after the last pass, and hourly expires the VK deliveries
    pending for 24 hours. VK events add one SELECT of the links they name and writes of the
    changed ones only. Delivery results add one SELECT of their rows and one UPDATE of the
    pending ones; the rows the last polls held add one UPDATE.
    """
    with db._session() as s:
        status = s.get(BotStatusORM, 1)
        if status is not None and status.report_id == payload.report_id:
            return True
        if status is None:
            status = BotStatusORM(id=1)
            s.add(status)
        status.report_id, status.boot_id, status.last_seen_at = payload.report_id, payload.boot_id, stamp(now)
        if payload.heartbeat is not None:
            status.started_at = stamp(payload.heartbeat.started_at)
            status.heartbeat_json = json.dumps(payload.heartbeat.model_dump(mode="json"), ensure_ascii=False)
            status.updated_at = stamp(now)
        added = merge_errors(s, payload.errors) if payload.errors else False
        if payload.vk_events or payload.tokens:
            apply_events(s, payload.vk_events, payload.tokens, now)
        held = HELD.snapshot()
        if payload.deliveries or held:
            apply_results(s, payload.deliveries, held, now)
        due = not status.cleaned_at or status.cleaned_at <= stamp(now - CLEAN_EVERY)
        if due:
            status.cleaned_at = stamp(now)
        if added or due:
            s.flush()
            # 30 days, then the newest 500 groups (the newest last_at wins, then the fingerprint).
            # Two plain statements: the unit ends right after, no loaded row is read again.
            plain = dict(synchronize_session=False)
            s.execute(delete(BotErrorORM).where(BotErrorORM.last_at < stamp(now - timedelta(days=KEEP_DAYS))),
                      execution_options=plain)
            keep = select(BotErrorORM.fingerprint).order_by(
                BotErrorORM.last_at.desc(), BotErrorORM.fingerprint.desc()).limit(KEEP_GROUPS)
            s.execute(delete(BotErrorORM).where(BotErrorORM.fingerprint.not_in(keep)), execution_options=plain)
        if due:
            s.execute(update(DeliveryORM).where(PENDING_VK, DeliveryORM.created_at < (now - DELIVERY_TTL).isoformat())
                      .values(state="expired", updated_at=now.isoformat()), execution_options=plain)
        s.commit()
    HELD.discard(held)
    return False


def merge_errors(s, items):
    """Adds the counts to the stored groups; the latest text wins. True if a group is new."""
    groups = {}
    for item in items:  # a fingerprint repeated within one report is one group
        first, last = sorted((stamp(item.first_at), stamp(item.last_at)))
        seen = groups.get(item.fingerprint)
        if seen:
            seen.update(count=seen["count"] + item.count, first_at=min(seen["first_at"], first),
                        last_at=max(seen["last_at"], last), level=item.level, logger=item.logger,
                        location=item.where, message=item.message, traceback=item.traceback)
            continue
        groups[item.fingerprint] = dict(count=item.count, first_at=first, last_at=last, level=item.level,
                                        logger=item.logger, location=item.where, message=item.message,
                                        traceback=item.traceback)
    rows = {row.fingerprint: row for row in s.query(BotErrorORM).filter(BotErrorORM.fingerprint.in_(list(groups)))}
    for fingerprint, group in groups.items():
        row = rows.get(fingerprint)
        if row is None:
            s.add(BotErrorORM(fingerprint=fingerprint, **group))
            continue
        row.count += group["count"]
        row.first_at, row.last_at = min(row.first_at, group["first_at"]), max(row.last_at, group["last_at"])
        row.level, row.logger, row.location = group["level"], group["logger"], group["location"]
        row.message, row.traceback = group["message"], group["traceback"]
    return len(rows) < len(groups)


def anonymize(session, uid, old_pid, new_pid):
    """Retention callback (account_cleanup): the account's VK link and codes go. The stage 1
    tables hold the bot's own state and log groups, no site account. The site grants are
    role_assignments rows; the cleanup removes them with the account's other roles. The VK
    deliveries are notification_delivery_events rows: profile_features.anonymize deletes them."""
    session.query(BotLinkCodeORM).filter_by(user_id=uid).delete(synchronize_session=False)
    user = session.get(UserORM, uid)
    if user is not None:
        save_link(session, user, None)


# ── The VK link (stage 2) ──

class Window:
    """Events per key in a sliding window, in process memory: the site runs one uvicorn
    process (BOT_API.md). reset() is for tests."""

    def __init__(self, span):
        self.span, self.events, self.lock = span, {}, threading.Lock()

    def _live(self, key, now):
        events = self.events.get(key)
        while events and events[0] <= now - self.span:
            events.popleft()
        if events is not None and not events:
            del self.events[key]
        return len(events or ())

    def count(self, key, now):
        with self.lock:
            return self._live(key, now)

    def add(self, key, now):
        with self.lock:
            if len(self.events) > 10000:  # forget keys whose window has passed
                for stale in [k for k, v in self.events.items() if v[-1] <= now - self.span]:
                    del self.events[stale]
            self.events.setdefault(key, deque()).append(now)

    def reset(self):
        with self.lock:
            self.events.clear()


CODES = Window(timedelta(hours=1))  # codes issued per account
FAILURES = Window(FAILURE_WINDOW)  # failed confirmations per VK, and of everyone under None


def reset_limits():
    CODES.reset()
    FAILURES.reset()


_READ_AS = str.maketrans({"O": "0", "I": "1", "L": "1"})


def normalize(code):
    """As the bot reads a code: no spaces or hyphens, upper case, O is 0, I and L are 1. None
    if what is left is not a code."""
    text = re.sub(r"[\s-]+", "", code).upper().translate(_READ_AS)
    return text if len(text) == CODE_LENGTH and all(ch in CODE_ALPHABET for ch in text) else None


def code_hash(code):
    return hashlib.sha256(code.encode()).hexdigest()


def shown(code):
    return f"{code[:5]}-{code[5:]}"


def save_link(s, user, link):
    """The one writer of bot_links and its copy users.bot_link_state: both change in this
    transaction, so the gate and /api/session read a current state with the users row. None
    removes the account's link. A pending application that became ready is announced."""
    if link is None:
        existing = s.get(BotLinkORM, user.user_id)
        if existing is not None:
            s.delete(existing)
            s.flush()  # the VK is free for another account within this transaction
    else:
        s.add(link)
    old, user.bot_link_state = user.bot_link_state, state_of(link)
    if user.bot_link_state != old:
        link_changed(s, user, old)


def display_name(s, uid):
    c = s.get(ContactInfoORM, uid)
    return " ".join(part for part in (c.name, c.surname) if part) if c else ""


def confirm_link(payload, now):
    """POST /links/confirm. Failures (404, 409) are counted per VK and in all; past the limit
    every attempt answers 429 before the code is looked at."""
    vk = payload.vk_user_id
    if FAILURES.count(vk, now) >= FAILURES_PER_VK or FAILURES.count(None, now) >= FAILURES_TOTAL:
        raise TooManyRequests("Too many failed link attempts", "link_rate_limited")
    try:
        return _confirm(payload, vk, now)
    except (NotFound, Conflict):
        FAILURES.add(vk, now)
        FAILURES.add(None, now)
        raise


def _confirm(payload, vk, now):
    invalid = NotFound("Link code not found, expired or used", "link_code_invalid")
    code = normalize(payload.code)
    with db._session() as s:
        row = s.get(BotLinkCodeORM, code_hash(code)) if code else None
        if row is None or row.expires_at <= stamp(now) or (row.used_at and row.used_vk_user_id != vk):
            raise invalid
        user = s.get(UserORM, row.user_id)
        if user is None or user.banned or user.account_state in ("archived", "purged"):
            raise invalid
        if row.used_at:  # the same VK again: the answer may have been lost on the way to the bot
            return LinkConfirmed(user_id=user.user_id, display_name=display_name(s, user.user_id),
                                 state=user.bot_link_state or "none")
        subject = f"vk:{vk}"
        identities = s.query(ExternalIdentityORM).filter(
            (ExternalIdentityORM.user_id == user.user_id) | (ExternalIdentityORM.subject == subject)).all()
        if any(i.user_id == user.user_id and i.subject != subject for i in identities):
            raise Conflict("The account signs in with another VK", "vk_mismatch")
        if any(i.user_id != user.user_id for i in identities):
            raise Conflict("This VK signs in to another account", "vk_taken")
        links = {l.user_id: l for l in s.query(BotLinkORM).filter(
            (BotLinkORM.user_id == user.user_id) | (BotLinkORM.vk_user_id == vk))}
        link = links.pop(user.user_id, None)
        first = link is None  # the account's first link turns VK on by default (stage 3)
        holder = s.get(UserORM, next(iter(links))) if links else None
        if holder is not None and holder.account_state not in ("archived", "purged"):
            raise Conflict("This VK is linked to another account", "vk_taken")
        if holder is not None:  # an archived account gives the VK up
            audit(s, "user", holder.user_id, user.user_id, "bot_link", {"vk_user_id": vk}, {"vk_user_id": None})
            save_link(s, holder, None)
        at, old = stamp(payload.at), link.vk_user_id if link else None
        if link is None or link.vk_user_id != vk:
            # A new link, or another VK in place of the old one: the confirmation is all it knows.
            link = link or BotLinkORM(user_id=user.user_id)
            link.vk_user_id, link.linked_at = vk, stamp(now)
            # A person who wrote to the community has allowed its messages unless VK says otherwise.
            link.messages_allowed = True if payload.messages_allowed is None else payload.messages_allowed
            link.messages_at, link.token_status, link.token_at = at, payload.token_status, at
        else:  # the same VK: a value older than the stored one does not win, as for events
            if payload.messages_allowed is not None and at >= link.messages_at:
                link.messages_allowed, link.messages_at = payload.messages_allowed, at
            if at >= link.token_at:
                link.token_status, link.token_at = payload.token_status, at
        link.updated_at = stamp(now)
        row.used_at, row.used_vk_user_id = stamp(now), vk
        audit(s, "user", user.user_id, user.user_id, "bot_link", {"vk_user_id": old}, {"vk_user_id": vk})
        save_link(s, user, link)
        if first:
            vk_on_by_default(s, user.user_id)
        answer = LinkConfirmed(user_id=user.user_id, display_name=display_name(s, user.user_id),
                               state=user.bot_link_state or "none")
        s.commit()
    return answer


def apply_events(s, vk_events, tokens, now):
    """Events of linked VKs; the others are skipped and not stored. An event applies when its
    `at` is not before the stored time of its field; of equal times the last in the list wins.
    One SELECT of the links named, writes of the changed rows only."""
    allow = {"message_allow": True, "message_deny": False}
    vk_events = [e for e in vk_events if e.event in allow]
    tokens = [t for t in tokens if t.status in TOKEN_STATUSES]
    ids = {e.vk_user_id for e in vk_events} | {t.vk_user_id for t in tokens}
    if not ids:
        return
    links = {l.vk_user_id: l for l in s.query(BotLinkORM).filter(BotLinkORM.vk_user_id.in_(ids))}
    changed = set()

    def put(vk, moment, value, field, at_field):
        link, at = links.get(vk), stamp(moment)
        if link is None or at < getattr(link, at_field):
            return
        if (getattr(link, field), getattr(link, at_field)) != (value, at):
            setattr(link, field, value)
            setattr(link, at_field, at)
            changed.add(vk)
    for e in vk_events:
        put(e.vk_user_id, e.at, allow[e.event], "messages_allowed", "messages_at")
    for t in tokens:
        put(t.vk_user_id, t.at, t.status, "token_status", "token_at")
    if not changed:
        return
    users = {u.user_id: u for u in s.query(UserORM).filter(UserORM.user_id.in_([links[vk].user_id for vk in changed]))}
    for vk in sorted(changed):
        links[vk].updated_at = stamp(now)
        save_link(s, users[links[vk].user_id], links[vk])


def issue_code(uid, now):
    """POST /bot-link/code: a new code replaces the account's others; expired codes of anyone
    go with it. Four statements with BEGIN and the account read."""
    if not bot_link.enabled():
        raise NotFound(DISABLED, "bot_api_disabled")
    if CODES.count(uid, now) >= CODES_PER_HOUR:
        raise TooManyRequests(f"At most {CODES_PER_HOUR} link codes an hour", "link_code_rate_limited")
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    with db._session() as s:
        s.execute(delete(BotLinkCodeORM).where((BotLinkCodeORM.user_id == uid) | (BotLinkCodeORM.expires_at <= stamp(now))),
                  execution_options=dict(synchronize_session=False))
        s.add(BotLinkCodeORM(code_hash=code_hash(code), user_id=uid, created_at=stamp(now), expires_at=stamp(now + CODE_TTL)))
        s.commit()
    CODES.add(uid, now)
    url = settings.BOT_VK_URL
    return LinkCode(code=shown(code), expires_at=stamp(now + CODE_TTL), link_url=f"{url}?ref={code}" if url else None,
                    command=f"привязать {shown(code)}")


def link_status(cur, now):
    """GET /bot-link/me: with the account read, one SELECT of the link and the live code."""
    if not bot_link.enabled():
        return LinkStatus(enabled=False)
    live = select(func.max(BotLinkCodeORM.expires_at)).where(
        BotLinkCodeORM.user_id == cur.user_id, BotLinkCodeORM.used_at.is_(None),
        BotLinkCodeORM.expires_at > stamp(now)).scalar_subquery()
    with db._session() as s:
        link, expires = s.execute(select(BotLinkORM, live).select_from(UserORM).outerjoin(
            BotLinkORM, BotLinkORM.user_id == UserORM.user_id).where(UserORM.user_id == cur.user_id)).one()
        return LinkStatus(enabled=True, **bot_link.summary(cur, now), bot_url=settings.BOT_VK_URL or None,
                          code_expires_at=expires, **(dict(
                              vk_user_id=link.vk_user_id, messages_allowed=link.messages_allowed,
                              token_status=link.token_status, linked_at=link.linked_at) if link else {}))


# ── Notifications through the bot (stage 3) ──

class Held:
    """Deliveries /work refused (no access to the object, the account gone) until the next
    report marks them `cancelled`: /work is a read unit and writes nothing. In process memory,
    as the link limits (one uvicorn process); at most HELD_LIMIT ids, /work finds the others
    again. /work skips the held ids, so they do not take the place of sendable rows."""

    def __init__(self):
        self.ids, self.lock = set(), threading.Lock()

    def add(self, ids):
        with self.lock:
            for delivery_id in ids:
                if len(self.ids) >= HELD_LIMIT:
                    break
                self.ids.add(delivery_id)

    def snapshot(self):
        with self.lock:
            return sorted(self.ids)

    def discard(self, ids):
        with self.lock:
            self.ids.difference_update(ids)

    def clear(self):
        with self.lock:
            self.ids.clear()


HELD = Held()

# The page a notification opens: targetRoute of frontend/src/utils/routes.ts.
ROUTES = {"event": "/events/{}", "subevent": "/subevents/{}", "task": "/tasks/{}", "task_queue": "/tasks/queues/{}",
          "block": "/blocks/{}", "report": "/reports/{}", "material": "/materials/{}", "season": "/seasons/{}",
          "pgas": "/pgas", "registrations": "/admin/registrations", "block_requests": "/blocks/requests",
          "meeting_event": "/meetings/event/{}", "meeting_subevent": "/meetings/subevent/{}"}


def target_path(target):
    """The site path of a notification's target; "/" without a target the site opens."""
    template, ident = ROUTES.get((target or {}).get("kind")), (target or {}).get("id")
    if template is None or not isinstance(ident, str) or not ident:
        return "/"
    return template.format(quote(ident, safe="!~*'()"))  # encodeURIComponent


def delivery_text(view):
    """The bell's text and a link to the same page (owner, 2026-11-04: the kind, the object's
    title and the link). Over TEXT_LIMIT the text is cut with «…», the link never."""
    link = settings.public_site_url() + target_path(view["target"])
    body, room = view["text"], TEXT_LIMIT - len(link) - 1
    if len(body) > room:
        body = body[:max(room - 1, 0)] + "…"
    return (body + "\n" + link)[:TEXT_LIMIT]


def random_id(delivery_id):
    """The first 31 bits of SHA-256 of the delivery ID, never 0: every repeat sends the same,
    so VK drops a second copy."""
    return int.from_bytes(hashlib.sha256(delivery_id.encode()).digest()[:4], "big") >> 1 or 1


def due_deliveries(limit, now):
    """GET /work: up to `limit` pending VK rows, due and at most 24 hours old, oldest first.

    A row whose VK takes no messages now (no link, messages denied, VK off for its category)
    waits: the SELECT skips it, so it never takes the place of a sendable row. A row of an
    account that is gone (archived, purged, banned), without its notification, or whose
    object the person no longer reads (the bell shows access_revoked) is not handed out and
    is held for `cancelled`. An idle poll is the one SELECT over ix_delivery_vk_pending; with
    rows, one SELECT of their notifications and the bell's text, target and access check
    (workspace.notification_views) once per recipient.
    """
    D, L, U, P = DeliveryORM, BotLinkORM, UserORM, NotificationPreferenceORM
    held = HELD.snapshot()
    gone = (U.user_id.is_(None) | (U.banned == True) | U.account_state.in_(GONE)).label("gone")  # noqa: E712
    stored = case((func.json_valid(P.preferences_json) == 1, P.preferences_json))  # a broken row reads as off
    vk_on = func.json_extract(stored, literal("$.") + D.category + literal(".vk")) == 1
    query = (select(D.delivery_id, D.user_id, D.event_key, D.created_at, L.vk_user_id, gone)
             .outerjoin(U, U.user_id == D.user_id).outerjoin(L, L.user_id == D.user_id).outerjoin(P, P.user_id == D.user_id)
             .where(PENDING_VK, D.next_attempt_at <= now.isoformat(), D.created_at >= (now - DELIVERY_TTL).isoformat(),
                    gone | ((L.messages_allowed == True) & vk_on))  # noqa: E712
             .order_by(D.created_at, D.delivery_id).limit(limit))
    if held:
        query = query.where(D.delivery_id.not_in(held))
    refused, result = [], []
    with db._session() as s:
        rows = s.execute(query).all()
        refused += [r.delivery_id for r in rows if r.gone]
        rows = [r for r in rows if not r.gone]
        keys = {(r.user_id, r.event_key) for r in rows}
        notes = {(n.user_id, n.event_key): n for n in s.query(NotificationORM).filter(
            NotificationORM.user_id.in_({u for u, _ in keys}), NotificationORM.event_key.in_({k for _, k in keys}))} if keys else {}
        by_user = {}
        for r in rows:
            if (r.user_id, r.event_key) in notes:
                by_user.setdefault(r.user_id, []).append(r)
        views = {}
        for uid, items in by_user.items():
            views.update(zip((r.delivery_id for r in items),
                             notification_views(s, uid, [notes[r.user_id, r.event_key] for r in items])))
        for r in rows:
            view = views.get(r.delivery_id)
            if view is None or view["kind"] == "access_revoked":
                refused.append(r.delivery_id)
                continue
            result.append(Delivery(delivery_id=r.delivery_id, peer_id=r.vk_user_id, text=delivery_text(view),
                                   random_id=random_id(r.delivery_id), created_at=stamp(datetime.fromisoformat(r.created_at))))
    HELD.add(refused)
    return result


def apply_results(s, results, held, now):
    """The bot's results: one SELECT of the pending rows they name and one UPDATE (executemany)
    of those. A result for a row no longer pending, or an unknown one, changes nothing (a
    repeat); of two for one row in a report the first counts; a row without a result (the bot
    did not try it) stays as it is. `denied` also turns the link's messages off, as
    message_deny at the report time. Then the rows the polls held are cancelled if pending."""
    D, when = DeliveryORM, now.isoformat()
    first = {}
    for result in results:
        if result.status in RESULTS:
            first.setdefault(result.delivery_id, result)
    changes, denied = [], set()
    if first:
        for row in s.execute(select(D.delivery_id, D.user_id, D.attempts, D.next_attempt_at)
                             .where(D.delivery_id.in_(list(first)), PENDING_VK)):
            result, attempts = first[row.delivery_id], row.attempts + 1
            change = dict(b_id=row.delivery_id, b_state=result.status, b_attempts=attempts, b_next=row.next_attempt_at,
                          b_sent=None, b_message=None, b_updated=when,
                          b_error=None if result.error_code is None else str(result.error_code)[:64])
            if result.status == "sent":
                change.update(b_sent=when, b_message=result.vk_message_id)
            elif result.status == "denied":
                denied.add(row.user_id)
            elif result.retryable and attempts <= len(RETRY_MINUTES):
                change.update(b_state="pending", b_next=(now + timedelta(minutes=RETRY_MINUTES[attempts - 1])).isoformat())
            changes.append(change)
    if changes:  # every row names the same columns: one executemany
        table = D.__table__
        s.execute(update(table).where(table.c.delivery_id == bindparam("b_id")).values(
            state=bindparam("b_state"), attempts=bindparam("b_attempts"), next_attempt_at=bindparam("b_next"),
            sent_at=bindparam("b_sent"), vk_message_id=bindparam("b_message"), error_code=bindparam("b_error"),
            updated_at=bindparam("b_updated")), changes)
    if denied:
        deny_messages(s, denied, now)
    if held:
        s.execute(update(D).where(D.delivery_id.in_(held), PENDING_VK).values(state="cancelled", updated_at=when),
                  execution_options=dict(synchronize_session=False))


def deny_messages(s, uids, now):
    """VK answered 901: the accounts' links take no messages from the report time on, as a
    message_deny event would (a stored later time wins). One SELECT of the links with their
    accounts; save_link recomputes users.bot_link_state."""
    at = stamp(now)
    for link, user in s.execute(select(BotLinkORM, UserORM).join(UserORM, UserORM.user_id == BotLinkORM.user_id)
                                .where(BotLinkORM.user_id.in_(uids))).all():
        if at >= link.messages_at and (link.messages_allowed, link.messages_at) != (False, at):
            link.messages_allowed, link.messages_at, link.updated_at = False, at, at
            save_link(s, user, link)


def reset_deliveries():
    """Tests: forget the held deliveries."""
    HELD.clear()


# ── People: console status and grants (stage 1) ──

class ConsoleError(BaseModel):
    fingerprint: str
    level: str
    logger: str
    where: str
    message: str
    traceback: str | None = None
    count: int
    first_at: str
    last_at: str


class ConsoleStatus(BaseModel):
    enabled: bool
    online: bool
    last_seen_at: str | None = None
    boot_id: str | None = None
    heartbeat: dict | None = None
    errors: list[ConsoleError] = []


class Maintainer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    maintainer: bool


class MaintainerOut(BaseModel):
    user_id: int
    maintainer: bool


class Sender(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sender: bool


class SenderOut(BaseModel):
    user_id: int
    sender: bool


class LinkStatus(BaseModel):
    """GET /bot-link/me; with the integration off only `enabled: false`."""
    enabled: bool
    state: str | None = None
    vk_user_id: int | None = None
    messages_allowed: bool | None = None
    token_status: str | None = None
    linked_at: str | None = None
    required: bool = False
    blocked: bool = False
    deadline: str | None = None
    bot_url: str | None = None
    code_expires_at: str | None = None


class LinkCode(BaseModel):
    code: str
    expires_at: str
    link_url: str | None = None
    command: str


def online(status, heartbeat, now):
    """The last report is at most max(3 × interval_s, 180) seconds old and was not the
    bot's goodbye (`stopping`)."""
    if status is None or not status.last_seen_at or (heartbeat or {}).get("stopping"):
        return False
    interval = (heartbeat or {}).get("interval_s")
    window = max(3 * interval, ONLINE_FLOOR_S) if isinstance(interval, int) else ONLINE_FLOOR_S
    return parse(status.last_seen_at) >= now - timedelta(seconds=window)


def console_status(now):
    with db._session() as s:
        status = s.get(BotStatusORM, 1)
        heartbeat = json.loads(status.heartbeat_json) if status is not None and status.heartbeat_json else None
        rows = s.query(BotErrorORM).order_by(BotErrorORM.last_at.desc(), BotErrorORM.fingerprint.desc()).limit(CONSOLE_ERRORS)
        errors = [ConsoleError(fingerprint=r.fingerprint, level=r.level, logger=r.logger, where=r.location,
                               message=r.message, traceback=r.traceback, count=r.count, first_at=r.first_at,
                               last_at=r.last_at) for r in rows]
        enabled = bool(token_hashes())
        return ConsoleStatus(enabled=enabled, online=enabled and online(status, heartbeat, now),
                             last_seen_at=status.last_seen_at if status else None,
                             boot_id=status.boot_id if status else None, heartbeat=heartbeat, errors=errors)


def require(uid, action, message):
    if not access.allowed(uid, action):
        fail(403, message)


def grantees(role):
    """Accounts holding the site grant, as user references (archive removes the row)."""
    with db._session() as s:
        ids = s.query(RoleAssignmentORM.user_id).filter_by(scope_kind="site", role=role).order_by(RoleAssignmentORM.user_id)
        return Page(items=[asdict(db._get_user_ref(s, uid)) for (uid,) in ids])


def set_grant(user_id, role, granted, actor):
    """Only an active account is granted; revoking always works; a repeat changes nothing."""
    with db._session() as s:
        u = s.get(UserORM, user_id)
        if not u or (granted and u.account_state != "active"):
            fail(404, "Active user not found")
        rows = s.query(RoleAssignmentORM).filter_by(user_id=user_id, scope_kind="site", role=role).all()
        if granted != bool(rows):
            audit(s, "user", user_id, actor, role, {role: bool(rows)}, {role: granted})
            if granted:
                s.add(RoleAssignmentORM(role_assignment_id=str(uuid.uuid4()), user_id=user_id, role=role,
                                        scope_kind="site", scope_id=None, revision=1))
            for row in rows:
                s.delete(row)
        s.commit()
    return granted


MAINTAINERS = "Only the IT block master manages bot maintainers"
SENDERS = "Only the chair and deputies manage broadcast senders"


def register_routes(router):
    @router.get("/bot/console/status", response_model=ConsoleStatus)
    def bot_console_status(cur: User = Depends(get_current_user)):
        require(cur.user_id, "bot.console.view", "Bot console access required")
        return console_status(utcnow())

    @router.get("/bot/maintainers", response_model=Page[UserReference])
    def bot_maintainers(cur: User = Depends(get_current_user)):
        require(cur.user_id, "bot.console.view", "Bot console access required")
        return grantees("bot_maintainer")

    @router.put("/bot/maintainers/{user_id}", response_model=MaintainerOut)
    def set_bot_maintainer(user_id: int, payload: Maintainer, cur: User = Depends(get_current_user)):
        """The IT block master decides who maintains the bot (owner, 2026-11-04)."""
        require(cur.user_id, "bot.maintainers.manage", MAINTAINERS)
        return MaintainerOut(user_id=user_id, maintainer=set_grant(user_id, "bot_maintainer", payload.maintainer, cur.user_id))

    @router.get("/broadcasts/senders", response_model=Page[UserReference])
    def broadcast_senders(cur: User = Depends(get_current_user)):
        require(cur.user_id, "broadcast.senders.manage", SENDERS)
        return grantees("broadcaster")

    @router.put("/broadcasts/senders/{user_id}", response_model=SenderOut)
    def set_broadcast_sender(user_id: int, payload: Sender, cur: User = Depends(get_current_user)):
        """The chair and deputies decide who else sends broadcasts (owner, 2026-11-04)."""
        require(cur.user_id, "broadcast.senders.manage", SENDERS)
        return SenderOut(user_id=user_id, sender=set_grant(user_id, "broadcaster", payload.sender, cur.user_id))

    # Stage 2: open to every account that is not archived or banned, pending ones included
    # (auth._access_rules exempts them; get_current_user still refuses archive and ban).
    @router.get("/bot-link/me", response_model=LinkStatus)
    def own_bot_link(cur: User = Depends(get_current_user)):
        return link_status(cur, utcnow())

    @router.post("/bot-link/code", response_model=LinkCode)
    def new_bot_link_code(cur: User = Depends(get_current_user)):
        return issue_code(cur.user_id, utcnow())
