"""Explicit block HR assignments, independent of ordinary membership and old names."""

from dataclasses import asdict

from fastapi import Depends, HTTPException

import access
from auth import get_current_user
from database import db, UserORM, _roster_candidate
from models import User
from registration import Revision, audit, version


class HrAssignment(Revision):
    user_id: int | None


def user_ref(session, meta):
    user = session.get(UserORM, meta.hr_user_id) if meta.hr_user_id is not None else None
    if not user or user.banned or user.account_state != "active":
        return None
    ref = db._get_user_ref(session, user.user_id)
    return asdict(ref) if ref else None


def assign(block_id, uid, payload):
    from membership import get_card, legacy_name, meta_for

    if not access.allowed(uid, "block.hr.assign"):
        raise HTTPException(403, "Only the chair, deputies and HR master can assign block HR")
    name = legacy_name(block_id)
    with db._session() as session:
        meta = meta_for(session, name)
        version(meta, payload.expected_revision)
        if payload.user_id is not None:
            _roster_candidate(session, payload.user_id)
        previous = meta.hr_user_id
        if previous != payload.user_id:
            meta.hr_user_id = payload.user_id
            meta.revision += 1
            audit(session, "block_hr", meta.block_id, uid, "Назначение HR блока",
                  {"user_id": previous}, {"user_id": payload.user_id})
        session.commit()
    return get_card(block_id, uid)


def register_routes(router):
    @router.put("/blocks/{block_id}/hr")
    def assign_hr(block_id: str, payload: HrAssignment, cur: User = Depends(get_current_user)):
        return assign(block_id, cur.user_id, payload)
