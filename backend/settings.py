import pathlib
from typing import Literal
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

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )
    
settings = Settings()
