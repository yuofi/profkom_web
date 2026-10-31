"""Bounded batch of the existing public participant-category read projection."""
import json
import re
from typing import Literal

from fastapi import Depends, Query
from pydantic import BaseModel

import access
from auth import get_current_user
from database import db, UserORM, LeadershipORM
from domain_models import CategoryRevisionORM
from errors import InvalidInput
from models import User


MAX_BATCH = 200


class ParticipantCategoryRead(BaseModel):
    user_id: int
    category: Literal["junior", "activist"]
    revision: int
    capabilities: list[str]


class ParticipantCategoryBatch(BaseModel):
    items: list[ParticipantCategoryRead]


def parse_ids(value):
    pieces = [piece.strip() for piece in value.split(",")]
    if not pieces or any(not re.fullmatch(r"[1-9][0-9]{0,18}", piece) for piece in pieces):
        raise InvalidInput("user_ids must contain positive integer IDs")
    values = sorted({int(piece) for piece in pieces})
    if len(values) > MAX_BATCH or values[-1] > 2**63 - 1:
        raise InvalidInput("user_ids batch is too large")
    return values


def target_capabilities(session, actor_id):
    """Per-target capabilities shared by the single and the batch read, from the current
    rows of this request. The chair is never archived (a transfer comes first) and a chair
    deputy is archived only by the chair (leadership.deputies), as accounts.py checks."""
    editor = access.allowed(actor_id, "participant.category")
    archiver = access.allowed(actor_id, "account.archive")
    leadership = archiver and access.allowed(actor_id, "leadership.deputies")
    lead = session.get(LeadershipORM, 1) if archiver else None
    try:
        deputies = set(json.loads(lead.deputies_json or "[]")) if lead else set()
    except ValueError:
        deputies = set()
    chair = lead.chair_user_id if lead else None

    def capabilities(user_id):
        caps = ["edit_participant_category"] if editor else []
        if archiver and user_id != chair and (leadership or user_id not in deputies):
            caps.append("archive_account")
        return caps
    return capabilities


def categories(session, user_ids, actor_id):
    # Match GET /participants/{id}/category exactly: an absent revision row is
    # read as 1, never inserted or guessed from another version counter.
    caps = target_capabilities(session, actor_id)
    rows = session.query(UserORM.user_id, UserORM.category, CategoryRevisionORM.revision).outerjoin(
        CategoryRevisionORM, CategoryRevisionORM.user_id == UserORM.user_id
    ).filter(UserORM.user_id.in_(user_ids), UserORM.account_state == "active", UserORM.banned == False).order_by(UserORM.user_id)  # noqa: E712
    return dict(items=[dict(user_id=uid, category=category, revision=revision if revision is not None else 1,
                           capabilities=caps(uid)) for uid, category, revision in rows])


def register_routes(router):
    @router.get("/participants/categories", response_model=ParticipantCategoryBatch)
    def batch(user_ids: str = Query(..., min_length=1, max_length=4096), cur: User = Depends(get_current_user)):
        identifiers = parse_ids(user_ids)
        with db._session() as session:
            return categories(session, identifiers, cur.user_id)
