# AI Usage & Engineering Decisions Summary

## Transparent Workflow
- **Architecture & Domain Modeling**: Designed the PostgreSQL + PostGIS spatial schema (`Geography(POINT, 4326)` + `Geometry(POLYGON, 4326)`), Redis sliding-window rate limiter, `Idempotency-Key` replay cache, and authoritative WebRTC call state machine (`RINGING -> CONNECTED -> ENDED | REJECTED | MISSED | BUSY`).
- **Implementation**: AI coding assistance was used to accelerate boilerplate across FastAPI routers, Pydantic v2 DTOs, Alembic migrations, Expo/React components, and Pytest unit tests, with every security boundary (JWT signing, scrypt/Argon2 hashing, RBAC role guards, privacy masking, and path confinement) explicitly structured and verified.
- **Verification**: Verified TypeScript compilation, lint checks, Python AST compilation across all FastAPI modules, and end-to-end 2-tab WebRTC calling and geospatial search flows.
