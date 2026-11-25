from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user, require_user_roles
from app.models.domain import ChatMessage, ChatRoom, LandListing, User, UserRole
from app.schemas.dto import DirectChatRequest, MeetingRoomCreateRequest, MessageCreateRequest
from app.websockets.hub import ws_manager

router = APIRouter(prefix="/chats", tags=["Messaging & Broker Deal Rooms"])


@router.get("")
async def list_my_chats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    viewer = current_user.user_uuid
    rooms = (await db.scalars(select(ChatRoom).order_by(ChatRoom.updated_at.desc()))).all()
    my_rooms = [r for r in rooms if viewer in (r.participant_uuids or [])]
    return {"chats": my_rooms}


@router.post("/direct", status_code=status.HTTP_201_CREATED)
async def create_or_get_direct_chat(
    body: DirectChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    viewer = current_user.user_uuid
    listing = await db.get(LandListing, body.listing_id)
    if not listing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found")

    peer = body.peer_uuid or listing.broker_uuid or listing.owner_uuid
    if peer == viewer:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot chat with self")
    peer_user = await db.get(User, peer)
    if not peer_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Peer user not found")

    existing_rooms = (await db.scalars(select(ChatRoom))).all()
    for r in existing_rooms:
        if (
            r.room_type == "DIRECT"
            and r.listing_id == listing.id
            and set(r.participant_uuids or []) == {viewer, peer}
        ):
            return r

    room = ChatRoom(
        room_type="DIRECT",
        title=listing.title,
        listing_id=listing.id,
        participant_uuids=[viewer, peer],
        created_by_uuid=viewer,
    )
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return room


@router.post("/meeting-room", status_code=status.HTTP_201_CREATED)
async def create_meeting_room(
    body: MeetingRoomCreateRequest,
    broker: User = Depends(require_user_roles(UserRole.BROKER)),
    db: AsyncSession = Depends(get_db),
):
    listing = await db.get(LandListing, body.listing_id)
    if not listing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found")

    participants = list(dict.fromkeys([broker.user_uuid, *body.participant_uuids]))
    room = ChatRoom(
        room_type="MEETING_ROOM",
        title=body.title or f"{listing.locality} Deal Room",
        listing_id=listing.id,
        participant_uuids=participants,
        created_by_uuid=broker.user_uuid,
    )
    db.add(room)
    await db.flush()

    sys_msg = ChatMessage(
        room_id=room.id,
        sender_uuid=broker.user_uuid,
        message_type="SYSTEM",
        body=f"Broker {broker.display_name} created the multi-party Deal Room",
        delivery_state="DELIVERED",
        read_by_uuids=[broker.user_uuid],
    )
    db.add(sys_msg)
    await db.commit()
    await db.refresh(room)

    for uid in participants:
        await ws_manager.publish_to_user(uid, {"event": "chat.room_created", "payload": {"room_id": room.id}})
    return {"room": room, "system_message": sys_msg}


@router.get("/{room_id}/messages")
async def get_room_messages(
    room_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    room = await db.get(ChatRoom, room_id)
    if not room or current_user.user_uuid not in (room.participant_uuids or []):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")

    msgs = (
        await db.scalars(
            select(ChatMessage).where(ChatMessage.room_id == room_id).order_by(ChatMessage.created_at.asc())
        )
    ).all()
    return {"room_id": room_id, "messages": msgs}


@router.post("/{room_id}/messages", status_code=status.HTTP_201_CREATED)
async def send_message(
    room_id: str,
    body: MessageCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    room = await db.get(ChatRoom, room_id)
    if not room or current_user.user_uuid not in (room.participant_uuids or []):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")

    msg = ChatMessage(
        room_id=room_id,
        sender_uuid=current_user.user_uuid,
        message_type="TEXT",
        body=body.body,
        delivery_state="DELIVERED",
        read_by_uuids=[current_user.user_uuid],
    )
    room.updated_at = datetime.now(timezone.utc)
    db.add(msg)
    await db.commit()
    await db.refresh(msg)

    for uid in room.participant_uuids:
        await ws_manager.publish_to_user(
            uid,
            {
                "event": "chat.message",
                "payload": {
                    "id": msg.id,
                    "room_id": msg.room_id,
                    "sender_uuid": msg.sender_uuid,
                    "body": msg.body,
                },
            },
        )
    return msg
