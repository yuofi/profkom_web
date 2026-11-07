import os
import pathlib
import re
from datetime import datetime
from typing import Literal
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    
    S3_ENDPOINT: str = ""
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_BUCKET_NAME: str = ""
    S3_TENANT_ID: str = ""
    S3_REGION_NAME: str = ""
    ADMIN_NAME: str = ""
    ADMIN_PASSWORD: str = ""
    DATABASE_PATH: str = ""
    # WAL only where backend/.env names it (PB-31): on a server a separately approved step of
    # DEPLOY.md, section 7. Otherwise the rollback journal.
    SQLITE_JOURNAL_MODE: Literal["WAL", "DELETE"] = "DELETE"
    # SHA-256 (lowercase hex) of the HereBot service token, or two comma-separated values while
    # the token is rotated. Empty: /api/bot/v1 answers 404 bot_api_disabled (backend/docs/BOT_API.md).
    BOT_API_TOKEN_SHA256: str = ""

    @field_validator("BOT_API_TOKEN_SHA256")
    @classmethod
    def _bot_token_hashes(cls, value):
        hashes = [part.strip() for part in value.split(",")] if value.strip() else []
        if len(hashes) > 2 or not all(re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes):
            raise ValueError("BOT_API_TOKEN_SHA256: one or two comma-separated lowercase hex SHA-256 values")
        return ",".join(hashes)

    # Stage 2, the VK link (BOT_API.md). The bot's dialog, https://vk.me/<short name> or
    # https://vk.me/club<id> without a query; empty: the site shows only the bot command.
    BOT_VK_URL: str = ""
    # From this moment an active account without a working link is closed until it links
    # (ISO 8601 with an offset). Empty: active accounts see only the banner.
    BOT_LINK_DEADLINE: datetime | None = None

    @field_validator("BOT_VK_URL")
    @classmethod
    def _bot_vk_url(cls, value):
        value = value.strip()
        if value and not re.fullmatch(r"https://vk\.me/(?:club\d+|[A-Za-z0-9_.]{2,64})", value):
            raise ValueError("BOT_VK_URL: https://vk.me/<short name> or https://vk.me/club<id>, without a query")
        return value

    @field_validator("BOT_LINK_DEADLINE", mode="before")
    @classmethod
    def _bot_link_deadline(cls, value):
        if isinstance(value, str):
            if not value.strip():
                return None
            try:
                value = datetime.fromisoformat(value.strip())
            except ValueError:
                raise ValueError("BOT_LINK_DEADLINE: ISO 8601 with an offset, e.g. 2026-12-01T00:00:00+03:00") from None
        if isinstance(value, datetime) and value.utcoffset() is None:
            raise ValueError("BOT_LINK_DEADLINE needs an offset, e.g. 2026-12-01T00:00:00+03:00")
        if value is not None and not isinstance(value, datetime):
            raise ValueError("BOT_LINK_DEADLINE: ISO 8601 with an offset")
        return value

    # Stage 3: the site's address for people in the links of VK notifications, without a
    # trailing slash. Empty: FRONTEND_URL. With the integration on, https only in production.
    PUBLIC_SITE_URL: str = ""

    @field_validator("PUBLIC_SITE_URL")
    @classmethod
    def _public_site_url(cls, value):
        value = value.strip().rstrip("/")
        if value and not re.fullmatch(r"https?://[^\s/?#]+(?:/[^\s?#]*)?", value):
            raise ValueError("PUBLIC_SITE_URL: http(s)://host[/path], without a query")
        return value

    @model_validator(mode="after")
    def _public_site_url_in_production(self):
        if os.getenv("APP_ENV") == "production" and self.BOT_API_TOKEN_SHA256 and not self.public_site_url().startswith("https://"):
            raise ValueError("PUBLIC_SITE_URL (or FRONTEND_URL) must be https:// in production with the bot integration on")
        return self

    def public_site_url(self):
        """PUBLIC_SITE_URL, else FRONTEND_URL as main.py reads it; no trailing slash."""
        return (self.PUBLIC_SITE_URL or os.getenv("FRONTEND_URL", "http://localhost:5173").strip()).rstrip("/")

    # The service (root) account for debugging (owner, 2026-11-08; backend/docs/SERVICE_ACCOUNT.md):
    # its login and the bcrypt hash of its password (scripts/service_password_hash.py). Off while
    # either is empty; a change takes effect after a restart.
    ROOT_LOGIN: str = ""
    ROOT_PASSWORD_HASH: str = ""

    @field_validator("ROOT_LOGIN")
    @classmethod
    def _root_login(cls, value):
        if value and not re.fullmatch(r"[^\s@]{1,64}", value):
            raise ValueError("ROOT_LOGIN: 1-64 characters without spaces or @")
        return value

    @field_validator("ROOT_PASSWORD_HASH")
    @classmethod
    def _root_password_hash(cls, value):
        value = value.strip()
        if value and not re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", value):
            # The value itself is never repeated in the message.
            raise ValueError("ROOT_PASSWORD_HASH: the bcrypt hash printed by scripts/service_password_hash.py")
        return value

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        # A refused value (a token hash, a password hash) never reaches the startup error.
        hide_input_in_errors=True,
    )
    
settings = Settings()
