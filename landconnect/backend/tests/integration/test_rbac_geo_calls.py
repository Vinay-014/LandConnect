import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.security import create_access_token, decode_token, require_roles
from app.models.domain import CallAuditLog, CallMode, CallState, User, UserRole
from app.services.call_state_machine import CallStateMachineService, VALID_TRANSITIONS
from app.services.privacy import to_privacy_safe_user


class FakeRedis:
    def __init__(self) -> None:
        self.kv: dict[str, str] = {}

    async def get(self, key: str):
        return self.kv.get(key)

    async def set(self, key: str, value: str, ex: int | None = None):
        self.kv[key] = value

    async def delete(self, key: str):
        self.kv.pop(key, None)


def test_privacy_masks_phone_and_email_by_default():
    seller = User(
        user_uuid="usr_seller_priya_02",
        email="priya@landconnect.in",
        phone="+91-99001-44556",
        password_hash="hashed",
        display_name="Priya Nair",
        role=UserRole.SELLER,
        show_contact_after_consent=True,
        consented_peer_uuids=[],
    )
    masked_view = to_privacy_safe_user(seller, viewer_uuid="usr_buyer_aarav_01")
    assert masked_view.email is None
    assert masked_view.phone is None
    assert masked_view.contact_revealed is False

    seller.consented_peer_uuids = ["usr_buyer_aarav_01"]
    consented_view = to_privacy_safe_user(seller, viewer_uuid="usr_buyer_aarav_01")
    assert consented_view.email == "priya@landconnect.in"
    assert consented_view.phone == "+91-99001-44556"
    assert consented_view.contact_revealed is True


@pytest.mark.asyncio
async def test_rbac_blocks_buyer_from_seller_broker_routes():
    buyer_token = create_access_token("usr_buyer_aarav_01", UserRole.BUYER.value)
    claims = decode_token(buyer_token, expected_type="access")
    guard = require_roles(UserRole.SELLER.value, UserRole.BROKER.value)

    with pytest.raises(Exception) as exc_info:
        await guard(claims=claims)
    assert exc_info.value.status_code == 403


def test_call_state_machine_valid_transitions():
    assert CallState.CONNECTED in VALID_TRANSITIONS[CallState.RINGING]
    assert CallState.MISSED in VALID_TRANSITIONS[CallState.RINGING]
    assert CallState.REJECTED in VALID_TRANSITIONS[CallState.RINGING]
    assert CallState.ENDED in VALID_TRANSITIONS[CallState.CONNECTED]
    assert len(VALID_TRANSITIONS[CallState.ENDED]) == 0


@pytest.mark.asyncio
async def test_call_initiation_and_accept_lifecycle():
    redis = FakeRedis()
    ws_events: list[tuple[str, dict]] = []

    async def fake_publish(uid: str, msg: dict):
        ws_events.append((uid, msg))

    service = CallStateMachineService(redis, fake_publish)
    caller = User(
        user_uuid="usr_buyer_aarav_01",
        email="a@lc.in",
        phone="1",
        password_hash="x",
        display_name="Aarav",
        role=UserRole.BUYER,
        allow_calls=True,
    )
    callee = User(
        user_uuid="usr_seller_priya_02",
        email="p@lc.in",
        phone="2",
        password_hash="x",
        display_name="Priya",
        role=UserRole.SELLER,
        allow_calls=True,
    )

    mock_db = MagicMock()
    mock_db.add = MagicMock()
    mock_db.commit = AsyncMock()
    mock_db.refresh = AsyncMock()

    audit, creds = await service.initiate_call(
        db=mock_db,
        caller=caller,
        callees=[callee],
        room_id="chat_01",
        listing_id="lst_01",
        mode=CallMode.VIDEO,
    )
    assert audit.state == CallState.RINGING
    assert "room_token" in creds
    assert len(ws_events) == 1
    assert ws_events[0][1]["event"] == "call.invite"

    mock_db.get = AsyncMock(return_value=audit)
    connected = await service.transition_state(
        db=mock_db,
        call_id=audit.call_id,
        actor_uuid=callee.user_uuid,
        target_state=CallState.CONNECTED,
    )
    assert connected.state == CallState.CONNECTED
    service._cancel_timeout(audit.call_id)
