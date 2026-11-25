import json
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import RedisSlidingWindowLimiter, check_idempotency, get_current_user
from app.models.domain import CallAuditLog, CallState, ChatRoom, User
from app.schemas.dto import CallActionRequest, CallInitiateRequest, CallSessionOut
from app.services.call_state_machine import CallStateMachineService
from app.websockets.hub import ws_manager

router = APIRouter(prefix="/calls", tags=["In-App Audio/Video Calling"])


def _call_service(request: Request) -> CallStateMachineService:
    svc = getattr(request.app.state, "call_service", None)
    if svc is None or svc.redis is not request.app.state.redis:
        svc = CallStateMachineService(request.app.state.redis, ws_manager.publish_to_user)
        request.app.state.call_service = svc
    return svc


@router.post("/initiate", status_code=status.HTTP_201_CREATED)
async def initiate_call(
    body: CallInitiateRequest,
    request: Request,
    idemp_cache_key: str | None = Depends(check_idempotency),
    caller: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cached_body = getattr(request.state, "idempotent_cached_body", None)
    if cached_body:
        return JSONResponse(
            content=json.loads(cached_body),
            status_code=status.HTTP_201_CREATED,
            headers={"X-Idempotent-Replay": "true"},
        )

    limiter = RedisSlidingWindowLimiter(request.app.state.redis)
    await limiter.enforce(f"rl:calls:init:{caller.user_uuid}", 12, 60)

    room = await db.get(ChatRoom, body.room_id)
    if not room or caller.user_uuid not in (room.participant_uuids or []):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat room not found")

    callees: list[User] = []
    for uid in room.participant_uuids:
        if uid != caller.user_uuid:
            u = await db.get(User, uid)
            if u:
                callees.append(u)

    if not callees:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No valid callees")

    service = _call_service(request)
    audit, creds = await service.initiate_call(
        db=db,
        caller=caller,
        callees=callees,
        room_id=room.id,
        listing_id=room.listing_id,
        mode=body.mode,
    )
    payload = {
        "call": CallSessionOut.model_validate(audit).model_dump(mode="json"),
        "room_token": creds.get("room_token"),
        "ice_servers": creds.get("ice_servers", []),
    }
    if idemp_cache_key:
        await request.app.state.redis.set(idemp_cache_key, json.dumps(payload), ex=3600)
    return payload


@router.get("/active")
async def get_active_call(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    call_id = await request.app.state.redis.get(f"call:busy:{current_user.user_uuid}")
    if not call_id:
        return {"call": None}
    audit = await db.get(CallAuditLog, call_id)
    if not audit or audit.state not in {CallState.RINGING, CallState.CONNECTED}:
        return {"call": None}
    service = _call_service(request)
    creds = service.adapter.create_room_credentials(
        audit.call_id, audit.webrtc_room_name, current_user.user_uuid, current_user.role.value
    )
    return {
        "call": CallSessionOut.model_validate(audit),
        "room_token": creds.get("room_token"),
        "ice_servers": creds.get("ice_servers", []),
    }


@router.post("/{call_id}/accept")
async def accept_call(
    call_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = _call_service(request)
    audit = await service.transition_state(db, call_id, current_user.user_uuid, CallState.CONNECTED)
    return {"call": CallSessionOut.model_validate(audit)}


@router.post("/{call_id}/reject")
async def reject_call(
    call_id: str,
    request: Request,
    body: CallActionRequest | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = _call_service(request)
    audit = await service.transition_state(
        db, call_id, current_user.user_uuid, CallState.REJECTED, reason=(body.reason if body else "declined")
    )
    return {"call": CallSessionOut.model_validate(audit)}


@router.post("/{call_id}/end")
async def end_call(
    call_id: str,
    request: Request,
    body: CallActionRequest | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = _call_service(request)
    audit = await service.transition_state(
        db, call_id, current_user.user_uuid, CallState.ENDED, reason=(body.reason if body else "hangup")
    )
    return {"call": CallSessionOut.model_validate(audit)}


@router.get("/logs")
async def list_call_logs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    viewer = current_user.user_uuid
    rows = (await db.scalars(select(CallAuditLog).order_by(CallAuditLog.started_at.desc()))).all()
    mine = [c for c in rows if c.caller_uuid == viewer or viewer in (c.callee_uuids or [])]
    return {"logs": [CallSessionOut.model_validate(c) for c in mine]}
