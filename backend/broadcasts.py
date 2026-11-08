"""HereBot stage 4: broadcasts through the bot, the people's side (backend/docs/BOT_API.md,
«Рассылки»).

The chair, the deputies and the senders they assign (`broadcast.send`) send a text. In one
write unit the site fixes the recipients with one INSERT … SELECT (active accounts whose VK
takes the community's messages, with the VK their link has now), cut into batches of 100 in
user_id order, and puts a bell notification to every active account but the author
(notifications.emit_everyone). The bot takes the batches from GET /work and reports the
results (bot_api.due_batches, apply_batches). Any active account reads a broadcast; only the
senders see its counts, never who received it.
"""
import base64
import json
import math
import uuid
from dataclasses import asdict
from datetime import datetime
from typing import Literal

from fastapi import Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import and_, func, insert, literal, or_, select, update
from sqlalchemy.orm import joinedload

import access
import api_contract
import bot_link
import request_keys
from api_contract import Page
from auth import get_current_user
from bot_api import BATCH_SIZE, DISABLED, TEXT_LIMIT, require
from bot_link import SENDABLE, iso, stamp, utcnow
from bot_models import BotLinkORM, BotStatusORM, BroadcastBatchORM, BroadcastORM, BroadcastRecipientORM
from database import UserORM, _user_ref_with_avatar, db
from domain_contract import UserReference
from errors import Conflict, InvalidInput, NotFound
from models import User
from notifications import emit_everyone
from registration import audit

TITLE_LIMIT = 100  # the bell's text: «Рассылка: » and the first line, cut with «…»
PAGE = 20
STATES = ("pending", "sent", "denied", "failed", "cancelled", "expired")
SEND = "Broadcast sender rights required"


class BroadcastIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=TEXT_LIMIT)  # inner line breaks stay
    # GL-07, as POST /tasks: a UUID; a repeat returns the first broadcast, other text is 409.
    idempotency_key: str | None = None

    @field_validator("idempotency_key")
    @classmethod
    def request_key(cls, value):
        if value is not None and request_keys.canonical_key(value) is None:
            raise ValueError("A UUID idempotency key is required")
        return None if value is None else request_keys.canonical_key(value)


class SendingPause(BaseModel):
    """The console paused sending through the bot (BOT_API.md, «Пауза отправки»)."""
    paused_at: str | None = None
    paused_by: UserReference | None = None  # None after the account's retention


class Audience(BaseModel):
    total: int  # active accounts (not archived, not banned), the author included
    reachable: int  # of them, the VK recipients a send now fixes: never more than total
    paused: SendingPause | None = None  # the console paused sending: a new broadcast waits


class Counts(BaseModel):
    total: int
    pending: int
    sent: int
    denied: int
    failed: int
    cancelled: int
    expired: int


class BroadcastOut(BaseModel):
    broadcast_id: str
    text: str
    author: UserReference | None = None  # None after the author's retention
    created_at: str
    state: Literal["sending", "done", "cancelled"]
    cancelled_at: str | None = None
    counts: Counts | None = None  # the VK recipients by state; only for `broadcast.send`
    paused: SendingPause | None = None  # only with counts, while sending and the console paused it


def enabled():
    if not bot_link.enabled():
        raise NotFound(DISABLED, "bot_api_disabled")


def may_send(uid):
    """The right comes first, before the integration switch: 403 with the broadcasts' own code."""
    require(uid, "broadcast.send", SEND, code="broadcast_send_forbidden")


def title(text):
    """The first non-empty line, at most TITLE_LIMIT characters with «…»."""
    line = next(line.strip() for line in text.splitlines() if line.strip())
    return line if len(line) <= TITLE_LIMIT else line[:TITLE_LIMIT - 1] + "…"


def zulu(value):
    return stamp(datetime.fromisoformat(value)) if value else None


def audience():
    """GET /broadcasts/audience: one SELECT over the accounts with their links and the pause.
    The author is counted in both (the bell skips them, the VK list does not). While paused,
    one more read names who paused."""
    U, L, S = UserORM, BotLinkORM, BotStatusORM
    pause = [select(column).where(S.id == 1).scalar_subquery() for column in (S.paused, S.paused_at, S.paused_by_user_id)]
    with db._session() as s:
        total, reachable, paused, paused_at, paused_by = s.execute(
            select(func.count(), func.count(L.user_id).filter(U.bot_link_state.in_(SENDABLE)), *pause)
            .select_from(U).outerjoin(L, L.user_id == U.user_id)
            .where(U.account_state == "active", U.banned == False)).one()  # noqa: E712
        people = authors(s, {paused_by} if paused and paused_by is not None else set())
        return Audience(total=total, reachable=reachable,
                        paused=SendingPause(paused_at=paused_at, paused_by=people.get(paused_by)) if paused else None)


def send(payload, uid, now):
    """POST /broadcasts in the request's write unit: the broadcast, the recipients in one
    INSERT … SELECT, the batches and the bell notifications in one INSERT each, the audit.
    Nobody to reach in VK is 409 and leaves nothing."""
    key, digest = payload.idempotency_key, request_keys.digest(payload)
    with db._session() as s:
        first = request_keys.previous(s, BroadcastORM, "author_user_id", uid, key, digest)
        if first is not None:
            return views(s, [first], True)[0]
        bid, when = str(uuid.uuid4()), iso(now)
        row = BroadcastORM(broadcast_id=bid, author_user_id=uid, text=payload.text, state="sending",
                           idempotency_key=key, request_hash=digest if key else None, created_at=when, updated_at=when)
        s.add(row)
        s.flush()
        U, L = UserORM, BotLinkORM
        # The batch of the n-th recipient by user_id: <broadcast_id>-0000, -0001, …
        batch = literal(bid + "-") + func.printf("%04d", (func.row_number().over(order_by=U.user_id) - 1) // BATCH_SIZE)
        snapshot = (select(literal(bid), U.user_id, batch, L.vk_user_id, literal("pending"), literal(when))
                    .select_from(U).join(L, L.user_id == U.user_id)
                    .where(U.account_state == "active", U.banned == False, U.bot_link_state.in_(SENDABLE)))  # noqa: E712
        count = s.execute(insert(BroadcastRecipientORM.__table__).from_select(
            ["broadcast_id", "user_id", "batch_id", "vk_user_id", "state", "updated_at"], snapshot)).rowcount
        if not count:
            raise Conflict("Nobody takes the community's messages in VK", "broadcast_no_recipients")
        s.execute(insert(BroadcastBatchORM.__table__), [
            dict(batch_id=f"{bid}-{index:04d}", broadcast_id=bid, state="pending", attempts=0, next_attempt_at=when,
                 created_at=when, updated_at=when) for index in range(math.ceil(count / BATCH_SIZE))])
        notified = emit_everyone(s, "broadcast", {"broadcast_id": bid, "title": title(payload.text)}, f"broadcast:{bid}", uid)
        audit(s, "broadcast", bid, uid, "broadcast_send", {}, {"state": "sending", "recipients": count, "notified": notified})
        out = views(s, [row], True, known={bid: dict(total=count, pending=count)})[0]
        s.commit()
    return out


def cancel(bid, uid, now):
    """POST /broadcasts/{id}/cancel: the pending recipients and batches are `cancelled`; a
    batch the bot has taken still reports, and a sent message beats the cancellation."""
    R, B, plain = BroadcastRecipientORM, BroadcastBatchORM, dict(synchronize_session=False)
    with db._session() as s:
        row = s.get(BroadcastORM, bid)
        if row is None:
            raise NotFound("Broadcast not found")
        if row.state != "sending":
            raise Conflict("The broadcast is not sending", "broadcast_not_sending")
        when = iso(now)
        stopped = s.execute(update(R).where(R.broadcast_id == bid, R.state == "pending")
                            .values(state="cancelled", updated_at=when), execution_options=plain).rowcount
        s.execute(update(B).where(B.broadcast_id == bid, B.state == "pending")
                  .values(state="cancelled", updated_at=when), execution_options=plain)
        row.state, row.cancelled_at, row.cancelled_by_user_id, row.updated_at = "cancelled", when, uid, when
        audit(s, "broadcast", bid, uid, "broadcast_cancel", {"state": "sending"}, {"state": "cancelled", "cancelled": stopped})
        out = views(s, [row], True)[0]
        s.commit()
    return out


def one(bid, with_counts):
    with db._session() as s:
        row = s.get(BroadcastORM, bid)
        if row is None:
            raise NotFound("Broadcast not found")
        return views(s, [row], with_counts)[0]


def page(cursor):
    """GET /broadcasts: newest first, a keyset on (created_at, broadcast_id) with LIMIT in SQL;
    a page is the same few statements however long the history is."""
    C, size = BroadcastORM, min(PAGE, api_contract.PAGE_SIZE)
    with db._session() as s:
        query = s.query(C)
        if cursor is not None:
            try:
                created, bid = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
            except (ValueError, TypeError, UnicodeError):
                created = bid = None
            if not isinstance(created, str) or not isinstance(bid, str):
                raise InvalidInput("Invalid cursor")
            query = query.filter(or_(C.created_at < created, and_(C.created_at == created, C.broadcast_id < bid)))
        rows = query.order_by(C.created_at.desc(), C.broadcast_id.desc()).limit(size + 1).all()
        items = rows[:size]
        following = (base64.urlsafe_b64encode(json.dumps([items[-1].created_at, items[-1].broadcast_id]).encode()).decode()
                     if len(rows) > size else None)
        return Page(items=views(s, items, True), next_cursor=following)


def views(s, rows, with_counts, known=None):
    """BroadcastOut of `rows`: the authors in one read with their avatars, the counts in one
    GROUP BY (`known` when the caller has them). Senders of a sending broadcast also learn
    whether the console paused sending: one read of bot_status, its author with the others."""
    status = s.get(BotStatusORM, 1) if with_counts and any(r.state == "sending" for r in rows) else None
    paused = status is not None and bool(status.paused)
    ids = {r.author_user_id for r in rows if r.author_user_id is not None}
    if paused and status.paused_by_user_id is not None:
        ids.add(status.paused_by_user_id)
    people = authors(s, ids)
    pause = SendingPause(paused_at=status.paused_at, paused_by=people.get(status.paused_by_user_id)) if paused else None
    counts = {}
    if with_counts:
        counts = {r.broadcast_id: dict.fromkeys(("total", *STATES), 0) for r in rows}
        for bid, values in (known or {}).items():
            counts[bid].update(values)
        missing = [bid for bid in counts if bid not in (known or {})]
        if missing:
            R = BroadcastRecipientORM
            for bid, state, number in s.execute(select(R.broadcast_id, R.state, func.count())
                                                .where(R.broadcast_id.in_(missing)).group_by(R.broadcast_id, R.state)):
                counts[bid]["total"] += number
                if state in STATES:
                    counts[bid][state] += number
    return [BroadcastOut(broadcast_id=r.broadcast_id, text=r.text, author=people.get(r.author_user_id),
                         created_at=zulu(r.created_at), state=r.state, cancelled_at=zulu(r.cancelled_at),
                         counts=Counts(**counts[r.broadcast_id]) if with_counts else None,
                         paused=pause if r.state == "sending" else None) for r in rows]


def authors(s, ids):
    if not ids:
        return {}
    from directory import avatar_urls
    users = s.query(UserORM).options(joinedload(UserORM.contact)).filter(UserORM.user_id.in_(ids)).all()
    avatars = avatar_urls(s, users)
    return {u.user_id: UserReference(**asdict(_user_ref_with_avatar(u, avatars[u.user_id]))) for u in users}


def register_routes(router):
    """After bot_api's: GET /broadcasts/senders and /audience come before /{broadcast_id}."""

    @router.get("/broadcasts/audience", response_model=Audience)
    def broadcast_audience(cur: User = Depends(get_current_user)):
        may_send(cur.user_id)
        enabled()
        return audience()

    @router.post("/broadcasts", response_model=BroadcastOut)
    def create_broadcast(payload: BroadcastIn, cur: User = Depends(get_current_user)):
        """The chair, deputies and assigned senders (owner, 2026-11-04)."""
        may_send(cur.user_id)
        enabled()
        return send(payload, cur.user_id, utcnow())

    @router.get("/broadcasts", response_model=Page[BroadcastOut])
    def list_broadcasts(cursor: str | None = None, cur: User = Depends(get_current_user)):
        may_send(cur.user_id)
        return page(cursor)

    @router.get("/broadcasts/{broadcast_id}", response_model=BroadcastOut)
    def get_broadcast(broadcast_id: str, cur: User = Depends(get_current_user)):
        """Every active account: the bell's notification opens this page."""
        return one(broadcast_id, access.allowed(cur.user_id, "broadcast.send"))

    @router.post("/broadcasts/{broadcast_id}/cancel", response_model=BroadcastOut)
    def cancel_broadcast(broadcast_id: str, cur: User = Depends(get_current_user)):
        may_send(cur.user_id)
        return cancel(broadcast_id, cur.user_id, utcnow())
