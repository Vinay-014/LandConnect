# LandConnect

Full-stack geospatial land marketplace, privacy-preserving deal room, and real-time WebRTC voice/video calling platform built with React, TypeScript, Express, WebSockets, and SQLite WAL. Designed to run zero-config out of the box for local development and portfolio demonstrations while maintaining production-grade durability, concurrency guarantees, and horizontal scaling seams.

---

## Architecture Overview

### Frontend
- **Framework**: React 19, TypeScript, Vite, Tailwind CSS (`src/App.tsx`, `src/components/LandingPage.tsx`, `src/components/ErrorBoundary.tsx`).
- **Geospatial Canvas**: Interactive Google Maps Platform (`@vis.gl/react-google-maps`) with polygon overlays, bounding-box and radius queries, plus a Leaflet fallback (`leaflet`) when no browser Maps API key is configured.
- **Realtime Media & Messaging**: Direct browser `RTCPeerConnection` WebRTC audio/video calling backed by a persistent WebSocket signaling client (`/ws`) and REST state machine (`/api/v1/calls/*`), with audio ringtone synthesis, screen/camera switching, mic/video toggles, call logs, and opt-in browser notifications.
- **Global Error Capture**: `src/main.tsx` attaches `window.onerror` and `unhandledrejection` telemetry handlers wrapped around an application `ErrorBoundary`.

### Backend & Data Layer
- **HTTP & WebSocket Server (`server.ts`)**: Single-process Express + `ws` server serving API routes, WebSocket signaling, Vite middleware in development, and immutable-cached static assets in production (`node server.ts` on Node 22 native TypeScript execution).
- **Relational Store (`server/store.ts`)**: Node native `node:sqlite` running in WAL mode (`PRAGMA journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `mmap_size = 256MB`) with:
  - SQLite **FTS5** full-text index (`listings_fts`) and sync triggers for parcel search.
  - Composite B-tree indexes on coordinates `(latitude, longitude)`, `(city, land_type, price_inr)`, participants, and messages.
  - Optimistic concurrency (`version` column + `If-Match` / conflict `409`) on parcel updates.
  - Persistent 24-hour `idempotency_keys` and 12-hour `grounding_cache` tables.
  - Batch loaders (`findUsersByUuids`, `findListingsByIds`, aggregated `listChatsForUser`) eliminating N+1 queries.
- **Realtime Pub/Sub Abstraction (`server/realtimeBus.ts`, `server/callEngine.ts`)**: `CallSignalingEngine` routes signaling, chat messages, typing indicators, and privacy updates through a `RealtimeBus` interface (`InProcessRealtimeBus` by default; swappable for Redis Pub/Sub across multiple stateless pods).
- **Storage Abstraction (`server/storage.ts`)**: `StorageProvider` interface with `LocalDiskStorageProvider` enforcing strict path confinement, magic-byte validation (PNG/JPEG/WEBP/PDF), and optional `STORAGE_PUBLIC_BASE_URL` CDN prefixing.
- **Security & Rate Limiting (`server/security.ts`)**: Non-blocking async `crypto.scrypt` password hashing, HMAC-SHA256 JWT access tokens, rotating refresh tokens with SQLite JTI revocation, bounded sliding-window rate limiter (`MAX_BUCKETS = 20,000`), mutual-consent phone/email masking, and user blocking enforcement.
- **Server-Side AI Grounding (`server.ts`)**: Optional Gemini Search & Google Maps grounding endpoint (`POST /api/v1/listings/:id/grounding-insights`) backed by SQLite caching (`X-Cache: HIT|MISS`) so external keys remain strictly server-side.

---

## Quick Start (Zero-Config Local & Portfolio Mode)

Prerequisites: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. On first boot, SQLite creates `.data/landconnect.sqlite`, generates runtime JWT signing secrets if unset, and seeds regional parcels, deal rooms, and optional demo personas (`BUYER`, `SELLER`, `BROKER`).

### Running Tests & Type Checks

```bash
npm run lint
npm test
npm run build
npm start
```

### Container Deployment

```bash
docker build -t landconnect:latest .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET="replace-with-32-byte-secret" \
  -e CALL_TOKEN_SECRET="replace-with-32-byte-secret" \
  -v landconnect_data:/app/.data \
  -v landconnect_uploads:/app/uploads \
  landconnect:latest
```

---

## Key Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket listen port |
| `SQLITE_DB_PATH` | `.data/landconnect.sqlite` | SQLite database file path |
| `JWT_SECRET` | Auto-generated in DB | Signing key for access/refresh JWTs |
| `CALL_TOKEN_SECRET` | Auto-generated in DB | Signing key for ephemeral WebRTC room tokens |
| `ENABLE_DEMO_AUTH` | `true` | Set to `false` in production to disable 1-click demo personas |
| `METRICS_TOKEN` | Unset (open) | Optional Bearer token protecting `/metrics` |
| `STORAGE_PUBLIC_BASE_URL` | Unset (local `/uploads`) | CDN or object storage origin prefix for uploaded media/PDFs |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Unset (STUN only) | Optional NAT-traversal TURN relay credentials for WebRTC |
| `GEMINI_API_KEY` | Unset | Optional server-side key for parcel Search & Maps grounding |
| `GROUNDING_CACHE_TTL_HOURS` | `12` | SQLite cache TTL for grounding responses |
| `VITE_GOOGLE_MAPS_API_KEY` | Unset (Leaflet fallback) | Optional browser-restricted Google Maps JavaScript key |

---

## Operational & Scalability Design

- **Health Probes**: `/health/live` (process liveness), `/health/ready` (returns `503` during graceful shutdown draining or DB unavailability), and `/health/deep` (WAL journal mode, coordinate integrity, WebSocket hub stats).
- **Compression & Caching**: Native `zlib.gzip` response compression for compressible payloads >= 1 KB (`Vary: Accept-Encoding`), `Cache-Control: public, max-age=60, stale-while-revalidate=300` on public showcase listings, and immutable 1-year caching on hashed Vite build assets.
- **Graceful Shutdown**: On `SIGTERM`/`SIGINT`, `/health/ready` switches to draining (`503`), active timers and WebSocket servers close cleanly, and SQLite runs `PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);` before exit.
- **Multi-Replica Upgrade Path**: The codebase cleanly isolates stateful boundaries behind interfaces (`RealtimeBus`, `StorageProvider`, `SqliteStore`), enabling a direct transition from single-node SQLite + local disk to PostgreSQL, S3/GCS, and Redis Pub/Sub without rewriting domain routes or client signaling logic.

---

## Implementation Notes & Engineering Decisions

- **Crash-Safe Calling State Machine**: Because WebRTC connections cannot survive a Node process restart, `callEngine.reconcileOnBoot()` reconciles any leftover `RINGING` or `CONNECTED` sessions in SQLite on startup and transitions them cleanly into terminal `MISSED` / `ENDED` audit records.
- **Privacy by Default**: User records are projected through `toPrivacySafeProfile(target, viewerUuid)` on every API response and WebSocket event so phone numbers and email addresses are withheld unless both users belong to a permitted thread and explicit mutual consent has been granted.
- **AI-Assisted Development Workflow**: Architectural planning, geospatial domain modeling, security boundary auditing, and integration test design were authored manually and verified iteratively alongside AI-assisted scaffolding for boilerplate components, responsive Tailwind refinement, and refactoring across backend modules.
