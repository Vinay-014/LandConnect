from datetime import datetime, timedelta, timezone

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt
import pytest

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
from app.models.domain import LandType, User, UserRole

pytestmark = pytest.mark.unit
settings = get_settings()


def _build_rbac_probe_app(mock_db_session) -> FastAPI:
    """Isolated FastAPI app wiring get_current_user and RoleChecker dependencies."""
    probe = FastAPI()

    async def override_db():
        yield mock_db_session

    probe.dependency_overrides[get_db] = override_db

    @probe.get("/probe/authenticated")
    async def read_authenticated(user: User = Depends(get_current_user)):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe.get("/probe/buyer")
    async def buyer_only(user: User = Depends(require_user_roles(UserRole.BUYER))):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe.get("/probe/seller")
    async def seller_only(user: User = Depends(RoleChecker(UserRole.SELLER))):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe.get("/probe/broker")
    async def broker_only(user: User = Depends(require_user_roles(UserRole.BROKER))):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    @probe.get("/probe/seller-or-broker")
    async def seller_or_broker(
        user: User = Depends(require_user_roles(UserRole.SELLER, UserRole.BROKER)),
    ):
        return {"user_uuid": user.user_uuid, "role": user.role.value}

    return probe


async def test_get_current_user_resolves_buyer_seller_broker(
    buyer_user: User,
    seller_user: User,
    broker_user: User,
    mock_db_session,
    token_factory,
):
    for expected_user in (buyer_user, seller_user, broker_user):
        credentials = HTTPAuthorizationCredentials(
            scheme="Bearer",
            credentials=token_factory(expected_user),
        )
        claims = await get_current_claims(credentials=credentials)
        resolved = await get_current_user(claims=claims, db=mock_db_session)
        assert resolved.user_uuid == expected_user.user_uuid
        assert resolved.role == expected_user.role
        mock_db_session.get.assert_awaited_with(User, expected_user.user_uuid)


async def test_get_current_user_rejects_invalid_and_tampered_tokens(
    buyer_user: User,
    mock_db_session,
):
    # Missing Bearer header
    with pytest.raises(HTTPException) as exc_missing:
        await get_current_claims(credentials=None)
    assert exc_missing.value.status_code == 401

    # Expired access token
    expired_token = jwt.encode(
        {
            "sub": buyer_user.user_uuid,
            "role": UserRole.BUYER.value,
            "type": "access",
            "exp": int((datetime.now(timezone.utc) - timedelta(minutes=10)).timestamp()),
        },
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )
    with pytest.raises(HTTPException) as exc_expired:
        await get_current_claims(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials=expired_token)
        )
    assert exc_expired.value.status_code == 401

    # Wrong token type (refresh token used as access token)
    refresh_jwt, _ = create_refresh_token(buyer_user.user_uuid)
    with pytest.raises(HTTPException) as exc_type:
        await get_current_claims(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials=refresh_jwt)
        )
    assert exc_type.value.status_code == 401

    # Unknown user in mock DB
    with pytest.raises(HTTPException) as exc_ghost:
        await get_current_user(
            claims={"sub": "usr_ghost_404", "role": UserRole.BUYER.value, "type": "access"},
            db=mock_db_session,
        )
    assert exc_ghost.value.status_code == 401

    # Role claim disagrees with persisted DB role
    with pytest.raises(HTTPException) as exc_mismatch:
        await get_current_user(
            claims={
                "sub": buyer_user.user_uuid,
                "role": UserRole.BROKER.value,
                "type": "access",
            },
            db=mock_db_session,
        )
    assert exc_mismatch.value.status_code == 401
    assert "does not match" in exc_mismatch.value.detail


@pytest.mark.parametrize(
    ("role_key", "path", "expected_status"),
    [
        ("buyer_user", "/probe/authenticated", 200),
        ("buyer_user", "/probe/buyer", 200),
        ("buyer_user", "/probe/seller", 403),
        ("buyer_user", "/probe/broker", 403),
        ("buyer_user", "/probe/seller-or-broker", 403),
        ("seller_user", "/probe/authenticated", 200),
        ("seller_user", "/probe/buyer", 403),
        ("seller_user", "/probe/seller", 200),
        ("seller_user", "/probe/broker", 403),
        ("seller_user", "/probe/seller-or-broker", 200),
        ("broker_user", "/probe/authenticated", 200),
        ("broker_user", "/probe/buyer", 403),
        ("broker_user", "/probe/seller", 403),
        ("broker_user", "/probe/broker", 200),
        ("broker_user", "/probe/seller-or-broker", 200),
    ],
)
async def test_role_constraints_via_get_current_user_di(
    role_key: str,
    path: str,
    expected_status: int,
    request: pytest.FixtureRequest,
    mock_db_session,
    auth_headers_for,
):
    actor: User = request.getfixturevalue(role_key)
    probe = _build_rbac_probe_app(mock_db_session)
    transport = httpx.ASGITransport(app=probe)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(path, headers=auth_headers_for(actor))

    assert response.status_code == expected_status
    if expected_status == 200:
        assert response.json() == {"user_uuid": actor.user_uuid, "role": actor.role.value}


async def test_listing_crud_and_meeting_room_rbac_via_get_current_user(
    async_client: httpx.AsyncClient,
    buyer_user: User,
    seller_user: User,
    other_seller_user: User,
    broker_user: User,
    auth_headers_for,
):
    # BUYER can browse listings but cannot create/edit/delete parcels
    read_res = await async_client.get("/api/v1/listings", headers=auth_headers_for(buyer_user))
    assert read_res.status_code == 200

    listing_payload = {
        "title": "Hennur Main Road Plot",
        "description": "Clear title residential plot near Hennur ORR.",
        "price_inr": 38000000,
        "area_sqft": 4800,
        "land_type": LandType.RESIDENTIAL.value,
        "zoning_status": "BMRDA Approved",
        "locality": "Hennur",
        "city": "Bengaluru",
        "latitude": 13.0358,
        "longitude": 77.6431,
        "images": [],
    }
    buyer_create = await async_client.post(
        "/api/v1/listings",
        json=listing_payload,
        headers=auth_headers_for(buyer_user),
    )
    assert buyer_create.status_code == 403

    # SELLER can create & edit own listing, but cannot edit another seller's listing
    seller_create = await async_client.post(
        "/api/v1/listings",
        json=listing_payload,
        headers=auth_headers_for(seller_user),
    )
    assert seller_create.status_code == 201

    other_edit = await async_client.patch(
        "/api/v1/listings/lst_other_seller_02",
        json={"price_inr": 69000000, "version": 1},
        headers=auth_headers_for(seller_user),
    )
    assert other_edit.status_code == 403

    # BROKER can edit seller listings and create Broker Deal Rooms
    broker_edit = await async_client.patch(
        "/api/v1/listings/lst_other_seller_02",
        json={"price_inr": 69000000, "version": 1},
        headers=auth_headers_for(broker_user),
    )
    assert broker_edit.status_code == 200

    # SELLER cannot create a Broker Deal Room (403); BROKER succeeds (201)
    room_payload = {
        "listing_id": "lst_seller_owned_01",
        "title": "Devanahalli Buyer-Seller Room",
        "participant_uuids": [buyer_user.user_uuid, seller_user.user_uuid],
    }
    seller_room = await async_client.post(
        "/api/v1/chats/meeting-room",
        json=room_payload,
        headers=auth_headers_for(seller_user),
    )
    assert seller_room.status_code == 403

    # Also verify get_current_user dependency_override swaps active identity cleanly
    main_app.dependency_overrides[get_current_user] = lambda: other_seller_user
    me_res = await async_client.get("/api/v1/auth/me")
    assert me_res.status_code == 200
    assert me_res.json()["user_uuid"] == other_seller_user.user_uuid
    main_app.dependency_overrides.pop(get_current_user, None)

    # Broker-only verification check
    seller_verify = await async_client.patch(
        "/api/v1/listings/lst_seller_owned_01/verify",
        json={"verification_status": "RERA_APPROVED"},
        headers=auth_headers_for(seller_user),
    )
    assert seller_verify.status_code == 403

    broker_verify = await async_client.patch(
        "/api/v1/listings/lst_seller_owned_01/verify",
        json={"verification_status": "RERA_APPROVED"},
        headers=auth_headers_for(broker_user),
    )
    assert broker_verify.status_code == 200
    assert broker_verify.json()["verification_status"] == "RERA_APPROVED"

    # Logout blacklists refresh token JTI
    refresh_jwt, _ = create_refresh_token(buyer_user.user_uuid)
    logout_res = await async_client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": refresh_jwt},
    )
    assert logout_res.status_code == 200
    refresh_after_logout = await async_client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": refresh_jwt},
    )
    assert refresh_after_logout.status_code == 401
