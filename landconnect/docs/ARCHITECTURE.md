# LandConnect — Backend Architecture & System Design

## 1. System Architecture Overview

LandConnect separates stateless REST API operations, stateful real-time WebSocket signaling, PostGIS geospatial indexing, and ephemeral WebRTC media negotiation into cleanly bounded layers:

- **API & Auth Layer (`app/api/v1/`, `app/core/security.py`)**: FastAPI async routers protected by JWT Access/Refresh tokens, Argon2/bcrypt password hashing, and role-based guards (`BUYER`, `SELLER`, `BROKER`).
- **Geospatial Engine (`PostGIS + GeoAlchemy2`)**: Parcel coordinates (`Geography(POINT, 4326)`) and boundary polygons (`Geometry(POLYGON, 4326)`) indexed with GiST for sub-10ms `ST_DWithin` radius searches and `ST_MakeEnvelope` viewport queries.
- **Real-Time Pub/Sub & Calling State Machine (`Redis + WebSockets`)**:
  - Multi-worker horizontal scaling via Redis Pub/Sub (`landconnect:ws:events`).
  - Call sessions stored in Redis with busy locks (`call:busy:{user_uuid}`) and a 30-second unanswered TTL timeout worker transitioning `RINGING -> MISSED`.
  - Ephemeral 5-minute HMAC-signed WebRTC room tokens scoped to `call_id` and verified participants.
- **Privacy Layer**: Raw `phone` and `email` fields are stripped from all peer DTOs by default. Peers interact exclusively via `user_uuid` handles unless `show_contact_after_consent` is explicitly enabled for a specific peer.

---

## 2. Entity-Relationship Diagram (Mermaid)

```mermaid
erDiagram
    USERS ||--o{ LAND_LISTINGS : owns
    USERS ||--o{ CHAT_ROOMS : participates
    LAND_LISTINGS ||--o{ CHAT_ROOMS : anchors
    CHAT_ROOMS ||--o{ CHAT_MESSAGES : contains
    CHAT_ROOMS ||--o{ CALL_AUDIT_LOGS : records

    USERS {
        string user_uuid PK
        string email UK
        string phone
        string role "BUYER | SELLER | BROKER"
        boolean allow_calls
        boolean show_contact_after_consent
        json consented_peer_uuids
    }

    LAND_LISTINGS {
        string id PK
        string title
        int price_inr
        int area_sqft
        string land_type
        geography location_geog "POINT SRID 4326 (GiST)"
        geometry boundary_geom "POLYGON SRID 4326 (GiST)"
        string owner_uuid FK
        string broker_uuid FK
        int version "Optimistic Lock"
    }

    CHAT_ROOMS {
        string id PK
        string room_type "DIRECT | MEETING_ROOM"
        string listing_id FK
        json participant_uuids
    }

    CHAT_MESSAGES {
        string id PK
        string room_id FK
        string sender_uuid
        string message_type "TEXT | SYSTEM"
        string delivery_state "SENT | DELIVERED | READ"
    }

    CALL_AUDIT_LOGS {
        string call_id PK
        string room_id FK
        string caller_uuid
        json callee_uuids
        string mode "AUDIO | VIDEO"
        string state "RINGING | CONNECTED | ENDED | REJECTED | MISSED | BUSY"
        int duration_seconds
    }
```

---

## 3. Calling State Machine

```mermaid
stateDiagram-v2
    [*] --> BUSY: Callee already in active call
    [*] --> RINGING: POST /calls/initiate (30s TTL started)
    RINGING --> CONNECTED: POST /calls/{id}/accept
    RINGING --> REJECTED: POST /calls/{id}/reject
    RINGING --> MISSED: 30s TTL expires (Server Worker)
    RINGING --> ENDED: Caller cancels before answer
    CONNECTED --> ENDED: POST /calls/{id}/end
    BUSY --> [*]
    REJECTED --> [*]
    MISSED --> [*]
    ENDED --> [*]
```

---

## 4. WebRTC Signaling Sequence

```mermaid
sequenceDiagram
    participant Buyer as Buyer Client
    participant API as FastAPI + CallStateMachine
    participant Redis as Redis (State + Pub/Sub)
    participant Seller as Seller Client

    Buyer->>API: POST /api/v1/calls/initiate (Idempotency-Key)
    API->>Redis: Check call:busy:{seller_uuid} & create session (30s TTL)
    API-->>Buyer: 201 Created (call_id, ephemeral room_token, ICE servers)
    API->>Redis: PUBLISH call.invite -> Seller
    Redis-->>Seller: WS push call.invite (caller role + listing context)
    Seller->>API: POST /api/v1/calls/{id}/accept
    API->>Redis: Cancel 30s TTL, transition RINGING -> CONNECTED
    API-->>Buyer: WS push call.accept
    Buyer->>Seller: WS relay webrtc.offer (SDP)
    Seller->>Buyer: WS relay webrtc.answer (SDP)
    Buyer<<->>Seller: Direct P2P / TURN Encrypted Audio+Video Stream
    Buyer->>API: POST /api/v1/calls/{id}/end
    API->>Redis: Clear call:busy locks, persist duration to CallAuditLog
```

---

## 5. Key Engineering Trade-offs

1. **Redis Pub/Sub + Ephemeral State vs. Database Polling**: Storing active call state and busy locks in Redis avoids Postgres row-lock contention during rapid call signaling and supports multi-worker FastAPI deployments, while PostgreSQL remains the durable audit log.
2. **WebRTC Adapter Pattern (`P2PStunTurnAdapter` vs. `LiveKitAdapter`)**: Abstracting credential issuance behind `WebRTCProviderAdapter` allows zero-cost 1-on-1 P2P calls during local evaluation and seamless cutover to a LiveKit SFU for 3+ participant Broker Deal Room video calls without altering client signaling contracts.
3. **Optimistic Concurrency (`version`) vs. Pessimistic Row Locks**: Using an integer `version` column on `land_listings` prevents lost updates when Sellers and Brokers edit a parcel concurrently, returning `409 Conflict` without holding long-lived database transactions.
4. **Geography vs. Geometry in PostGIS**: `location_geog` uses `Geography(POINT, 4326)` so `ST_DWithin` computes exact spheroidal meter distances natively around Bengaluru without manual planar projection distortion.
