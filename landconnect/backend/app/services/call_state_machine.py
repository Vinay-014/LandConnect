import asyncio
import json
import uuid
from datetime import datetime, timezone

import redis.asyncio as aioredis
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.domain import CallAuditLog, CallMode, CallState, User
from app.services.webrtc_adapter import get_webrtc_adapter

settings = get_settings()

VALID_TRANSITIONS: dict[CallState, set[CallState]] = {
    CallState.RINGING: {
        CallState.CONNECTED,
        CallState.REJECTED,
        CallState.MISSED,
        CallState.ENDED,
    },
    CallState.CONNECTED: {CallState.ENDED},
    CallState.ENDED: set(),
    CallState.REJECTED: set(),
    CallState.MISSED: set(),
    CallState.BUSY: set(),
}


class CallStateMachineService:
    """
    Authoritative server-side call state machine backed by Redis (ephemeral state + 30s TTL)
    and PostgreSQL (durable audit log).
    """

    def __init__(self, redis_client: aioredis.Redis, ws_publisher) -> None:
        self.redis = redis_client
        self.publish_ws = ws_publisher
        self.adapter = get_webrtc_adapter()
        self._ttl_tasks: dict[str, asyncio.Task] = {}

    def _call_key(self, call_id: str) -> str:
        return f"call:session:{call_id}"

    def _busy_key(self, user_uuid: str) -> str:
        return f"call:busy:{user_uuid}"

    async def initiate_call(
        self,
        db: AsyncSession,
        caller: User,
        callees: list[User],
        room_id: str,
        listing_id: str | None,
        mode: CallMode,
    ) -> tuple[CallAuditLog, dict]:
        if await self.redis.get(self._busy_key(caller.user_uuid)):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Caller is already in an active call",
            )

        for callee in callees:
            if not callee.allow_calls:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"{callee.display_name} has disabled incoming calls",
                )

        # Single-callee busy check
        if len(callees) == 1 and await self.redis.get(self._busy_key(callees[0].user_uuid)):
            busy_log = CallAuditLog(
                call_id=f"call_{uuid.uuid4().hex[:12]}",
                room_id=room_id,
                listing_id=listing_id,
                caller_uuid=caller.user_uuid,
                callee_uuids=[callees[0].user_uuid],
                mode=mode,
                state=CallState.BUSY,
                webrtc_room_name=f"lc_{uuid.uuid4().hex[:10]}",
                ended_at=datetime.now(timezone.utc),
                end_reason="callee_busy",
            )
            db.add(busy_log)
            await db.commit()
            await db.refresh(busy_log)
            return busy_log, {}

        call_id = f"call_{uuid.uuid4().hex[:12]}"
        room_name = f"lc_{uuid.uuid4().hex[:10]}"
        now = datetime.now(timezone.utc)

        audit = CallAuditLog(
            call_id=call_id,
            room_id=room_id,
            listing_id=listing_id,
            caller_uuid=caller.user_uuid,
            callee_uuids=[c.user_uuid for c in callees],
            mode=mode,
            state=CallState.RINGING,
            webrtc_room_name=room_name,
            started_at=now,
        )
        db.add(audit)
        await db.commit()
        await db.refresh(audit)

        session_payload = {
            "call_id": call_id,
            "room_id": room_id,
            "listing_id": listing_id,
            "caller_uuid": caller.user_uuid,
            "callee_uuids": [c.user_uuid for c in callees],
            "mode": mode.value,
            "state": CallState.RINGING.value,
            "webrtc_room_name": room_name,
            "started_at": now.isoformat(),
        }
        await self.redis.set(self._call_key(call_id), json.dumps(session_payload), ex=3600)
        await self.redis.set(self._busy_key(caller.user_uuid), call_id, ex=3600)
        for c in callees:
            await self.redis.set(self._busy_key(c.user_uuid), call_id, ex=3600)

        # Schedule 30s unanswered timeout -> MISSED
        self._ttl_tasks[call_id] = asyncio.create_task(self._ringing_timeout_worker(call_id))

        for callee in callees:
            creds = self.adapter.create_room_credentials(
                call_id, room_name, callee.user_uuid, callee.role.value
            )
            await self.publish_ws(
                callee.user_uuid,
                {
                    "event": "call.invite",
                    "payload": {
                        "call": session_payload,
                        "room_token": creds["room_token"],
                        "ice_servers": creds["ice_servers"],
                    },
                },
            )

        caller_creds = self.adapter.create_room_credentials(
            call_id, room_name, caller.user_uuid, caller.role.value
        )
        return audit, caller_creds

    async def transition_state(
        self,
        db: AsyncSession,
        call_id: str,
        actor_uuid: str,
        target_state: CallState,
        reason: str | None = None,
    ) -> CallAuditLog:
        raw = await self.redis.get(self._call_key(call_id))
        audit = await db.get(CallAuditLog, call_id)
        if not audit:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call not found")

        participants = {audit.caller_uuid, *audit.callee_uuids}
        if actor_uuid not in participants and actor_uuid != "SYSTEM":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a call participant")

        if target_state not in VALID_TRANSITIONS[audit.state]:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Invalid transition {audit.state.value} -> {target_state.value}",
            )

        now = datetime.now(timezone.utc)
        audit.state = target_state
        if target_state == CallState.CONNECTED:
            audit.answered_at = now
            self._cancel_timeout(call_id)
        elif target_state in {CallState.ENDED, CallState.REJECTED, CallState.MISSED}:
            self._cancel_timeout(call_id)
            audit.ended_at = now
            audit.end_reason = reason or target_state.value.lower()
            if audit.answered_at:
                audit.duration_seconds = max(1, int((now - audit.answered_at).total_seconds()))
            await self.redis.delete(self._call_key(call_id))
            for uid in participants:
                await self.redis.delete(self._busy_key(uid))

        if raw and target_state == CallState.CONNECTED:
            data = json.loads(raw)
            data["state"] = CallState.CONNECTED.value
            data["answered_at"] = now.isoformat()
            await self.redis.set(self._call_key(call_id), json.dumps(data), ex=3600)

        await db.commit()
        await db.refresh(audit)

        event_map = {
            CallState.CONNECTED: "call.accept",
            CallState.REJECTED: "call.reject",
            CallState.ENDED: "call.end",
            CallState.MISSED: "call.timeout",
        }
        event_name = event_map[target_state]
        for uid in participants:
            await self.publish_ws(
                uid,
                {
                    "event": event_name,
                    "payload": {
                        "call_id": audit.call_id,
                        "state": audit.state.value,
                        "duration_seconds": audit.duration_seconds,
                    },
                },
            )
        return audit

    def _cancel_timeout(self, call_id: str) -> None:
        task = self._ttl_tasks.pop(call_id, None)
        if task and not task.done():
            task.cancel()

    def shutdown(self) -> None:
        for call_id in list(self._ttl_tasks.keys()):
            self._cancel_timeout(call_id)

    async def _ringing_timeout_worker(self, call_id: str) -> None:
        try:
            await asyncio.sleep(settings.CALL_RINGING_TTL_SECONDS)
            raw = await self.redis.get(self._call_key(call_id))
            if not raw:
                return
            data = json.loads(raw)
            if data.get("state") == CallState.RINGING.value:
                from app.core.database import AsyncSessionLocal

                async with AsyncSessionLocal() as db:
                    await self.transition_state(
                        db, call_id, "SYSTEM", CallState.MISSED, reason="timeout_30s"
                    )
        except asyncio.CancelledError:
            return
        finally:
            self._ttl_tasks.pop(call_id, None)
