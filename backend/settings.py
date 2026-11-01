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
    # WAL by default (PB-31); DELETE is the rollback of DEPLOY.md.
    SQLITE_JOURNAL_MODE: Literal["WAL", "DELETE"] = "WAL"

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )
    
settings = Settings()
