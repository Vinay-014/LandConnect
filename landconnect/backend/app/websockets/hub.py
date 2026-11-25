import asyncio
import json
from collections import defaultdict
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
import redis.asyncio as aioredis

from app.core.security import decode_token

router = APIRouter()


class WebSocketConnectionManager:
    """Multi-instance WebSocket connection manager backed by Redis Pub/Sub."""

    def __init__(self) -> None:
        self.active: dict[str, set[WebSocket]] = defaultdict(set)
        self.redis: aioredis.Redis | None = None
        self._pubsub_task: asyncio.Task | None = None

    async def start(self, redis_client: aioredis.Redis) -> None:
        self.redis = redis_client
        self._pubsub_task = asyncio.create_task(self._listen_pubsub())

    async def stop(self) -> None:
        if self._pubsub_task and not self._pubsub_task.done():
            self._pubsub_task.cancel()

    async def connect(self, user_uuid: str, ws: WebSocket) -> None:
        await ws.accept()
        self.active[user_uuid].add(ws)
        if self.redis:
            await self.redis.sadd("presence:online", user_uuid)

    async def disconnect(self, user_uuid: str, ws: WebSocket) -> None:
        self.active[user_uuid].discard(ws)
        if not self.active[user_uuid]:
            self.active.pop(user_uuid, None)
            if self.redis:
                await self.redis.srem("presence:online", user_uuid)

    async def publish_to_user(self, user_uuid: str, message: dict) -> None:
        if self.redis:
            await self.redis.publish(
                "landconnect:ws:events",
                json.dumps({"target_uuid": user_uuid, "message": message}),
            )
        else:
            await self._deliver_local(user_uuid, message)

    async def _deliver_local(self, user_uuid: str, message: dict) -> None:
        raw = json.dumps(message)
        for sock in list(self.active.get(user_uuid, ())):
            try:
                await sock.send_text(raw)
            except Exception:
                self.active[user_uuid].discard(sock)

    async def _listen_pubsub(self) -> None:
        if not self.redis:
            return
        pubsub = self.redis.pubsub()
        await pubsub.subscribe("landconnect:ws:events")
        try:
            async for item in pubsub.listen():
                if item.get("type") == "message":
                    envelope = json.loads(item["data"])
                    await self._deliver_local(envelope["target_uuid"], envelope["message"])
        except asyncio.CancelledError:
            await pubsub.unsubscribe("landconnect:ws:events")

    async def _is_call_participant_pair(self, call_id: str | None, sender_uuid: str, target_uuid: str) -> bool:
        if not call_id:
            return False
        if not self.redis:
            return True
        raw = await self.redis.get(f"call:session:{call_id}")
        if not raw:
            return False
        session = json.loads(raw)
        participants = {session.get("caller_uuid"), *(session.get("callee_uuids") or [])}
        return sender_uuid in participants and target_uuid in participants


ws_manager = WebSocketConnectionManager()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    try:
        claims = decode_token(token, expected_type="access")
        user_uuid = claims["sub"]
    except HTTPException:
        await websocket.close(code=1008)
        return

    await ws_manager.connect(user_uuid, websocket)
    await websocket.send_text(json.dumps({"event": "ws.connected", "payload": {"user_uuid": user_uuid}}))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event = data.get("event")
            payload = data.get("payload") or {}
            target_uuid = payload.get("target_uuid")
            if event in {"webrtc.offer", "webrtc.answer", "webrtc.ice", "call.mode_switch"} and target_uuid:
                if await ws_manager._is_call_participant_pair(payload.get("call_id"), user_uuid, target_uuid):
                    await ws_manager.publish_to_user(
                        target_uuid,
                        {"event": event, "payload": {**payload, "from_uuid": user_uuid}},
                    )
            elif event == "chat.typing" and target_uuid:
                await ws_manager.publish_to_user(
                    target_uuid,
                    {"event": "chat.typing", "payload": {"room_id": payload.get("room_id"), "user_uuid": user_uuid}},
                )
    except WebSocketDisconnect:
        await ws_manager.disconnect(user_uuid, websocket)
