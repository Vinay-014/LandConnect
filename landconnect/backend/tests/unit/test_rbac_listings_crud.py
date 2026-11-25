import httpx
import pytest

from app.core.security import create_access_token
from app.models.domain import LandType, UserRole, VerificationStatus

pytestmark = pytest.mark.unit


def _sample_listing_payload() -> dict:
    return {
        "title": "Kanakapura Valley 1.5 Acre Orchard Parcel",
        "description": "Level terrain with 40ft panchayat road access and drip irrigation.",
        "price_inr": 29500000,
        "area_sqft": 65340,
        "land_type": LandType.AGRICULTURAL.value,
        "zoning_status": "Green Belt · Clear EC Title",
        "locality": "Kanakapura Road",
        "city": "Bengaluru",
        "latitude": 12.7851,
        "longitude": 77.4982,
        "images": [],
    }


@pytest.mark.parametrize(
    "actor_uuid",
    [
        "usr_buyer_aarav_01",
        "usr_seller_priya_02",
        "usr_broker_rahul_03",
    ],
)
async def test_listings_read_allows_all_authenticated_roles(
    actor_uuid: str,
    async_client: httpx.AsyncClient,
    user_directory,
    token_factory,
):
    unauth = await async_client.get("/api/v1/listings")
    assert unauth.status_code == 401

    actor = user_directory[actor_uuid]
    res = await async_client.get(
        "/api/v1/listings",
        headers={"Authorization": f"Bearer {token_factory(actor)}"},
    )
    assert res.status_code == 200
    assert isinstance(res.json(), list)
    assert len(res.json()) == 2


@pytest.mark.parametrize(
    ("actor_uuid", "expected_status", "expected_verification"),
    [
        ("usr_buyer_aarav_01", 403, None),
        ("usr_seller_priya_02", 201, VerificationStatus.PENDING_SURVEY.value),
        ("usr_broker_rahul_03", 201, VerificationStatus.VERIFIED.value),
    ],
)
async def test_listings_create_rbac_matrix(
    actor_uuid: str,
    expected_status: int,
    expected_verification: str | None,
    async_client: httpx.AsyncClient,
    user_directory,
    token_factory,
):
    unauth = await async_client.post("/api/v1/listings", json=_sample_listing_payload())
    assert unauth.status_code == 401

    actor = user_directory[actor_uuid]
    res = await async_client.post(
        "/api/v1/listings",
        json=_sample_listing_payload(),
        headers={"Authorization": f"Bearer {token_factory(actor)}"},
    )
    assert res.status_code == expected_status
    if expected_status == 201:
        body = res.json()
        assert body["owner_uuid"] == actor.user_uuid
        assert body["verification_status"] == expected_verification
        if actor.role == UserRole.BROKER:
            assert body["broker_uuid"] == actor.user_uuid
        else:
            assert body["broker_uuid"] is None


@pytest.mark.parametrize(
    ("actor_uuid", "target_listing_id", "expected_status"),
    [
        # Buyer cannot update any listing
        ("usr_buyer_aarav_01", "lst_seller_owned_01", 403),
        # Seller can update their own listing, denied on another seller's listing
        ("usr_seller_priya_02", "lst_seller_owned_01", 200),
        ("usr_seller_priya_02", "lst_other_seller_02", 403),
        # Broker can update client/seller listings
        ("usr_broker_rahul_03", "lst_seller_owned_01", 200),
        ("usr_broker_rahul_03", "lst_other_seller_02", 200),
    ],
)
async def test_listings_update_rbac_and_ownership_matrix(
    actor_uuid: str,
    target_listing_id: str,
    expected_status: int,
    async_client: httpx.AsyncClient,
    user_directory,
    token_factory,
):
    actor = user_directory[actor_uuid]
    res = await async_client.patch(
        f"/api/v1/listings/{target_listing_id}",
        json={"price_inr": 35000000, "version": 1},
        headers={"Authorization": f"Bearer {token_factory(actor)}"},
    )
    assert res.status_code == expected_status
    if expected_status == 200:
        assert res.json()["price_inr"] == 35000000
        assert res.json()["version"] == 2


@pytest.mark.parametrize(
    ("actor_uuid", "target_listing_id", "expected_status"),
    [
        # Buyer cannot delete any listing
        ("usr_buyer_aarav_01", "lst_seller_owned_01", 403),
        # Seller cannot delete another seller's listing, but can delete own listing
        ("usr_seller_priya_02", "lst_other_seller_02", 403),
        ("usr_seller_priya_02", "lst_seller_owned_01", 204),
        # Broker can delete any listing
        ("usr_broker_rahul_03", "lst_other_seller_02", 204),
    ],
)
async def test_listings_delete_rbac_and_ownership_matrix(
    actor_uuid: str,
    target_listing_id: str,
    expected_status: int,
    async_client: httpx.AsyncClient,
    user_directory,
    token_factory,
):
    actor = user_directory[actor_uuid]
    res = await async_client.delete(
        f"/api/v1/listings/{target_listing_id}",
        headers={"Authorization": f"Bearer {token_factory(actor)}"},
    )
    assert res.status_code == expected_status


async def test_listings_crud_rejects_role_tampered_jwt_via_get_current_user(
    async_client: httpx.AsyncClient,
    user_directory,
):
    """A token claiming BROKER role for a persisted BUYER account must fail get_current_user with 401."""
    buyer = user_directory["usr_buyer_aarav_01"]
    tampered_token = create_access_token(buyer.user_uuid, UserRole.BROKER.value)
    res = await async_client.post(
        "/api/v1/listings",
        json=_sample_listing_payload(),
        headers={"Authorization": f"Bearer {tampered_token}"},
    )
    assert res.status_code == 401
    assert "does not match" in res.json()["detail"]
