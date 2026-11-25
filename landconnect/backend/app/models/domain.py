import enum
import uuid
from datetime import datetime, timezone

from geoalchemy2 import Geography, Geometry
from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class UserRole(str, enum.Enum):
    BUYER = "BUYER"
    SELLER = "SELLER"
    BROKER = "BROKER"


class LandType(str, enum.Enum):
    AGRICULTURAL = "AGRICULTURAL"
    RESIDENTIAL = "RESIDENTIAL"
    COMMERCIAL = "COMMERCIAL"
    INDUSTRIAL = "INDUSTRIAL"


class VerificationStatus(str, enum.Enum):
    VERIFIED = "VERIFIED"
    RERA_APPROVED = "RERA_APPROVED"
    PENDING_SURVEY = "PENDING_SURVEY"


class CallState(str, enum.Enum):
    RINGING = "RINGING"
    CONNECTED = "CONNECTED"
    ENDED = "ENDED"
    REJECTED = "REJECTED"
    MISSED = "MISSED"
    BUSY = "BUSY"


class CallMode(str, enum.Enum):
    AUDIO = "AUDIO"
    VIDEO = "VIDEO"


class User(Base):
    __tablename__ = "users"

    user_uuid: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: f"usr_{uuid.uuid4().hex[:16]}"
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    phone: Mapped[str] = mapped_column(String(32), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), nullable=False, index=True)
    city: Mapped[str] = mapped_column(String(120), default="Bengaluru")
    bio: Mapped[str] = mapped_column(Text, default="")
    allow_calls: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    show_contact_after_consent: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    consented_peer_uuids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class LandListing(Base):
    __tablename__ = "land_listings"

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: f"lst_{uuid.uuid4().hex[:12]}"
    )
    title: Mapped[str] = mapped_column(String(220), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    price_inr: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    area_sqft: Mapped[int] = mapped_column(Integer, nullable=False)
    area_acres: Mapped[float] = mapped_column(Float, nullable=False)
    land_type: Mapped[LandType] = mapped_column(Enum(LandType), nullable=False, index=True)
    zoning_status: Mapped[str] = mapped_column(String(200), nullable=False)
    verification_status: Mapped[VerificationStatus] = mapped_column(
        Enum(VerificationStatus), default=VerificationStatus.PENDING_SURVEY, nullable=False
    )
    locality: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    city: Mapped[str] = mapped_column(String(120), default="Bengaluru")
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)

    # PostGIS spatial columns for ST_DWithin radius search & ST_MakeEnvelope bbox queries
    location_geog: Mapped[object] = mapped_column(
        Geography(geometry_type="POINT", srid=4326), nullable=False
    )
    boundary_geom: Mapped[object | None] = mapped_column(
        Geometry(geometry_type="POLYGON", srid=4326), nullable=True
    )
    polygon_geojson: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    images: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)

    owner_uuid: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.user_uuid", ondelete="CASCADE"), nullable=False, index=True
    )
    broker_uuid: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.user_uuid", ondelete="SET NULL"), nullable=True
    )

    # Optimistic concurrency version column
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        Index("ix_land_listings_location_geog", "location_geog", postgresql_using="gist"),
        Index("ix_land_listings_boundary_geom", "boundary_geom", postgresql_using="gist"),
    )


class ChatRoom(Base):
    __tablename__ = "chat_rooms"

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: f"chat_{uuid.uuid4().hex[:12]}"
    )
    room_type: Mapped[str] = mapped_column(String(24), nullable=False)  # DIRECT | MEETING_ROOM
    title: Mapped[str] = mapped_column(String(220), nullable=False)
    listing_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("land_listings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    participant_uuids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    created_by_uuid: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: f"msg_{uuid.uuid4().hex[:12]}"
    )
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_uuid: Mapped[str] = mapped_column(String(64), nullable=False)
    message_type: Mapped[str] = mapped_column(String(16), default="TEXT", nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    delivery_state: Mapped[str] = mapped_column(String(16), default="SENT", nullable=False)
    read_by_uuids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )

    room: Mapped[ChatRoom] = relationship(back_populates="messages")


class CallAuditLog(Base):
    __tablename__ = "call_audit_logs"

    call_id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: f"call_{uuid.uuid4().hex[:12]}"
    )
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    listing_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    caller_uuid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    callee_uuids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    mode: Mapped[CallMode] = mapped_column(Enum(CallMode), nullable=False)
    state: Mapped[CallState] = mapped_column(Enum(CallState), nullable=False, index=True)
    webrtc_room_name: Mapped[str] = mapped_column(String(120), nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    end_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
