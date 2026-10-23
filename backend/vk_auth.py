"""VK verification and explicit identity links; display names never authenticate."""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from fastapi import HTTPException
from database import db
from models import User, ContactInfo

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


def login_user(token: str):
    identity = verified_identity(token)
    user = db.get_external_user(identity["subject"])
    if user:
        if user.banned or user.account_state == "archived":
            raise HTTPException(403, "Account unavailable")
        return user
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
            group_number="0",
            phone=phone,
            vk=f"https://vk.com/id{identity['vk_id']}",
        ),
        User(user_id=0, hashed_password="", group_number="0", account_state="pending"),
    )
    db.link_external_identity(user.user_id, identity["subject"])
    return user
