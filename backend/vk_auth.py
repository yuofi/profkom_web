"""VK verification and explicit identity links; display names never authenticate."""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from fastapi import HTTPException
from database import db, ContactInfoORM, ExternalIdentityORM, UserORM
from errors import Conflict
from models import User, ContactInfo

# How the old site saved the link of an account it created on a VK login (6eb9dea main.py:493).
VK_LINK = re.compile(r"https?://(?:www\.|m\.)?vk\.(?:com|ru)/id(\d+)/?", re.IGNORECASE)


def vk_id_of_link(link):
    match = VK_LINK.fullmatch((link or "").strip())
    return match.group(1) if match else None

# The VK ID application of the site; must equal the frontend's VITE_APP_ID.
if os.getenv("APP_ENV") == "production" and not os.getenv("VK_CLIENT_ID", "").strip():
    raise RuntimeError("Production VK_CLIENT_ID must be explicitly configured")


def verified_identity(token: str) -> dict:
    """The VK user of a token issued to this site's VK ID application.

    VK ID checks that the token belongs to client_id. There is no second check: a
    token of another application must not log in (A-SEC-3, owner decision 7)."""
    client_id = os.getenv("VK_CLIENT_ID", "").strip()
    if not client_id:
        raise HTTPException(503, "VK login is not configured")
    try:
        data = urllib.parse.urlencode(
            {"client_id": client_id, "access_token": token}
        ).encode()
        request = urllib.request.Request("https://id.vk.ru/oauth2/user_info", data=data)
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise HTTPException(
            503 if error.code >= 500 else 401,
            "VK ID is unavailable" if error.code >= 500 else "Failed to verify VK token",
        ) from None
    except (OSError, TimeoutError):
        raise HTTPException(503, "VK ID is unavailable") from None
    except ValueError:
        raise HTTPException(401, "Failed to verify VK token") from None
    user = payload.get("user") if isinstance(payload, dict) and not payload.get("error") else None
    if not isinstance(user, dict):
        raise HTTPException(401, "Failed to verify VK token")
    subject = str(user.get("user_id") or user.get("id") or "").strip()
    if not subject.isdigit() or int(subject) <= 0:
        raise HTTPException(401, "Could not identify VK user")
    return {**user, "subject": "vk:" + subject, "vk_id": subject}


def unlinked_account(vk_id):
    """A current account that names this VK in its profile but has no VK identity yet."""
    with db._session() as s:
        rows = (
            s.query(ContactInfoORM.user_id, ContactInfoORM.vk)
            .join(UserORM, UserORM.user_id == ContactInfoORM.user_id)
            .outerjoin(ExternalIdentityORM, ExternalIdentityORM.user_id == UserORM.user_id)
            .filter(
                ExternalIdentityORM.subject.is_(None),
                UserORM.account_state.notin_(("archived", "purged")),
                ContactInfoORM.vk.like(f"%id{vk_id}%"),
            )
        )
        return any(vk_id_of_link(link) == vk_id for _, link in rows)


def login_user(identity: dict):
    """The account of a verified VK identity; a new pending one for an unknown identity."""
    user = db.get_external_user(identity["subject"])
    if user:
        if user.banned or user.account_state == "archived":
            raise HTTPException(403, "Account unavailable")
        return user
    # An account of the old site keeps the VK link its VK login saved, but no identity: the
    # operator links it by ID (MIGRATION_V13.md). A second account is not created, and a
    # profile link alone does not sign in (MIGRATION-08).
    if unlinked_account(identity["vk_id"]):
        raise Conflict("This VK is named by an existing account; it must be linked first", "vk_link_required")
    # A VK email/name is not proof of ownership of an existing local account.
    email = identity.get("email") or f"vk_{identity['vk_id']}@vk.com"
    if db.get_user_by_email(email):
        email = f"vk_{identity['vk_id']}@vk.com"
    if db.get_user_by_email(email):
        raise HTTPException(409, "Authenticate the existing account to link VK")
    phone = str(
        identity.get("phone")
        or identity.get("phone_number")
        or identity.get("mobile_phone")
        or ""
    ).strip()
    if phone and not phone.startswith("+"):
        phone = "+" + phone
    name = (identity.get("first_name") or "").strip() or "VK"
    surname = (identity.get("last_name") or "").strip() or "User"
    user = db.create_user_with_contact(
        ContactInfo(
            user_id=0,
            email=email,
            name=name,
            surname=surname,
            kkr_name=f"{name} {surname}",
            group_number="",  # the applicant fills it in before approval (A-ROL-20)
            phone=phone,
            vk=f"https://vk.com/id{identity['vk_id']}",
        ),
        User(user_id=0, hashed_password="", group_number="", account_state="pending"),
    )
    db.link_external_identity(user.user_id, identity["subject"])
    return user
