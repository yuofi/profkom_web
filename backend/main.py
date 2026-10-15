from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import List, Optional, Union

from fastapi import FastAPI, HTTPException, Depends, APIRouter, Response, Cookie, Body, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, field_validator

from models import Block, ContactInfo, User, Guide, PgasEntry, Season, Event, Subevent, Meeting, Leader, ReportSeries
from database import db
import database as database_module


import logging
import re
# ── Import the NEW auth module instead of inline helpers ───
from auth import (
    hash_password,
    verify_password,
    create_token_pair,
    refresh_tokens,
    revoke_refresh_token,
    revoke_all_user_tokens,
    get_current_user,          # replaces old get_current_user
    get_current_user_optional, # optional auth
    require_admin,             # replaces old require_admin
    require_superuser,         # replaces old require_superuser
    require_pgas_admin,        # права на раздел ПГАС
    REFRESH_TTL_DAYS,
)
from utils.s3_service import generate_presigned_url


app = FastAPI(
    title="Profcom backend",
    )

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
router = APIRouter(prefix="/api")
origins = [
    FRONTEND_URL,
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)
# ═══════════════════════════════════════════════════════════
#  SCHEMAS
# ═══════════════════════════════════════════════════════════

class ContactInfoIn(BaseModel):
    email: EmailStr
    surname: str = ""
    name: str = ""
    patronymic: str = ""
    kkr_name: str = ""
    group_number: str = ""
    location: str = ""
    blocks: str = ""
    phone: str = ""
    vk: str = ""
    tg: str = ""
    budget: bool = False
    in_profcom: bool = False
    photo_url: Optional[str] = None




class RegisterIn(BaseModel):
    email: EmailStr
    surname: str = ""
    name: str = ""
    patronymic: str = ""
    password: str = Field(..., min_length=1, max_length=4096)
    group_number: int = Field(..., ge=100, le=700)
    tg: str = Field(
        ...,
        min_length=5,
        max_length=33,  # with optional leading "@"
        pattern=r"^@?[A-Za-z0-9_]{5,32}$",
    )

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Password cannot be empty")
        if len(v) > 4096:
            raise ValueError("Password too long")
        return v


class UserOut(BaseModel):
    user_id: int
    kkr_name: str
    kkr_score: int
    group_number: int
    blocks: str
    photo_url: Optional[str] = None
    banned: bool
    super_user: bool
    admin: bool
    pgas_admin: bool = False
    events_roles: str = "[]"


class ProfileOut(UserOut):
    email: EmailStr
    tg: str


class ContactInfoOut(ContactInfoIn):
    user_id: int
    photo_url: Optional[str] = None


class MeOut(ContactInfoOut):
    kkr_name: str
    kkr_score: int
    banned: bool
    super_user: bool
    admin: bool
    pgas_admin: bool = False
    has_password: bool = True
    events_roles: str = "[]"


class GuideIn(BaseModel):
    title: str
    owner_block: Optional[str] = "none"
    text: Optional[str] = ""
    description: Optional[str] = ""
    original_link: Optional[str] = None


class GuideUpdate(BaseModel):
    title: Optional[str] = None
    owner_block: Optional[str] = None
    text: Optional[str] = None
    description: Optional[str] = None
    original_link: Optional[str] = None


class GuideOut(BaseModel):
    guide_id: int
    title: str
    owner_block: str
    text: str
    description: str = ""
    original_link: Optional[str] = None


class PgasEntryIn(BaseModel):
    title: str = Field(..., min_length=1)
    year: int = Field(..., ge=1900, le=2200)
    file_url: str = Field(..., min_length=1)
    file_name: str = ""
    file_type: str = ""


class PgasEntryOut(BaseModel):
    entry_id: int
    title: str
    year: int
    file_url: str
    file_name: str = ""
    file_type: str = ""
    created_at: str = ""
    uploaded_by: Optional[int] = None


class BlockIn(BaseModel):
    name: str = Field(..., min_length=1)
    master: str
    hr: str = ""
    cnt_of_human: int = 0
    arr_of_human: list[int] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Block name cannot be empty")
        if "/" in v:
            raise ValueError("Block name cannot contain '/'")
        return v


class BlockUpdate(BaseModel):
    master: Optional[str] = None
    hr: Optional[str] = None
    cnt_of_human: Optional[int] = None
    arr_of_human: Optional[list[int]] = None


class BlockOut(BlockIn):
    pass


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: Optional[str] = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordIn(BaseModel):
    old_password: Optional[str] = None
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Password cannot be empty")
        if len(v) > 4096:
            raise ValueError("Password too long")
        return v


class VKLoginIn(BaseModel):
    access_token: str
    id_token: Optional[str] = None


class ProfileUpdate(BaseModel):
    surname: Optional[str] = None
    name: Optional[str] = None
    patronymic: Optional[str] = None
    kkr_name: Optional[str] = None
    group_number: Optional[str] = None
    location: Optional[str] = None
    blocks: Optional[str] = None
    phone: Optional[str] = None
    vk: Optional[str] = None
    tg: Optional[str] = None
    email: Optional[EmailStr] = None
    budget: Optional[bool] = None
    in_profcom: Optional[bool] = None
    photo_url: Optional[str] = None
    events_roles: Optional[str] = None

    @field_validator("group_number")
    @classmethod
    def validate_group_number(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            if not v.strip().isdigit():
                raise ValueError("Group number must be numeric")
        return v


class ContactFilter(BaseModel):
    group_number: Optional[str] = None
    blocks: Optional[str] = None
    in_profcom: Optional[bool] = None
    budget: Optional[bool] = None


class PresignedUrlRequest(BaseModel):
    folder: str
    content_type: str  # например, 'image/jpeg'
    file_name: Optional[str] = None


class UrlsResponse(BaseModel):
    upload_url: str
    public_url: str


class UserRefOut(BaseModel):
    user_id: Optional[int] = None
    display_name: str
    avatar_url: Optional[str] = None


class RoleAssignmentOut(BaseModel):
    role_assignment_id: str
    user_id: int
    role: str
    scope_kind: str
    scope_id: Optional[str] = None
    principal_assignment_id: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = []


class LeadershipOut(BaseModel):
    chair: Optional[UserRefOut] = None
    deputies: list[UserRefOut] = []
    revision: int = 1
    capabilities: list[str] = []


class LeadershipTransferIn(BaseModel):
    new_chair_user_id: int
    expected_revision: Optional[int] = None


class LeadershipDeputiesIn(BaseModel):
    user_ids: Optional[list[int]] = None
    deputy_user_ids: Optional[list[int]] = None
    expected_revision: Optional[int] = None


class SessionOut(BaseModel):
    user_id: int
    account_state: str
    registration_status: str
    capabilities: list[str] = []
    permissions: list[str] = []
    assignments: list[RoleAssignmentOut] = []
    leadership: Optional[dict] = None
    super_user: bool = False
    admin: bool = False
    pgas_admin: bool = False
    events_roles: str = "[]"


# ─────────────────────────────────────────────────────────────
#  BE-02 SCHEMAS
# ─────────────────────────────────────────────────────────────

class LeaderOut(BaseModel):
    role_assignment_id: str
    user: UserRefOut
    deputy_user_ids: list[int] = []
    revision: int = 1
    capabilities: list[str] = []


class RichTextSchema(BaseModel):
    format: str = "markdown"
    body: str = ""


class SeasonIn(BaseModel):
    title: str
    type: str = "winter_spring"
    starts_at: str
    ends_at: str


class SeasonPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    reason: Optional[str] = None


class SeasonRevisionIn(BaseModel):
    expected_revision: Optional[int] = None


class SeasonOut(BaseModel):
    season_id: str
    title: str
    sequence_number: int
    previous_season_id: Optional[str] = None
    type: str
    starts_at: str
    ends_at: str
    state: str
    is_current: bool
    revision: int
    capabilities: list[str] = []


class ReportSeriesOut(BaseModel):
    series_id: str
    owner_kind: str
    title: str
    parent_series_id: Optional[str] = None


class EventCreateIn(BaseModel):
    season_id: str
    title: str
    description: Union[RichTextSchema, str] = ""
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    report_series_id: Optional[str] = None


class EventPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    description: Optional[Union[RichTextSchema, str]] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None


class EventCopyIn(BaseModel):
    season_id: str
    title: str
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None


class EventOut(BaseModel):
    event_id: str
    season_id: str
    title: str
    description: RichTextSchema
    leaders: list[LeaderOut] = []
    report_series_id: str
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    revision: int = 1
    capabilities: list[str] = []


class SubeventCreateIn(BaseModel):
    title: str
    description: Union[RichTextSchema, str] = ""
    report_series_id: Optional[str] = None


class SubeventPatchIn(BaseModel):
    expected_revision: int
    title: Optional[str] = None
    description: Optional[Union[RichTextSchema, str]] = None


class SubeventOut(BaseModel):
    subevent_id: str
    event_id: str
    title: str
    description: RichTextSchema
    leaders: list[LeaderOut] = []
    organizer_user_ids: list[int] = []
    report_series_id: str
    revision: int = 1
    capabilities: list[str] = []


class EventCopyOut(BaseModel):
    event: EventOut
    subevents: list[SubeventOut] = []


class UserIdsIn(BaseModel):
    user_ids: list[int]
    expected_revision: int


class BlockLeaderIn(BaseModel):
    user_id: int
    expected_revision: Optional[int] = None


class MeetingIn(BaseModel):
    expected_revision: Optional[int] = None
    title: str
    starts_at: str
    join_url: str


class MeetingOut(BaseModel):
    meeting_id: str
    owner_kind: str
    owner_id: str
    title: str
    starts_at: str
    join_url: str
    revision: int = 1
    capabilities: list[str] = []


class SeasonCorrectionIn(BaseModel):
    object_kind: str
    object_id: str
    expected_revision: int
    target_season_id: str
    reason: str


class SeasonCorrectionOut(BaseModel):
    object_kind: str
    object_id: str
    source_season_id: str
    target_season_id: str
    revision: int



# ═══════════════════════════════════════════════════════════
#  AUTH ENDPOINTS  (NEW)
# ═══════════════════════════════════════════════════════════

@router.post("/auth/register", response_model=TokenPair, status_code=201)
def register(payload: RegisterIn, response: Response):
    """
    Register a new user.
    Body JSON:
    {
      "email": "...",
      "surname": "...",
      "name": "...",
      "patronymic": "...",
      "password": "..."
    }
    Returns access + refresh tokens immediately.
    """
    logger.info(f"Arguments: {payload.model_dump_json()}")
    # Uniqueness: email
    if db.get_user_by_email(str(payload.email)):
        raise HTTPException(409, "Email already registered")

    kkr_name = " ".join(
        part.strip()
        for part in [payload.name, payload.surname]
        if part and part.strip()
    ).strip()
    if not kkr_name:
        kkr_name = str(payload.email)

    contact_model = ContactInfo(
        user_id=0,
        surname=payload.surname,
        name=payload.name,
        patronymic=payload.patronymic,
        kkr_name=kkr_name,
        group_number=str(payload.group_number),
        location="",
        blocks="",
        phone="",
        vk="",
        tg=payload.tg,
        email=str(payload.email),
        budget=True,
        in_profcom=False,
    )
    user_model = User(
        user_id=0,
        hashed_password=hash_password(payload.password),   # ← hash!
        kkr_score=0,
        group_number=str(payload.group_number),
        blocks="",
        banned=False,
        super_user=False,
        admin=False,
    )
    created = db.create_user_with_contact(contact_model, user_model)

    # Return tokens so the user is logged-in right away
    tokens = create_token_pair(created.user_id)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/login", response_model=TokenPair)
def login(body: LoginIn, response: Response):
    """
    Authenticate with email + password → get tokens.
    """
    user = db.get_user_by_email(str(body.email))
    if not user:
        raise HTTPException(401, "Invalid credentials")

    if not user.hashed_password:
        raise HTTPException(401, "No password set for this account. Please login via VK.")

    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(401, "Invalid credentials")

    if user.banned:
        raise HTTPException(403, "User is banned")

    if getattr(user, "account_state", "active") == "archived":
        raise HTTPException(403, "Account is archived")

    tokens = create_token_pair(user.user_id)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/change-password")
def change_password(
    payload: ChangePasswordIn,
    cur: User = Depends(get_current_user),
):
    if cur.hashed_password:
        if not payload.old_password:
            raise HTTPException(400, "Old password is required")
        if not verify_password(payload.old_password, cur.hashed_password):
            raise HTTPException(400, "Invalid old password")

    new_hashed = hash_password(payload.new_password)
    db.update_user(cur.user_id, hashed_password=new_hashed)
    revoke_all_user_tokens(cur.user_id)
    return {"detail": "Password updated successfully"}


@router.post("/auth/vk", response_model=TokenPair)
def vk_login(payload: VKLoginIn, response: Response):
    import urllib.request
    import urllib.parse
    import json
    from jose import jwt
    from utils.s3_service import upload_image_from_url

    email = None
    first_name = "VK"
    last_name = "User"
    vk_id = None
    avatar_url = None
    phone = None

    if payload.id_token:
        try:
            claims = jwt.get_unverified_claims(payload.id_token)
            first_name = claims.get("first_name", first_name)
            last_name = claims.get("last_name", last_name)
            phone = claims.get("phone") or claims.get("phone_number")
        except Exception:
            pass

    try:
        url = "https://id.vk.ru/oauth2/user_info"
        data = urllib.parse.urlencode({
            "client_id": "54678274",
            "access_token": payload.access_token,
        }).encode("utf-8")

        headers = {
            "Accept-Language": "ru-RU, ru;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded"
        }

        req = urllib.request.Request(url, data=data, headers=headers)
        logging.info("Requesting VK user info from oauth2/user_info")
        with urllib.request.urlopen(req) as vk_response:
            vk_data = json.loads(vk_response.read().decode())
            vk_user = vk_data.get("user")
            logging.info("VK user info response received")
            if "error" in vk_data or not vk_user:
                raise Exception("VK API error")

            raw_id = vk_user.get("user_id") if "user_id" in vk_user else vk_user.get("id")
            if raw_id is not None and str(raw_id).lower() != "none" and str(raw_id).strip():
                vk_id = str(raw_id).strip()
            email = vk_user.get("email")
            if "first_name" in vk_user:
                first_name = vk_user["first_name"]
            if "last_name" in vk_user:
                last_name = vk_user["last_name"]
            if "avatar" in vk_user:
                avatar_url = vk_user["avatar"]
            if "phone" in vk_user and vk_user["phone"]:
                phone = str(vk_user["phone"])
            elif "phone_number" in vk_user and vk_user["phone_number"]:
                phone = str(vk_user["phone_number"])
    except Exception:
        try:
            escaped_token = urllib.parse.quote(payload.access_token)
            url2 = f"https://api.vk.com/method/users.get?v=5.131&access_token={escaped_token}&fields=contacts,photo_max,photo_200&lang=ru"
            req2 = urllib.request.Request(url2)
            with urllib.request.urlopen(req2) as response2:
                vk_data2 = json.loads(response2.read().decode())
                if "error" in vk_data2 or not vk_data2.get("response"):
                    raise HTTPException(401, "Invalid VK token")
                vk_user = vk_data2["response"][0]
                raw_id2 = vk_user.get("id") if "id" in vk_user else vk_user.get("user_id")
                if raw_id2 is not None and str(raw_id2).lower() != "none" and str(raw_id2).strip():
                    vk_id = str(raw_id2).strip()
                if "first_name" in vk_user:
                    first_name = vk_user["first_name"]
                if "last_name" in vk_user:
                    last_name = vk_user["last_name"]
                if "photo_max" in vk_user:
                    avatar_url = vk_user["photo_max"]
                elif "photo_200" in vk_user:
                    avatar_url = vk_user["photo_200"]
                if "mobile_phone" in vk_user and vk_user["mobile_phone"]:
                    phone = phone or str(vk_user["mobile_phone"])
                elif "home_phone" in vk_user and vk_user["home_phone"]:
                    phone = phone or str(vk_user["home_phone"])
                elif "phone" in vk_user and vk_user["phone"]:
                    phone = phone or str(vk_user["phone"])
        except Exception as e:
            if isinstance(e, HTTPException):
                raise e
            raise HTTPException(401, "Failed to verify VK token")

    if not vk_id or vk_id.lower() == "none":
        raise HTTPException(401, "Could not identify VK user")

    if phone:
        phone = str(phone).strip()
        if not phone.startswith("+"):
            phone = "+" + phone

    user = None
    if email:
        logging.info(f"Looking up user by email: {email}")
        user = db.get_user_by_email(email)

    kkr_name_to_check = f"{first_name} {last_name}".strip()

    if not user and kkr_name_to_check:
        logging.info(f"Looking up user by name: {kkr_name_to_check}")
        user = db.get_user_by_name(kkr_name_to_check)

    if not user:
        if not email:
            email = f"vk_{vk_id}@vk.com"

        kkr_name = kkr_name_to_check
        contact_model = ContactInfo(
            user_id=0,
            surname=last_name,
            name=first_name,
            patronymic="",
            kkr_name=kkr_name,
            group_number="0",
            location="",
            blocks="",
            phone=phone or "",
            vk=f"https://vk.com/id{vk_id}",
            tg="",
            email=email,
            budget=True,
            in_profcom=False,
        )
        s3_photo_url = None
        if avatar_url:
            pattern = r"cs=[^&]*"
            avatar_url = re.sub(pattern, "cs=150x150", avatar_url)
            s3_photo_url = upload_image_from_url(avatar_url, folder="avatars")

        user_model = User(
            user_id=0,
            hashed_password="",
            kkr_score=0,
            group_number="0",
            blocks="",
            photo_url=s3_photo_url,
            banned=False,
            super_user=False,
            admin=False,
        )
        user = db.create_user_with_contact(contact_model, user_model)
        logger.info(f"Created new user from VK login: {user.user_id} ({kkr_name})")
    else:
        if user.banned:
            raise HTTPException(403, "User is banned")
        if getattr(user, "account_state", "active") == "archived":
            raise HTTPException(403, "Account is archived")

        # Update existing user photo if missing
        if avatar_url and not user.photo_url:
            pattern = r"cs=[^&]*"
            avatar_url = re.sub(pattern, "cs=150x150", avatar_url)
            s3_photo_url = upload_image_from_url(avatar_url, folder="avatars")
            if s3_photo_url:
                db.update_user(user.user_id, photo_url=s3_photo_url)
        db.update_contact(user.user_id, vk=f"https://vk.com/id{vk_id}")
        if phone:
            db.update_contact(user.user_id, phone=phone)

    if user.banned:
        raise HTTPException(403, "User is banned")

    tokens = create_token_pair(user.user_id)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/refresh", response_model=TokenPair)
def refresh(response: Response, refresh_token: str = Cookie(None)):
    """
    Exchange a refresh token for a new access + refresh pair.
    Old refresh token is deleted (rotation).
    """
    if not refresh_token:
        raise HTTPException(401, "Refresh token missing in cookies")

    tokens = refresh_tokens(refresh_token)
    response.set_cookie(
        key="refresh_token",
        value=tokens["refresh_token"],
        httponly=True,
        max_age=REFRESH_TTL_DAYS * 24 * 60 * 60,
        samesite="none",
        secure=True
    )
    return tokens


@router.post("/auth/logout")
def logout(
    response: Response,
    refresh_token: str = Cookie(None),
    cur: User = Depends(get_current_user),    # must be authenticated
):
    """Revoke a single refresh token (one device)."""
    if refresh_token:
        rt = db.get_refresh_token(refresh_token)
        if rt and rt["user_id"] == cur.user_id:
            revoke_refresh_token(refresh_token)
    response.delete_cookie("refresh_token", samesite="none", secure=True)
    return {"detail": "Logged out"}


@router.post("/auth/logout-all")
def logout_all(
    response: Response,
    cur: User = Depends(get_current_user),
):
    """Revoke ALL refresh tokens for the current user."""
    revoke_all_user_tokens(cur.user_id)
    response.delete_cookie("refresh_token", samesite="none", secure=True)
    return {"detail": "Logged out from all devices"}


# ═══════════════════════════════════════════════════════════
#  PROFILE   (protected by Bearer token now)
# ═══════════════════════════════════════════════════════════

@router.get("/profile/me", response_model=MeOut)
def my_profile(cur: User = Depends(get_current_user)):
    """Return the profile of the currently authenticated user."""
    contact = db.get_contact(cur.user_id)
    if not contact:
        raise HTTPException(500, "Contact info missing for user")
    
    # Combine contact info with user-level flags
    return MeOut(
        **contact.__dict__,
        kkr_score=cur.kkr_score,
        banned=cur.banned,
        super_user=cur.super_user,
        admin=cur.admin,
        pgas_admin=cur.pgas_admin,
        has_password=bool(cur.hashed_password),
        events_roles=cur.events_roles
    )


@router.get("/profile/{user_id}", response_model=ProfileOut)
def get_profile(user_id: int, cur: User = Depends(get_current_user)):
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    contact = db.get_contact(user_id)
    if not contact:
        raise HTTPException(500, "Contact info missing for user")
    return ProfileOut(**user.__dict__, kkr_name=contact.kkr_name, email=contact.email, tg=contact.tg)


@router.patch("/profile/{user_id}", response_model=UserOut)
def update_profile(
    user_id: int,
    payload: ProfileUpdate,
    cur: User = Depends(get_current_user),
):
    if cur.user_id != user_id and not (cur.admin or cur.super_user or db.is_tachki(cur.user_id)):
        raise HTTPException(403, "Forbidden")
    target = db.get_user(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    contact = db.get_contact(user_id)
    if not contact:
        raise HTTPException(500, "Contact info missing for user")

    if payload.email is not None and payload.email != contact.email:
        existing = db.get_user_by_email(str(payload.email))
        if existing and existing.user_id != user_id:
            raise HTTPException(409, "Email already registered")

    fields_set = payload.model_fields_set if hasattr(payload, "model_fields_set") else payload.__fields_set__

    new_kkr_name = None
    if "kkr_name" in fields_set:
        new_kkr_name = payload.kkr_name
    elif "name" in fields_set or "surname" in fields_set:
        new_name = payload.name if ("name" in fields_set and payload.name is not None) else (contact.name if contact else "")
        new_surname = payload.surname if ("surname" in fields_set and payload.surname is not None) else (contact.surname if contact else "")
        new_kkr_name = " ".join(
            part.strip()
            for part in [new_name, new_surname]
            if part and part.strip()
        ).strip()

    db.update_contact(
        user_id,
        surname=payload.surname, name=payload.name, patronymic=payload.patronymic,
        kkr_name=new_kkr_name,
        group_number=payload.group_number, location=payload.location,
        blocks=payload.blocks, phone=payload.phone,
        vk=payload.vk, tg=payload.tg,
        email=str(payload.email) if payload.email is not None else None,
        budget=payload.budget,
        in_profcom=payload.in_profcom,
    )
    db.update_user(
        user_id, 
        group_number=payload.group_number, 
        blocks=payload.blocks, 
        photo_url=payload.photo_url,
        events_roles=payload.events_roles
    )
    updated = db.get_user(user_id)
    updated_contact = db.get_contact(user_id)
    return UserOut(**updated.__dict__, kkr_name=updated_contact.kkr_name if updated_contact else "")


@router.delete("/profile/{user_id}")
def delete_user(user_id: int, cur: User = Depends(require_superuser)):
    if not db.get_user(user_id):
        raise HTTPException(404, "User not found")
    db.delete_user(user_id)
    return {"status": "deleted"}


# ═══════════════════════════════════════════════════════════
#  GUIDES
# ═══════════════════════════════════════════════════════════

@router.get("/guides", response_model=List[GuideOut])
def list_guides(cur: Optional[User] = Depends(get_current_user_optional)):
    all_guides = db.list_guides()
    if cur and cur.super_user:
        return [GuideOut(**g.__dict__) for g in all_guides]

    user_blocks = set()
    if cur:
        user_blocks = {b.strip().lower() for b in db.get_user_block_names(cur.user_id)}

    result = []
    for g in all_guides:
        ob = (g.owner_block or "").strip().lower()
        if ob in ("", "none", "all"):
            result.append(GuideOut(**g.__dict__))
        elif cur and ob in user_blocks:
            result.append(GuideOut(**g.__dict__))
    logger.info(f"user blocks: {user_blocks}, guides found: {[(i.title, i.owner_block) for i in result]}")
    return result


@router.get("/guides/{guide_id}", response_model=GuideOut)
def get_guide(guide_id: int, cur: Optional[User] = Depends(get_current_user_optional)):
    g = db.get_guide(guide_id)
    if not g:
        raise HTTPException(404, "Guide not found")

    ob = (g.owner_block or "").strip().lower()
    if ob in ("", "none", "all"):
        return GuideOut(**g.__dict__)

    if not cur:
        raise HTTPException(403, "Access forbidden")

    if cur.super_user:
        return GuideOut(**g.__dict__)

    user_blocks = {b.strip().lower() for b in db.get_user_block_names(cur.user_id)}
    if ob in user_blocks:
        return GuideOut(**g.__dict__)

    raise HTTPException(403, "Access forbidden")


@router.post("/guides", response_model=GuideOut)
def create_guide(guide: GuideIn, cur: User = Depends(get_current_user)):
    if cur.super_user:
        owner_block = (guide.owner_block or "none").strip()
    else:
        master_blocks = db.get_user_master_block_names(cur.user_id)
        if not master_blocks:
            raise HTTPException(403, "Only block masters and superusers can create guides")

        requested_ob = (guide.owner_block or "").strip()
        matched = next((mb for mb in master_blocks if mb.lower() == requested_ob.lower()), None)
        owner_block = matched if matched else master_blocks[0]

    g = Guide(
        guide_id=0,
        title=guide.title,
        owner_block=owner_block if owner_block else "none",
        text=guide.text if guide.text else f"# {guide.title}\n\n",
        description=guide.description if guide.description is not None else "",
        original_link=guide.original_link,
    )
    created = db.create_guide(g)
    return GuideOut(**created.__dict__)


@router.post("/guides/{guide_id}", response_model=GuideOut)
@router.put("/guides/{guide_id}", response_model=GuideOut)
@router.patch("/guides/{guide_id}", response_model=GuideOut)
def edit_guide(
    guide_id: int,
    guide: GuideUpdate,
    cur: User = Depends(get_current_user),
):
    existing = db.get_guide(guide_id)
    if not existing:
        raise HTTPException(404, "Guide not found")

    if cur.super_user:
        new_owner_block = guide.owner_block if guide.owner_block is not None else existing.owner_block
    else:
        master_blocks = db.get_user_master_block_names(cur.user_id)
        master_blocks_lower = {mb.lower(): mb for mb in master_blocks}
        existing_ob = (existing.owner_block or "").strip().lower()

        if existing_ob not in master_blocks_lower:
            raise HTTPException(403, "You can only edit guides belonging to your own block as a master")

        current_master_block = master_blocks_lower[existing_ob]

        if guide.owner_block is not None:
            req_ob = guide.owner_block.strip().lower()
            if req_ob in ("", "none", "all"):
                new_owner_block = "none"
            elif req_ob == existing_ob:
                new_owner_block = current_master_block
            elif req_ob in master_blocks_lower:
                new_owner_block = master_blocks_lower[req_ob]
            else:
                raise HTTPException(403, "You can only set visibility to 'none' (for all) or your own block")
        else:
            new_owner_block = existing.owner_block

    fields_set = guide.model_fields_set if hasattr(guide, "model_fields_set") else guide.__fields_set__
    new_orig_link = guide.original_link if "original_link" in fields_set else existing.original_link

    updated = db.update_guide(
        guide_id,
        title=guide.title if guide.title is not None else existing.title,
        owner_block=new_owner_block if new_owner_block else "none",
        text=guide.text if guide.text is not None else existing.text,
        description=guide.description if guide.description is not None else existing.description,
        original_link=new_orig_link,
    )
    if not updated:
        raise HTTPException(404, "Guide not found")
    return GuideOut(**updated.__dict__)


@router.delete("/guides/{guide_id}")
def delete_guide(guide_id: int, cur: User = Depends(get_current_user)):
    existing = db.get_guide(guide_id)
    if not existing:
        raise HTTPException(404, "Guide not found")

    if not cur.super_user:
        master_blocks = db.get_user_master_block_names(cur.user_id)
        master_blocks_lower = {mb.lower() for mb in master_blocks}
        existing_ob = (existing.owner_block or "").strip().lower()
        if existing_ob not in master_blocks_lower:
            raise HTTPException(403, "You can only delete guides of your own block")

    success = db.delete_guide(guide_id)
    if not success:
        raise HTTPException(404, "Guide not found")
    return {"status": "deleted"}


# ═══════════════════════════════════════════════════════════
#  PGAS
# ═══════════════════════════════════════════════════════════

#: Допустимые MIME-типы файлов ПГАС
PGAS_ALLOWED_CONTENT_TYPES = (
    "application/pdf", 
    "image/png", 
    "image/jpeg", 
    "image/jpg", 
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/zip",
    "application/x-zip-compressed"
)
#: Допустимые расширения файлов ПГАС
PGAS_ALLOWED_EXTENSIONS = ("pdf", "png", "jpg", "jpeg", "docx", "doc")
PGAS_BAD_FILE = "Only pdf, doc, docx, png and jpg files are allowed for PGAS"


def _validate_pgas_file(file_url: str, file_type: str) -> None:
    """Пускаем только pdf/doc/docx/png/jpg: сверяем и MIME-тип (если он передан), и расширение ссылки."""
    ct = (file_type or "").strip().lower()
    if ct and ct not in PGAS_ALLOWED_CONTENT_TYPES:
        raise HTTPException(400, PGAS_BAD_FILE)

    ext = file_url.split("?")[0].rsplit(".", 1)[-1].strip().lower()
    if ext not in PGAS_ALLOWED_EXTENSIONS:
        raise HTTPException(400, PGAS_BAD_FILE)


@router.get("/pgas", response_model=List[PgasEntryOut])
def list_pgas(cur: User = Depends(get_current_user)):
    """Таблицу ПГАС видит любой авторизованный пользователь."""
    return [PgasEntryOut(**e.__dict__) for e in db.list_pgas_entries()]


@router.post("/pgas", response_model=PgasEntryOut)
def create_pgas(payload: PgasEntryIn, cur: User = Depends(require_pgas_admin)):
    """Добавить запись в таблицу ПГАС. Доступно pgas_admin и суперюзеру."""
    _validate_pgas_file(payload.file_url, payload.file_type)

    entry = PgasEntry(
        entry_id=0,
        title=payload.title,
        year=payload.year,
        file_url=payload.file_url,
        file_name=payload.file_name,
        file_type=payload.file_type,
        created_at=datetime.now(timezone.utc).isoformat(),
        uploaded_by=cur.user_id,
    )
    created = db.create_pgas_entry(entry)
    return PgasEntryOut(**created.__dict__)


@router.delete("/pgas/{entry_id}")
def delete_pgas(entry_id: int, cur: User = Depends(require_pgas_admin)):
    """Удалить запись ПГАС. Доступно pgas_admin и суперюзеру."""
    if not db.get_pgas_entry(entry_id):
        raise HTTPException(404, "PGAS entry not found")

    success = db.delete_pgas_entry(entry_id)
    if not success:
        raise HTTPException(404, "PGAS entry not found")
    return {"status": "deleted"}


# ═══════════════════════════════════════════════════════════
#  BLOCKS
# ═══════════════════════════════════════════════════════════

@router.get("/blocks", response_model=List[BlockOut])
def list_blocks():
    return [BlockOut(**b.__dict__) for b in db.list_blocks()]


@router.post("/blocks", response_model=BlockOut)
def create_block(payload: BlockIn, cur: User = Depends(require_superuser)):
    existing = db.get_block(payload.name)
    if existing:
        raise HTTPException(409, "Block already exists")
    block = Block(
        name=payload.name,
        master=payload.master,
        hr=payload.hr,
        cnt_of_human=payload.cnt_of_human,
        arr_of_human=payload.arr_of_human,
    )
    created = db.create_block(block)
    return BlockOut(**created.__dict__)


@router.patch("/blocks/{block_name}", response_model=BlockOut)
def update_block(
    block_name: str,
    payload: BlockUpdate,
    cur: User = Depends(get_current_user),
):
    block = db.get_block(block_name)
    if not block:
        if not cur.super_user and not cur.admin:
            raise HTTPException(403, "Admin rights required")
        raise HTTPException(404, "Block not found")

    if not cur.super_user:
        contact = db.get_contact(cur.user_id)
        is_master = (block.master_user_id == cur.user_id) or (bool(contact and contact.kkr_name and contact.kkr_name == block.master))
        is_hr = bool(contact and contact.kkr_name and contact.kkr_name == block.hr)
        if not (is_master or is_hr):
            if not cur.admin:
                raise HTTPException(403, "Admin rights required")
            raise HTTPException(403, "You can only edit a block if you are its Master or HR")

    updated = db.update_block(
        block_name,
        master=payload.master,
        hr=payload.hr,
        cnt_of_human=payload.cnt_of_human,
        arr_of_human=payload.arr_of_human,
    )
    if not updated:
        raise HTTPException(404, "Block not found")
    return BlockOut(**updated.__dict__)


@router.delete("/blocks/{block_name}")
def delete_block(block_name: str, cur: User = Depends(require_superuser)):
    if not db.get_block(block_name):
        raise HTTPException(404, "Block not found")
    db.delete_block(block_name)
    return {"status": "deleted"}


@router.post("/blocks/{block_name}/enter", response_model=BlockOut)
def enter_block(block_name: str, cur: User = Depends(get_current_user)):
    updated = db.enter_user_to_block(cur.user_id, block_name)
    if not updated:
        raise HTTPException(404, "User or block not found")
    return BlockOut(**updated.__dict__)


@router.post("/blocks/{block_name}/exit", response_model=BlockOut)
def exit_block(block_name: str, cur: User = Depends(get_current_user)):
    updated = db.exit_user_from_block(cur.user_id, block_name)
    if not updated:
        raise HTTPException(404, "User or block not found")
    return BlockOut(**updated.__dict__)


# ═══════════════════════════════════════════════════════════
#  CONTACTS
# ═══════════════════════════════════════════════════════════

@router.get("/contacts", response_model=List[ContactInfoOut])
def get_all_contacts(cur: User = Depends(get_current_user)):
    if getattr(cur, "account_state", "active") != "active":
        raise HTTPException(403, "Access denied")
    return [ContactInfoOut(**c.__dict__) for c in db.list_contacts()]


# ═══════════════════════════════════════════════════════════
#  SESSION & LEADERSHIP (BE-01)
# ═══════════════════════════════════════════════════════════

@router.get("/session", response_model=SessionOut)
def get_session(cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state == "archived":
        raise HTTPException(403, "Account is archived")

    reg_status = "approved" if acc_state == "active" else "pending"
    if acc_state == "pending":
        return SessionOut(
            user_id=cur.user_id,
            account_state="pending",
            registration_status="pending",
            capabilities=["session:read"],
            assignments=[],
        )

    caps = ["session:read", "contacts:read", "guides:read", "profile:read"]
    if cur.super_user or db.is_chair(cur.user_id):
        caps.extend(["leadership:manage", "leadership:transfer", "leadership:deputies", "admin"])
    elif cur.admin or db.is_deputy_chair(cur.user_id):
        caps.extend(["admin"])

    assignments_dc = db.get_user_assignments(cur.user_id)
    assignments_out = [
        RoleAssignmentOut(
            role_assignment_id=a.role_assignment_id,
            user_id=a.user_id,
            role=a.role,
            scope_kind=a.scope_kind,
            scope_id=a.scope_id,
            principal_assignment_id=a.principal_assignment_id,
            revision=a.revision,
            capabilities=a.capabilities,
        )
        for a in assignments_dc
    ]

    is_ch = bool(cur.super_user or db.is_chair(cur.user_id))
    is_dep = bool(db.is_deputy_chair(cur.user_id))
    caps_sorted = sorted(list(set(caps)))

    return SessionOut(
        user_id=cur.user_id,
        account_state=acc_state,
        registration_status=reg_status,
        capabilities=caps_sorted,
        permissions=caps_sorted,
        assignments=assignments_out,
        leadership={"is_chair": is_ch, "is_deputy": is_dep},
        super_user=cur.super_user,
        admin=cur.admin,
        pgas_admin=cur.pgas_admin,
        events_roles=cur.events_roles or "[]",
    )


@router.get("/leadership", response_model=LeadershipOut)
def get_leadership(cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state != "active":
        raise HTTPException(403, "Approved active account required")

    lead = db.get_leadership()
    caps = ["read"]
    if cur.super_user or db.is_chair(cur.user_id):
        caps.extend(["leadership:transfer", "leadership:deputies"])

    chair_out = (
        UserRefOut(
            user_id=lead.chair.user_id,
            display_name=lead.chair.display_name,
            avatar_url=lead.chair.avatar_url,
        )
        if lead.chair
        else None
    )
    deputies_out = [
        UserRefOut(
            user_id=d.user_id,
            display_name=d.display_name,
            avatar_url=d.avatar_url,
        )
        for d in lead.deputies
    ]

    return LeadershipOut(
        chair=chair_out,
        deputies=deputies_out,
        revision=lead.revision,
        capabilities=sorted(list(set(caps))),
    )


@router.post("/leadership/transfer", response_model=LeadershipOut)
def transfer_leadership(payload: LeadershipTransferIn, cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state != "active":
        raise HTTPException(403, "Approved active account required")
    if not (cur.super_user or db.is_chair(cur.user_id)):
        raise HTTPException(403, "Only the current chair can transfer leadership")

    target = db.get_user(payload.new_chair_user_id)
    if not target:
        raise HTTPException(404, "Target user not found")

    try:
        lead = db.transfer_chair(payload.new_chair_user_id, payload.expected_revision)
    except ValueError as e:
        msg = str(e)
        if "revision mismatch" in msg or "Conflict" in msg:
            raise HTTPException(409, detail=msg)
        raise HTTPException(400, detail=msg)

    chair_out = (
        UserRefOut(
            user_id=lead.chair.user_id,
            display_name=lead.chair.display_name,
            avatar_url=lead.chair.avatar_url,
        )
        if lead.chair
        else None
    )
    deputies_out = [
        UserRefOut(
            user_id=d.user_id,
            display_name=d.display_name,
            avatar_url=d.avatar_url,
        )
        for d in lead.deputies
    ]

    return LeadershipOut(
        chair=chair_out,
        deputies=deputies_out,
        revision=lead.revision,
        capabilities=["read"],
    )


@router.put("/leadership/deputies", response_model=LeadershipOut)
def set_deputies(payload: LeadershipDeputiesIn, cur: User = Depends(get_current_user)):
    acc_state = getattr(cur, "account_state", "active") or "active"
    if acc_state != "active":
        raise HTTPException(403, "Approved active account required")
    if not (cur.super_user or db.is_chair(cur.user_id)):
        raise HTTPException(403, "Only the current chair can set deputies")

    uids = payload.user_ids if payload.user_ids is not None else payload.deputy_user_ids
    if uids is None:
        uids = []

    try:
        lead = db.set_chair_deputies(uids, payload.expected_revision)
    except ValueError as e:
        msg = str(e)
        if "revision mismatch" in msg or "Conflict" in msg:
            raise HTTPException(409, detail=msg)
        raise HTTPException(400, detail=msg)

    chair_out = (
        UserRefOut(
            user_id=lead.chair.user_id,
            display_name=lead.chair.display_name,
            avatar_url=lead.chair.avatar_url,
        )
        if lead.chair
        else None
    )
    deputies_out = [
        UserRefOut(
            user_id=d.user_id,
            display_name=d.display_name,
            avatar_url=d.avatar_url,
        )
        for d in lead.deputies
    ]

    return LeadershipOut(
        chair=chair_out,
        deputies=deputies_out,
        revision=lead.revision,
        capabilities=["read", "leadership:transfer", "leadership:deputies"],
    )


@router.post("/contacts/filter", response_model=List[ContactInfoOut])
def filter_contacts(filt: ContactFilter, cur: User = Depends(require_admin)):
    contacts = db.filter_contacts(
        group_number=filt.group_number, blocks=filt.blocks,
        in_profcom=filt.in_profcom, budget=filt.budget,
    )
    return [ContactInfoOut(**c.__dict__) for c in contacts]


# ═══════════════════════════════════════════════════════════
#  UPLOAD
# ═══════════════════════════════════════════════════════════

@router.post("/upload/presigned-url", response_model=UrlsResponse)
def get_presigned_url(
    payload: PresignedUrlRequest,
    cur: User = Depends(get_current_user)
):
    """
    Generate a presigned URL for direct S3 upload.
    If folder is 'guides', only superusers can upload.
    If folder is 'pgas', only pgas admins and superusers can upload, and only pdf/docx/png/jpg.
    """
    if payload.folder == 'guides' and not cur.super_user and not db.get_user_master_block_names(cur.user_id):
        raise HTTPException(403, "Only superusers and block masters can upload to 'guides' folder")

    if payload.folder == 'pgas':
        if not cur.pgas_admin and not cur.super_user:
            raise HTTPException(403, "Only PGAS admins and superusers can upload to 'pgas' folder")
        ct = payload.content_type.strip().lower()
        ext = (
            payload.file_name.split("?")[0].rsplit(".", 1)[-1].strip().lower()
            if (payload.file_name and "." in payload.file_name)
            else ""
        )
        if ct and ct not in PGAS_ALLOWED_CONTENT_TYPES:
            raise HTTPException(400, PGAS_BAD_FILE)
        if ext and ext not in PGAS_ALLOWED_EXTENSIONS:
            raise HTTPException(400, PGAS_BAD_FILE)
        if not ct and not ext:
            raise HTTPException(400, PGAS_BAD_FILE)

    urls = generate_presigned_url(payload.folder, payload.content_type, payload.file_name)
    return urls


# ═══════════════════════════════════════════════════════════
#  BE-02: SEASONS, EVENTS, LEADERS, MEETINGS
# ═══════════════════════════════════════════════════════════

def _to_rich_text_body(v: Union[RichTextSchema, str]) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, RichTextSchema):
        return v.body
    if isinstance(v, dict):
        return v.get("body", "")
    return str(v)


def _to_season_out(s: Season) -> SeasonOut:
    return SeasonOut(
        season_id=s.season_id,
        title=s.title,
        sequence_number=s.sequence_number,
        previous_season_id=s.previous_season_id,
        type=s.type,
        starts_at=s.starts_at,
        ends_at=s.ends_at,
        state=s.state,
        is_current=s.is_current,
        revision=s.revision,
        capabilities=s.capabilities,
    )


def _to_event_out(ev: Event) -> EventOut:
    return EventOut(
        event_id=ev.event_id,
        season_id=ev.season_id,
        title=ev.title,
        description=RichTextSchema(format=ev.description.format, body=ev.description.body),
        leaders=[
            LeaderOut(
                role_assignment_id=l.role_assignment_id,
                user=UserRefOut(user_id=l.user.user_id, display_name=l.user.display_name, avatar_url=l.user.avatar_url),
                deputy_user_ids=l.deputy_user_ids,
                revision=l.revision,
                capabilities=l.capabilities,
            )
            for l in ev.leaders
        ],
        report_series_id=ev.report_series_id,
        starts_at=ev.starts_at,
        ends_at=ev.ends_at,
        revision=ev.revision,
        capabilities=ev.capabilities,
    )


def _to_subevent_out(sub: Subevent) -> SubeventOut:
    return SubeventOut(
        subevent_id=sub.subevent_id,
        event_id=sub.event_id,
        title=sub.title,
        description=RichTextSchema(format=sub.description.format, body=sub.description.body),
        leaders=[
            LeaderOut(
                role_assignment_id=l.role_assignment_id,
                user=UserRefOut(user_id=l.user.user_id, display_name=l.user.display_name, avatar_url=l.user.avatar_url),
                deputy_user_ids=l.deputy_user_ids,
                revision=l.revision,
                capabilities=l.capabilities,
            )
            for l in sub.leaders
        ],
        organizer_user_ids=sub.organizer_user_ids,
        report_series_id=sub.report_series_id,
        revision=sub.revision,
        capabilities=sub.capabilities,
    )


def _to_meeting_out(m: Meeting) -> MeetingOut:
    return MeetingOut(
        meeting_id=m.meeting_id,
        owner_kind=m.owner_kind,
        owner_id=m.owner_id,
        title=m.title,
        starts_at=m.starts_at,
        join_url=m.join_url,
        revision=m.revision,
        capabilities=m.capabilities,
    )


# ── Seasons ──

@router.get("/seasons", response_model=List[SeasonOut])
def list_seasons(cur: User = Depends(get_current_user)):
    return [_to_season_out(s) for s in db.get_seasons()]


@router.get("/seasons/current", response_model=SeasonOut)
def get_current_season(cur: User = Depends(get_current_user)):
    s = db.get_current_season()
    if not s:
        raise HTTPException(404, "No current season")
    return _to_season_out(s)


@router.get("/seasons/{season_id}", response_model=SeasonOut)
def get_season(season_id: str, cur: User = Depends(get_current_user)):
    s = db.get_season(season_id)
    if not s:
        raise HTTPException(404, "Season not found")
    return _to_season_out(s)


@router.post("/seasons", response_model=SeasonOut)
def create_season(payload: SeasonIn, cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can create seasons")
    try:
        s = db.create_season(payload.title, payload.type, payload.starts_at, payload.ends_at)
        return _to_season_out(s)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.patch("/seasons/{season_id}", response_model=SeasonOut)
def patch_season(season_id: str, payload: SeasonPatchIn, cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can modify seasons")
    try:
        s = db.patch_season(season_id, payload.expected_revision, payload.title, payload.starts_at, payload.ends_at, payload.reason)
        return _to_season_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "shorten season ends_at" in msg:
            raise HTTPException(422, msg)
        raise HTTPException(409, msg)


@router.post("/seasons/{season_id}/open", response_model=SeasonOut)
def open_season(season_id: str, payload: SeasonRevisionIn = Body(default=SeasonRevisionIn()), cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can open a season")
    try:
        s = db.open_season(season_id, payload.expected_revision)
        return _to_season_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/seasons/{season_id}/begin-summary", response_model=SeasonOut)
def begin_summary(season_id: str, payload: SeasonRevisionIn = Body(default=SeasonRevisionIn()), cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can begin summary on a season")
    try:
        s = db.begin_summary_season(season_id, payload.expected_revision)
        return _to_season_out(s)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/seasons/{season_id}/close")
def close_season(season_id: str, payload: SeasonRevisionIn = Body(default=SeasonRevisionIn()), cur: User = Depends(get_current_user)):
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "Only the chair can close a season")
    try:
        s = db.close_season(season_id, payload.expected_revision)
        return {"season": _to_season_out(s), "summary": {}}
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "previous_season_not_closed" in msg:
            target_s = db.get_season(season_id)
            prev_id = target_s.previous_season_id if target_s else ""
            raise HTTPException(
                status_code=409,
                detail={
                    "detail": "season_not_ready",
                    "fields": {
                        "blockers": [
                            {
                                "kind": "previous_season_not_closed",
                                "owner_kind": "season",
                                "owner_id": prev_id,
                                "title": "Previous season not closed",
                            }
                        ]
                    },
                },
            )
        raise HTTPException(409, msg)


# ── Report Series ──

@router.get("/report-series", response_model=List[ReportSeriesOut])
def list_report_series(cur: User = Depends(get_current_user)):
    return [
        ReportSeriesOut(
            series_id=r.series_id,
            owner_kind=r.owner_kind,
            title=r.title,
            parent_series_id=r.parent_series_id,
        )
        for r in db.list_report_series()
    ]


# ── Events ──

@router.get("/events", response_model=List[EventOut])
def list_events(season_id: Optional[str] = None, cur: User = Depends(get_current_user)):
    return [_to_event_out(ev) for ev in db.list_events(season_id=season_id)]


@router.post("/events", response_model=EventOut)
def create_event(payload: EventCreateIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can create events")
    try:
        ev = db.create_event(
            payload.season_id,
            payload.title,
            _to_rich_text_body(payload.description),
            payload.starts_at,
            payload.ends_at,
            payload.report_series_id,
        )
        return _to_event_out(ev)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.get("/events/{event_id}", response_model=EventOut)
def get_event(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    return _to_event_out(ev)


@router.patch("/events/{event_id}", response_model=EventOut)
def patch_event(event_id: str, payload: EventPatchIn, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        desc = _to_rich_text_body(payload.description) if payload.description is not None else None
        updated = db.patch_event(
            event_id,
            payload.expected_revision,
            payload.title,
            desc,
            payload.starts_at,
            payload.ends_at,
        )
        return _to_event_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/events/{event_id}/copy", response_model=EventCopyOut)
def copy_event(event_id: str, payload: EventCopyIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can copy events")
    try:
        new_ev, new_subs = db.copy_event_structure(
            event_id,
            payload.season_id,
            payload.title,
            payload.starts_at,
            payload.ends_at,
        )
        return EventCopyOut(
            event=_to_event_out(new_ev),
            subevents=[_to_subevent_out(s) for s in new_subs],
        )
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Subevents ──

@router.post("/events/{event_id}/subevents", response_model=SubeventOut)
def create_subevent(event_id: str, payload: SubeventCreateIn, cur: User = Depends(get_current_user)):
    can_create = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_create:
        raise HTTPException(403, "Only tachki or event leaders/deputies can create subevents")
    try:
        sub = db.create_subevent(
            event_id,
            payload.title,
            _to_rich_text_body(payload.description),
            payload.report_series_id,
        )
        return _to_subevent_out(sub)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.get("/events/{event_id}/subevents", response_model=List[SubeventOut])
def list_subevents(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    all_subs = db.list_subevents(event_id)
    if (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    ):
        return [_to_subevent_out(s) for s in all_subs]
    # Filter to only subevents user participates in
    filtered = []
    for s in all_subs:
        if (
            db.is_subevent_leader(cur.user_id, s.subevent_id)
            or db.is_subevent_leader_deputy(cur.user_id, s.subevent_id)
            or db.is_subevent_organizer(cur.user_id, s.subevent_id)
        ):
            filtered.append(_to_subevent_out(s))
    return filtered


@router.get("/subevents/{subevent_id}", response_model=SubeventOut)
def get_subevent(subevent_id: str, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_view = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
        or db.is_subevent_organizer(cur.user_id, subevent_id)
    )
    if not can_view:
        raise HTTPException(403, "Access to subevent forbidden")
    return _to_subevent_out(sub)


@router.patch("/subevents/{subevent_id}", response_model=SubeventOut)
def patch_subevent(subevent_id: str, payload: SubeventPatchIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        desc = _to_rich_text_body(payload.description) if payload.description is not None else None
        updated = db.patch_subevent(subevent_id, payload.expected_revision, payload.title, desc)
        return _to_subevent_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Leaders, Deputies, Organizers ──

@router.put("/events/{event_id}/leaders", response_model=EventOut)
def set_event_leaders(event_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can assign event leaders")
    try:
        ev = db.set_event_leaders(event_id, payload.user_ids, payload.expected_revision)
        return _to_event_out(ev)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/subevents/{subevent_id}/leaders", response_model=SubeventOut)
def set_subevent_leaders(subevent_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_assign = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
    )
    if not can_assign:
        raise HTTPException(403, "Only tachki or event leaders/deputies can assign subevent leaders")
    try:
        updated = db.set_subevent_leaders(subevent_id, payload.user_ids, payload.expected_revision)
        return _to_subevent_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/subevents/{subevent_id}/organizers", response_model=SubeventOut)
def set_subevent_organizers(subevent_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_assign = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
    )
    if not can_assign:
        raise HTTPException(403, "Only tachki or event leaders/deputies can assign subevent organizers")
    try:
        updated = db.set_subevent_organizers(subevent_id, payload.user_ids, payload.expected_revision)
        return _to_subevent_out(updated)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/blocks/{block_id}/leader", response_model=BlockOut)
def set_block_leader(block_id: str, payload: BlockLeaderIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can assign block master")
    try:
        b = db.set_block_leader(block_id, payload.user_id, payload.expected_revision)
        return BlockOut(**b.__dict__)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.put("/role-assignments/{role_assignment_id}/deputies", response_model=LeaderOut)
def set_deputies(role_assignment_id: str, payload: UserIdsIn, cur: User = Depends(get_current_user)):
    with db._session() as session:
        assignment = session.get(database_module.RoleAssignmentORM, role_assignment_id)
        if not assignment:
            raise HTTPException(404, "Role assignment not found")
        if assignment.scope_kind == "block":
            is_master = (assignment.user_id == cur.user_id)
            if not (db.is_tachki(cur.user_id) or is_master):
                raise HTTPException(403, "Only tachki or block master can assign block deputies")
        elif assignment.scope_kind == "event":
            if not db.is_tachki(cur.user_id):
                raise HTTPException(403, "Only tachki can assign event leader deputies")
        elif assignment.scope_kind == "subevent":
            sub = session.get(database_module.SubeventORM, assignment.scope_id)
            if not sub:
                raise HTTPException(404, "Subevent not found")
            can_assign = (
                db.is_tachki(cur.user_id)
                or db.is_event_leader(cur.user_id, sub.event_id)
                or db.is_event_leader_deputy(cur.user_id, sub.event_id)
            )
            if not can_assign:
                raise HTTPException(403, "Only tachki or parent event leaders/deputies can assign subevent leader deputies")
        else:
            if not db.is_tachki(cur.user_id):
                raise HTTPException(403, "Forbidden")
    try:
        leader = db.set_deputies(role_assignment_id, payload.user_ids, payload.expected_revision)
        return LeaderOut(
            role_assignment_id=leader.role_assignment_id,
            user=UserRefOut(
                user_id=leader.user.user_id,
                display_name=leader.user.display_name,
                avatar_url=leader.user.avatar_url,
            ),
            deputy_user_ids=leader.deputy_user_ids,
            revision=leader.revision,
            capabilities=leader.capabilities,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── Meetings (Созвоны) ──

@router.get("/events/{event_id}/meeting", response_model=MeetingOut)
def get_event_meeting(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_view = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_view:
        subs = db.list_subevents(event_id)
        for s in subs:
            if db.is_subevent_leader(cur.user_id, s.subevent_id) or db.is_subevent_leader_deputy(cur.user_id, s.subevent_id):
                can_view = True
                break
    if not can_view:
        raise HTTPException(403, "Forbidden")
    m = db.get_meeting("event", event_id)
    if not m:
        raise HTTPException(404, "No meeting scheduled")
    return _to_meeting_out(m)


@router.put("/events/{event_id}/meeting", response_model=MeetingOut)
def set_event_meeting(event_id: str, payload: MeetingIn, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        m = db.set_meeting("event", event_id, payload.title, payload.starts_at, payload.join_url, payload.expected_revision)
        return _to_meeting_out(m)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.delete("/events/{event_id}/meeting")
def delete_event_meeting(event_id: str, cur: User = Depends(get_current_user)):
    ev = db.get_event(event_id)
    if not ev:
        raise HTTPException(404, "Event not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, event_id)
        or db.is_event_leader_deputy(cur.user_id, event_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    db.delete_meeting("event", event_id)
    return {"status": "deleted"}


@router.get("/subevents/{subevent_id}/meeting", response_model=MeetingOut)
def get_subevent_meeting(subevent_id: str, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_view = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
        or db.is_subevent_organizer(cur.user_id, subevent_id)
    )
    if not can_view:
        raise HTTPException(403, "Forbidden")
    m = db.get_meeting("subevent", subevent_id)
    if not m:
        raise HTTPException(404, "No meeting scheduled")
    return _to_meeting_out(m)


@router.put("/subevents/{subevent_id}/meeting", response_model=MeetingOut)
def set_subevent_meeting(subevent_id: str, payload: MeetingIn, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    try:
        m = db.set_meeting("subevent", subevent_id, payload.title, payload.starts_at, payload.join_url, payload.expected_revision)
        return _to_meeting_out(m)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.delete("/subevents/{subevent_id}/meeting")
def delete_subevent_meeting(subevent_id: str, cur: User = Depends(get_current_user)):
    sub = db.get_subevent(subevent_id)
    if not sub:
        raise HTTPException(404, "Subevent not found")
    can_edit = (
        db.is_tachki(cur.user_id)
        or db.is_event_leader(cur.user_id, sub.event_id)
        or db.is_event_leader_deputy(cur.user_id, sub.event_id)
        or db.is_subevent_leader(cur.user_id, subevent_id)
        or db.is_subevent_leader_deputy(cur.user_id, subevent_id)
    )
    if not can_edit:
        raise HTTPException(403, "Forbidden")
    db.delete_meeting("subevent", subevent_id)
    return {"status": "deleted"}


# ── Season Correction ──

@router.post("/season-corrections", response_model=SeasonCorrectionOut)
def correct_season(payload: SeasonCorrectionIn, cur: User = Depends(get_current_user)):
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Only tachki can perform season corrections")
    try:
        res = db.correct_season(
            payload.object_kind,
            payload.object_id,
            payload.expected_revision,
            payload.target_season_id,
            payload.reason,
            cur.user_id,
        )
        return SeasonCorrectionOut(
            object_kind=res.object_kind,
            object_id=res.object_id,
            source_season_id=res.source_season_id,
            target_season_id=res.target_season_id,
            revision=res.revision,
        )
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        msg = str(e)
        if "differ" in msg or "deadline exceeds" in msg:
            raise HTTPException(422, msg)
        raise HTTPException(409, msg)


app.include_router(router)