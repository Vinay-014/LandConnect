from abc import ABC, abstractmethod
from typing import Any

from app.core.config import get_settings
from app.core.security import create_ephemeral_call_token

settings = get_settings()


class WebRTCProviderAdapter(ABC):
    """Adapter pattern decoupling signaling/token issuance from underlying WebRTC SFU/P2P transport."""

    @abstractmethod
    def create_room_credentials(
        self, call_id: str, room_name: str, user_uuid: str, role: str
    ) -> dict[str, Any]:
        raise NotImplementedError


class P2PStunTurnAdapter(WebRTCProviderAdapter):
    def create_room_credentials(
        self, call_id: str, room_name: str, user_uuid: str, role: str
    ) -> dict[str, Any]:
        ice_servers: list[dict[str, Any]] = [{"urls": settings.STUN_SERVER_URL}]
        if settings.TURN_SERVER_URL:
            ice_servers.append(
                {
                    "urls": settings.TURN_SERVER_URL,
                    "username": settings.TURN_USERNAME,
                    "credential": settings.TURN_CREDENTIAL,
                }
            )
        token = create_ephemeral_call_token(call_id, room_name, user_uuid, role)
        return {
            "provider": "p2p",
            "room_name": room_name,
            "room_token": token,
            "ice_servers": ice_servers,
        }


class LiveKitAdapter(WebRTCProviderAdapter):
    def create_room_credentials(
        self, call_id: str, room_name: str, user_uuid: str, role: str
    ) -> dict[str, Any]:
        # Generates LiveKit-compatible JWT grants when LIVEKIT_API_KEY/SECRET are configured
        token = create_ephemeral_call_token(call_id, room_name, user_uuid, role)
        return {
            "provider": "livekit",
            "url": settings.LIVEKIT_URL,
            "room_name": room_name,
            "room_token": token,
            "ice_servers": [{"urls": settings.STUN_SERVER_URL}],
        }


def get_webrtc_adapter() -> WebRTCProviderAdapter:
    if settings.WEBRTC_PROVIDER == "livekit":
        return LiveKitAdapter()
    return P2PStunTurnAdapter()
