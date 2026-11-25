# LandConnect — Privacy-First Land Marketplace & Real-Time Deal Rooms

LandConnect is a WhatsApp-inspired real estate land marketplace engineered for the **Backend Development Track**. It pairs PostGIS geospatial parcel search with role-based Deal Rooms and privacy-preserving WebRTC audio/video calling.

## Key Capabilities

- **Authentication, RBAC & Privacy Layer**: JWT Access/Refresh token rotation, Argon2/bcrypt/scrypt password hashing, `BUYER` / `SELLER` / `BROKER` role permissions, and masked `user_uuid` handles (`allow_calls`, `show_contact_after_consent`).
- **PostGIS Geospatial Search**: `GET /api/v1/listings/nearby` (`ST_DWithin`) and `GET /api/v1/listings/bbox` (`ST_MakeEnvelope`) with GeoJSON parcel polygon boundaries.
- **WhatsApp-Inspired Messaging & Broker Deal Rooms**: 1-on-1 property threads with context headers and multi-party Broker Deal Rooms with system event logs and WebSocket read receipts.
- **In-App Audio & Video Calling State Machine**: `RINGING -> CONNECTED -> ENDED | REJECTED | MISSED | BUSY`, 30-second unanswered TTL worker, busy lock detection, ephemeral room tokens, and WebRTC SDP/ICE signaling.
- **Production Engineering Standouts**: `Idempotency-Key` replay protection, optimistic locking (`version`), Redis sliding-window rate limiter, `X-Request-ID` structured JSON logging, and `/health/deep`.

## Quickstart (Docker Compose)

```bash
cd landconnect
docker compose up --build
```

- **Backend OpenAPI / Swagger Docs**: `http://localhost:8000/docs`
- **Deep Health Check**: `http://localhost:8000/health/deep`
- **Frontend Web App**: `http://localhost:3000`

## Demo Credentials (1-Click Login Supported)

| Role | Name | Email | Password |
| :--- | :--- | :--- | :--- |
| `BUYER` | Aarav Mehta | `aarav.buyer@landconnect.in` | `LandConnect@2026` |
| `SELLER` | Priya Nair | `priya.seller@landconnect.in` | `LandConnect@2026` |
| `BROKER` | Rahul Deshmukh | `rahul.broker@landconnect.in` | `LandConnect@2026` |

> **2-Tab Calling Test**: Open two browser tabs, sign in as `Aarav (BUYER)` in Tab 1 and `Priya (SELLER)` in Tab 2, open the Sarjapur chat thread, and click **Audio** or **Video** to test real-time WebRTC signaling, accept/reject, mute/camera toggles, and persistent call logs.

## Running Backend Tests

```bash
cd landconnect/backend
pytest -v
```

## Documentation
- [System Architecture, ER Diagram & Trade-offs](./docs/ARCHITECTURE.md)
- [AI Usage Summary](./docs/AI_USAGE.md)
