from datetime import datetime, timezone
import uuid
from collections.abc import AsyncIterator, Callable
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import pytest_asyncio

from app.core.database import get_db
from app.core.security import create_access_token
from app.main import app
from app.models.domain import LandListing, LandType, User, UserRole, VerificationStatus


class FakeScalarResult:
    def __init__(self, items: list) -> None:
        self._items = items

    def all(self) -> list:
        return list(self._items)


class FakePipeline:
    def __init__(self, store: dict[str, list[str]]) -> None:
        self.store = store
        self.ops: list[tuple] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def zremrangebyscore(self, key: str, min_score: int, max_score: int):
        self.ops.append(("rem", key, max_score))

    def zcard(self, key: str):
        self.ops.append(("card", key))

    def zadd(self, key: str, mapping: dict[str, int]):
        self.ops.append(("add", key, mapping))

    def expire(self, key: str, ttl: int):
        self.ops.append(("exp", key, ttl))

    async def execute(self):
        results = []
        for op in self.ops:
            if op[0] == "rem":
                key, max_score = op[1], op[2]
                items = self.store.get(key, [])
                self.store[key] = [m for m in items if int(m.split(":")[0]) > max_score]
                results.append(0)
            elif op[0] == "card":
                results.append(len(self.store.get(op[1], [])))
            elif op[0] == "add":
                key, mapping = op[1], op[2]
                items = self.store.setdefault(key, [])
                for member in mapping:
                    items.append(member)
                results.append(1)
            elif op[0] == "exp":
                results.append(True)
        return results


class FakeRedis:
    """In-memory async Redis double for isolated FastAPI & service tests."""

    def __init__(self) -> None:
        self.kv: dict[str, str] = {}
        self.zsets: dict[str, list[str]] = {}
        self.sets: dict[str, set[str]] = {}

    def pipeline(self, transaction: bool = True):
        return FakePipeline(self.zsets)

    async def get(self, key: str):
        return self.kv.get(key)

    async def set(self, key: str, value: str, ex: int | None = None):
        self.kv[key] = value

    async def delete(self, key: str):
        self.kv.pop(key, None)

    async def scard(self, key: str) -> int:
        return len(self.sets.get(key, set()))

    async def ping(self) -> bool:
        return True


def build_user(
    *,
    user_uuid: str,
    role: UserRole,
    display_name: str,
    email: str,
    allow_calls: bool = True,
) -> User:
    return User(
        user_uuid=user_uuid,
        email=email,
        phone="+91-98000-00001",
        password_hash="$argon2id$v=19$m=65536,t=3,p=4$mockhash",
        display_name=display_name,
        role=role,
        city="Bengaluru",
        bio="",
        allow_calls=allow_calls,
        show_contact_after_consent=False,
        consented_peer_uuids=[],
    )


def build_listing(
    *,
    listing_id: str,
    owner_uuid: str,
    broker_uuid: str | None = None,
    title: str = "Devanahalli 2-Acre Orchard Parcel",
    price_inr: int = 32000000,
    land_type: LandType = LandType.AGRICULTURAL,
) -> LandListing:
    now = datetime.now(timezone.utc)
    return LandListing(
        id=listing_id,
        title=title,
        description="Verified road-facing agricultural acreage with clear EC.",
        price_inr=price_inr,
        area_sqft=87120,
        area_acres=2.0,
        land_type=land_type,
        zoning_status="Green Belt · Clear Title EC",
        verification_status=(
            VerificationStatus.VERIFIED if broker_uuid else VerificationStatus.PENDING_SURVEY
        ),
        locality="Devanahalli",
        city="Bengaluru",
        latitude=13.2473,
        longitude=77.7131,
        location_geog="POINT(77.7131 13.2473)",
        boundary_geom=None,
        polygon_geojson=None,
        images=[],
        owner_uuid=owner_uuid,
        broker_uuid=broker_uuid,
        version=1,
        created_at=now,
        updated_at=now,
    )


@pytest.fixture
def user_directory() -> dict[str, User]:
    buyer = build_user(
        user_uuid="usr_buyer_aarav_01",
        role=UserRole.BUYER,
        display_name="Aarav Mehta",
        email="aarav.buyer@landconnect.in",
    )
    seller = build_user(
        user_uuid="usr_seller_priya_02",
        role=UserRole.SELLER,
        display_name="Priya Nair",
        email="priya.seller@landconnect.in",
    )
    other_seller = build_user(
        user_uuid="usr_seller_vikram_04",
        role=UserRole.SELLER,
        display_name="Vikram Rao",
        email="vikram.seller@landconnect.in",
    )
    broker = build_user(
        user_uuid="usr_broker_rahul_03",
        role=UserRole.BROKER,
        display_name="Rahul Verma",
        email="rahul.broker@landconnect.in",
    )
    return {
        buyer.user_uuid: buyer,
        seller.user_uuid: seller,
        other_seller.user_uuid: other_seller,
        broker.user_uuid: broker,
    }


@pytest.fixture
def listing_directory(user_directory: dict[str, User]) -> dict[str, LandListing]:
    seller_listing = build_listing(
        listing_id="lst_seller_owned_01",
        owner_uuid=user_directory["usr_seller_priya_02"].user_uuid,
    )
    other_seller_listing = build_listing(
        listing_id="lst_other_seller_02",
        owner_uuid=user_directory["usr_seller_vikram_04"].user_uuid,
        title="Sarjapur Commercial Corner Plot",
        price_inr=68000000,
        land_type=LandType.COMMERCIAL,
    )
    return {
        seller_listing.id: seller_listing,
        other_seller_listing.id: other_seller_listing,
    }


@pytest.fixture
def fake_redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture
def mock_db_session(
    user_directory: dict[str, User],
    listing_directory: dict[str, LandListing],
) -> MagicMock:
    session = MagicMock()

    async def fake_get(model, pk):
        if model is User:
            return user_directory.get(pk)
        if model is LandListing:
            return listing_directory.get(pk)
        return None

    def fake_add(obj):
        if isinstance(obj, LandListing):
            now = datetime.now(timezone.utc)
            if not obj.id:
                obj.id = f"lst_{uuid.uuid4().hex[:12]}"
            if obj.created_at is None:
                obj.created_at = now
            obj.updated_at = now
            listing_directory[obj.id] = obj

    async def fake_delete(obj):
        if isinstance(obj, LandListing):
            listing_directory.pop(obj.id, None)

    async def fake_scalars(stmt):
        return FakeScalarResult(list(listing_directory.values()))

    async def fake_refresh(obj):
        if isinstance(obj, LandListing):
            obj.updated_at = datetime.now(timezone.utc)

    session.get = AsyncMock(side_effect=fake_get)
    session.scalars = AsyncMock(side_effect=fake_scalars)
    session.add = MagicMock(side_effect=fake_add)
    session.delete = AsyncMock(side_effect=fake_delete)
    session.commit = AsyncMock()
    session.refresh = AsyncMock(side_effect=fake_refresh)
    return session


@pytest.fixture
def buyer_user(user_directory: dict[str, User]) -> User:
    return user_directory["usr_buyer_aarav_01"]


@pytest.fixture
def seller_user(user_directory: dict[str, User]) -> User:
    return user_directory["usr_seller_priya_02"]


@pytest.fixture
def other_seller_user(user_directory: dict[str, User]) -> User:
    return user_directory["usr_seller_vikram_04"]


@pytest.fixture
def broker_user(user_directory: dict[str, User]) -> User:
    return user_directory["usr_broker_rahul_03"]


@pytest.fixture
def token_factory() -> Callable[[User], str]:
    def _make_token(user: User) -> str:
        role_val = user.role.value if isinstance(user.role, UserRole) else str(user.role)
        return create_access_token(user.user_uuid, role_val)

    return _make_token


@pytest.fixture
def auth_headers_for(token_factory: Callable[[User], str]) -> Callable[[User], dict[str, str]]:
    def _headers(user: User) -> dict[str, str]:
        return {"Authorization": f"Bearer {token_factory(user)}"}

    return _headers


@pytest_asyncio.fixture
async def async_client(
    mock_db_session: MagicMock,
    fake_redis: FakeRedis,
) -> AsyncIterator[httpx.AsyncClient]:
    async def override_get_db():
        yield mock_db_session

    app.state.redis = fake_redis
    app.dependency_overrides[get_db] = override_get_db
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
    app.dependency_overrides.clear()
