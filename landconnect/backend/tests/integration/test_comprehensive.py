import pytest
from fastapi import HTTPException

from app.core.security import RedisSlidingWindowLimiter
from app.models.domain import CallMode, CallState, User, UserRole
from app.services.call_state_machine import CallStateMachineService


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


class FakeRateRedis:
    def __init__(self) -> None:
        self.zsets: dict[str, list[str]] = {}
        self.kv: dict[str, str] = {}

    def pipeline(self, transaction: bool = True):
        return FakePipeline(self.zsets)

    async def get(self, key: str):
        return self.kv.get(key)

    async def set(self, key: str, value: str, ex: int | None = None):
        self.kv[key] = value

    async def delete(self, key: str):
        self.kv.pop(key, None)


@pytest.mark.asyncio
async def test_sliding_window_rate_limiter_enforces_429():
    redis = FakeRateRedis()
    limiter = RedisSlidingWindowLimiter(redis)

    rem1 = await limiter.enforce("rl:calls:usr_1", max_requests=2, window_seconds=60)
    rem2 = await limiter.enforce("rl:calls:usr_1", max_requests=2, window_seconds=60)
    assert rem1 == 1
    assert rem2 == 0

    with pytest.raises(HTTPException) as exc:
        await limiter.enforce("rl:calls:usr_1", max_requests=2, window_seconds=60)
    assert exc.value.status_code == 429
    assert exc.value.headers["Retry-After"] == "60"


@pytest.mark.asyncio
async def test_call_rejects_when_callee_disables_calls():
    redis = FakeRateRedis()

    async def noop_publish(uid: str, msg: dict):
        return None

    service = CallStateMachineService(redis, noop_publish)
    caller = User(
        user_uuid="usr_buyer_01",
        email="b@lc.in",
        phone="1",
        password_hash="x",
        display_name="Buyer",
        role=UserRole.BUYER,
        allow_calls=True,
    )
    callee = User(
        user_uuid="usr_seller_02",
        email="s@lc.in",
        phone="2",
        password_hash="x",
        display_name="Private Seller",
        role=UserRole.SELLER,
        allow_calls=False,
    )

    with pytest.raises(HTTPException) as exc:
        await service.initiate_call(
            db=None,  # fails before DB access due to privacy check
            caller=caller,
            callees=[callee],
            room_id="chat_01",
            listing_id="lst_01",
            mode=CallMode.AUDIO,
        )
    assert exc.value.status_code == 403
