"""
JWT access + refresh token helpers.
Works with the project's custom `db` singleton.
"""

from __future__ import annotations

import hashlib
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer

from database import db
from models import User

# ── Config (hardcoded defaults; override via env vars) ─────
SECRET_KEY       = os.getenv("JWT_SECRET_KEY", "CHANGE-ME-IN-PROD-super-secret-key-1234567890")
if os.getenv("APP_ENV") == "production" and (not os.getenv("JWT_SECRET_KEY") or len(SECRET_KEY) < 32 or SECRET_KEY.startswith("CHANGE-ME")):
    raise RuntimeError("Production JWT_SECRET_KEY must be explicitly configured (at least 32 characters)")
ALGORITHM        = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TTL_MIN   = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
REFRESH_TTL_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# tokenUrl is only used by the Swagger "Authorize" button
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


# ═══════════════════════════════════════════════════════════
# Password helpers
# ═══════════════════════════════════════════════════════════
def hash_password(plain: str) -> str:
    digest = hashlib.sha256(plain.encode("utf-8")).hexdigest()
    return pwd_ctx.hash(digest)


def verify_password(plain: str, hashed: str) -> bool:
    if not hashed or not plain:
        return False
    digest = hashlib.sha256(plain.encode("utf-8")).hexdigest()
    try:
        if pwd_ctx.verify(digest, hashed):
            return True
    except Exception:
        pass
    if len(plain.encode("utf-8")) <= 72:
        try:
            return pwd_ctx.verify(plain, hashed)
        except Exception:
            return False
    return False


# ═══════════════════════════════════════════════════════════
# Token creation
# ═══════════════════════════════════════════════════════════
def create_access_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub":  str(user_id),
        "type": "access",
        "sv": db.get_user(user_id).session_version if db.get_user(user_id) else 0,
        "iat":  now,
        "exp":  now + timedelta(minutes=ACCESS_TTL_MIN),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(user_id: int) -> str:
    """Generate a random UUID, store it in the DB, return the raw string."""
    token_value = str(uuid.uuid4())
    expires_at  = datetime.now(timezone.utc) + timedelta(days=REFRESH_TTL_DAYS)
    db.save_refresh_token(token_value, user_id, expires_at)
    return token_value


def create_token_pair(user_id: int) -> dict:
    return {
        "access_token":  create_access_token(user_id),
        "refresh_token": create_refresh_token(user_id),
        "token_type":    "bearer",
    }


# ═══════════════════════════════════════════════════════════
# Token verification / dependencies
# ═══════════════════════════════════════════════════════════
def _decode_access(token: str) -> dict:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(401, "Not an access token")
        sub = payload.get("sub")
        if sub is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Access token invalid or expired",
                headers={"WWW-Authenticate": "Bearer"},
            )
        try:
            int(sub)
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Access token invalid or expired",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return payload
    except HTTPException:
        raise
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Access token invalid or expired",
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    """
    FastAPI dependency: reads Authorization: Bearer <token>,
    validates it, returns the User object from your DB.
    """
    payload = _decode_access(token)
    user_id = int(payload["sub"])
    user = db.get_user(user_id)
    if not user:
        raise HTTPException(401, "User not found")
    if payload.get("sv", 0) != user.session_version:
        raise HTTPException(401, "Session revoked")
    if user.banned:
        raise HTTPException(403, "User is banned")
    if getattr(user, "account_state", "active") == "archived":
        raise HTTPException(403, "Account is archived")
    return user


# <img> and a plain link send no Authorization header: a file's bytes also accept the
# session cookie the frontend keeps the access token in (decision 23).
FILE_CONTENT = re.compile(r"/api/files/[^/]+/content")


def request_token(request: Request) -> Optional[str]:
    from fastapi.security.utils import get_authorization_scheme_param

    scheme, raw_token = get_authorization_scheme_param(request.headers.get("Authorization"))
    if scheme.lower() == "bearer":
        return raw_token
    if request.method in ("GET", "HEAD") and FILE_CONTENT.fullmatch(request.url.path):
        return request.cookies.get("access_token")
    return None


def get_file_reader(request: Request) -> User:
    token = request_token(request)
    if not token:
        raise HTTPException(401, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return get_current_user(token)


def get_current_user_optional(token: Optional[str] = Depends(oauth2_scheme_optional)) -> Optional[User]:
    """
    FastAPI dependency: reads optional Bearer token, returns User or None.
    Does not raise HTTPException if unauthenticated or token expired.
    """
    if not token:
        return None
    try:
        payload = _decode_access(token)
        user_id = int(payload["sub"])
        user = db.get_user(user_id)
        if not user or user.banned or getattr(user, "account_state", "active") == "archived":
            return None
        return user
    except Exception:
        return None


def require_admin(cur: User = Depends(get_current_user)) -> User:
    if not db.is_tachki(cur.user_id):
        raise HTTPException(403, "Admin rights required")
    return cur


def require_superuser(cur: User = Depends(get_current_user)) -> User:
    if not db.is_chair(cur.user_id):
        raise HTTPException(403, "SuperUser rights required")
    return cur


def require_pgas_admin(cur: User = Depends(get_current_user)) -> User:
    import access

    if not access.allowed(cur.user_id, "pgas.manage"):
        raise HTTPException(403, "PGAS admin rights required")
    return cur


# ═══════════════════════════════════════════════════════════
# Refresh & revoke
# ═══════════════════════════════════════════════════════════
# Another tab may have rotated this token a moment ago and set the new one (A-ROL-14).
REFRESH_USED = "Refresh token not found (revoked or already used)"


def refresh_tokens(refresh_token_value: str) -> dict:
    """Validate refresh token → delete it (rotation) → issue new pair."""
    rt = db.consume_refresh_token(refresh_token_value)
    if rt is None:
        raise HTTPException(401, REFRESH_USED)

    if rt["expires_at"] < datetime.now(timezone.utc):
        db.delete_refresh_token(refresh_token_value)
        raise HTTPException(401, "Refresh token expired")

    user_id = rt["user_id"]
    user = db.get_user(user_id)
    if not user:
        db.delete_refresh_token(refresh_token_value)
        raise HTTPException(401, "User not found")
    if user.banned:
        db.delete_refresh_token(refresh_token_value)
        raise HTTPException(403, "User is banned")
    if getattr(user, "account_state", "active") == "archived":
        db.delete_refresh_token(refresh_token_value)
        raise HTTPException(403, "Account is archived")

    return create_token_pair(user_id)


def revoke_refresh_token(token_value: str):
    db.delete_refresh_token(token_value)


def revoke_all_user_tokens(user_id: int):
    db.revoke_sessions(user_id)

PASSWORD_CHANGE_REQUIRED = "Password change required"


async def guard_working_access(request: Request):
    token=request_token(request)
    from access import actor_id
    path=request.url.path.removeprefix("/api")
    feedback_intake = path == "/feedback" and request.method == "POST"
    exempt=feedback_intake or path.startswith("/auth/") or path=="/session" or path in {"/registrations/me","/registrations/me/resubmit"}
    uid=None
    if not exempt:
        if token is None:
            raise HTTPException(401,"Not authenticated",headers={"WWW-Authenticate":"Bearer"})
        cur=get_current_user(token)
        if cur.account_state!="active":
            raise HTTPException(403,"Approved active account required")
        if cur.must_change_password:
            # Only the session, logout and the password change itself until then (АВ-52)
            raise HTTPException(403,PASSWORD_CHANGE_REQUIRED)
        uid=cur.user_id
    elif token and not path.startswith("/auth/") and not feedback_intake:
        uid=get_current_user(token).user_id
    marker=actor_id.set(uid)
    try:
        yield
    finally:
        actor_id.reset(marker)


# These wait on VK or on a password hash before they write. Holding the shared write lock
# meanwhile stopped every other writer (A-ROL-15): they open a short transaction after it.
OWN_TRANSACTION = {"/api/auth/login", "/api/auth/vk", "/api/auth/vk/link"}


async def unit_of_work(request: Request):
    if request.url.path in OWN_TRANSACTION:
        yield
        return
    async with db.async_atomic(write=request.method not in {"GET", "HEAD", "OPTIONS"}):
        yield
