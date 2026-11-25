import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
import redis.asyncio as aioredis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.models.domain import User, UserRole

settings = get_settings()
pwd_context = CryptContext(schemes=["argon2", "bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(user_uuid: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_uuid,
        "role": role,
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(user_uuid: str) -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    jti = str(uuid.uuid4())
    payload = {
        "sub": user_uuid,
        "jti": jti,
        "type": "refresh",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)).timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM), jti


def decode_token(token: str, expected_type: str = "access") -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired or invalid",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    if payload.get("type") != expected_type:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


def create_ephemeral_call_token(call_id: str, room_name: str, user_uuid: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "call_id": call_id,
        "room": room_name,
        "sub": user_uuid,
        "role": role,
        "exp": int((now + timedelta(minutes=5)).timestamp()),
    }
    return jwt.encode(payload, settings.CALL_TOKEN_SECRET, algorithm=settings.JWT_ALGORITHM)


async def get_current_claims(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict[str, Any]:
    if not credentials or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return decode_token(credentials.credentials, expected_type="access")


async def get_current_user(
    claims: dict[str, Any] = Depends(get_current_claims),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Resolve authenticated User ORM entity from JWT claims and verify role integrity."""
    user_uuid = claims.get("sub")
    if not isinstance(user_uuid, str) or not user_uuid.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token subject missing",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = await db.get(User, user_uuid)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authenticated user no longer exists",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_role = claims.get("role")
    db_role = user.role.value if isinstance(user.role, UserRole) else str(user.role)
    if token_role != db_role:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token role does not match persisted account role",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


class RoleChecker:
    """Callable FastAPI dependency enforcing allowed UserRole constraints on get_current_user."""

    def __init__(self, *allowed_roles: UserRole | str) -> None:
        self.allowed_roles: tuple[str, ...] = tuple(
            r.value if isinstance(r, UserRole) else str(r) for r in allowed_roles
        )

    async def __call__(self, current_user: User = Depends(get_current_user)) -> User:
        user_role = (
            current_user.role.value
            if isinstance(current_user.role, UserRole)
            else str(current_user.role)
        )
        if user_role not in self.allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Role {user_role} is forbidden. "
                    f"Required: {', '.join(self.allowed_roles)}"
                ),
            )
        return current_user


def require_user_roles(*allowed_roles: UserRole | str) -> RoleChecker:
    return RoleChecker(*allowed_roles)


def require_roles(*allowed_roles: str):
    async def _guard(claims: dict[str, Any] = Depends(get_current_claims)) -> dict[str, Any]:
        if claims.get("role") not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role {claims.get('role')} is forbidden. Required: {', '.join(allowed_roles)}",
            )
        return claims

    return _guard


class RedisSlidingWindowLimiter:
    """Atomic Redis ZSET sliding-window rate limiter protecting auth and call initiation."""

    def __init__(self, redis_client: aioredis.Redis) -> None:
        self.redis = redis_client

    async def enforce(self, key: str, max_requests: int, window_seconds: int) -> int:
        now_ms = int(time.time() * 1000)
        cutoff_ms = now_ms - (window_seconds * 1000)
        member = f"{now_ms}:{uuid.uuid4().hex[:8]}"

        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.zremrangebyscore(key, 0, cutoff_ms)
            pipe.zcard(key)
            pipe.zadd(key, {member: now_ms})
            pipe.expire(key, window_seconds + 1)
            _, current_count, _, _ = await pipe.execute()

        if int(current_count) >= max_requests:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded",
                headers={"Retry-After": str(window_seconds)},
            )
        return max(0, max_requests - int(current_count) - 1)


async def check_idempotency(
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> str | None:
    if not idempotency_key:
        return None
    redis_client: aioredis.Redis = request.app.state.redis
    cache_key = f"idemp:{request.method}:{request.url.path}:{idempotency_key}"
    cached = await redis_client.get(cache_key)
    if cached:
        request.state.idempotent_cached_body = cached
    return cache_key
