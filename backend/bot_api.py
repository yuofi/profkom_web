"""HereBot: the service API /api/bot/v1 and the people's console and grant routes (stage 1).

The contract is backend/docs/BOT_API.md. The bot is a client with a service token; the site
stores only its SHA-256 (settings.BOT_API_TOKEN_SHA256, two values while rotating). The token
check reads no database, so a wrong token never waits for the write lock or a unit. The
service routes are outside the user router: no JWT, account or working-access guard.
Stage 1 hands out no work and keeps the last heartbeat and the bot's error groups.
"""
import hashlib
import hmac
import json
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.routing import APIRoute
from fastapi.security.utils import get_authorization_scheme_param
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from sqlalchemy import delete, select

import access
from api_contract import Page
from auth import get_current_user, unit_of_work
from bot_models import BotErrorORM, BotStatusORM
from database import db, RoleAssignmentORM, UserORM
from domain_contract import UserReference
from errors import NotFound, PayloadTooLarge, Unauthenticated
from models import User
from registration import audit, fail
from settings import settings

PREFIX = "/api/bot/v1"
API = 1
MAX_BODY = 256 * 1024
MAX_ERRORS = 50
MESSAGE_LIMIT, TRACEBACK_LIMIT, NAME_LIMIT = 1000, 8000, 200
POLL_AFTER_MS = 3000
KEEP_GROUPS, KEEP_DAYS, CLEAN_EVERY = 500, 30, timedelta(hours=1)
CONSOLE_ERRORS = 100
ONLINE_FLOOR_S = 180


def utcnow():
    return datetime.now(timezone.utc)


def stamp(moment):
    """ISO 8601 UTC with `Z`, whole seconds: the wire format and the stored text order."""
    moment = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


# ── Service token ──

def token_hashes():
    value = settings.BOT_API_TOKEN_SHA256
    return value.split(",") if value else []


async def bot_token(request: Request):
    """404 while the integration is off, 401 for a missing or wrong token; no database read."""
    hashes = token_hashes()
    if not hashes:
        raise NotFound("Bot API is disabled", "bot_api_disabled")
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


class Report(Lenient):
    api: Literal[1] = API
    report_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    boot_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    heartbeat: Heartbeat | None = None
    errors: list[ErrorGroup] = Field(default_factory=list, max_length=MAX_ERRORS)


class Work(BaseModel):
    api: int = API
    server_time: str
    poll_after_ms: int = POLL_AFTER_MS
    paused: bool = False
    deliveries: list[dict] = []  # stage 3
    broadcasts: list[dict] = []  # stage 4
    commands: list[dict] = []  # stage 5


class Accepted(BaseModel):
    api: int = API
    accepted: bool = True
    duplicate: bool
    server_time: str


# ── Service routes ──

@service_router.get("/work", response_model=Work)
async def work(limit: int = Query(50, ge=1, le=100)):
    """Stage 1 has no queue yet: empty lists, no SQL."""
    return Work(server_time=stamp(utcnow()))


@service_router.post("/report", response_model=Accepted)
def report(payload: Report):
    now = utcnow()
    return Accepted(duplicate=store(payload, now), server_time=stamp(now))


def store(payload, now):
    """The report in the request's write unit; True for a repeat of the last report.

    A heartbeat-only report is one SELECT and one UPDATE of bot_status (with BEGIN, three
    statements); error groups add one SELECT and their writes; the retention runs when the
    report adds a group or an hour after the last pass.
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
        s.commit()
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
