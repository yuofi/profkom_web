"""HereBot: the service API /api/bot/v1 and the people's routes (stages 1 to 5).

The contract is backend/docs/BOT_API.md. The bot is a client with a service token; the site
stores only its SHA-256 (settings.BOT_API_TOKEN_SHA256, two values while rotating). The token
check reads no database, so a wrong token never waits for the write lock or a unit. The
service routes are outside the user router: no JWT, account or working-access guard.
Stage 1 keeps the last heartbeat and the bot's error groups. Stage 2 links an account to its
VK: the site issues a one-time code, the bot confirms it, reports carry the VK's message and
token events (the policy without SQL is bot_link.py). Stage 3 hands out the site's
notifications queued for VK (notification_delivery_events, channel `vk`) and applies the
bot's results. Stage 4 does the same for the batches of broadcasts; the people's side of
broadcasts (sending, the list, cancel) is broadcasts.py. Stage 5 hands out the console's
commands, applies their results and honours the console's pause; the console itself (status,
pause, commands) is bot_console.py.
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
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from fastapi.routing import APIRoute
from fastapi.security.utils import get_authorization_scheme_param
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from sqlalchemy import and_, bindparam, case, delete, exists, func, literal, or_, select, text, update

import access
import bot_link
from api_contract import Page
from auth import get_current_user, unit_of_work
from bot_link import TOKEN_STATUSES, iso, parse, stamp, state_of, utcnow
from bot_models import (BotCommandORM, BotErrorORM, BotLinkCodeORM, BotLinkORM, BotStatusORM, BroadcastBatchORM,
                        BroadcastORM, BroadcastRecipientORM)
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
# Stage 4: the batches of broadcasts, over ix_broadcast_batches_pending in the same way.
PENDING_BATCH = text("broadcast_batches.state = 'pending'")
MAX_BATCHES = 5  # batches in one /work, apart from `limit`
MAX_BATCH_REPORTS, BATCH_SIZE = 10, 100  # batches in one report, recipients in a batch
# Stage 5: the console's commands, over ix_bot_commands_open in the same way.
OPEN_COMMANDS = text("bot_commands.state IN ('pending', 'running')")
COMMAND_KINDS = ("restart", "logs", "updates_check", "update", "rollback")
COMMAND_RESULTS = ("running", "done", "failed", "unsupported")
PENDING_TTL, RUNNING_TTL = timedelta(minutes=10), timedelta(minutes=30)  # since created_at, then `expired`
MAX_COMMANDS, MAX_COMMAND_REPORTS = 10, 20  # commands in one /work, results in one report
OUTPUT_LIMIT, OUTPUT_TTL = 128 * 1024, timedelta(hours=24)  # bytes of UTF-8; a `logs` output is kept 24 hours
COMMAND_MESSAGE_LIMIT = 500
KEEP_COMMANDS = 500  # and KEEP_DAYS
UPDATES_LIMIT = 16 * 1024  # bytes of JSON of heartbeat.updates


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


def small_object(value):
    """Stage 5 `updates`, kept as the bot sent it: an object of at most UPDATES_LIMIT bytes of
    JSON. Anything else drops this key alone; the report is accepted."""
    if not isinstance(value, dict):
        return None
    return value if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()) <= UPDATES_LIMIT else None


def last_bytes(value):
    """A `logs` output over OUTPUT_LIMIT bytes of UTF-8 keeps its end: the newest records, as
    the bot drops the oldest."""
    raw = value.encode()
    return value if len(raw) <= OUTPUT_LIMIT else raw[-OUTPUT_LIMIT:].decode(errors="ignore")


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
    updates: Annotated[Any, AfterValidator(small_object)] = None  # stage 5: the bot's state/ files


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


class Outcome(Lenient):
    """What VK answered to one message; another status is skipped (rules of v1)."""
    status: str = Field(max_length=32)
    vk_message_id: int | None = Field(None, ge=0, le=2**63 - 1)
    error_code: int | clipped(64) | None = None  # VK's error code, or the bot's word for a network failure
    retryable: bool = False

    def code(self):
        return None if self.error_code is None else str(self.error_code)[:64]


class DeliveryResult(Outcome):
    delivery_id: str = Field(min_length=1, max_length=64)


class PeerResult(Outcome):
    """One recipient of a batch (stage 4)."""
    peer_id: VkUserId


class BatchResults(Lenient):
    batch_id: str = Field(min_length=1, max_length=64)
    results: list[PeerResult] = Field(default_factory=list, max_length=BATCH_SIZE)


class CommandResult(Lenient):
    """What the bot did with a console command (stage 5); another status is skipped."""
    command_id: str = Field(min_length=1, max_length=64)
    status: str = Field(max_length=32)
    code: clipped(64) | None = None  # the machine reason: rate_limited, busy, stale, no_log …
    message: clipped(COMMAND_MESSAGE_LIMIT) | None = None
    output: Annotated[str, AfterValidator(last_bytes)] | None = None  # the lines of `logs`


class Report(Lenient):
    api: Literal[1] = API
    report_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    boot_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    heartbeat: Heartbeat | None = None
    errors: list[ErrorGroup] = Field(default_factory=list, max_length=MAX_ERRORS)
    deliveries: list[DeliveryResult] = Field(default_factory=list, max_length=MAX_DELIVERIES)
    broadcasts: list[BatchResults] = Field(default_factory=list, max_length=MAX_BATCH_REPORTS)
    commands: list[CommandResult] = Field(default_factory=list, max_length=MAX_COMMAND_REPORTS)
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


class Batch(BaseModel):
    """One batch of a broadcast to send with messages.send and peer_ids (stage 4)."""
    broadcast_id: str
    batch_id: str
    text: str
    peer_ids: list[int]
    random_id: int
    created_at: str


class Requester(BaseModel):
    """Who asked for a command: the site account, the VK of its link (None without one) and
    the site display name; all None after the account's retention."""
    user_id: int | None = None
    vk_user_id: int | None = None
    name: str | None = None


class Command(BaseModel):
    """One console command for the bot (stage 5)."""
    command_id: str
    kind: str
    args: dict
    requested_by: Requester
    created_at: str


class Work(BaseModel):
    api: int = API
    server_time: str
    poll_after_ms: int = POLL_AFTER_MS
    paused: bool = False  # stage 5
    deliveries: list[Delivery] = []  # stage 3
    broadcasts: list[Batch] = []  # stage 4
    commands: list[Command] = []  # stage 5


class Accepted(BaseModel):
    api: int = API
    accepted: bool = True
    duplicate: bool
    server_time: str


# ── Service routes ──

@service_router.get("/work", response_model=Work)
def work(limit: int = Query(50, ge=1, le=100)):
    """Stage 5 first: one SELECT of the pause and of whether a command is open, the commands
    themselves only when one is. While paused, nothing else. Then the due VK deliveries
    (stage 3) and batches of broadcasts (stage 4): an idle poll is three SELECTs, each over
    its partial index, one while paused."""
    now = utcnow()
    paused, waiting = console_flags(now)
    commands = due_commands(now) if waiting else []
    if paused:
        return Work(server_time=stamp(now), paused=True, commands=commands)
    return Work(server_time=stamp(now), deliveries=due_deliveries(limit, now), broadcasts=due_batches(now),
                commands=commands)


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
    pending for 24 hours and the batches of broadcasts pending for 24 hours (one UPDATE, two
    more when some expire). VK events add one SELECT of the links they name and writes of the
    changed ones only. Delivery results add one SELECT of their rows and one UPDATE of the
    pending ones; the rows the last polls held add one UPDATE. Batch results add two SELECTs
    (the batches, their open recipients) and an UPDATE each of recipients, batches and
    broadcasts; the empty batches the last polls held add one UPDATE. A `denied` of either
    adds one SELECT of the links with their accounts and the writes of the changed ones.
    Command results (stage 5) add one SELECT of the commands named and one UPDATE of the
    changed ones; hourly the commands add three: expiry, outputs over 24 hours, retention.
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
            heartbeat = payload.heartbeat
            status.started_at = stamp(heartbeat.started_at)
            # Without `updates` (a bot before stage 5, or one too big) the heartbeat is stored as before.
            heartbeat = heartbeat.model_dump(mode="json", exclude={"updates"} if heartbeat.updates is None else None)
            status.heartbeat_json = json.dumps(heartbeat, ensure_ascii=False)
            status.updated_at = stamp(now)
        added = merge_errors(s, payload.errors) if payload.errors else False
        if payload.vk_events or payload.tokens:
            apply_events(s, payload.vk_events, payload.tokens, now)
        held, empty, denied = HELD.snapshot(), EMPTY.snapshot(), (set(), set())
        if payload.deliveries or held:
            denied[0].update(apply_results(s, payload.deliveries, held, now))
        if payload.broadcasts or empty:
            denied[1].update(apply_batches(s, payload.broadcasts, empty, now))
        if denied[0] or denied[1]:
            deny_messages(s, now, uids=denied[0], vks=denied[1])
        if payload.commands:
            apply_commands(s, payload.commands, now)
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
            expire_batches(s, now)
            clean_commands(s, now)
        s.commit()
    HELD.discard(held)
    EMPTY.discard(empty)
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
    deliveries are notification_delivery_events rows: profile_features.anonymize deletes them.
    Stage 4: the account's rows as a broadcast recipient go, and its broadcasts and
    cancellations lose its name (the texts stay). Stage 5: its console commands lose the
    requester (account, VK, name) and the pause loses its author if it was the account."""
    plain = dict(synchronize_session=False)
    session.query(BotLinkCodeORM).filter_by(user_id=uid).delete(**plain)
    session.query(BroadcastRecipientORM).filter_by(user_id=uid).delete(**plain)
    for field in ("author_user_id", "cancelled_by_user_id"):
        session.query(BroadcastORM).filter(getattr(BroadcastORM, field) == uid).update({field: None}, **plain)
    session.query(BotCommandORM).filter_by(requested_by_user_id=uid).update(
        {"requested_by_user_id": None, "requested_vk_user_id": None, "requested_name": None}, **plain)
    session.query(BotStatusORM).filter_by(paused_by_user_id=uid).update({"paused_by_user_id": None}, **plain)
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
          "meeting_event": "/meetings/event/{}", "meeting_subevent": "/meetings/subevent/{}",
          "broadcast": "/broadcasts/{}"}


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
    did not try it) stays as it is. Then the rows the polls held are cancelled if pending.
    Returns the accounts of `denied` rows: the caller turns their links' messages off."""
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
    if held:
        s.execute(update(D).where(D.delivery_id.in_(held), PENDING_VK).values(state="cancelled", updated_at=when),
                  execution_options=dict(synchronize_session=False))
    return denied


def deny_messages(s, now, uids=(), vks=()):
    """VK answered 901: the links of these accounts (deliveries) and of these VKs (batches of
    broadcasts) take no messages from the report time on, as a message_deny event would (a
    stored later time wins). One SELECT of the links with their accounts; save_link
    recomputes users.bot_link_state."""
    at = stamp(now)
    for link, user in s.execute(select(BotLinkORM, UserORM).join(UserORM, UserORM.user_id == BotLinkORM.user_id)
                                .where(BotLinkORM.user_id.in_(uids) | BotLinkORM.vk_user_id.in_(vks))).all():
        if at >= link.messages_at and (link.messages_allowed, link.messages_at) != (False, at):
            link.messages_allowed, link.messages_at, link.updated_at = False, at, at
            save_link(s, user, link)


# ── Broadcasts through the bot (stage 4) ──

EMPTY = Held()  # due batches /work found without a pending recipient: the next report closes them


def due_batches(now):
    """GET /work: up to MAX_BATCHES pending batches, due and at most 24 hours old, oldest
    first, each with the VKs remembered for its pending recipients. Idle, one SELECT over
    ix_broadcast_batches_pending (the broadcast's text joined by its key); with batches, one
    SELECT of their pending recipients. A batch without one is not handed out: it is held
    for the next report, which closes it, and the following polls skip it."""
    B, R, C = BroadcastBatchORM, BroadcastRecipientORM, BroadcastORM
    held = EMPTY.snapshot()
    query = (select(B.batch_id, B.broadcast_id, B.created_at, C.text).join(C, C.broadcast_id == B.broadcast_id)
             .where(PENDING_BATCH, B.next_attempt_at <= iso(now), B.created_at >= iso(now - DELIVERY_TTL))
             .order_by(B.created_at, B.batch_id).limit(MAX_BATCHES))
    if held:
        query = query.where(B.batch_id.not_in(held))
    with db._session() as s:
        batches = s.execute(query).all()
        if not batches:
            return []
        peers = {}
        for batch_id, vk in s.execute(select(R.batch_id, R.vk_user_id).where(
                R.batch_id.in_([b.batch_id for b in batches]), R.state == "pending").order_by(R.batch_id, R.user_id)):
            peers.setdefault(batch_id, []).append(vk)
    EMPTY.add(b.batch_id for b in batches if b.batch_id not in peers)
    return [Batch(broadcast_id=b.broadcast_id, batch_id=b.batch_id, text=b.text, peer_ids=peers[b.batch_id],
                  random_id=random_id(b.batch_id), created_at=stamp(datetime.fromisoformat(b.created_at)))
            for b in batches if b.batch_id in peers]


def apply_batches(s, entries, empty, now):
    """The bot's results for batches: one SELECT of the batches named, one of their recipients
    still `pending` or `cancelled` (a sent message beats a cancellation), one UPDATE
    (executemany) each of the changed recipients and batches, one of the broadcasts left
    without a pending recipient. An unknown batch or peer, another state or a second result
    for one recipient in the report changes nothing. A retryable failure keeps a pending
    recipient pending and a cancelled one cancelled. A pending batch named is `done` when no
    recipient is left pending; else it counts an attempt and waits RETRY_MINUTES, and after
    the fifth the recipients left fail with their last error. The empty batches the polls
    held are closed. Returns the VKs that answered `denied`."""
    B, R, C = BroadcastBatchORM, BroadcastRecipientORM, BroadcastORM
    when, first, denied = iso(now), {}, set()
    for entry in entries:
        for result in entry.results:
            if result.status in RESULTS:
                first.setdefault((entry.batch_id, result.peer_id), result)
    named = list(dict.fromkeys(entry.batch_id for entry in entries))
    batches = {b.batch_id: b for b in s.execute(select(B.batch_id, B.broadcast_id, B.state, B.attempts)
                                                .where(B.batch_id.in_(named)))} if named else {}
    recipients, finished = {}, set()  # (broadcast_id, user_id): [state, vk_message_id, error_code]; broadcasts
    left = {}  # batch_id: keys of its recipients still pending
    if batches:
        for r in s.execute(select(R.broadcast_id, R.user_id, R.batch_id, R.vk_user_id, R.state, R.error_code)
                           .where(R.batch_id.in_(list(batches)), R.state.in_(("pending", "cancelled")))):
            key, result = (r.broadcast_id, r.user_id), first.get((r.batch_id, r.vk_user_id))
            if result is not None and not (result.status == "failed" and result.retryable):
                recipients[key] = [result.status, result.vk_message_id if result.status == "sent" else None, result.code()]
                if result.status == "denied":
                    denied.add(r.vk_user_id)
            elif r.state == "pending":  # a retryable failure, or no result at all
                if result is not None:
                    recipients[key] = ["pending", None, result.code()]
                left.setdefault(r.batch_id, []).append((key, recipients[key][2] if key in recipients else r.error_code))
    changes = []
    for b in batches.values():
        if b.state != "pending":
            continue
        attempts, pending = b.attempts + 1, left.get(b.batch_id)
        change = dict(b_id=b.batch_id, b_state="done", b_attempts=attempts, b_next=when, b_updated=when)
        if pending and attempts <= len(RETRY_MINUTES):
            change.update(b_state="pending", b_next=iso(now + timedelta(minutes=RETRY_MINUTES[attempts - 1])))
        else:
            for key, error in pending or ():  # the fifth attempt: the rest fail with their last error
                recipients[key] = ["failed", None, error]
            finished.add(b.broadcast_id)
        changes.append(change)
    if recipients:  # every row names the same columns: one executemany
        table = R.__table__
        s.execute(update(table).where(table.c.broadcast_id == bindparam("b_broadcast"), table.c.user_id == bindparam("b_user"))
                  .values(state=bindparam("b_state"), vk_message_id=bindparam("b_message"), error_code=bindparam("b_error"),
                          updated_at=bindparam("b_updated")),
                  [dict(b_broadcast=key[0], b_user=key[1], b_state=state, b_message=message, b_error=error, b_updated=when)
                   for key, (state, message, error) in recipients.items()])
    if changes:
        table = B.__table__
        s.execute(update(table).where(table.c.batch_id == bindparam("b_id")).values(
            state=bindparam("b_state"), attempts=bindparam("b_attempts"), next_attempt_at=bindparam("b_next"),
            updated_at=bindparam("b_updated")), changes)
    plain, nobody = dict(synchronize_session=False), ~exists().where(R.batch_id == B.batch_id, R.state == "pending")
    which = C.broadcast_id.in_(finished)
    if empty:
        s.execute(update(B).where(B.batch_id.in_(empty), PENDING_BATCH, nobody).values(state="done", updated_at=when),
                  execution_options=plain)
        which |= C.broadcast_id.in_(select(B.broadcast_id).where(B.batch_id.in_(empty)))
    if finished or empty:
        close_broadcasts(s, which, when)
    return denied


def close_broadcasts(s, which, when):
    """Broadcasts among `which` still `sending` without a pending recipient become `done`."""
    R, C = BroadcastRecipientORM, BroadcastORM
    s.execute(update(C).where(which, C.state == "sending", ~exists().where(R.broadcast_id == C.broadcast_id, R.state == "pending"))
              .values(state="done", updated_at=when), execution_options=dict(synchronize_session=False))


def expire_batches(s, now):
    """Hourly: pending batches over 24 hours old and their pending recipients are `expired`,
    their broadcasts `done` when nothing else is pending. One UPDATE when none expire."""
    B, R, C = BroadcastBatchORM.__table__, BroadcastRecipientORM, BroadcastORM
    when = iso(now)
    gone = s.execute(update(B).where(PENDING_BATCH, B.c.created_at < iso(now - DELIVERY_TTL))
                     .values(state="expired", updated_at=when).returning(B.c.batch_id, B.c.broadcast_id)).all()
    if gone:
        s.execute(update(R).where(R.batch_id.in_([g.batch_id for g in gone]), R.state == "pending")
                  .values(state="expired", updated_at=when), execution_options=dict(synchronize_session=False))
        close_broadcasts(s, C.broadcast_id.in_({g.broadcast_id for g in gone}), when)


def reset_deliveries():
    """Tests: forget the held deliveries and empty batches."""
    HELD.clear()
    EMPTY.clear()


# ── The console's commands and pause (stage 5) ──

def live_commands(now):
    """The terms of the commands the bot still gets: pending under 10 minutes and running under
    30, both since created_at. The literal first term repeats ix_bot_commands_open's own."""
    C = BotCommandORM
    return (OPEN_COMMANDS, C.created_at >= iso(now - RUNNING_TTL),
            or_(C.state == "running", C.created_at >= iso(now - PENDING_TTL)))


def shown_state(state, created_at, now):
    """The state a reader sees: pending for 10 minutes or running for 30 is `expired` even
    before the hourly pass marks it."""
    if (state == "pending" and created_at < iso(now - PENDING_TTL)) or (
            state == "running" and created_at < iso(now - RUNNING_TTL)):
        return "expired"
    return state


def console_flags(now):
    """GET /work: the pause (no bot_status row is not paused) and whether a command is open,
    in one SELECT: the status row by its key and an EXISTS over ix_bot_commands_open."""
    paused = select(BotStatusORM.paused).where(BotStatusORM.id == 1).scalar_subquery()
    with db._session() as s:
        paused, waiting = s.execute(select(paused, exists().where(*live_commands(now)))).one()
    return bool(paused), bool(waiting)


def due_commands(now):
    """GET /work: up to MAX_COMMANDS open commands, oldest first, over ix_bot_commands_open. A
    command is handed out until its result comes, after `running` too: a bot restarted by an
    update finds it again."""
    C = BotCommandORM
    with db._session() as s:
        rows = s.execute(select(C.command_id, C.kind, C.args_json, C.requested_by_user_id, C.requested_vk_user_id,
                                C.requested_name, C.created_at).where(*live_commands(now))
                         .order_by(C.created_at, C.command_id).limit(MAX_COMMANDS)).all()
    return [Command(command_id=r.command_id, kind=r.kind, args=json.loads(r.args_json),
                    requested_by=Requester(user_id=r.requested_by_user_id, vk_user_id=r.requested_vk_user_id,
                                           name=r.requested_name),
                    created_at=stamp(datetime.fromisoformat(r.created_at))) for r in rows]


def apply_commands(s, results, now):
    """The bot's command results in the order sent, each on the state the console shows
    (shown_state) after the ones before it: `running` applies to a pending command; done,
    failed and unsupported to a pending, running or expired one (a late result beats the
    expiry). So `running` and the result of one command in a report end in the result. A
    finished command, an unknown command_id or status is skipped. The output is kept for
    `logs` only. One SELECT of the commands named, one UPDATE (executemany) of the changed."""
    C, when = BotCommandORM, iso(now)
    results = [r for r in results if r.status in COMMAND_RESULTS]
    if not results:
        return
    rows = s.execute(select(C.command_id, C.kind, C.state, C.created_at)
                     .where(C.command_id.in_({r.command_id for r in results}))).all()
    kinds = {r.command_id: r.kind for r in rows}
    states = {r.command_id: shown_state(r.state, r.created_at, now) for r in rows}
    changes = {}
    for result in results:
        state, final = states.get(result.command_id), result.status != "running"
        if state not in (("pending", "running", "expired") if final else ("pending",)):
            continue
        states[result.command_id] = result.status
        output = result.output if final and kinds[result.command_id] == "logs" else None
        changes[result.command_id] = dict(b_id=result.command_id, b_state=result.status, b_code=result.code,
                                          b_message=result.message, b_output=output, b_updated=when,
                                          b_finished=when if final else None)
    if changes:  # every row names the same columns: one executemany
        table = C.__table__
        s.execute(update(table).where(table.c.command_id == bindparam("b_id")).values(
            state=bindparam("b_state"), code=bindparam("b_code"), message=bindparam("b_message"),
            output=bindparam("b_output"), updated_at=bindparam("b_updated"), finished_at=bindparam("b_finished")),
            list(changes.values()))


def clean_commands(s, now):
    """Hourly: pending for 10 minutes and running for 30 become `expired`, outputs over 24 hours
    old are wiped, commands over 30 days old go and the newest KEEP_COMMANDS stay. Three
    statements."""
    C, plain, when = BotCommandORM, dict(synchronize_session=False), iso(now)
    s.execute(update(C).where(OPEN_COMMANDS, or_(C.created_at < iso(now - RUNNING_TTL),
                                                 and_(C.state == "pending", C.created_at < iso(now - PENDING_TTL))))
              .values(state="expired", updated_at=when), execution_options=plain)
    s.execute(update(C).where(C.output.is_not(None), C.finished_at < iso(now - OUTPUT_TTL)).values(output=None),
              execution_options=plain)
    keep = select(C.command_id).order_by(C.created_at.desc(), C.command_id.desc()).limit(KEEP_COMMANDS)
    s.execute(delete(C).where(or_(C.created_at < iso(now - timedelta(days=KEEP_DAYS)), C.command_id.not_in(keep))),
              execution_options=plain)


# ── People: grants (stage 1); the console's status is bot_console.py ──

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
CONSOLE = "Bot console access required"


def register_routes(router):
    """The console's own routes, its status included, are bot_console.register_routes."""

    @router.get("/bot/maintainers", response_model=Page[UserReference])
    def bot_maintainers(cur: User = Depends(get_current_user)):
        require(cur.user_id, "bot.console.view", CONSOLE)
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
