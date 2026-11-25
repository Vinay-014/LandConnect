from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "LandConnect API"
    API_V1_PREFIX: str = "/api/v1"
    ENVIRONMENT: str = "development"
    CORS_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8081",
        "http://127.0.0.1:8081",
    ]

    DATABASE_URL: str = "postgresql+asyncpg://landconnect:landconnect@postgres:5432/landconnect"
    REDIS_URL: str = "redis://redis:6379/0"

    JWT_SECRET_KEY: str = "change-me-in-production-use-64-byte-secret"
    CALL_TOKEN_SECRET: str = "change-me-call-room-secret"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    WEBRTC_PROVIDER: str = "p2p"  # "p2p" | "livekit" | "daily"
    LIVEKIT_API_KEY: str = ""
    LIVEKIT_API_SECRET: str = ""
    LIVEKIT_URL: str = "ws://localhost:7880"
    STUN_SERVER_URL: str = "stun:stun.l.google.com:19302"
    TURN_SERVER_URL: str = ""
    TURN_USERNAME: str = ""
    TURN_CREDENTIAL: str = ""

    CALL_RINGING_TTL_SECONDS: int = 30
    UPLOAD_DIR: str = "/app/uploads"


@lru_cache
def get_settings() -> Settings:
    return Settings()
