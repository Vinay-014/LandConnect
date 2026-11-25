from datetime import datetime
from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models.domain import CallMode, CallState, LandType, UserRole, VerificationStatus


class RegisterRequest(BaseModel):
    email: EmailStr
    phone: str = Field(min_length=7, max_length=32)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=2, max_length=120)
    role: UserRole
    city: str = "Bengaluru"
    bio: str = ""


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class PrivacyUpdateRequest(BaseModel):
    allow_calls: bool | None = None
    show_contact_after_consent: bool | None = None
    consent_peer_uuid: str | None = None
    revoke_peer_uuid: str | None = None


class PublicUserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_uuid: str
    display_name: str
    role: UserRole
    city: str
    bio: str
    allow_calls: bool
    show_contact_after_consent: bool
    contact_revealed: bool = False
    masked_handle: str
    email: str | None = None
    phone: str | None = None
    consented_peer_uuids: list[str] | None = None


class ListingCreateRequest(BaseModel):
    title: str = Field(min_length=4, max_length=220)
    description: str = Field(min_length=10, max_length=4000)
    price_inr: int = Field(gt=0)
    area_sqft: int = Field(gt=0)
    land_type: LandType
    zoning_status: str = Field(min_length=2, max_length=200)
    locality: str = Field(min_length=2, max_length=120)
    city: str = "Bengaluru"
    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)
    polygon_geojson: dict | None = None
    images: list[str] = Field(default_factory=list)


class ListingUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=4, max_length=220)
    description: str | None = Field(default=None, min_length=10, max_length=4000)
    price_inr: int | None = Field(default=None, gt=0)
    zoning_status: str | None = None
    version: int = Field(ge=1)


class ListingVerifyRequest(BaseModel):
    verification_status: VerificationStatus


class ListingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    description: str
    price_inr: int
    area_sqft: int
    area_acres: float
    land_type: LandType
    zoning_status: str
    verification_status: VerificationStatus
    locality: str
    city: str
    latitude: float
    longitude: float
    polygon_geojson: dict | None = None
    images: list[str]
    owner_uuid: str
    broker_uuid: str | None = None
    version: int
    distance_km: float | None = None
    created_at: datetime
    updated_at: datetime


class DirectChatRequest(BaseModel):
    listing_id: str
    peer_uuid: str | None = None


class MeetingRoomCreateRequest(BaseModel):
    listing_id: str
    title: str | None = None
    participant_uuids: list[str] = Field(min_length=1)


class MessageCreateRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class CallInitiateRequest(BaseModel):
    room_id: str
    mode: CallMode = CallMode.AUDIO


class CallActionRequest(BaseModel):
    reason: str | None = None


class CallSessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    call_id: str
    room_id: str
    listing_id: str | None = None
    caller_uuid: str
    callee_uuids: list[str]
    mode: CallMode
    state: CallState
    webrtc_room_name: str
    started_at: datetime
    answered_at: datetime | None = None
    ended_at: datetime | None = None
    duration_seconds: int
    end_reason: str | None = None
