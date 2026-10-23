"""Registration review with a bounded, auditable resubmission process."""

import json, uuid
from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from fastapi import Depends, HTTPException
from auth import get_current_user
from database import db, UserORM, ContactInfoORM, AuditLogORM, NotificationORM
from domain_models import RegistrationORM, ParticipationORM, MembershipORM
from models import User
from api_contract import Page
from domain_contract import RegistrationApplication as ApplicationOut
import contact_rules
import access


class Fields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surname: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    patronymic: str | None = None
    group_number: str = Field(min_length=1, max_length=30)
    phone: str = Field(min_length=1, max_length=40)
    email: EmailStr
    tg: str = Field(min_length=1, max_length=200)
    vk: str = Field(min_length=1, max_length=300)
    funding: contact_rules.Funding
    residence: str = Field(min_length=1, max_length=500)

    @field_validator("tg", "vk", mode="before")
    @classmethod
    def normalize_contact(cls, value, info):
        return contact_rules.telegram(value) if info.field_name == "tg" else contact_rules.vk(value)

    @field_validator("group_number", mode="before")
    @classmethod
    def check_group(cls, value):
        return contact_rules.group_number(value)

    @field_validator(
        "surname",
        "name",
        "phone",
        "tg",
        "vk",
        "residence",
        mode="before",
    )
    @classmethod
    def trim(cls, v):
        return v.strip() if isinstance(v, str) else v


class Revision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)


class Update(Revision):
    fields: Fields


class Decision(Revision):
    reason: str | None = None


def now():
    return datetime.now(timezone.utc).isoformat()


def fail(status, message, code=None):
    """An HTTP error; `code` names a case the client words on its own (FIX_PLAN 2.13)."""
    raise HTTPException(status, {"code": code, "message": message} if code else message)


def audit(s, kind, id, uid, reason, old, new):
    s.add(
        AuditLogORM(
            target_kind=kind,
            target_id=str(id),
            changed_by_user_id=uid,
            reason=reason,
            old_values_json=json.dumps(old, ensure_ascii=False),
            new_values_json=json.dumps(new, ensure_ascii=False),
            created_at=now(),
        )
    )


ATTEMPT_LIMIT = 5


def can_resubmit(r):
    """A rejected application may be sent again until the limit (A-ROL-18)."""
    return r.status == "rejected" and r.attempts_used < ATTEMPT_LIMIT


def complete(r):
    """Whether the application holds every field an approval needs."""
    try:
        Fields.model_validate(json.loads(r.fields_json))
        return True
    except ValueError:
        return False


def dto(r, uid):
    caps = []
    if r.user_id == uid and can_resubmit(r):
        caps.append("resubmit_registration")
    if access.allowed(uid, "registration.review"):
        if r.status == "pending":
            caps += ["approve_registration", "reject_registration"]
        if r.status != "approved":
            caps += ["reset_registration_limit"]
    return dict(
        user_id=r.user_id,
        status=r.status,
        attempts_used=r.attempts_used,
        attempt_limit=ATTEMPT_LIMIT,
        total_submissions=r.total_submissions,
        rejection_reason=r.rejection_reason,
        fields=json.loads(r.fields_json),
        revision=r.revision,
        capabilities=caps,
    )


def registration_status(uid):
    with db._session() as s:
        return ensure_application(s, uid).status


def version(r, expected):
    if r.revision != expected:
        fail(409, "Revision conflict", "revision_conflict")


def append_history(r, action, uid, reason=None, **extra):
    h = json.loads(r.history_json)
    h.append(dict(action=action, actor=uid, at=now(), reason=reason, **extra))
    r.history_json = json.dumps(h, ensure_ascii=False)
    r.revision += 1


def register_routes(router):
    @router.get("/registrations/me", response_model=ApplicationOut)
    def own(cur: User = Depends(get_current_user)):
        with db._session() as s:
            r = ensure_application(s, cur.user_id)
            s.commit()
            return dto(r, cur.user_id)

    @router.patch("/registrations/me", response_model=ApplicationOut)
    def update(payload: Update, cur: User = Depends(get_current_user)):
        with db._session() as s:
            r = ensure_application(s, cur.user_id)
            version(r, payload.expected_revision)
            if r.status == "approved":
                fail(409, "Use your contact profile")
            fields = payload.fields.model_dump(mode="json")
            old = json.loads(r.fields_json)
            if db.email_taken(fields["email"], cur.user_id):
                fail(409, "Email already registered", "email_taken")
            was_complete = complete(r)
            r.fields_json = json.dumps(fields, ensure_ascii=False)
            append_history(r, "edit_fields", cur.user_id)
            if r.status == "pending" and not was_complete:
                # A VK application reaches the reviewers once it can be decided (A-ROL-20)
                from notifications import registration_submitted

                registration_submitted(s, r)
            audit(
                s,
                "registration",
                cur.user_id,
                cur.user_id,
                "Registration fields updated",
                old,
                fields,
            )
            s.commit()
            return dto(r, cur.user_id)

    @router.post("/registrations/me/resubmit", response_model=ApplicationOut)
    def resubmit(payload: Revision, cur: User = Depends(get_current_user)):
        with db._session() as s:
            r = ensure_application(s, cur.user_id)
            version(r, payload.expected_revision)
            if r.status != "rejected":
                fail(409, "Only rejected registrations can be resubmitted")
            if r.attempts_used >= ATTEMPT_LIMIT:
                fail(
                    409,
                    dict(
                        code="registration_attempt_limit",
                        message="Submission limit reached",
                    ),
                )
            if not complete(r):
                fail(422, "Complete all required registration fields")
            r.attempts_used += 1
            r.total_submissions += 1
            r.status = "pending"
            r.rejection_reason = None
            append_history(r, "resubmit", cur.user_id)
            from notifications import registration_submitted

            registration_submitted(s, r)
            audit(
                s,
                "registration",
                cur.user_id,
                cur.user_id,
                "Resubmission",
                {},
                dict(total_submissions=r.total_submissions),
            )
            s.commit()
            return dto(r, cur.user_id)

    @router.get("/registrations", response_model=Page[ApplicationOut])
    def queue(
        status: Literal["pending", "rejected", "approved"] | None = None,
        cur: User = Depends(get_current_user),
    ):
        """Waiting applications first, then rejected, then approved (A-ROL-21)."""
        if not access.allowed(cur.user_id, "registration.review"):
            fail(403, "Registration review required")
        order = {"pending": 0, "rejected": 1, "approved": 2}
        with db._session() as s:
            rows = s.query(RegistrationORM)
            if status:
                rows = rows.filter(RegistrationORM.status == status)
            return Page(
                items=[
                    dto(r, cur.user_id)
                    for r in sorted(rows, key=lambda r: (order.get(r.status, 3), r.user_id))
                ]
            )

    @router.post("/registrations/{user_id}/{command}", response_model=ApplicationOut)
    def decide(
        user_id: int,
        command: Literal["approve", "reject", "reset-attempts"],
        payload: Decision,
        cur: User = Depends(get_current_user),
    ):
        if not access.allowed(cur.user_id, "registration.review"):
            fail(403, "Registration review required")
        with db._session() as s:
            r = ensure_application(s, user_id)
            version(r, payload.expected_revision)
            reason = (payload.reason or "").strip()
            if command in ("reject", "reset-attempts") and not reason:
                fail(422, "Reason is required")
            old = dict(status=r.status, attempts_used=r.attempts_used)
            if command == "reset-attempts":
                if r.status == "approved":
                    fail(409, "Approved registrations do not need a reset")
                r.attempts_used = 0
            else:
                if r.status != "pending":
                    fail(409, "Application is not pending")
                if command == "approve":
                    try:
                        fields = Fields.model_validate(json.loads(r.fields_json))
                    except ValueError:
                        fail(422, "Complete all required registration fields")
                    u = s.get(UserORM, user_id)
                    c = s.get(ContactInfoORM, user_id)
                    if db.email_taken(str(fields.email), user_id):
                        fail(409, "Email already registered", "email_taken")
                    for k in (
                        "surname",
                        "name",
                        "patronymic",
                        "group_number",
                        "phone",
                        "tg",
                        "vk",
                    ):
                        setattr(c, k, getattr(fields, k) or "")
                    c.email = str(fields.email)
                    c.budget = fields.funding == "budget"
                    c.location = fields.residence
                    c.in_profcom = True
                    c.kkr_name = f"{fields.name} {fields.surname}"
                    u.group_number = fields.group_number
                    u.account_state = "active"
                    if (
                        not s.query(ParticipationORM)
                        .filter_by(user_id=user_id, ended_at=None)
                        .first()
                    ):
                        s.add(
                            ParticipationORM(
                                interval_id=str(uuid.uuid4()),
                                participant_id=f"participant-{user_id}",
                                user_id=user_id,
                                started_at=now(),
                            )
                        )
                    # A roster row of the old site is observed from the approval (A-DIR-18).
                    for member in s.query(MembershipORM).filter_by(
                        user_id=user_id, left_at=None, joined_at=None, observed_since=None
                    ):
                        member.observed_since = now()
                    r.status = "approved"
                    r.rejection_reason = None
                else:
                    r.status = "rejected"
                    r.rejection_reason = reason
            append_history(r, command, cur.user_id, reason)
            audit(
                s,
                "registration",
                user_id,
                cur.user_id,
                reason,
                old,
                dict(status=r.status, attempts_used=r.attempts_used),
            )
            s.add(
                NotificationORM(
                    notification_id=str(uuid.uuid4()),
                    user_id=user_id,
                    kind="registration_" + command,
                    payload_json="{}",
                    is_read=False,
                    created_at=now(),
                )
            )
            s.commit()
            return dto(r, cur.user_id)


from domain_seed import ensure_application
