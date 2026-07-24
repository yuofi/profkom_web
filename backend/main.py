from __future__ import annotations

from typing import List, Optional

from fastapi import FastAPI, HTTPException, Depends, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field

from database import db
from models import Block, ContactInfo, User, Guide
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
    get_current_user,      # replaces old get_current_user
    require_admin,         # replaces old require_admin
    require_superuser,     # replaces old require_superuser
)
from utils.s3_service import generate_presigned_url


app = FastAPI(
    title="Profcom backend",
    )

router = APIRouter(prefix="/api")
origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://localhost:80",
    "https://5x4kxnk4-5173.euw.devtunnels.ms"
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
    password: str                    # ← NEW: plain-text password from client
    group_number: int = Field(..., ge=1)
    tg: str = Field(
        ...,
        min_length=5,
        max_length=33,  # with optional leading "@"
        pattern=r"^@?[A-Za-z0-9_]{5,32}$",
    )
    # NOTE: other user fields are set server-side with defaults on registration


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
    has_password: bool = True


class GuideIn(BaseModel):
    title: str
    owner_block: str
    text: str
    original_link: Optional[str] = None


class GuideOut(GuideIn):
    guide_id: int


class BlockIn(BaseModel):
    name: str
    master: str
    hr: str = ""
    cnt_of_human: int = 0
    arr_of_human: list[int] = Field(default_factory=list)


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
    refresh_token: str


class LoginIn(BaseModel):
    email: EmailStr
    password: str

class ChangePasswordIn(BaseModel):
    old_password: Optional[str] = None
    new_password: str


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


class ContactFilter(BaseModel):
    group_number: Optional[str] = None
    blocks: Optional[str] = None
    in_profcom: Optional[bool] = None
    budget: Optional[bool] = None


class PresignedUrlRequest(BaseModel):
    folder: str
    content_type: str  # например, 'image/jpeg'

class UrlsResponse(BaseModel):
    upload_url: str
    public_url: str


# ═══════════════════════════════════════════════════════════
#  AUTH ENDPOINTS  (NEW)
# ═══════════════════════════════════════════════════════════

@router.post("/auth/register", response_model=TokenPair, status_code=201)
def register(payload: RegisterIn):
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
    return create_token_pair(created.user_id)


@router.post("/auth/login", response_model=TokenPair)
def login(body: LoginIn):
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

    return create_token_pair(user.user_id)


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
    return {"detail": "Password updated successfully"}


@router.post("/auth/vk", response_model=TokenPair)
def vk_login(payload: VKLoginIn):
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

    if payload.id_token:
        try:
            claims = jwt.get_unverified_claims(payload.id_token)
            email = claims.get("email")
            first_name = claims.get("first_name", first_name)
            last_name = claims.get("last_name", last_name)
        except Exception:
            pass

    try:
        url = "https://id.vk.ru/oauth2/user_info"
        data = urllib.parse.urlencode({
            "client_id": "54678274",
            "access_token": payload.access_token
        }).encode("utf-8")
        req = urllib.request.Request(url, data=data)
        logging.info(f"Requesting VK user info with access_token: {payload.access_token}")
        with urllib.request.urlopen(req) as response:
            vk_data = json.loads(response.read().decode())
            vk_user = vk_data.get("user")
            logging.info(f"VK user info response: {vk_user}")
            if "error" in vk_data:
                raise Exception("VK API error")
            
            vk_id = str(vk_user.get("user_id"))
            if not email:
                email = vk_user.get("email")
            if "first_name" in vk_user:
                first_name = vk_user["first_name"]
            if "last_name" in vk_user:
                last_name = vk_user["last_name"]
            if "avatar" in vk_user:
                avatar_url = vk_user["avatar"]
    except Exception:
        try:
            url2 = f"https://api.vk.com/method/users.get?v=5.131&access_token={payload.access_token}"
            req2 = urllib.request.Request(url2)
            with urllib.request.urlopen(req2) as response2:
                vk_data2 = json.loads(response2.read().decode())
                if "error" in vk_data2:
                    raise HTTPException(401, "Invalid VK token")
                vk_user = vk_data2["response"][0]
                vk_id = str(vk_user["id"])
                if "first_name" in vk_user:
                    first_name = vk_user["first_name"]
                if "last_name" in vk_user:
                    last_name = vk_user["last_name"]
                if "photo_max" in vk_user:
                    avatar_url = vk_user["photo_max"]
                elif "photo_200" in vk_user:
                    avatar_url = vk_user["photo_200"]
        except Exception as e:
            if isinstance(e, HTTPException):
                raise e
            raise HTTPException(401, "Failed to verify VK token")

    if not vk_id:
        raise HTTPException(401, "Could not identify VK user")
        
    user = None
    if email:
        logging.info(f"Looking up user by email: {email}") 
        user = db.get_user_by_email(email)
        
    kkr_name_to_check = f"{first_name} {last_name}".strip()
    
    if not user:
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
            phone="",
            vk=f"https://vk.com/id{vk_id}",
            tg="",
            email=email,
            budget=True,
            in_profcom=False,
        )
        s3_photo_url = None
        if avatar_url:
            pattern = r"cs=.*$"
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
        # Update existing user photo if missing
        if avatar_url and not user.photo_url:
            
            pattern = r"cs=.*$"
            avatar_url = re.sub(pattern, "cs=150x150", avatar_url)
            s3_photo_url = upload_image_from_url(avatar_url, folder="avatars")
            if s3_photo_url:
                db.update_user(user.user_id, photo_url=s3_photo_url)
        
    if user.banned:
        raise HTTPException(403, "User is banned")
        
    return create_token_pair(user.user_id)


@router.post("/auth/refresh", response_model=TokenPair)
def refresh(body: RefreshRequest):
    """
    Exchange a refresh token for a new access + refresh pair.
    Old refresh token is deleted (rotation).
    """
    return refresh_tokens(body.refresh_token)


@router.post("/auth/logout")
def logout(
    body: RefreshRequest,
    cur: User = Depends(get_current_user),    # must be authenticated
):
    """Revoke a single refresh token (one device)."""
    revoke_refresh_token(body.refresh_token)
    return {"detail": "Logged out"}


@router.post("/auth/logout-all")
def logout_all(cur: User = Depends(get_current_user)):
    """Revoke ALL refresh tokens for the current user."""
    revoke_all_user_tokens(cur.user_id)
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
        has_password=bool(cur.hashed_password)
    )


@router.get("/profile/{user_id}", response_model=ProfileOut)
def get_profile(user_id: int):
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
    cur: User = Depends(get_current_user),         # ← Bearer token now
):
    target = db.get_user(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if cur.user_id != user_id and not (cur.admin or cur.super_user):
        raise HTTPException(403, "Forbidden")

    contact = db.get_contact(user_id)
    new_surname = payload.surname if payload.surname is not None else (contact.surname if contact else "")
    new_name = payload.name if payload.name is not None else (contact.name if contact else "")
    new_patronymic = payload.patronymic if payload.patronymic is not None else (contact.patronymic if contact else "")
    
    new_kkr_name = " ".join(
        part.strip()
        for part in [new_name, new_surname]
        if part and part.strip()
    ).strip()

    if payload.kkr_name is not None:
        new_kkr_name = payload.kkr_name

    db.update_contact(
        user_id,
        surname=payload.surname, name=payload.name, patronymic=payload.patronymic,
        kkr_name=new_kkr_name,
        group_number=payload.group_number, location=payload.location,
        blocks=payload.blocks, phone=payload.phone,
        vk=payload.vk, tg=payload.tg,
        email=payload.email, budget=payload.budget,
        in_profcom=payload.in_profcom,
    )
    db.update_user(
        user_id, 
        group_number=payload.group_number, 
        blocks=payload.blocks, 
        photo_url=payload.photo_url
    )
    updated = db.get_user(user_id)
    updated_contact = db.get_contact(user_id)
    return UserOut(**updated.__dict__, kkr_name=updated_contact.kkr_name)


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
def list_guides():
    return [GuideOut(**g.__dict__) for g in db.list_guides()]


@router.post("/guides", response_model=GuideOut)
def create_guide(guide: GuideIn, cur: User = Depends(require_superuser)):
    g = Guide(guide_id=0, title=guide.title, owner_block=guide.owner_block,
              text=guide.text, original_link=guide.original_link)
    created = db.create_guide(g)
    return GuideOut(**created.__dict__)


@router.post("/guides/{guide_id}", response_model=GuideOut)
def edit_guide(
    guide_id: int,
    guide: GuideIn,
    cur: User = Depends(require_superuser),
):
    updated = db.update_guide(
        guide_id,
        title=guide.title,
        owner_block=guide.owner_block,
        text=guide.text,
        original_link=guide.original_link,
    )
    if not updated:
        raise HTTPException(404, "Guide not found")
    return GuideOut(**updated.__dict__)


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
    cur: User = Depends(require_admin),
):
    if not cur.super_user:
        block = db.get_block(block_name)
        if not block:
            raise HTTPException(404, "Block not found")
        contact = db.get_contact(cur.user_id)
        if not contact or (contact.kkr_name != block.master and contact.kkr_name != block.hr):
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
def get_all_contacts():
    return [ContactInfoOut(**c.__dict__) for c in db.list_contacts()]


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
    """
    if payload.folder == 'guides' and not cur.super_user:
        raise HTTPException(403, "Only superusers can upload to 'guides' folder")

    urls = generate_presigned_url(payload.folder, payload.content_type)
    return urls

app.include_router(router)