import pathlib
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    
    S3_ENDPOINT: str = ""
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_BUCKET_NAME: str = ""
    S3_TENANT_ID: str = ""
    ADMIN_NAME: str = ""
    ADMIN_PASSWORD: str = ""
    DATABASE_PATH: str = ""

    model_config = SettingsConfigDict(
        env_file=".env"
    )
    
settings = Settings()
