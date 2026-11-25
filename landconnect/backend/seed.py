import asyncio
from geoalchemy2.elements import WKTElement
from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.core.security import hash_password
from app.models.domain import (
    ChatMessage,
    ChatRoom,
    LandListing,
    LandType,
    User,
    UserRole,
    VerificationStatus,
)


async def seed() -> None:
    async with AsyncSessionLocal() as db:
        existing = await db.scalar(select(User).limit(1))
        if existing:
            return

        pw_hash = hash_password("LandConnect@2026")
        buyer = User(
            user_uuid="usr_buyer_aarav_01",
            email="aarav.buyer@landconnect.in",
            phone="+91-98450-11223",
            password_hash=pw_hash,
            display_name="Aarav Mehta",
            role=UserRole.BUYER,
            city="Bengaluru",
            bio="Acquiring clear-title land parcels across North Bengaluru and Sarjapur.",
        )
        seller = User(
            user_uuid="usr_seller_priya_02",
            email="priya.seller@landconnect.in",
            phone="+91-99001-44556",
            password_hash=pw_hash,
            display_name="Priya Nair",
            role=UserRole.SELLER,
            city="Devanahalli",
            bio="Direct landowner with A-Khata plots and agricultural estates.",
            show_contact_after_consent=True,
        )
        broker = User(
            user_uuid="usr_broker_rahul_03",
            email="rahul.broker@landconnect.in",
            phone="+91-97412-88990",
            password_hash=pw_hash,
            display_name="Rahul Deshmukh",
            role=UserRole.BROKER,
            city="Whitefield",
            bio="RERA-registered land advisory specialist.",
        )
        db.add_all([buyer, seller, broker])
        await db.flush()

        listings = [
            LandListing(
                id="lst_devanahalli_01",
                title="Devanahalli Airport Corridor Coconut Estate",
                description="4.2-acre irrigated agricultural estate near Kempegowda International Airport.",
                price_inr=64000000,
                area_sqft=182952,
                area_acres=4.2,
                land_type=LandType.AGRICULTURAL,
                zoning_status="Green Belt · Clear Title EC",
                verification_status=VerificationStatus.VERIFIED,
                locality="Devanahalli",
                city="Bengaluru Rural",
                latitude=13.2473,
                longitude=77.7138,
                location_geog=WKTElement("POINT(77.7138 13.2473)", srid=4326),
                boundary_geom=WKTElement(
                    "POLYGON((77.7124 13.2484, 77.7153 13.2484, 77.7155 13.2462, 77.7122 13.2463, 77.7124 13.2484))",
                    srid=4326,
                ),
                owner_uuid=seller.user_uuid,
                broker_uuid=broker.user_uuid,
            ),
            LandListing(
                id="lst_sarjapur_02",
                title="Sarjapur Road Corner Villa Plot — A-Khata",
                description="East-facing 4,800 sq.ft DC-converted residential corner plot.",
                price_inr=31200000,
                area_sqft=4800,
                area_acres=0.11,
                land_type=LandType.RESIDENTIAL,
                zoning_status="BDA / BMRDA Approved · A-Khata",
                verification_status=VerificationStatus.RERA_APPROVED,
                locality="Sarjapur Road",
                city="Bengaluru",
                latitude=12.9012,
                longitude=77.7059,
                location_geog=WKTElement("POINT(77.7059 12.9012)", srid=4326),
                boundary_geom=WKTElement(
                    "POLYGON((77.7051 12.9019, 77.7068 12.9019, 77.7068 12.9005, 77.7051 12.9005, 77.7051 12.9019))",
                    srid=4326,
                ),
                owner_uuid=seller.user_uuid,
            ),
            LandListing(
                id="lst_mysuru_bogadi_06",
                title="Mysuru Bogadi Outer Ring Road Residential Plot — MUDA",
                description="East-facing 2,400 sq.ft MUDA-approved residential plot near Bogadi Ring Road.",
                price_inr=5000000,
                area_sqft=2400,
                area_acres=0.06,
                land_type=LandType.RESIDENTIAL,
                zoning_status="MUDA Approved · E-Khata Clear Title",
                verification_status=VerificationStatus.VERIFIED,
                locality="Bogadi Ring Road",
                city="Mysuru",
                latitude=12.2889,
                longitude=76.5974,
                location_geog=WKTElement("POINT(76.5974 12.2889)", srid=4326),
                boundary_geom=WKTElement(
                    "POLYGON((76.5967 12.2895, 76.5981 12.2895, 76.5981 12.2883, 76.5967 12.2883, 76.5967 12.2895))",
                    srid=4326,
                ),
                owner_uuid=seller.user_uuid,
            ),
            LandListing(
                id="lst_belagavi_tilakwadi_07",
                title="Belagavi Tilakwadi Bypass Residential Corner Plot",
                description="BUDA-approved 3,200 sq.ft residential corner plot with clear 30-year EC.",
                price_inr=5200000,
                area_sqft=3200,
                area_acres=0.07,
                land_type=LandType.RESIDENTIAL,
                zoning_status="BUDA Approved · NA Residential",
                verification_status=VerificationStatus.VERIFIED,
                locality="Tilakwadi Bypass",
                city="Belagavi",
                latitude=15.8291,
                longitude=74.4997,
                location_geog=WKTElement("POINT(74.4997 15.8291)", srid=4326),
                boundary_geom=WKTElement(
                    "POLYGON((74.4990 15.8297, 74.5004 15.8297, 74.5004 15.8285, 74.4990 15.8285, 74.4990 15.8297))",
                    srid=4326,
                ),
                owner_uuid=seller.user_uuid,
                broker_uuid=broker.user_uuid,
            ),
            LandListing(
                id="lst_chikmagalur_aldur_08",
                title="Chikkamagaluru Aldur Foothills Shade Coffee & Pepper Plot",
                description="1.5-acre Arabica shade-coffee estate with perennial stream border and Bhoomi RTC.",
                price_inr=5500000,
                area_sqft=65340,
                area_acres=1.5,
                land_type=LandType.AGRICULTURAL,
                zoning_status="Agricultural Patta · Clear Bhoomi RTC",
                verification_status=VerificationStatus.VERIFIED,
                locality="Aldur–Mudigere Belt",
                city="Chikkamagaluru",
                latitude=13.2146,
                longitude=75.6762,
                location_geog=WKTElement("POINT(75.6762 13.2146)", srid=4326),
                boundary_geom=WKTElement(
                    "POLYGON((75.6750 13.2155, 75.6774 13.2155, 75.6774 13.2137, 75.6750 13.2137, 75.6750 13.2155))",
                    srid=4326,
                ),
                owner_uuid=seller.user_uuid,
            ),
            LandListing(
                id="lst_hubballi_gokul_10",
                title="Hubballi Gokul Road Commercial Frontage Plot",
                description="4,200 sq.ft HDMC commercial parcel along the Gokul Road Airport corridor.",
                price_inr=6800000,
                area_sqft=4200,
                area_acres=0.1,
                land_type=LandType.COMMERCIAL,
                zoning_status="HDMC Commercial Zone · Clear Title",
                verification_status=VerificationStatus.RERA_APPROVED,
                locality="Gokul Road Airport Belt",
                city="Hubballi",
                latitude=15.3617,
                longitude=75.0849,
                location_geog=WKTElement("POINT(75.0849 15.3617)", srid=4326),
                boundary_geom=WKTElement(
                    "POLYGON((75.0841 15.3624, 75.0857 15.3624, 75.0857 15.3610, 75.0841 15.3610, 75.0841 15.3624))",
                    srid=4326,
                ),
                owner_uuid=seller.user_uuid,
                broker_uuid=broker.user_uuid,
            ),
            LandListing(
                id="lst_mangaluru_baikampady_11",
                title="Mangaluru NH-66 Baikampady Warehousing Industrial Plot",
                description="18,000 sq.ft leveled industrial plot 900m from NH-66 and NMPT approach.",
                price_inr=8400000,
                area_sqft=18000,
                area_acres=0.41,
                land_type=LandType.INDUSTRIAL,
                zoning_status="KIADB Coastal Industrial Zone",
                verification_status=VerificationStatus.VERIFIED,
                locality="Baikampady NH-66",
                city="Mangaluru",
                latitude=12.9562,
                longitude=74.8126,
                location_geog=WKTElement("POINT(74.8126 12.9562)", srid=4326),
                boundary_geom=WKTElement(
                    "POLYGON((74.8116 12.9570, 74.8136 12.9570, 74.8136 12.9554, 74.8116 12.9554, 74.8116 12.9570))",
                    srid=4326,
                ),
                owner_uuid=seller.user_uuid,
                broker_uuid=broker.user_uuid,
            ),
        ]
        db.add_all(listings)
        await db.flush()

        room = ChatRoom(
            id="chat_meeting_devanahalli_02",
            room_type="MEETING_ROOM",
            title="Devanahalli Estate Deal Room",
            listing_id="lst_devanahalli_01",
            participant_uuids=[broker.user_uuid, buyer.user_uuid, seller.user_uuid],
            created_by_uuid=broker.user_uuid,
        )
        db.add(room)
        await db.flush()

        db.add(
            ChatMessage(
                room_id=room.id,
                sender_uuid=broker.user_uuid,
                message_type="SYSTEM",
                body="Broker Rahul added Seller Priya and Buyer Aarav to the deal room",
                delivery_state="READ",
                read_by_uuids=[broker.user_uuid, buyer.user_uuid, seller.user_uuid],
            )
        )
        await db.commit()


if __name__ == "__main__":
    asyncio.run(seed())
