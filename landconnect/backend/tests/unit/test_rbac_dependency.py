from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
import httpx
from jose import jwt

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import (
    RoleChecker,
    create_access_token,
    create_refresh_token,
    get_current_claims,
    get_current_user,
    require_user_roles,
)
from app.main import app as main_app
from app.models.domain import User, UserRole

pytestmark = pytest.mark.unit
settings = get_settings()


def _make_test_rbac_app(mock_db_session) -> FastAPI:
    """Build an isolated FastAPI app exercising get_current_user and RoleChecker DI."""
    probe_app = FastAPI()

    async def override_db():
        yield mock_db_session

    probe_app.dependency_overrides[get_db] = override_db

    @probe_app.get("/rbac/any")
    async def any_authenticated(user: User = Depends(get_current_user)):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe_app.get("/rbac/buyer-only")
    async def buyer_only(user: User = Depends(require_user_roles(UserRole.BUYER))):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe_app.get("/rbac/seller-only")
    async def seller_only(user: User = Depends(RoleChecker(UserRole.SELLER))):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe_app.get("/rbac/broker-only")
    async def broker_only(user: User = Depends(require_user_roles(UserRole.BROKER))):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe_app.get("/rbac/seller-or-broker")
    async def seller_or_broker(
        user: User = Depends(require_user_roles(UserRole.SELLER, UserRole.BROKER)),
    ):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    return probe_app


async def test_get_current_user_resolves_valid_roles(user_directory, mock_db_session):
    for user in user_directory.values():
        token = create_access_token(user.user_uuid, user.role.value)
        claims = await get_current_claims(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        )
        resolved = await get_current_user(claims=claims, db=mock_db_session)
        assert resolved.user_uuid == user.user_uuid
        assert resolved.role == user.role


async def test_get_current_user_rejects_missing_and_invalid_tokens(mock_db_session):
    with pytest.raises(HTTPException) as missing_exc:
        await get_current_claims(credentials=None)
    assert missing_exc.value.status_code == 401

    with pytest.raises(HTTPException) as malformed_exc:
        await get_current_claims(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials="not-a-valid-jwt")
        )
    assert malformed_exc.value.status_code == 401

    refresh_token, _ = create_refresh_token("usr_buyer_aarav_01")
    with pytest.raises(HTTPException) as wrong_type_exc:
        await get_current_claims(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials=refresh_token)
        )
    assert wrong_type_exc.value.status_code == 401


async def test_get_current_user_rejects_expired_token():
    expired_payload = {
        "sub": "usr_buyer_aarav_01",
        "role": UserRole.BUYER.value,
        "type": "access",
        "exp": int((datetime.now(timezone.utc) - timedelta(minutes=5)).timestamp()),
    }
    expired_jwt = jwt.encode(
        expired_payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM
    )
    with pytest.raises(HTTPException) as exc:
        await get_current_claims(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials=expired_jwt)
        )
    assert exc.value.status_code == 401


async def test_get_current_user_rejects_deleted_user_and_role_mismatch(
    user_directory, mock_db_session
):
    ghost_claims = {"sub": "usr_nonexistent_99", "role": UserRole.BUYER.value, "type": "access"}
    with pytest.raises(HTTPException) as ghost_exc:
        await get_current_user(claims=ghost_claims, db=mock_db_session)
    assert ghost_exc.value.status_code == 401

    buyer = user_directory["usr_buyer_aarav_01"]
    tampered_claims = {"sub": buyer.user_uuid, "role": UserRole.BROKER.value, "type": "access"}
    with pytest.raises(HTTPException) as mismatch_exc:
        await get_current_user(claims=tampered_claims, db=mock_db_session)
    assert mismatch_exc.value.status_code == 401
    assert "does not match" in mismatch_exc.value.detail


@pytest.mark.parametrize(
    ("actor_uuid", "endpoint", "expected_status"),
    [
        # Buyer access matrix
        ("usr_buyer_aarav_01", "/rbac/any", 200),
        ("usr_buyer_aarav_01", "/rbac/buyer-only", 200),
        ("usr_buyer_aarav_01", "/rbac/seller-only", 403),
        ("usr_buyer_aarav_01", "/rbac/broker-only", 403),
        ("usr_buyer_aarav_01", "/rbac/seller-or-broker", 403),
        # Seller access matrix
        ("usr_seller_priya_02", "/rbac/any", 200),
        ("usr_seller_priya_02", "/rbac/buyer-only", 403),
        ("usr_seller_priya_02", "/rbac/seller-only", 200),
        ("usr_seller_priya_02", "/rbac/broker-only", 403),
        ("usr_seller_priya_02", "/rbac/seller-or-broker", 200),
        # Broker access matrix
        ("usr_broker_rahul_03", "/rbac/any", 200),
        ("usr_broker_rahul_03", "/rbac/buyer-only", 403),
        ("usr_broker_rahul_03", "/rbac/seller-only", 403),
        ("usr_broker_rahul_03", "/rbac/broker-only", 200),
        ("usr_broker_rahul_03", "/rbac/seller-or-broker", 200),
    ],
)
async def test_fastapi_di_enforces_role_constraints(
    actor_uuid: str,
    endpoint: str,
    expected_status: int,
    user_directory,
    mock_db_session,
    token_factory,
):
    probe_app = _make_test_rbac_app(mock_db_session)
    actor = user_directory[actor_uuid]
    token = token_factory(actor)

    transport = httpx.ASGITransport(app=probe_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(endpoint, headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == expected_status
    if expected_status == 200:
        assert response.json()["user_uuid"] == actor.user_uuid
        assert response.json()["role"] == actor.role.value


async def test_fastapi_dependency_override_switches_active_user(user_directory, mock_db_session):
    """Verify FastAPI dependency_overrides on get_current_user cleanly enforces RBAC."""
    probe_app = _make_test_rbac_app(mock_db_session)
    buyer = user_directory["usr_buyer_aarav_01"]
    broker = user_directory["usr_broker_rahul_03"]

    probe_app.dependency_overrides[get_current_user] = lambda: buyer
    transport = httpx.ASGITransport(app=probe_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        denied = await client.get("/rbac/broker-only")
        assert denied.status_code == 403

        probe_app.dependency_overrides[get_current_user] = lambda: broker
        allowed = await client.get("/rbac/broker-only")
        assert allowed.status_code == 200
        assert allowed.json()["role"] == UserRole.BROKER.value

    probe_app.dependency_overrides.clear()


async def test_production_auth_me_uses_get_current_user_di(
    async_client: httpx.AsyncClient,
    user_directory,
    token_factory,
):
    unauth = await async_client.get("/api/v1/auth/me")
    assert unauth.status_code == 401

    buyer = user_directory["usr_buyer_aarav_01"]
    buyer_res = await async_client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token_factory(buyer)}"},
    )
    assert buyer_res.status_code == 200
    assert buyer_res.json()["user_uuid"] == buyer.user_uuid
    assert buyer_res.json()["role"] == UserRole.BUYER.value

    # Verify main app overrides cleanly as well
    main_app.dependency_overrides[get_current_user] = lambda: user_directory["usr_broker_rahul_03"]
    override_res = await async_client.get("/api/v1/auth/me")
    assert override_res.status_code == 200
    assert override_res.json()["role"] == UserRole.BROKER.value
    main_app.dependency_overrides.pop(get_current_user, None)
