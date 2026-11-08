"""HereBot stage 5: the bot console, the people's side (backend/docs/BOT_API.md, «Консоль бота»).

The IT block master and the maintainers they assign (`bot.console.view`, `bot.console.operate`)
read the bot's state, its error groups and the send queue, pause and resume sending, and give
the bot commands: restart, logs, the update check, update and rollback. The site never calls
the bot: a command waits in bot_commands until the bot takes it from GET /work and reports
it (bot_api.due_commands, apply_commands); the pause lives in bot_status and keeps GET /work
from handing out deliveries and batches. The console status of stage 1 lives here too.
"""
import base64
import json
import secrets
from datetime import timedelta
from typing import Literal

from fastapi import Depends
from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import defer

import api_contract
import request_keys
import service_account
from api_contract import Page
from auth import get_current_user
from bot_api import (COMMAND_KINDS, CONSOLE, OUTPUT_TTL, PENDING_BATCH, PENDING_VK, live_commands, online, require,
                     shown_state, token_hashes)
from bot_link import iso, stamp, utcnow
from bot_models import BotCommandORM, BotErrorORM, BotLinkORM, BotStatusORM, BroadcastBatchORM
from broadcasts import authors, enabled, zulu
from database import db
from domain_contract import UserReference
from errors import Conflict, InvalidInput, NotFound, TooManyRequests
from models import User
from profile_features_models import NotificationDeliveryEventORM as DeliveryORM
from registration import audit

CONSOLE_ERRORS = 100
PAGE = 20
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
STATES = ("pending", "running", "done", "failed", "unsupported", "expired")
SLOTS = {"update": ("update", "rollback"), "rollback": ("update", "rollback")}  # one open command per slot
NEEDS_VK = ("updates_check", "update", "rollback")  # the server needs the requester's VK ID
RESTART_EVERY = timedelta(minutes=2)
OPERATE = "Bot console operator rights required"


# ── The console's status ──

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


class Queue(BaseModel):
    """What waits to be sent (stage 5): VK deliveries and batches of broadcasts in `pending`."""
    deliveries: int = 0
    batches: int = 0


class ConsoleStatus(BaseModel):
    enabled: bool
    online: bool
    last_seen_at: str | None = None
    boot_id: str | None = None
    heartbeat: dict | None = None  # from stage 5 with `updates` as the bot sent it
    errors: list[ConsoleError] = []
    paused: bool = False  # stage 5
    paused_at: str | None = None
    paused_by: UserReference | None = None
    queue: Queue = Queue()


def console_status(now):
    """GET /bot/console/status: the status row, the newest error groups, both queue counts in
    one SELECT over their partial indexes and, while paused, its author: the same few
    statements whatever is stored."""
    D, B = DeliveryORM, BroadcastBatchORM
    with db._session() as s:
        status = s.get(BotStatusORM, 1)
        heartbeat = json.loads(status.heartbeat_json) if status is not None and status.heartbeat_json else None
        rows = s.query(BotErrorORM).order_by(BotErrorORM.last_at.desc(), BotErrorORM.fingerprint.desc()).limit(CONSOLE_ERRORS)
        errors = [ConsoleError(fingerprint=r.fingerprint, level=r.level, logger=r.logger, where=r.location,
                               message=r.message, traceback=r.traceback, count=r.count, first_at=r.first_at,
                               last_at=r.last_at) for r in rows]
        deliveries, batches = s.execute(select(select(func.count()).select_from(D).where(PENDING_VK).scalar_subquery(),
                                               select(func.count()).select_from(B).where(PENDING_BATCH).scalar_subquery())).one()
        paused = bool(status is not None and status.paused)
        author = status.paused_by_user_id if paused else None
        people = authors(s, {author}) if author is not None else {}
        on = bool(token_hashes())
        return ConsoleStatus(enabled=on, online=on and online(status, heartbeat, now),
                             last_seen_at=status.last_seen_at if status else None,
                             boot_id=status.boot_id if status else None, heartbeat=heartbeat, errors=errors,
                             paused=paused, paused_at=status.paused_at if paused else None,
                             paused_by=people.get(author), queue=Queue(deliveries=deliveries, batches=batches))


# ── The pause ──

class PauseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paused: bool


def set_pause(paused, uid, now):
    """PUT /bot/console/pause: a change is audited (`bot_pause`, `bot_resume`) and makes the
    status row if there is none; the same value again changes nothing. Resuming clears
    paused_at and paused_by: they name the pause in force."""
    with db._session() as s:
        status = s.get(BotStatusORM, 1)
        if bool(status is not None and status.paused) != paused:
            if status is None:
                status = BotStatusORM(id=1)
                s.add(status)
            audit(s, "bot", "pause", uid, "bot_pause" if paused else "bot_resume", {"paused": not paused}, {"paused": paused})
            status.paused, status.paused_at, status.paused_by_user_id = paused, stamp(now) if paused else None, uid if paused else None
        s.commit()
        return console_status(now)


# ── Commands ──

class NoArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LogsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lines: int = Field(200, ge=1, le=2000)  # records; one with a traceback is one
    level: Literal[LEVELS] | None = None  # records of this level and above
    contains: str | None = Field(None, min_length=1, max_length=100)  # a substring, any case


class VersionArgs(BaseModel):
    """The version the person saw in the console: updates.check.target or .previous."""
    model_config = ConfigDict(extra="forbid")
    version: str = Field(max_length=32, pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")


ARGS = {"restart": NoArgs, "logs": LogsArgs, "updates_check": NoArgs, "update": VersionArgs, "rollback": VersionArgs}


class CommandIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal[COMMAND_KINDS]
    # Checked by kind and stored with its defaults: `logs` may omit any of its fields.
    args: dict = Field(default_factory=dict, validate_default=True)
    # GL-07, as POST /tasks: a UUID; a repeat returns the first command, other data is 409.
    idempotency_key: str | None = None

    @field_validator("args")
    @classmethod
    def by_kind(cls, value, info: ValidationInfo):
        kind = info.data.get("kind")
        return value if kind is None else ARGS[kind].model_validate(value).model_dump()

    @field_validator("idempotency_key")
    @classmethod
    def request_key(cls, value):
        if value is not None and request_keys.canonical_key(value) is None:
            raise ValueError("A UUID idempotency key is required")
        return None if value is None else request_keys.canonical_key(value)


class CommandOut(BaseModel):
    command_id: str
    kind: str
    args: dict
    state: Literal[STATES]  # pending and running past their terms read as `expired`
    code: str | None = None
    message: str | None = None
    requested_by: UserReference | None = None  # None after the requester's retention
    created_at: str
    updated_at: str
    finished_at: str | None = None
    has_output: bool = False  # a `logs` output kept for 24 hours
    output: str | None = None  # only for one command, never in the list


def create(payload, uid, now):
    """POST /bot/console/commands in the request's write unit: a repeat with the same key
    returns the first command; then the bot must be online, no command of the same slot may
    be open, the update requests need the author's VK (the service account has none: its own
    refusal), a restart waits 2 minutes after the last one. The command, its requester
    (account, VK, display name) and the audit."""
    C, kind, args = BotCommandORM, payload.kind, payload.args
    key, digest = payload.idempotency_key, request_keys.digest(payload)
    with db._session() as s:
        first = request_keys.previous(s, C, "requested_by_user_id", uid, key, digest)
        if first is not None:
            return views(s, [(first, first.output is not None)], now, True)[0]
        status = s.get(BotStatusORM, 1)
        heartbeat = json.loads(status.heartbeat_json) if status is not None and status.heartbeat_json else None
        if not online(status, heartbeat, now):
            raise Conflict("The bot is offline: the command would not reach it", "bot_offline")
        busy, last_restart = s.execute(select(exists().where(*live_commands(now), C.kind.in_(SLOTS.get(kind, (kind,)))),
                                              select(func.max(C.created_at)).where(C.kind == "restart").scalar_subquery())).one()
        if busy:
            raise Conflict("A command of this kind is waiting for the bot", "bot_command_pending")
        link = s.get(BotLinkORM, uid)
        if kind in NEEDS_VK and service_account.is_service_id(uid):
            # It has no VK to name; whether the update server should take one is an open owner question.
            raise Conflict("The service account has no VK for the update requests", "bot_console_service_vk")
        if kind in NEEDS_VK and link is None:
            raise Conflict("The update requests name the requester's VK", "bot_console_vk_required")
        if kind == "restart" and last_restart is not None and last_restart > iso(now - RESTART_EVERY):
            raise TooManyRequests("At most one restart in 2 minutes", "bot_command_rate_limited")
        people, when = authors(s, {uid}), iso(now)
        row = C(command_id=secrets.token_hex(16), kind=kind, args_json=json.dumps(args, ensure_ascii=False), state="pending",
                requested_by_user_id=uid, requested_vk_user_id=link.vk_user_id if link else None,
                requested_name=people[uid].display_name, idempotency_key=key, request_hash=digest if key else None,
                created_at=when, updated_at=when)
        s.add(row)
        audit(s, "bot", row.command_id, uid, "bot_command", {}, {"kind": kind, "args": args})
        out = views(s, [(row, False)], now, True, people)[0]
        s.commit()
    return out


def one(command_id, now):
    with db._session() as s:
        row = s.get(BotCommandORM, command_id)
        if row is None:
            raise NotFound("Command not found")
        return views(s, [(row, row.output is not None)], now, True)[0]


def page(cursor, now):
    """GET /bot/console/commands: newest first, a keyset on (created_at, command_id) over
    ix_bot_commands_list with LIMIT in SQL; the outputs are not read."""
    C, size = BotCommandORM, min(PAGE, api_contract.PAGE_SIZE)
    with db._session() as s:
        query = s.query(C, C.output.is_not(None)).options(defer(C.output))
        if cursor is not None:
            try:
                created, cid = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
            except (ValueError, TypeError, UnicodeError):
                created = cid = None
            if not isinstance(created, str) or not isinstance(cid, str):
                raise InvalidInput("Invalid cursor")
            query = query.filter(or_(C.created_at < created, and_(C.created_at == created, C.command_id < cid)))
        rows = query.order_by(C.created_at.desc(), C.command_id.desc()).limit(size + 1).all()
        items = rows[:size]
        last = items[-1][0] if items else None
        following = (base64.urlsafe_b64encode(json.dumps([last.created_at, last.command_id]).encode()).decode()
                     if len(rows) > size else None)
        return Page(items=views(s, items, now, False), next_cursor=following)


def views(s, rows, now, with_output, people=None):
    """CommandOut of (row, has a stored output) pairs: the requesters in one read with their
    avatars; the state and the output as of `now`."""
    if people is None:
        people = authors(s, {r.requested_by_user_id for r, _ in rows if r.requested_by_user_id is not None})
    kept = iso(now - OUTPUT_TTL)
    out = []
    for r, stored in rows:
        has = bool(stored) and r.finished_at is not None and r.finished_at >= kept
        out.append(CommandOut(command_id=r.command_id, kind=r.kind, args=json.loads(r.args_json),
                              state=shown_state(r.state, r.created_at, now), code=r.code, message=r.message,
                              requested_by=people.get(r.requested_by_user_id), created_at=zulu(r.created_at),
                              updated_at=zulu(r.updated_at), finished_at=zulu(r.finished_at), has_output=has,
                              output=r.output if with_output and has else None))
    return out


def register_routes(router):
    """After broadcasts': the console's routes, its status of stage 1 included."""

    @router.get("/bot/console/status", response_model=ConsoleStatus)
    def bot_console_status(cur: User = Depends(get_current_user)):
        require(cur.user_id, "bot.console.view", CONSOLE)
        return console_status(utcnow())

    @router.put("/bot/console/pause", response_model=ConsoleStatus)
    def bot_console_pause(payload: PauseIn, cur: User = Depends(get_current_user)):
        """The IT block master and the maintainers (owner, 2026-11-04)."""
        require(cur.user_id, "bot.console.operate", OPERATE)
        enabled()
        return set_pause(payload.paused, cur.user_id, utcnow())

    @router.post("/bot/console/commands", response_model=CommandOut)
    def create_bot_command(payload: CommandIn, cur: User = Depends(get_current_user)):
        require(cur.user_id, "bot.console.operate", OPERATE)
        enabled()
        return create(payload, cur.user_id, utcnow())

    @router.get("/bot/console/commands", response_model=Page[CommandOut])
    def list_bot_commands(cursor: str | None = None, cur: User = Depends(get_current_user)):
        require(cur.user_id, "bot.console.view", CONSOLE)
        return page(cursor, utcnow())

    @router.get("/bot/console/commands/{command_id}", response_model=CommandOut)
    def get_bot_command(command_id: str, cur: User = Depends(get_current_user)):
        require(cur.user_id, "bot.console.view", CONSOLE)
        return one(command_id, utcnow())
