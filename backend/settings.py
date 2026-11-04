import pathlib
import re
from typing import Literal
from pydantic import field_validator
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

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )
    
settings = Settings()
