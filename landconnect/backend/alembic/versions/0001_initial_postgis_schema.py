"""Initial PostGIS schema for LandConnect.

Revision ID: 0001_initial_postgis
Revises:
Create Date: 2026-11-21
"""
from alembic import op
import geoalchemy2
import sqlalchemy as sa

revision = "0001_initial_postgis"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
    op.create_table(
        "users",
        sa.Column("user_uuid", sa.String(64), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("phone", sa.String(32), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("role", sa.Enum("BUYER", "SELLER", "BROKER", name="userrole"), nullable=False),
        sa.Column("city", sa.String(120), nullable=False, server_default="Bengaluru"),
        sa.Column("bio", sa.Text(), nullable=False, server_default=""),
        sa.Column("allow_calls", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("show_contact_after_consent", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("consented_peer_uuids", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "land_listings",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("title", sa.String(220), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("price_inr", sa.Integer(), nullable=False),
        sa.Column("area_sqft", sa.Integer(), nullable=False),
        sa.Column("area_acres", sa.Float(), nullable=False),
        sa.Column("land_type", sa.Enum("AGRICULTURAL", "RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", name="landtype"), nullable=False),
        sa.Column("zoning_status", sa.String(200), nullable=False),
        sa.Column("verification_status", sa.Enum("VERIFIED", "RERA_APPROVED", "PENDING_SURVEY", name="verificationstatus"), nullable=False),
        sa.Column("locality", sa.String(120), nullable=False),
        sa.Column("city", sa.String(120), nullable=False),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("location_geog", geoalchemy2.Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("boundary_geom", geoalchemy2.Geometry(geometry_type="POLYGON", srid=4326), nullable=True),
        sa.Column("polygon_geojson", sa.JSON(), nullable=True),
        sa.Column("images", sa.JSON(), nullable=False),
        sa.Column("owner_uuid", sa.String(64), sa.ForeignKey("users.user_uuid", ondelete="CASCADE"), nullable=False),
        sa.Column("broker_uuid", sa.String(64), sa.ForeignKey("users.user_uuid", ondelete="SET NULL"), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_land_listings_location_geog", "land_listings", ["location_geog"], postgresql_using="gist")

    op.create_table(
        "chat_rooms",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("room_type", sa.String(24), nullable=False),
        sa.Column("title", sa.String(220), nullable=False),
        sa.Column("listing_id", sa.String(64), sa.ForeignKey("land_listings.id", ondelete="CASCADE"), nullable=False),
        sa.Column("participant_uuids", sa.JSON(), nullable=False),
        sa.Column("created_by_uuid", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "chat_messages",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("room_id", sa.String(64), sa.ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender_uuid", sa.String(64), nullable=False),
        sa.Column("message_type", sa.String(16), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("delivery_state", sa.String(16), nullable=False),
        sa.Column("read_by_uuids", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "call_audit_logs",
        sa.Column("call_id", sa.String(64), primary_key=True),
        sa.Column("room_id", sa.String(64), sa.ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("listing_id", sa.String(64), nullable=True),
        sa.Column("caller_uuid", sa.String(64), nullable=False),
        sa.Column("callee_uuids", sa.JSON(), nullable=False),
        sa.Column("mode", sa.Enum("AUDIO", "VIDEO", name="callmode"), nullable=False),
        sa.Column("state", sa.Enum("RINGING", "CONNECTED", "ENDED", "REJECTED", "MISSED", "BUSY", name="callstate"), nullable=False),
        sa.Column("webrtc_room_name", sa.String(120), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("end_reason", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("call_audit_logs")
    op.drop_table("chat_messages")
    op.drop_table("chat_rooms")
    op.drop_table("land_listings")
    op.drop_table("users")
