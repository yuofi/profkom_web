"""Bounded batch of the existing public participant-category read projection."""
import re
from typing import Literal

from fastapi import Depends, Query
from pydantic import BaseModel

import access
from auth import get_current_user
from database import db, UserORM
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


def categories(session, user_ids, actor_id):
    # Match GET /participants/{id}/category exactly: an absent revision row is
    # read as 1, never inserted or guessed from another version counter.
    caps = ["edit_participant_category"] if access.allowed(actor_id, "participant.category") else []
    rows = session.query(UserORM.user_id, UserORM.category, CategoryRevisionORM.revision).outerjoin(
        CategoryRevisionORM, CategoryRevisionORM.user_id == UserORM.user_id
    ).filter(UserORM.user_id.in_(user_ids), UserORM.account_state == "active", UserORM.banned == False).order_by(UserORM.user_id)  # noqa: E712
    return dict(items=[dict(user_id=uid, category=category, revision=revision if revision is not None else 1,
                           capabilities=list(caps)) for uid, category, revision in rows])


def register_routes(router):
    @router.get("/participants/categories", response_model=ParticipantCategoryBatch)
    def batch(user_ids: str = Query(..., min_length=1, max_length=4096), cur: User = Depends(get_current_user)):
        identifiers = parse_ids(user_ids)
        with db._session() as session:
            return categories(session, identifiers, cur.user_id)
