"""
JWT access + refresh token helpers.
Works with the project's custom `db` singleton.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from database import db
from models import User

# ── Config (hardcoded defaults; override via env vars) ─────
SECRET_KEY       = os.getenv("JWT_SECRET_KEY", "CHANGE-ME-IN-PROD-super-secret-key-1234567890")
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
    return pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


# ═══════════════════════════════════════════════════════════
# Token creation
# ═══════════════════════════════════════════════════════════
def create_access_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub":  str(user_id),
        "type": "access",
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
        return payload
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
    if user.banned:
        raise HTTPException(403, "User is banned")
    return user


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
        if not user or user.banned:
            return None
        return user
    except Exception:
        return None


def require_admin(cur: User = Depends(get_current_user)) -> User:
    if not cur.admin and not cur.super_user:
        raise HTTPException(403, "Admin rights required")
    return cur


def require_superuser(cur: User = Depends(get_current_user)) -> User:
    if not cur.super_user:
        raise HTTPException(403, "SuperUser rights required")
    return cur


# ═══════════════════════════════════════════════════════════
# Refresh & revoke
# ═══════════════════════════════════════════════════════════
def refresh_tokens(refresh_token_value: str) -> dict:
    """Validate refresh token → delete it (rotation) → issue new pair."""
    rt = db.get_refresh_token(refresh_token_value)
    if rt is None:
        raise HTTPException(401, "Refresh token not found (revoked or already used)")

    if rt["expires_at"] < datetime.now(timezone.utc):
        db.delete_refresh_token(refresh_token_value)
        raise HTTPException(401, "Refresh token expired")

    user_id = rt["user_id"]
    db.delete_refresh_token(refresh_token_value)   # rotation
    return create_token_pair(user_id)


def revoke_refresh_token(token_value: str):
    db.delete_refresh_token(token_value)


def revoke_all_user_tokens(user_id: int):
    db.delete_all_refresh_tokens(user_id)