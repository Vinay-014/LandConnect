from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import (
    RedisSlidingWindowLimiter,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.models.domain import User
from app.schemas.dto import LoginRequest, PrivacyUpdateRequest, RefreshRequest, RegisterRequest
from app.services.privacy import to_privacy_safe_user

router = APIRouter(prefix="/auth", tags=["Authentication & Privacy"])


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    limiter = RedisSlidingWindowLimiter(request.app.state.redis)
    await limiter.enforce(f"rl:auth:register:{request.client.host if request.client else 'unknown'}", 15, 60)

    existing = await db.scalar(select(User).where(User.email == body.email.lower()))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    user = User(
        email=body.email.lower(),
        phone=body.phone,
        password_hash=hash_password(body.password),
        display_name=body.display_name,
        role=body.role,
        city=body.city,
        bio=body.bio,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    access_token = create_access_token(user.user_uuid, user.role.value)
    refresh_token, _ = create_refresh_token(user.user_uuid)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": to_privacy_safe_user(user, user.user_uuid),
    }


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    limiter = RedisSlidingWindowLimiter(request.app.state.redis)
    await limiter.enforce(f"rl:auth:login:{request.client.host if request.client else 'unknown'}", 30, 60)

    user = await db.scalar(select(User).where(User.email == body.email.lower()))
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    access_token = create_access_token(user.user_uuid, user.role.value)
    refresh_token, _ = create_refresh_token(user.user_uuid)
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": to_privacy_safe_user(user, user.user_uuid),
    }


@router.post("/refresh")
async def refresh(body: RefreshRequest, request: Request, db: AsyncSession = Depends(get_db)):
    claims = decode_token(body.refresh_token, expected_type="refresh")
    jti = claims["jti"]
    if await request.app.state.redis.get(f"revoked:refresh:{jti}"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token revoked")

    user = await db.get(User, claims["sub"])
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    await request.app.state.redis.set(f"revoked:refresh:{jti}", "1", ex=60 * 60 * 24 * 7)
    access_token = create_access_token(user.user_uuid, user.role.value)
    next_refresh, _ = create_refresh_token(user.user_uuid)
    return {"access_token": access_token, "refresh_token": next_refresh, "token_type": "bearer"}


@router.post("/logout")
async def logout(body: RefreshRequest, request: Request):
    try:
        claims = decode_token(body.refresh_token, expected_type="refresh")
        jti = claims.get("jti")
        if jti:
            await request.app.state.redis.set(f"revoked:refresh:{jti}", "1", ex=60 * 60 * 24 * 7)
    except HTTPException:
        pass
    return {"status": "logged_out"}


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return to_privacy_safe_user(user, user.user_uuid)


@router.patch("/privacy")
async def update_privacy(
    body: PrivacyUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):

    if body.allow_calls is not None:
        user.allow_calls = body.allow_calls
    if body.show_contact_after_consent is not None:
        user.show_contact_after_consent = body.show_contact_after_consent
    consented = list(user.consented_peer_uuids or [])
    if body.consent_peer_uuid and body.consent_peer_uuid not in consented:
        consented.append(body.consent_peer_uuid)
    if body.revoke_peer_uuid and body.revoke_peer_uuid in consented:
        consented.remove(body.revoke_peer_uuid)
    user.consented_peer_uuids = consented

    await db.commit()
    await db.refresh(user)
    return to_privacy_safe_user(user, user.user_uuid)
