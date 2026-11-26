import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { configureSecuritySecrets, hashPassword } from './security.ts';
import type {
  CallSession,
  CallState,
  ChatMessage,
  ChatRoom,
  GeoJsonPolygon,
  IdempotencyRecord,
  LandListing,
  LandType,
  ListingReport,
  MessageDeliveryState,
  UserRecord,
  UserRole,
  VerificationStatus,
} from './types.ts';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'landconnect-db.json');

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface UserRow {
  user_uuid: string;
  email: string;
  phone: string;
  password_hash: string;
  display_name: string;
  role: string;
  city: string;
  bio: string;
  allow_calls: number;
  show_contact_after_consent: number;
  is_demo: number;
  created_at: string;
}

interface ListingRow {
  id: string;
  title: string;
  description: string;
  price_inr: number;
  area_sqft: number;
  area_acres: number;
  land_type: string;
  zoning_status: string;
  verification_status: string;
  locality: string;
  city: string;
  latitude: number;
  longitude: number;
  polygon_geojson: string;
  images_json: string;
  owner_uuid: string;
  broker_uuid: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ChatRoomRow {
  id: string;
  room_type: string;
  title: string;
  listing_id: string | null;
  created_by_uuid: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  room_id: string;
  sender_uuid: string;
  message_type: string;
  body: string;
  attachment_url: string | null;
  attachment_name: string | null;
  attachment_type: string | null;
  delivery_state: string;
  created_at: string;
}

interface CallRow {
  call_id: string;
  room_id: string;
  listing_id: string | null;
  caller_uuid: string;
  mode: string;
  state: string;
  webrtc_room_name: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  end_reason: string | null;
}

interface LegacySnapshot {
  users?: UserRecord[];
  listings?: LandListing[];
  chats?: ChatRoom[];
  messages?: ChatMessage[];
  calls?: CallSession[];
  revokedRefreshJtis?: string[];
}

export class SqliteStore {
  private conn: DatabaseSync;
  public readonly dbPath: string;
  public readonly journalMode: string;
  private hasFts5 = false;

  constructor(customPath?: string) {
    const targetPath =
      customPath || process.env.SQLITE_DB_PATH || path.join(DATA_DIR, 'landconnect.sqlite');
    this.dbPath = targetPath;

    if (targetPath !== ':memory:') {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.conn = new DatabaseSync(targetPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });

    this.conn.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -16000;
      PRAGMA mmap_size = 268435456;
    `);
    const modeRow = this.conn.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    this.journalMode = String(modeRow?.journal_mode || 'wal');

    this.migrateSchema();
    this.bootstrapSecrets();
    this.seedOrMigrateInitialData();
    this.ensureCuratedKarnatakaInventory();
  }

  private migrateSchema() {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS app_secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        user_uuid TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('BUYER', 'SELLER', 'BROKER')),
        city TEXT NOT NULL,
        bio TEXT NOT NULL,
        allow_calls INTEGER NOT NULL DEFAULT 1,
        show_contact_after_consent INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_contact_consents (
        owner_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        peer_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_uuid, peer_uuid)
      );

      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price_inr INTEGER NOT NULL CHECK(price_inr > 0),
        area_sqft INTEGER NOT NULL CHECK(area_sqft > 0),
        area_acres REAL NOT NULL CHECK(area_acres > 0),
        land_type TEXT NOT NULL CHECK(land_type IN ('AGRICULTURAL', 'RESIDENTIAL', 'COMMERCIAL', 'INDUSTRIAL')),
        zoning_status TEXT NOT NULL,
        verification_status TEXT NOT NULL CHECK(verification_status IN ('VERIFIED', 'RERA_APPROVED', 'PENDING_SURVEY')),
        locality TEXT NOT NULL,
        city TEXT NOT NULL,
        latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
        longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
        polygon_geojson TEXT NOT NULL,
        images_json TEXT NOT NULL,
        owner_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        broker_uuid TEXT REFERENCES users(user_uuid) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_listings_coords ON listings(latitude, longitude);
      CREATE INDEX IF NOT EXISTS idx_listings_type_price ON listings(land_type, price_inr);
      CREATE INDEX IF NOT EXISTS idx_listings_city_type_price ON listings(city, land_type, price_inr);
      CREATE INDEX IF NOT EXISTS idx_listings_owner ON listings(owner_uuid);
      CREATE INDEX IF NOT EXISTS idx_listings_updated ON listings(updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_rooms (
        id TEXT PRIMARY KEY,
        room_type TEXT NOT NULL CHECK(room_type IN ('DIRECT', 'MEETING_ROOM')),
        title TEXT NOT NULL,
        listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
        created_by_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_participants (
        room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        user_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (room_id, user_uuid)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants(user_uuid, room_id);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        sender_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        message_type TEXT NOT NULL CHECK(message_type IN ('TEXT', 'SYSTEM')),
        body TEXT NOT NULL,
        attachment_url TEXT,
        attachment_name TEXT,
        attachment_type TEXT,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('SENT', 'DELIVERED', 'READ')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room_time ON chat_messages(room_id, created_at, id);

      CREATE TABLE IF NOT EXISTS message_reads (
        message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        reader_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY (message_id, reader_uuid)
      );

      CREATE TABLE IF NOT EXISTS call_sessions (
        call_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
        caller_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('AUDIO', 'VIDEO')),
        state TEXT NOT NULL CHECK(state IN ('RINGING', 'CONNECTED', 'ENDED', 'REJECTED', 'MISSED', 'BUSY')),
        webrtc_room_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        answered_at TEXT,
        ended_at TEXT,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        end_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_calls_started ON call_sessions(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_calls_state ON call_sessions(state);

      CREATE TABLE IF NOT EXISTS call_participants (
        call_id TEXT NOT NULL REFERENCES call_sessions(call_id) ON DELETE CASCADE,
        user_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        role_in_call TEXT NOT NULL CHECK(role_in_call IN ('CALLER', 'CALLEE')),
        PRIMARY KEY (call_id, user_uuid)
      );
      CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_uuid, call_id);

      CREATE TABLE IF NOT EXISTS revoked_refresh_tokens (
        jti TEXT PRIMARY KEY,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        composite_key TEXT PRIMARY KEY,
        key_value TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        user_uuid TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at_ms);

      CREATE TABLE IF NOT EXISTS grounding_cache (
        listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        focus_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (listing_id, focus_key)
      );
      CREATE INDEX IF NOT EXISTS idx_grounding_cache_time ON grounding_cache(created_at_ms);

      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        blocked_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (blocker_uuid, blocked_uuid)
      );
      CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_uuid, blocker_uuid);

      CREATE TABLE IF NOT EXISTS listing_reports (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        reporter_uuid TEXT NOT NULL REFERENCES users(user_uuid) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listing_reports_listing ON listing_reports(listing_id, created_at DESC);
    `);

    const msgCols = this.conn.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>;
    const existingMsgCols = new Set(msgCols.map((c) => c.name));
    if (!existingMsgCols.has('attachment_url')) {
      this.conn.exec('ALTER TABLE chat_messages ADD COLUMN attachment_url TEXT');
    }
    if (!existingMsgCols.has('attachment_name')) {
      this.conn.exec('ALTER TABLE chat_messages ADD COLUMN attachment_name TEXT');
    }
    if (!existingMsgCols.has('attachment_type')) {
      this.conn.exec('ALTER TABLE chat_messages ADD COLUMN attachment_type TEXT');
    }

    try {
      const ftsExists = this.conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listings_fts'")
        .get();
      this.conn.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(
          title,
          locality,
          city,
          description,
          zoning_status,
          content='listings',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS listings_fts_ai AFTER INSERT ON listings BEGIN
          INSERT INTO listings_fts(rowid, title, locality, city, description, zoning_status)
          VALUES (new.rowid, new.title, new.locality, new.city, new.description, new.zoning_status);
        END;

        CREATE TRIGGER IF NOT EXISTS listings_fts_ad AFTER DELETE ON listings BEGIN
          INSERT INTO listings_fts(listings_fts, rowid, title, locality, city, description, zoning_status)
          VALUES ('delete', old.rowid, old.title, old.locality, old.city, old.description, old.zoning_status);
        END;

        CREATE TRIGGER IF NOT EXISTS listings_fts_au AFTER UPDATE ON listings BEGIN
          INSERT INTO listings_fts(listings_fts, rowid, title, locality, city, description, zoning_status)
          VALUES ('delete', old.rowid, old.title, old.locality, old.city, old.description, old.zoning_status);
          INSERT INTO listings_fts(rowid, title, locality, city, description, zoning_status)
          VALUES (new.rowid, new.title, new.locality, new.city, new.description, new.zoning_status);
        END;
      `);
      if (!ftsExists) {
        this.conn.exec("INSERT INTO listings_fts(listings_fts) VALUES('rebuild')");
      }
      this.hasFts5 = true;
    } catch {
      this.hasFts5 = false;
    }
  }

  public withTransaction<T>(fn: () => T): T {
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.conn.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  public getOrCreateSecret(name: string): string {
    const existing = this.conn
      .prepare('SELECT value FROM app_secrets WHERE name = ?')
      .get(name) as { value?: string } | undefined;
    if (existing?.value) return existing.value;

    const generated = crypto.randomBytes(32).toString('hex');
    this.conn
      .prepare('INSERT OR IGNORE INTO app_secrets (name, value, created_at) VALUES (?, ?, ?)')
      .run(name, generated, new Date().toISOString());
    const stored = this.conn
      .prepare('SELECT value FROM app_secrets WHERE name = ?')
      .get(name) as { value: string };
    return stored.value;
  }

  private bootstrapSecrets() {
    configureSecuritySecrets({
      jwtSecret: process.env.JWT_SECRET || this.getOrCreateSecret('jwt_secret'),
      callTokenSecret: process.env.CALL_TOKEN_SECRET || this.getOrCreateSecret('call_token_secret'),
    });
  }

  private seedOrMigrateInitialData() {
    const row = this.conn.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
    if (row.cnt > 0) return;

    if (this.dbPath !== ':memory:' && fs.existsSync(LEGACY_JSON_FILE)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf8')) as LegacySnapshot;
        if (Array.isArray(legacy.users) && legacy.users.length > 0) {
          this.importLegacySnapshot(legacy);
          return;
        }
      } catch {
        // Fall through to clean showcase seeding
      }
    }

    this.seedShowcaseData();
  }

  private importLegacySnapshot(snap: LegacySnapshot) {
    const now = new Date().toISOString();
    const demoEmails = new Set([
      'aarav.buyer@landconnect.in',
      'priya.seller@landconnect.in',
      'rahul.broker@landconnect.in',
    ]);

    this.withTransaction(() => {
      const insUser = this.conn.prepare(`
        INSERT OR IGNORE INTO users
          (user_uuid, email, phone, password_hash, display_name, role, city, bio, allow_calls, show_contact_after_consent, is_demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insConsent = this.conn.prepare(`
        INSERT OR IGNORE INTO user_contact_consents (owner_uuid, peer_uuid, created_at) VALUES (?, ?, ?)
      `);

      for (const u of snap.users || []) {
        insUser.run(
          u.user_uuid,
          u.email.toLowerCase(),
          u.phone,
          u.password_hash,
          u.display_name,
          u.role,
          u.city,
          u.bio,
          u.allow_calls ? 1 : 0,
          u.show_contact_after_consent ? 1 : 0,
          demoEmails.has(u.email.toLowerCase()) ? 1 : 0,
          u.created_at || now,
        );
      }
      for (const u of snap.users || []) {
        for (const peerUuid of u.consented_peer_uuids || []) {
          insConsent.run(u.user_uuid, peerUuid, now);
        }
      }

      const insListing = this.conn.prepare(`
        INSERT OR IGNORE INTO listings
          (id, title, description, price_inr, area_sqft, area_acres, land_type, zoning_status, verification_status, locality, city, latitude, longitude, polygon_geojson, images_json, owner_uuid, broker_uuid, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of snap.listings || []) {
        insListing.run(
          l.id,
          l.title,
          l.description,
          l.price_inr,
          l.area_sqft,
          l.area_acres,
          l.land_type,
          l.zoning_status,
          l.verification_status,
          l.locality,
          l.city,
          l.latitude,
          l.longitude,
          JSON.stringify(l.polygon_geojson),
          JSON.stringify(l.images || []),
          l.owner_uuid,
          l.broker_uuid ?? null,
          l.version || 1,
          l.created_at || now,
          l.updated_at || now,
        );
      }

      const insRoom = this.conn.prepare(`
        INSERT OR IGNORE INTO chat_rooms (id, room_type, title, listing_id, created_by_uuid, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insRoomPart = this.conn.prepare(`
        INSERT OR IGNORE INTO chat_participants (room_id, user_uuid, joined_at) VALUES (?, ?, ?)
      `);
      for (const c of snap.chats || []) {
        insRoom.run(
          c.id,
          c.room_type,
          c.title,
          c.listing_id ?? null,
          c.created_by_uuid,
          c.created_at || now,
          c.updated_at || now,
        );
        for (const uid of c.participant_uuids || []) {
          insRoomPart.run(c.id, uid, c.created_at || now);
        }
      }

      const insMsg = this.conn.prepare(`
        INSERT OR IGNORE INTO chat_messages (id, room_id, sender_uuid, message_type, body, delivery_state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insRead = this.conn.prepare(`
        INSERT OR IGNORE INTO message_reads (message_id, reader_uuid, read_at) VALUES (?, ?, ?)
      `);
      for (const m of snap.messages || []) {
        insMsg.run(m.id, m.room_id, m.sender_uuid, m.message_type, m.body, m.delivery_state, m.created_at || now);
        for (const rUuid of m.read_by_uuids || []) {
          insRead.run(m.id, rUuid, m.created_at || now);
        }
      }

      const insCall = this.conn.prepare(`
        INSERT OR IGNORE INTO call_sessions
          (call_id, room_id, listing_id, caller_uuid, mode, state, webrtc_room_name, started_at, answered_at, ended_at, duration_seconds, end_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insCallPart = this.conn.prepare(`
        INSERT OR IGNORE INTO call_participants (call_id, user_uuid, role_in_call) VALUES (?, ?, ?)
      `);
      for (const call of snap.calls || []) {
        insCall.run(
          call.call_id,
          call.room_id,
          call.listing_id ?? null,
          call.caller_uuid,
          call.mode,
          call.state,
          call.webrtc_room_name,
          call.started_at || now,
          call.answered_at ?? null,
          call.ended_at ?? null,
          call.duration_seconds || 0,
          call.end_reason ?? null,
        );
        insCallPart.run(call.call_id, call.caller_uuid, 'CALLER');
        for (const cid of call.callee_uuids || []) {
          insCallPart.run(call.call_id, cid, 'CALLEE');
        }
      }

      const insRevoked = this.conn.prepare(`
        INSERT OR IGNORE INTO revoked_refresh_tokens (jti, expires_at_ms) VALUES (?, ?)
      `);
      const weekAhead = Date.now() + 7 * 24 * 60 * 60 * 1000;
      for (const jti of snap.revokedRefreshJtis || []) {
        insRevoked.run(jti, weekAhead);
      }
    });
  }

  private seedShowcaseData() {
    // Demo persona login uses dedicated server-side /api/v1/auth/demo-login flow without static client passwords
    const demoSecretHash = hashPassword(crypto.randomBytes(24).toString('hex'));
    const now = new Date().toISOString();

    const buyerUuid = 'usr_buyer_aarav_01';
    const sellerUuid = 'usr_seller_priya_02';
    const brokerUuid = 'usr_broker_rahul_03';
    const seller2Uuid = 'usr_seller_vikram_04';

    const users: UserRecord[] = [
      {
        user_uuid: buyerUuid,
        email: 'aarav.buyer@landconnect.in',
        phone: '+91-98450-11223',
        password_hash: demoSecretHash,
        display_name: 'Aarav Mehta',
        role: 'BUYER',
        city: 'Bengaluru',
        bio: 'Acquiring 2–5 acre clear-title parcels along North Bengaluru & Sarjapur growth corridors.',
        allow_calls: true,
        show_contact_after_consent: false,
        consented_peer_uuids: [],
        is_demo: true,
        created_at: now,
      },
      {
        user_uuid: sellerUuid,
        email: 'priya.seller@landconnect.in',
        phone: '+91-99001-44556',
        password_hash: demoSecretHash,
        display_name: 'Priya Nair',
        role: 'SELLER',
        city: 'Devanahalli, Karnataka',
        bio: 'Direct landowner offering A-Khata residential plots and converted agricultural estates.',
        allow_calls: true,
        show_contact_after_consent: true,
        consented_peer_uuids: [],
        is_demo: true,
        created_at: now,
      },
      {
        user_uuid: brokerUuid,
        email: 'rahul.broker@landconnect.in',
        phone: '+91-97412-88990',
        password_hash: demoSecretHash,
        display_name: 'Rahul Deshmukh',
        role: 'BROKER',
        city: 'Whitefield, Bengaluru',
        bio: 'RERA-registered land advisory specialist facilitating commercial, industrial, and villa plot deals.',
        allow_calls: true,
        show_contact_after_consent: false,
        consented_peer_uuids: [],
        is_demo: true,
        created_at: now,
      },
      {
        user_uuid: seller2Uuid,
        email: 'vikram.seller@landconnect.in',
        phone: '+91-98862-33445',
        password_hash: demoSecretHash,
        display_name: 'Vikram Gowda',
        role: 'SELLER',
        city: 'Kanakapura Road, Karnataka',
        bio: 'Family estate steward managing irrigated orchards and industrial KIADB-adjacent parcels.',
        allow_calls: true,
        show_contact_after_consent: false,
        consented_peer_uuids: [],
        is_demo: false,
        created_at: now,
      },
    ];

    const listings: LandListing[] = [
      {
        id: 'lst_devanahalli_01',
        title: 'Devanahalli Airport Corridor Coconut Estate',
        description:
          'Fertile 4.2-acre irrigated agricultural parcel 11 minutes from Kempegowda International Airport terminal. Clear 30-year EC, drip irrigation, borewell, and 40ft blacktop tar road frontage.',
        price_inr: 64000000,
        area_sqft: 182952,
        area_acres: 4.2,
        land_type: 'AGRICULTURAL',
        zoning_status: 'Green Belt · Clear Title EC (1994–2026)',
        verification_status: 'VERIFIED',
        locality: 'Devanahalli',
        city: 'Bengaluru Rural',
        latitude: 13.2473,
        longitude: 77.7138,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [77.7124, 13.2484],
              [77.7153, 13.2484],
              [77.7155, 13.2462],
              [77.7122, 13.2463],
              [77.7124, 13.2484],
            ],
          ],
        },
        images: ['/src/assets/images/land_devanahalli_farm_1795332740140.jpg'],
        owner_uuid: sellerUuid,
        broker_uuid: brokerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_sarjapur_02',
        title: 'Sarjapur Road Corner Villa Plot — A-Khata',
        description:
          'East-facing 4,800 sq.ft DC-converted residential corner plot inside a gated avenue layout off Sarjapur–Varthur corridor. Underground power, Cauvery pipeline ready, immediate registration.',
        price_inr: 31200000,
        area_sqft: 4800,
        area_acres: 0.11,
        land_type: 'RESIDENTIAL',
        zoning_status: 'BDA / BMRDA Approved · A-Khata',
        verification_status: 'RERA_APPROVED',
        locality: 'Sarjapur Road',
        city: 'Bengaluru',
        latitude: 12.9012,
        longitude: 77.7059,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [77.7051, 12.9019],
              [77.7068, 12.9019],
              [77.7068, 12.9005],
              [77.7051, 12.9005],
              [77.7051, 12.9019],
            ],
          ],
        },
        images: ['/src/assets/images/land_sarjapur_residential_1795332739674.jpg'],
        owner_uuid: sellerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_whitefield_03',
        title: 'Whitefield ITPL Main Road Commercial Corner Parcel',
        description:
          'High-FAR commercial corner parcel spanning 1.15 acres (50,094 sq.ft) with 180ft arterial frontage near Hopefarm Metro Station. Ideal for Grade-A boutique office or mixed-use retail.',
        price_inr: 215000000,
        area_sqft: 50094,
        area_acres: 1.15,
        land_type: 'COMMERCIAL',
        zoning_status: 'Commercial General (C2) · FAR 3.25',
        verification_status: 'VERIFIED',
        locality: 'Whitefield',
        city: 'Bengaluru',
        latitude: 12.9854,
        longitude: 77.7492,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [77.7481, 12.9862],
              [77.7503, 12.9861],
              [77.7502, 12.9845],
              [77.7482, 12.9846],
              [77.7481, 12.9862],
            ],
          ],
        },
        images: ['/src/assets/images/land_whitefield_commercial_1795332740192.jpg'],
        owner_uuid: seller2Uuid,
        broker_uuid: brokerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_peenya_04',
        title: 'Nelamangala–Peenya NH-48 Logistics Industrial Yard',
        description:
          'Leveled 3.0-acre industrial logistics plot 400m from NH-48 Tumkur Expressway. Compaction tested, compound wall erected, 80ft heavy-truck concrete turning bay, HT power feeder nearby.',
        price_inr: 98000000,
        area_sqft: 130680,
        area_acres: 3.0,
        land_type: 'INDUSTRIAL',
        zoning_status: 'KIADB Industrial Zone · Non-Polluting',
        verification_status: 'VERIFIED',
        locality: 'Nelamangala / Peenya',
        city: 'Bengaluru',
        latitude: 13.0764,
        longitude: 77.4521,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [77.4508, 13.0774],
              [77.4535, 13.0773],
              [77.4534, 13.0754],
              [77.4507, 13.0755],
              [77.4508, 13.0774],
            ],
          ],
        },
        images: ['/src/assets/images/land_peenya_industrial_1795332740018.jpg'],
        owner_uuid: seller2Uuid,
        broker_uuid: brokerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_kanakapura_05',
        title: 'Kanakapura Road Mango Orchard & Retreat Parcel',
        description:
          'Scenic 5.6-acre organic mango orchard near Kaggalipura with stone gate, caretaker cottage, dual borewells, and unobstructed hill views. Conversion eligible under farmhouse cluster.',
        price_inr: 52500000,
        area_sqft: 243936,
        area_acres: 5.6,
        land_type: 'AGRICULTURAL',
        zoning_status: 'Agricultural · RTC & Mutation Verified',
        verification_status: 'PENDING_SURVEY',
        locality: 'Kanakapura Road',
        city: 'Bengaluru South',
        latitude: 12.7852,
        longitude: 77.5081,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [77.5065, 12.7864],
              [77.5097, 12.7863],
              [77.5095, 12.7839],
              [77.5064, 12.7841],
              [77.5065, 12.7864],
            ],
          ],
        },
        images: ['/src/assets/images/land_kanakapura_orchard_1795332740710.jpg'],
        owner_uuid: seller2Uuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      ...this.buildKarnatakaRegionalListings(sellerUuid, seller2Uuid, brokerUuid, now),
    ];

    const t1 = new Date(Date.now() - 1000 * 60 * 95).toISOString();
    const t2 = new Date(Date.now() - 1000 * 60 * 88).toISOString();
    const t3 = new Date(Date.now() - 1000 * 60 * 42).toISOString();
    const t4 = new Date(Date.now() - 1000 * 60 * 35).toISOString();

    this.withTransaction(() => {
      const insUser = this.conn.prepare(`
        INSERT INTO users
          (user_uuid, email, phone, password_hash, display_name, role, city, bio, allow_calls, show_contact_after_consent, is_demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const u of users) {
        insUser.run(
          u.user_uuid,
          u.email,
          u.phone,
          u.password_hash,
          u.display_name,
          u.role,
          u.city,
          u.bio,
          u.allow_calls ? 1 : 0,
          u.show_contact_after_consent ? 1 : 0,
          u.is_demo ? 1 : 0,
          u.created_at,
        );
      }

      const insListing = this.conn.prepare(`
        INSERT INTO listings
          (id, title, description, price_inr, area_sqft, area_acres, land_type, zoning_status, verification_status, locality, city, latitude, longitude, polygon_geojson, images_json, owner_uuid, broker_uuid, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of listings) {
        insListing.run(
          l.id,
          l.title,
          l.description,
          l.price_inr,
          l.area_sqft,
          l.area_acres,
          l.land_type,
          l.zoning_status,
          l.verification_status,
          l.locality,
          l.city,
          l.latitude,
          l.longitude,
          JSON.stringify(l.polygon_geojson),
          JSON.stringify(l.images),
          l.owner_uuid,
          l.broker_uuid ?? null,
          l.version,
          l.created_at,
          l.updated_at,
        );
      }

      const insRoom = this.conn.prepare(`
        INSERT INTO chat_rooms (id, room_type, title, listing_id, created_by_uuid, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insRoomPart = this.conn.prepare(`
        INSERT INTO chat_participants (room_id, user_uuid, joined_at) VALUES (?, ?, ?)
      `);
      insRoom.run('chat_direct_sarjapur_01', 'DIRECT', 'Sarjapur Road Corner Villa Plot', 'lst_sarjapur_02', buyerUuid, t1, t2);
      insRoomPart.run('chat_direct_sarjapur_01', buyerUuid, t1);
      insRoomPart.run('chat_direct_sarjapur_01', sellerUuid, t1);

      insRoom.run('chat_meeting_devanahalli_02', 'MEETING_ROOM', 'Devanahalli Estate Deal Room', 'lst_devanahalli_01', brokerUuid, t3, t4);
      insRoomPart.run('chat_meeting_devanahalli_02', brokerUuid, t3);
      insRoomPart.run('chat_meeting_devanahalli_02', buyerUuid, t3);
      insRoomPart.run('chat_meeting_devanahalli_02', sellerUuid, t3);

      const insMsg = this.conn.prepare(`
        INSERT INTO chat_messages (id, room_id, sender_uuid, message_type, body, delivery_state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insRead = this.conn.prepare(`
        INSERT INTO message_reads (message_id, reader_uuid, read_at) VALUES (?, ?, ?)
      `);

      const seedMessages: Array<ChatMessage> = [
        {
          id: 'msg_01',
          room_id: 'chat_direct_sarjapur_01',
          sender_uuid: buyerUuid,
          message_type: 'TEXT',
          body: 'Hi Priya, is the 4,800 sq.ft Sarjapur corner plot available for a site survey this weekend? Keeping my phone private until we align on survey docs.',
          delivery_state: 'READ',
          read_by_uuids: [buyerUuid, sellerUuid],
          created_at: t1,
        },
        {
          id: 'msg_02',
          room_id: 'chat_direct_sarjapur_01',
          sender_uuid: sellerUuid,
          message_type: 'TEXT',
          body: 'Hello Aarav! Yes, A-Khata and latest EC are ready. Feel free to start an in-app audio or video call anytime from this thread.',
          delivery_state: 'READ',
          read_by_uuids: [buyerUuid, sellerUuid],
          created_at: t2,
        },
        {
          id: 'msg_03',
          room_id: 'chat_meeting_devanahalli_02',
          sender_uuid: brokerUuid,
          message_type: 'SYSTEM',
          body: 'Broker Rahul Deshmukh created the Deal Room for Devanahalli Airport Corridor Coconut Estate',
          delivery_state: 'READ',
          read_by_uuids: [brokerUuid, buyerUuid, sellerUuid],
          created_at: t3,
        },
        {
          id: 'msg_04',
          room_id: 'chat_meeting_devanahalli_02',
          sender_uuid: brokerUuid,
          message_type: 'SYSTEM',
          body: 'Broker Rahul added Seller Priya and Buyer Aarav to the deal room',
          delivery_state: 'READ',
          read_by_uuids: [brokerUuid, buyerUuid, sellerUuid],
          created_at: t3,
        },
        {
          id: 'msg_05',
          room_id: 'chat_meeting_devanahalli_02',
          sender_uuid: brokerUuid,
          message_type: 'TEXT',
          body: 'Welcome both. Let us review the 4.2-acre survey sketch and schedule a 3-way video walkthrough right here.',
          delivery_state: 'READ',
          read_by_uuids: [brokerUuid, buyerUuid, sellerUuid],
          created_at: t4,
        },
      ];

      for (const m of seedMessages) {
        insMsg.run(m.id, m.room_id, m.sender_uuid, m.message_type, m.body, m.delivery_state, m.created_at);
        for (const rUuid of m.read_by_uuids) {
          insRead.run(m.id, rUuid, m.created_at);
        }
      }
    });
  }

  private buildKarnatakaRegionalListings(
    sellerUuid: string,
    seller2Uuid: string,
    brokerUuid: string,
    now: string,
  ): LandListing[] {
    return [
      {
        id: 'lst_mysuru_bogadi_06',
        title: 'Mysuru Bogadi Outer Ring Road Residential Plot — MUDA',
        description:
          'East-facing 2,400 sq.ft MUDA-approved residential plot 600m off Bogadi Outer Ring Road. Underground drainage, wide concrete avenue, clear E-Khata, ready for immediate home construction.',
        price_inr: 5000000,
        area_sqft: 2400,
        area_acres: 0.06,
        land_type: 'RESIDENTIAL',
        zoning_status: 'MUDA Approved · E-Khata Clear Title',
        verification_status: 'VERIFIED',
        locality: 'Bogadi Ring Road',
        city: 'Mysuru',
        latitude: 12.2889,
        longitude: 76.5974,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [76.5967, 12.2895],
              [76.5981, 12.2895],
              [76.5981, 12.2883],
              [76.5967, 12.2883],
              [76.5967, 12.2895],
            ],
          ],
        },
        images: ['/src/assets/images/land_sarjapur_residential_1795332739674.jpg'],
        owner_uuid: sellerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_belagavi_tilakwadi_07',
        title: 'Belagavi Tilakwadi Bypass Residential Corner Plot',
        description:
          'Clear-title 3,200 sq.ft BUDA-approved residential corner plot near Tilakwadi Congress Road bypass. Dual 30ft road frontage, municipal water line, and clear 30-year EC.',
        price_inr: 5200000,
        area_sqft: 3200,
        area_acres: 0.07,
        land_type: 'RESIDENTIAL',
        zoning_status: 'BUDA Approved · NA Residential',
        verification_status: 'VERIFIED',
        locality: 'Tilakwadi Bypass',
        city: 'Belagavi',
        latitude: 15.8291,
        longitude: 74.4997,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [74.499, 15.8297],
              [74.5004, 15.8297],
              [74.5004, 15.8285],
              [74.499, 15.8285],
              [74.499, 15.8297],
            ],
          ],
        },
        images: ['/src/assets/images/land_sarjapur_residential_1795332739674.jpg'],
        owner_uuid: sellerUuid,
        broker_uuid: brokerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_chikmagalur_aldur_08',
        title: 'Chikkamagaluru Aldur Foothills Shade Coffee & Pepper Plot',
        description:
          'Lush 1.5-acre Arabica shade-coffee and silver-oak estate along the Aldur–Mudigere foothills road. Perennial stream border, clear Bhoomi RTC, ideal for boutique eco-retreat.',
        price_inr: 5500000,
        area_sqft: 65340,
        area_acres: 1.5,
        land_type: 'AGRICULTURAL',
        zoning_status: 'Agricultural Patta · Clear Bhoomi RTC',
        verification_status: 'VERIFIED',
        locality: 'Aldur–Mudigere Belt',
        city: 'Chikkamagaluru',
        latitude: 13.2146,
        longitude: 75.6762,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [75.675, 13.2155],
              [75.6774, 13.2155],
              [75.6774, 13.2137],
              [75.675, 13.2137],
              [75.675, 13.2155],
            ],
          ],
        },
        images: ['/src/assets/images/land_kanakapura_orchard_1795332740710.jpg'],
        owner_uuid: seller2Uuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_kodagu_kushalnagar_09',
        title: 'Kodagu Kushalnagar Highway Orchard & Homestay Acreage',
        description:
          'Peaceful 1.2-acre spice and fruit orchard 8 minutes off Kushalnagar–Madikeri SH-88. Surveyed boundary stones, village tar road access, 3-phase power line at gate.',
        price_inr: 6200000,
        area_sqft: 52272,
        area_acres: 1.2,
        land_type: 'AGRICULTURAL',
        zoning_status: 'Surveyed RTC · Conversion Eligible',
        verification_status: 'PENDING_SURVEY',
        locality: 'Kushalnagar Corridor',
        city: 'Kodagu',
        latitude: 12.4581,
        longitude: 75.9592,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [75.9581, 12.459],
              [75.9603, 12.459],
              [75.9603, 12.4572],
              [75.9581, 12.4572],
              [75.9581, 12.459],
            ],
          ],
        },
        images: ['/src/assets/images/land_devanahalli_farm_1795332740140.jpg'],
        owner_uuid: seller2Uuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_hubballi_gokul_10',
        title: 'Hubballi Gokul Road Commercial Frontage Plot',
        description:
          'Prime 4,200 sq.ft HDMC commercial parcel along the Gokul Road Airport growth corridor. High visibility 60ft highway access suitable for showroom, clinic, or corporate hub.',
        price_inr: 6800000,
        area_sqft: 4200,
        area_acres: 0.1,
        land_type: 'COMMERCIAL',
        zoning_status: 'HDMC Commercial Zone · Clear Title',
        verification_status: 'RERA_APPROVED',
        locality: 'Gokul Road Airport Belt',
        city: 'Hubballi',
        latitude: 15.3617,
        longitude: 75.0849,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [75.0841, 15.3624],
              [75.0857, 15.3624],
              [75.0857, 15.361],
              [75.0841, 15.361],
              [75.0841, 15.3624],
            ],
          ],
        },
        images: ['/src/assets/images/land_whitefield_commercial_1795332740192.jpg'],
        owner_uuid: sellerUuid,
        broker_uuid: brokerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'lst_mangaluru_baikampady_11',
        title: 'Mangaluru NH-66 Baikampady Warehousing Industrial Plot',
        description:
          'Compact 18,000 sq.ft (0.41-acre) leveled industrial plot 900m from NH-66 and New Mangalore Port approach. Heavy-vehicle concrete road, storm drain, and HT power proximity.',
        price_inr: 8400000,
        area_sqft: 18000,
        area_acres: 0.41,
        land_type: 'INDUSTRIAL',
        zoning_status: 'KIADB Coastal Industrial Zone · Non-Polluting',
        verification_status: 'VERIFIED',
        locality: 'Baikampady NH-66',
        city: 'Mangaluru',
        latitude: 12.9562,
        longitude: 74.8126,
        polygon_geojson: {
          type: 'Polygon',
          coordinates: [
            [
              [74.8116, 12.957],
              [74.8136, 12.957],
              [74.8136, 12.9554],
              [74.8116, 12.9554],
              [74.8116, 12.957],
            ],
          ],
        },
        images: ['/src/assets/images/land_peenya_industrial_1795332740018.jpg'],
        owner_uuid: seller2Uuid,
        broker_uuid: brokerUuid,
        version: 1,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  private ensureCuratedKarnatakaInventory() {
    const sellerRow = this.conn
      .prepare('SELECT user_uuid FROM users WHERE user_uuid = ?')
      .get('usr_seller_priya_02') as { user_uuid?: string } | undefined;
    const seller2Row = this.conn
      .prepare('SELECT user_uuid FROM users WHERE user_uuid = ?')
      .get('usr_seller_vikram_04') as { user_uuid?: string } | undefined;
    if (!sellerRow?.user_uuid || !seller2Row?.user_uuid) return;

    const brokerRow = this.conn
      .prepare('SELECT user_uuid FROM users WHERE user_uuid = ?')
      .get('usr_broker_rahul_03') as { user_uuid?: string } | undefined;

    const now = new Date().toISOString();
    const regional = this.buildKarnatakaRegionalListings(
      sellerRow.user_uuid,
      seller2Row.user_uuid,
      brokerRow?.user_uuid ?? sellerRow.user_uuid,
      now,
    );

    const insListing = this.conn.prepare(`
      INSERT OR IGNORE INTO listings
        (id, title, description, price_inr, area_sqft, area_acres, land_type, zoning_status, verification_status, locality, city, latitude, longitude, polygon_geojson, images_json, owner_uuid, broker_uuid, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.withTransaction(() => {
      for (const l of regional) {
        insListing.run(
          l.id,
          l.title,
          l.description,
          l.price_inr,
          l.area_sqft,
          l.area_acres,
          l.land_type,
          l.zoning_status,
          l.verification_status,
          l.locality,
          l.city,
          l.latitude,
          l.longitude,
          JSON.stringify(l.polygon_geojson),
          JSON.stringify(l.images),
          l.owner_uuid,
          l.broker_uuid ?? null,
          l.version,
          l.created_at,
          l.updated_at,
        );
      }
    });
  }

  private hydrateUserRow(row: UserRow): UserRecord {
    const consents = this.conn
      .prepare('SELECT peer_uuid FROM user_contact_consents WHERE owner_uuid = ?')
      .all(row.user_uuid) as Array<{ peer_uuid: string }>;

    return {
      user_uuid: row.user_uuid,
      email: row.email,
      phone: row.phone,
      password_hash: row.password_hash,
      display_name: row.display_name,
      role: row.role as UserRole,
      city: row.city,
      bio: row.bio,
      allow_calls: Boolean(row.allow_calls),
      show_contact_after_consent: Boolean(row.show_contact_after_consent),
      consented_peer_uuids: consents.map((c) => c.peer_uuid),
      is_demo: Boolean(row.is_demo),
      created_at: row.created_at,
    };
  }

  private hydrateListingRow(row: ListingRow): LandListing {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      price_inr: row.price_inr,
      area_sqft: row.area_sqft,
      area_acres: row.area_acres,
      land_type: row.land_type as LandType,
      zoning_status: row.zoning_status,
      verification_status: row.verification_status as VerificationStatus,
      locality: row.locality,
      city: row.city,
      latitude: row.latitude,
      longitude: row.longitude,
      polygon_geojson: JSON.parse(row.polygon_geojson) as GeoJsonPolygon,
      images: JSON.parse(row.images_json) as string[],
      owner_uuid: row.owner_uuid,
      broker_uuid: row.broker_uuid ?? undefined,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private hydrateCallRow(row: CallRow): CallSession {
    const callees = this.conn
      .prepare("SELECT user_uuid FROM call_participants WHERE call_id = ? AND role_in_call = 'CALLEE'")
      .all(row.call_id) as Array<{ user_uuid: string }>;
    return {
      call_id: row.call_id,
      room_id: row.room_id,
      listing_id: row.listing_id ?? undefined,
      caller_uuid: row.caller_uuid,
      callee_uuids: callees.map((c) => c.user_uuid),
      mode: row.mode as 'AUDIO' | 'VIDEO',
      state: row.state as CallState,
      webrtc_room_name: row.webrtc_room_name,
      started_at: row.started_at,
      answered_at: row.answered_at ?? undefined,
      ended_at: row.ended_at ?? undefined,
      duration_seconds: row.duration_seconds,
      end_reason: row.end_reason ?? undefined,
    };
  }

  // ------------------------------------------------------------------
  // USERS & PRIVACY
  // ------------------------------------------------------------------
  findUserByEmail(email: string): UserRecord | undefined {
    const row = this.conn
      .prepare('SELECT * FROM users WHERE lower(email) = lower(?)')
      .get(email.trim()) as UserRow | undefined;
    return row ? this.hydrateUserRow(row) : undefined;
  }

  findUserByUuid(uuid: string): UserRecord | undefined {
    const row = this.conn
      .prepare('SELECT * FROM users WHERE user_uuid = ?')
      .get(uuid) as UserRow | undefined;
    return row ? this.hydrateUserRow(row) : undefined;
  }

  findUsersByUuids(uuids: string[]): Map<string, UserRecord> {
    const unique = Array.from(new Set(uuids.filter(Boolean)));
    const result = new Map<string, UserRecord>();
    if (unique.length === 0) return result;

    const placeholders = unique.map(() => '?').join(',');
    const rows = this.conn
      .prepare(`SELECT * FROM users WHERE user_uuid IN (${placeholders})`)
      .all(...unique) as unknown as UserRow[];

    const consentRows = this.conn
      .prepare(`SELECT owner_uuid, peer_uuid FROM user_contact_consents WHERE owner_uuid IN (${placeholders})`)
      .all(...unique) as Array<{ owner_uuid: string; peer_uuid: string }>;

    const consentsByOwner = new Map<string, string[]>();
    for (const c of consentRows) {
      let arr = consentsByOwner.get(c.owner_uuid);
      if (!arr) {
        arr = [];
        consentsByOwner.set(c.owner_uuid, arr);
      }
      arr.push(c.peer_uuid);
    }

    for (const row of rows) {
      result.set(row.user_uuid, {
        user_uuid: row.user_uuid,
        email: row.email,
        phone: row.phone,
        password_hash: row.password_hash,
        display_name: row.display_name,
        role: row.role as UserRole,
        city: row.city,
        bio: row.bio,
        allow_calls: Boolean(row.allow_calls),
        show_contact_after_consent: Boolean(row.show_contact_after_consent),
        consented_peer_uuids: consentsByOwner.get(row.user_uuid) ?? [],
        is_demo: Boolean(row.is_demo),
        created_at: row.created_at,
      });
    }
    return result;
  }

  findDemoUserByRole(role: UserRole): UserRecord | undefined {
    const row = this.conn
      .prepare('SELECT * FROM users WHERE role = ? AND is_demo = 1 ORDER BY created_at ASC LIMIT 1')
      .get(role) as UserRow | undefined;
    return row ? this.hydrateUserRow(row) : undefined;
  }

  listUsers(): UserRecord[] {
    return this.listUsersPage({ limit: 500, offset: 0 }).items;
  }

  listUsersPage(opts: { q?: string; limit?: number; offset?: number } = {}): {
    items: UserRecord[];
    total: number;
  } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.q && opts.q.trim()) {
      const needle = `%${opts.q.trim().toLowerCase()}%`;
      clauses.push('(lower(display_name) LIKE ? OR lower(city) LIKE ? OR lower(role) LIKE ?)');
      params.push(needle, needle, needle);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);

    const totalRow = this.conn
      .prepare(`SELECT COUNT(*) AS cnt FROM users ${whereSql}`)
      .get(...params) as { cnt: number };
    const rows = this.conn
      .prepare(`SELECT * FROM users ${whereSql} ORDER BY created_at ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as UserRow[];

    const userMap = this.findUsersByUuids(rows.map((r) => r.user_uuid));
    return {
      items: rows.map((r) => userMap.get(r.user_uuid)!).filter(Boolean),
      total: totalRow.cnt,
    };
  }

  createUser(user: UserRecord): UserRecord {
    this.conn
      .prepare(`
        INSERT INTO users
          (user_uuid, email, phone, password_hash, display_name, role, city, bio, allow_calls, show_contact_after_consent, is_demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        user.user_uuid,
        user.email.toLowerCase(),
        user.phone,
        user.password_hash,
        user.display_name,
        user.role,
        user.city,
        user.bio,
        user.allow_calls ? 1 : 0,
        user.show_contact_after_consent ? 1 : 0,
        user.is_demo ? 1 : 0,
        user.created_at,
      );
    return user;
  }

  updateUserPrivacy(
    userUuid: string,
    patch: {
      allow_calls?: boolean;
      show_contact_after_consent?: boolean;
      consent_peer_uuid?: string;
      revoke_peer_uuid?: string;
    },
  ): UserRecord | undefined {
    return this.withTransaction(() => {
      const existing = this.findUserByUuid(userUuid);
      if (!existing) return undefined;

      const allowCalls = typeof patch.allow_calls === 'boolean' ? patch.allow_calls : existing.allow_calls;
      const showConsent =
        typeof patch.show_contact_after_consent === 'boolean'
          ? patch.show_contact_after_consent
          : existing.show_contact_after_consent;

      this.conn
        .prepare('UPDATE users SET allow_calls = ?, show_contact_after_consent = ? WHERE user_uuid = ?')
        .run(allowCalls ? 1 : 0, showConsent ? 1 : 0, userUuid);

      if (typeof patch.consent_peer_uuid === 'string' && patch.consent_peer_uuid !== userUuid) {
        const peerExists = this.conn
          .prepare('SELECT 1 FROM users WHERE user_uuid = ?')
          .get(patch.consent_peer_uuid);
        if (peerExists) {
          this.conn
            .prepare('INSERT OR IGNORE INTO user_contact_consents (owner_uuid, peer_uuid, created_at) VALUES (?, ?, ?)')
            .run(userUuid, patch.consent_peer_uuid, new Date().toISOString());
        }
      }
      if (typeof patch.revoke_peer_uuid === 'string') {
        this.conn
          .prepare('DELETE FROM user_contact_consents WHERE owner_uuid = ? AND peer_uuid = ?')
          .run(userUuid, patch.revoke_peer_uuid);
      }

      return this.findUserByUuid(userUuid);
    });
  }

  updateUserProfile(
    userUuid: string,
    patch: { display_name?: string; city?: string; bio?: string },
  ): UserRecord | undefined {
    const existing = this.findUserByUuid(userUuid);
    if (!existing) return undefined;
    const nextName = patch.display_name?.trim() || existing.display_name;
    const nextCity = patch.city?.trim() || existing.city;
    const nextBio = patch.bio !== undefined ? patch.bio.trim() || existing.bio : existing.bio;
    this.conn
      .prepare('UPDATE users SET display_name = ?, city = ?, bio = ? WHERE user_uuid = ?')
      .run(nextName, nextCity, nextBio, userUuid);
    return this.findUserByUuid(userUuid);
  }

  updateUserPassword(userUuid: string, newPasswordHash: string): boolean {
    const info = this.conn
      .prepare('UPDATE users SET password_hash = ? WHERE user_uuid = ?')
      .run(newPasswordHash, userUuid);
    return info.changes > 0;
  }

  blockUser(blockerUuid: string, blockedUuid: string, reason = ''): boolean {
    if (blockerUuid === blockedUuid) return false;
    const targetExists = this.conn.prepare('SELECT 1 FROM users WHERE user_uuid = ?').get(blockedUuid);
    if (!targetExists) return false;
    this.conn
      .prepare('INSERT OR REPLACE INTO user_blocks (blocker_uuid, blocked_uuid, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(blockerUuid, blockedUuid, reason.trim().slice(0, 240), new Date().toISOString());
    return true;
  }

  unblockUser(blockerUuid: string, blockedUuid: string): boolean {
    const info = this.conn
      .prepare('DELETE FROM user_blocks WHERE blocker_uuid = ? AND blocked_uuid = ?')
      .run(blockerUuid, blockedUuid);
    return info.changes > 0;
  }

  isBlockedBetween(userA: string, userB: string): boolean {
    const row = this.conn
      .prepare(
        'SELECT 1 FROM user_blocks WHERE (blocker_uuid = ? AND blocked_uuid = ?) OR (blocker_uuid = ? AND blocked_uuid = ?) LIMIT 1',
      )
      .get(userA, userB, userB, userA);
    return Boolean(row);
  }

  listBlockedUsers(blockerUuid: string): string[] {
    const rows = this.conn
      .prepare('SELECT blocked_uuid FROM user_blocks WHERE blocker_uuid = ? ORDER BY created_at DESC')
      .all(blockerUuid) as Array<{ blocked_uuid: string }>;
    return rows.map((r) => r.blocked_uuid);
  }

  createListingReport(report: ListingReport): ListingReport {
    this.conn
      .prepare(
        'INSERT INTO listing_reports (id, listing_id, reporter_uuid, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(report.id, report.listing_id, report.reporter_uuid, report.reason, report.details, report.created_at);
    return report;
  }

  getGroundingCache(listingId: string, focusKey: string, ttlHours = 12): Record<string, unknown> | null {
    const row = this.conn
      .prepare('SELECT payload_json, created_at_ms FROM grounding_cache WHERE listing_id = ? AND focus_key = ?')
      .get(listingId, focusKey) as { payload_json: string; created_at_ms: number } | undefined;
    if (!row) return null;
    const maxAgeMs = Math.max(1, ttlHours) * 60 * 60 * 1000;
    if (Date.now() - row.created_at_ms > maxAgeMs) {
      this.conn
        .prepare('DELETE FROM grounding_cache WHERE listing_id = ? AND focus_key = ?')
        .run(listingId, focusKey);
      return null;
    }
    try {
      return JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  setGroundingCache(listingId: string, focusKey: string, payload: unknown): void {
    const now = Date.now();
    this.conn
      .prepare(
        'INSERT OR REPLACE INTO grounding_cache (listing_id, focus_key, payload_json, created_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run(listingId, focusKey, JSON.stringify(payload), now);
    this.conn
      .prepare('DELETE FROM grounding_cache WHERE created_at_ms < ?')
      .run(now - 7 * 24 * 60 * 60 * 1000);
  }

  // ------------------------------------------------------------------
  // LISTINGS & SPATIAL QUERIES
  // ------------------------------------------------------------------
  findListingById(id: string): LandListing | undefined {
    const row = this.conn.prepare('SELECT * FROM listings WHERE id = ?').get(id) as ListingRow | undefined;
    return row ? this.hydrateListingRow(row) : undefined;
  }

  findListingsByIds(ids: string[]): Map<string, LandListing> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    const result = new Map<string, LandListing>();
    if (unique.length === 0) return result;
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.conn
      .prepare(`SELECT * FROM listings WHERE id IN (${placeholders})`)
      .all(...unique) as unknown as ListingRow[];
    for (const r of rows) {
      result.set(r.id, this.hydrateListingRow(r));
    }
    return result;
  }

  queryListings(filters: {
    landType?: string;
    city?: string;
    minPrice?: number;
    maxPrice?: number;
    q?: string;
    sort?: 'price_asc' | 'price_desc' | 'updated_desc';
    limit?: number;
    offset?: number;
  }): { items: LandListing[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filters.landType && filters.landType !== 'ALL') {
      clauses.push('land_type = ?');
      params.push(filters.landType.toUpperCase());
    }
    if (filters.city && filters.city !== 'ALL') {
      clauses.push('lower(city) LIKE ?');
      params.push(`%${filters.city.trim().toLowerCase()}%`);
    }
    if (typeof filters.minPrice === 'number' && Number.isFinite(filters.minPrice)) {
      clauses.push('price_inr >= ?');
      params.push(filters.minPrice);
    }
    if (typeof filters.maxPrice === 'number' && Number.isFinite(filters.maxPrice)) {
      clauses.push('price_inr <= ?');
      params.push(filters.maxPrice);
    }
    if (filters.q && filters.q.trim()) {
      const tokens = filters.q
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
        .filter((t) => t.length >= 2);
      if (this.hasFts5 && tokens.length > 0) {
        const matchExpr = tokens.map((t) => `"${t}"*`).join(' ');
        clauses.push('rowid IN (SELECT rowid FROM listings_fts WHERE listings_fts MATCH ?)');
        params.push(matchExpr);
      } else {
        const needle = `%${filters.q.trim().toLowerCase()}%`;
        clauses.push('(lower(title) LIKE ? OR lower(locality) LIKE ? OR lower(description) LIKE ? OR lower(city) LIKE ?)');
        params.push(needle, needle, needle, needle);
      }
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderSql =
      filters.sort === 'price_asc'
        ? 'ORDER BY price_inr ASC, updated_at DESC'
        : filters.sort === 'price_desc'
          ? 'ORDER BY price_inr DESC, updated_at DESC'
          : 'ORDER BY updated_at DESC, price_inr ASC';
    const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);

    const countRow = this.conn
      .prepare(`SELECT COUNT(*) AS cnt FROM listings ${whereSql}`)
      .get(...params) as { cnt: number };
    const rows = this.conn
      .prepare(`SELECT * FROM listings ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as ListingRow[];

    return {
      items: rows.map((r) => this.hydrateListingRow(r)),
      total: countRow.cnt,
    };
  }

  queryListingsNearby(lat: number, lng: number, radiusKm: number, limit = 100): LandListing[] {
    // Bounding-box pre-filter leverages idx_listings_coords B-Tree before Haversine distance filter
    const latDelta = radiusKm / 111.045;
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const lngDelta = radiusKm / (111.045 * cosLat);

    const rows = this.conn
      .prepare(`
        SELECT * FROM listings
        WHERE latitude BETWEEN ? AND ?
          AND longitude BETWEEN ? AND ?
      `)
      .all(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta) as unknown as ListingRow[];

    return rows
      .map((r) => {
        const hydrated = this.hydrateListingRow(r);
        hydrated.distance_km = Number(haversineKm(lat, lng, hydrated.latitude, hydrated.longitude).toFixed(2));
        return hydrated;
      })
      .filter((l) => (l.distance_km ?? Infinity) <= radiusKm)
      .sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0))
      .slice(0, limit);
  }

  queryListingsBbox(minLng: number, minLat: number, maxLng: number, maxLat: number, limit = 100): LandListing[] {
    const rows = this.conn
      .prepare(`
        SELECT * FROM listings
        WHERE longitude BETWEEN ? AND ?
          AND latitude BETWEEN ? AND ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(minLng, maxLng, minLat, maxLat, limit) as unknown as ListingRow[];
    return rows.map((r) => this.hydrateListingRow(r));
  }

  createListing(listing: LandListing): LandListing {
    this.conn
      .prepare(`
        INSERT INTO listings
          (id, title, description, price_inr, area_sqft, area_acres, land_type, zoning_status, verification_status, locality, city, latitude, longitude, polygon_geojson, images_json, owner_uuid, broker_uuid, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        listing.id,
        listing.title,
        listing.description,
        listing.price_inr,
        listing.area_sqft,
        listing.area_acres,
        listing.land_type,
        listing.zoning_status,
        listing.verification_status,
        listing.locality,
        listing.city,
        listing.latitude,
        listing.longitude,
        JSON.stringify(listing.polygon_geojson),
        JSON.stringify(listing.images),
        listing.owner_uuid,
        listing.broker_uuid ?? null,
        listing.version,
        listing.created_at,
        listing.updated_at,
      );
    return listing;
  }

  updateListingOptimistic(params: {
    id: string;
    actorUuid: string;
    actorRole: UserRole;
    expectedVersion?: number;
    patch: { title?: string; description?: string; price_inr?: number; zoning_status?: string };
  }):
    | { status: 'OK'; listing: LandListing }
    | { status: 'NOT_FOUND' }
    | { status: 'FORBIDDEN' }
    | { status: 'CONFLICT'; currentVersion: number } {
    return this.withTransaction(() => {
      const current = this.findListingById(params.id);
      if (!current) return { status: 'NOT_FOUND' as const };
      if (params.actorRole === 'SELLER' && current.owner_uuid !== params.actorUuid) {
        return { status: 'FORBIDDEN' as const };
      }

      const targetVersion =
        typeof params.expectedVersion === 'number' && !Number.isNaN(params.expectedVersion)
          ? params.expectedVersion
          : current.version;

      if (targetVersion !== current.version) {
        return { status: 'CONFLICT' as const, currentVersion: current.version };
      }

      const nextTitle = params.patch.title?.trim() || current.title;
      const nextDescription = params.patch.description?.trim() || current.description;
      const nextPrice =
        typeof params.patch.price_inr === 'number' && params.patch.price_inr > 0
          ? params.patch.price_inr
          : current.price_inr;
      const nextZoning = params.patch.zoning_status?.trim() || current.zoning_status;
      const now = new Date().toISOString();

      const info = this.conn
        .prepare(`
          UPDATE listings
          SET title = ?, description = ?, price_inr = ?, zoning_status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `)
        .run(nextTitle, nextDescription, nextPrice, nextZoning, now, params.id, targetVersion);

      if (info.changes === 0) {
        const latest = this.findListingById(params.id);
        return { status: 'CONFLICT' as const, currentVersion: latest?.version ?? current.version };
      }

      return { status: 'OK' as const, listing: this.findListingById(params.id)! };
    });
  }

  verifyListing(id: string, brokerUuid: string, nextStatus: VerificationStatus): LandListing | undefined {
    return this.withTransaction(() => {
      const current = this.findListingById(id);
      if (!current) return undefined;
      const now = new Date().toISOString();
      this.conn
        .prepare(`
          UPDATE listings
          SET verification_status = ?, broker_uuid = COALESCE(broker_uuid, ?), version = version + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(nextStatus, brokerUuid, now, id);
      return this.findListingById(id);
    });
  }

  deleteListing(id: string, actorUuid: string, actorRole: UserRole): 'DELETED' | 'NOT_FOUND' | 'FORBIDDEN' {
    return this.withTransaction(() => {
      const existing = this.findListingById(id);
      if (!existing) return 'NOT_FOUND';
      if (actorRole === 'SELLER' && existing.owner_uuid !== actorUuid) {
        return 'FORBIDDEN';
      }
      this.conn.prepare('DELETE FROM listings WHERE id = ?').run(id);
      return 'DELETED';
    });
  }

  // ------------------------------------------------------------------
  // CHATS, DEAL ROOMS & MESSAGES
  // ------------------------------------------------------------------
  findChatRoomById(roomId: string): ChatRoom | undefined {
    const row = this.conn.prepare('SELECT * FROM chat_rooms WHERE id = ?').get(roomId) as ChatRoomRow | undefined;
    if (!row) return undefined;
    const parts = this.conn
      .prepare('SELECT user_uuid FROM chat_participants WHERE room_id = ? ORDER BY joined_at ASC')
      .all(roomId) as Array<{ user_uuid: string }>;
    return {
      id: row.id,
      room_type: row.room_type as 'DIRECT' | 'MEETING_ROOM',
      title: row.title,
      listing_id: row.listing_id ?? '',
      participant_uuids: parts.map((p) => p.user_uuid),
      created_by_uuid: row.created_by_uuid,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  findDirectChat(listingId: string, userA: string, userB: string): ChatRoom | undefined {
    const row = this.conn
      .prepare(`
        SELECT r.id FROM chat_rooms r
        JOIN chat_participants p1 ON p1.room_id = r.id AND p1.user_uuid = ?
        JOIN chat_participants p2 ON p2.room_id = r.id AND p2.user_uuid = ?
        WHERE r.room_type = 'DIRECT' AND r.listing_id = ?
        LIMIT 1
      `)
      .get(userA, userB, listingId) as { id?: string } | undefined;
    return row?.id ? this.findChatRoomById(row.id) : undefined;
  }

  listChatsForUser(viewerUuid: string): Array<{
    room: ChatRoom;
    listing: LandListing | null;
    last_message: ChatMessage | null;
    unread_count: number;
  }> {
    const roomRows = this.conn
      .prepare(`
        SELECT r.* FROM chat_rooms r
        JOIN chat_participants cp ON cp.room_id = r.id
        WHERE cp.user_uuid = ?
        ORDER BY r.updated_at DESC
      `)
      .all(viewerUuid) as unknown as ChatRoomRow[];

    if (roomRows.length === 0) return [];

    const roomIds = roomRows.map((r) => r.id);
    const roomPlaceholders = roomIds.map(() => '?').join(',');

    const partRows = this.conn
      .prepare(
        `SELECT room_id, user_uuid FROM chat_participants WHERE room_id IN (${roomPlaceholders}) ORDER BY joined_at ASC`,
      )
      .all(...roomIds) as Array<{ room_id: string; user_uuid: string }>;
    const participantsByRoom = new Map<string, string[]>();
    for (const p of partRows) {
      let arr = participantsByRoom.get(p.room_id);
      if (!arr) {
        arr = [];
        participantsByRoom.set(p.room_id, arr);
      }
      arr.push(p.user_uuid);
    }

    const listingIds = roomRows.map((r) => r.listing_id).filter((id): id is string => Boolean(id));
    const listingsById = this.findListingsByIds(listingIds);

    const lastMsgRows = this.conn
      .prepare(`
        SELECT m.* FROM chat_messages m
        JOIN (
          SELECT room_id, MAX(rowid) AS max_rowid
          FROM chat_messages
          WHERE room_id IN (${roomPlaceholders})
          GROUP BY room_id
        ) latest ON latest.max_rowid = m.rowid
      `)
      .all(...roomIds) as unknown as ChatMessageRow[];
    const lastMsgByRoom = new Map<string, ChatMessageRow>();
    for (const m of lastMsgRows) {
      lastMsgByRoom.set(m.room_id, m);
    }

    const lastMsgIds = lastMsgRows.map((m) => m.id);
    const readsByMsg = new Map<string, string[]>();
    if (lastMsgIds.length > 0) {
      const msgPlaceholders = lastMsgIds.map(() => '?').join(',');
      const readRows = this.conn
        .prepare(`SELECT message_id, reader_uuid FROM message_reads WHERE message_id IN (${msgPlaceholders})`)
        .all(...lastMsgIds) as Array<{ message_id: string; reader_uuid: string }>;
      for (const rd of readRows) {
        let arr = readsByMsg.get(rd.message_id);
        if (!arr) {
          arr = [];
          readsByMsg.set(rd.message_id, arr);
        }
        arr.push(rd.reader_uuid);
      }
    }

    const unreadRows = this.conn
      .prepare(`
        SELECT m.room_id, COUNT(*) AS cnt
        FROM chat_messages m
        WHERE m.room_id IN (${roomPlaceholders})
          AND m.sender_uuid != ?
          AND NOT EXISTS (
            SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.reader_uuid = ?
          )
        GROUP BY m.room_id
      `)
      .all(...roomIds, viewerUuid, viewerUuid) as Array<{ room_id: string; cnt: number }>;
    const unreadByRoom = new Map<string, number>();
    for (const u of unreadRows) {
      unreadByRoom.set(u.room_id, u.cnt);
    }

    return roomRows.map((rr) => {
      const room: ChatRoom = {
        id: rr.id,
        room_type: rr.room_type as 'DIRECT' | 'MEETING_ROOM',
        title: rr.title,
        listing_id: rr.listing_id ?? '',
        participant_uuids: participantsByRoom.get(rr.id) ?? [],
        created_by_uuid: rr.created_by_uuid,
        created_at: rr.created_at,
        updated_at: rr.updated_at,
      };
      const lastRow = lastMsgByRoom.get(rr.id);
      const lastMessage: ChatMessage | null = lastRow
        ? {
            id: lastRow.id,
            room_id: lastRow.room_id,
            sender_uuid: lastRow.sender_uuid,
            message_type: lastRow.message_type as 'TEXT' | 'SYSTEM',
            body: lastRow.body,
            ...(lastRow.attachment_url ? { attachment_url: lastRow.attachment_url } : {}),
            ...(lastRow.attachment_name ? { attachment_name: lastRow.attachment_name } : {}),
            ...(lastRow.attachment_type ? { attachment_type: lastRow.attachment_type } : {}),
            delivery_state: lastRow.delivery_state as MessageDeliveryState,
            read_by_uuids: readsByMsg.get(lastRow.id) ?? [],
            created_at: lastRow.created_at,
          }
        : null;

      return {
        room,
        listing: rr.listing_id ? listingsById.get(rr.listing_id) ?? null : null,
        last_message: lastMessage,
        unread_count: unreadByRoom.get(rr.id) ?? 0,
      };
    });
  }

  private hydrateMessageRow(row: ChatMessageRow): ChatMessage {
    const reads = this.conn
      .prepare('SELECT reader_uuid FROM message_reads WHERE message_id = ?')
      .all(row.id) as Array<{ reader_uuid: string }>;
    return {
      id: row.id,
      room_id: row.room_id,
      sender_uuid: row.sender_uuid,
      message_type: row.message_type as 'TEXT' | 'SYSTEM',
      body: row.body,
      ...(row.attachment_url ? { attachment_url: row.attachment_url } : {}),
      ...(row.attachment_name ? { attachment_name: row.attachment_name } : {}),
      ...(row.attachment_type ? { attachment_type: row.attachment_type } : {}),
      delivery_state: row.delivery_state as MessageDeliveryState,
      read_by_uuids: reads.map((r) => r.reader_uuid),
      created_at: row.created_at,
    };
  }

  createChatRoom(room: ChatRoom, initialMessages: ChatMessage[] = []): ChatRoom {
    this.withTransaction(() => {
      this.conn
        .prepare(`
          INSERT INTO chat_rooms (id, room_type, title, listing_id, created_by_uuid, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          room.id,
          room.room_type,
          room.title,
          room.listing_id || null,
          room.created_by_uuid,
          room.created_at,
          room.updated_at,
        );

      const insPart = this.conn.prepare(
        'INSERT OR IGNORE INTO chat_participants (room_id, user_uuid, joined_at) VALUES (?, ?, ?)',
      );
      for (const uid of room.participant_uuids) {
        insPart.run(room.id, uid, room.created_at);
      }

      const insMsg = this.conn.prepare(`
        INSERT INTO chat_messages (id, room_id, sender_uuid, message_type, body, attachment_url, attachment_name, attachment_type, delivery_state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insRead = this.conn.prepare(
        'INSERT OR IGNORE INTO message_reads (message_id, reader_uuid, read_at) VALUES (?, ?, ?)',
      );
      for (const m of initialMessages) {
        insMsg.run(
          m.id,
          m.room_id,
          m.sender_uuid,
          m.message_type,
          m.body,
          m.attachment_url ?? null,
          m.attachment_name ?? null,
          m.attachment_type ?? null,
          m.delivery_state,
          m.created_at,
        );
        for (const r of m.read_by_uuids) {
          insRead.run(m.id, r, m.created_at);
        }
      }
    });
    return room;
  }

  addParticipantToRoom(roomId: string, peerUuid: string, systemMessage: ChatMessage): ChatRoom | undefined {
    return this.withTransaction(() => {
      const room = this.findChatRoomById(roomId);
      if (!room) return undefined;
      if (room.participant_uuids.includes(peerUuid)) return room;

      this.conn
        .prepare('INSERT OR IGNORE INTO chat_participants (room_id, user_uuid, joined_at) VALUES (?, ?, ?)')
        .run(roomId, peerUuid, systemMessage.created_at);
      this.conn
        .prepare(`
          INSERT INTO chat_messages (id, room_id, sender_uuid, message_type, body, delivery_state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          systemMessage.id,
          systemMessage.room_id,
          systemMessage.sender_uuid,
          systemMessage.message_type,
          systemMessage.body,
          systemMessage.delivery_state,
          systemMessage.created_at,
        );
      for (const r of systemMessage.read_by_uuids) {
        this.conn
          .prepare('INSERT OR IGNORE INTO message_reads (message_id, reader_uuid, read_at) VALUES (?, ?, ?)')
          .run(systemMessage.id, r, systemMessage.created_at);
      }
      this.conn
        .prepare('UPDATE chat_rooms SET updated_at = ? WHERE id = ?')
        .run(systemMessage.created_at, roomId);

      return this.findChatRoomById(roomId);
    });
  }

  getRoomMessages(roomId: string, limit = 100, cursor?: string | null): {
    messages: ChatMessage[];
    next_cursor: string | null;
    total: number;
  } {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const totalRow = this.conn
      .prepare('SELECT COUNT(*) AS cnt FROM chat_messages WHERE room_id = ?')
      .get(roomId) as { cnt: number };

    let rows: ChatMessageRow[];
    if (cursor) {
      const pivot = this.conn
        .prepare('SELECT rowid FROM chat_messages WHERE id = ? AND room_id = ?')
        .get(cursor, roomId) as { rowid?: number } | undefined;
      if (pivot?.rowid !== undefined) {
        rows = this.conn
          .prepare('SELECT * FROM chat_messages WHERE room_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?')
          .all(roomId, pivot.rowid, safeLimit) as unknown as ChatMessageRow[];
      } else {
        rows = this.conn
          .prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE room_id = ? ORDER BY rowid DESC LIMIT ?) sub ORDER BY rowid ASC')
          .all(roomId, safeLimit) as unknown as ChatMessageRow[];
      }
    } else {
      const desc = this.conn
        .prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY rowid DESC LIMIT ?')
        .all(roomId, safeLimit) as unknown as ChatMessageRow[];
      rows = desc.reverse();
    }

    const hydrated = rows.map((r) => this.hydrateMessageRow(r));
    return {
      messages: hydrated,
      next_cursor: hydrated.length > 0 ? hydrated[0].id : null,
      total: totalRow.cnt,
    };
  }

  createMessage(msg: ChatMessage): ChatMessage {
    this.withTransaction(() => {
      this.conn
        .prepare(`
          INSERT INTO chat_messages (id, room_id, sender_uuid, message_type, body, attachment_url, attachment_name, attachment_type, delivery_state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          msg.id,
          msg.room_id,
          msg.sender_uuid,
          msg.message_type,
          msg.body,
          msg.attachment_url ?? null,
          msg.attachment_name ?? null,
          msg.attachment_type ?? null,
          msg.delivery_state,
          msg.created_at,
        );
      for (const r of msg.read_by_uuids) {
        this.conn
          .prepare('INSERT OR IGNORE INTO message_reads (message_id, reader_uuid, read_at) VALUES (?, ?, ?)')
          .run(msg.id, r, msg.created_at);
      }
      this.conn
        .prepare('UPDATE chat_rooms SET updated_at = ? WHERE id = ?')
        .run(msg.created_at, msg.room_id);
    });
    return msg;
  }

  markRoomRead(roomId: string, readerUuid: string): boolean {
    return this.withTransaction(() => {
      const now = new Date().toISOString();
      const unread = this.conn
        .prepare(`
          SELECT id, sender_uuid FROM chat_messages m
          WHERE m.room_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.reader_uuid = ?
            )
        `)
        .all(roomId, readerUuid) as Array<{ id: string; sender_uuid: string }>;

      if (unread.length === 0) return false;

      const insRead = this.conn.prepare(
        'INSERT OR IGNORE INTO message_reads (message_id, reader_uuid, read_at) VALUES (?, ?, ?)',
      );
      const updState = this.conn.prepare(
        "UPDATE chat_messages SET delivery_state = 'READ' WHERE id = ? AND sender_uuid != ?",
      );
      for (const row of unread) {
        insRead.run(row.id, readerUuid, now);
        updState.run(row.id, readerUuid);
      }
      return true;
    });
  }

  // ------------------------------------------------------------------
  // CALL SESSIONS & CRASH RECOVERY
  // ------------------------------------------------------------------
  createCallSession(call: CallSession): CallSession {
    this.withTransaction(() => {
      this.conn
        .prepare(`
          INSERT INTO call_sessions
            (call_id, room_id, listing_id, caller_uuid, mode, state, webrtc_room_name, started_at, answered_at, ended_at, duration_seconds, end_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          call.call_id,
          call.room_id,
          call.listing_id ?? null,
          call.caller_uuid,
          call.mode,
          call.state,
          call.webrtc_room_name,
          call.started_at,
          call.answered_at ?? null,
          call.ended_at ?? null,
          call.duration_seconds,
          call.end_reason ?? null,
        );

      const insPart = this.conn.prepare(
        'INSERT OR IGNORE INTO call_participants (call_id, user_uuid, role_in_call) VALUES (?, ?, ?)',
      );
      insPart.run(call.call_id, call.caller_uuid, 'CALLER');
      for (const cid of call.callee_uuids) {
        insPart.run(call.call_id, cid, 'CALLEE');
      }
    });
    return call;
  }

  updateCallSession(call: CallSession) {
    this.conn
      .prepare(`
        UPDATE call_sessions
        SET mode = ?, state = ?, answered_at = ?, ended_at = ?, duration_seconds = ?, end_reason = ?
        WHERE call_id = ?
      `)
      .run(
        call.mode,
        call.state,
        call.answered_at ?? null,
        call.ended_at ?? null,
        call.duration_seconds,
        call.end_reason ?? null,
        call.call_id,
      );
  }

  findCallById(callId: string): CallSession | undefined {
    const row = this.conn.prepare('SELECT * FROM call_sessions WHERE call_id = ?').get(callId) as CallRow | undefined;
    return row ? this.hydrateCallRow(row) : undefined;
  }

  getCallLogsForUser(userUuid: string, limit = 50): CallSession[] {
    const rows = this.conn
      .prepare(`
        SELECT DISTINCT cs.* FROM call_sessions cs
        JOIN call_participants cp ON cp.call_id = cs.call_id
        WHERE cp.user_uuid = ?
        ORDER BY cs.started_at DESC
        LIMIT ?
      `)
      .all(userUuid, Math.min(200, Math.max(1, limit))) as unknown as CallRow[];
    return rows.map((r) => this.hydrateCallRow(r));
  }

  reconcileStaleCallsOnBoot(): number {
    return this.withTransaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const stale = this.conn
        .prepare("SELECT * FROM call_sessions WHERE state IN ('RINGING', 'CONNECTED')")
        .all() as unknown as CallRow[];

      for (const row of stale) {
        if (row.state === 'RINGING') {
          this.conn
            .prepare("UPDATE call_sessions SET state = 'MISSED', ended_at = ?, duration_seconds = 0, end_reason = 'server_restart' WHERE call_id = ?")
            .run(nowIso, row.call_id);
        } else {
          const started = row.answered_at ? new Date(row.answered_at).getTime() : new Date(row.started_at).getTime();
          const secs = Math.max(1, Math.round((now.getTime() - started) / 1000));
          this.conn
            .prepare("UPDATE call_sessions SET state = 'ENDED', ended_at = ?, duration_seconds = ?, end_reason = 'server_restart' WHERE call_id = ?")
            .run(nowIso, secs, row.call_id);
        }
      }
      return stale.length;
    });
  }

  // ------------------------------------------------------------------
  // REFRESH REVOCATION & PERSISTENT IDEMPOTENCY
  // ------------------------------------------------------------------
  isRefreshTokenRevoked(jti: string): boolean {
    const row = this.conn.prepare('SELECT 1 FROM revoked_refresh_tokens WHERE jti = ?').get(jti);
    return Boolean(row);
  }

  revokeRefreshToken(jti: string, expiresAtMs = Date.now() + 7 * 24 * 60 * 60 * 1000) {
    this.conn
      .prepare('INSERT OR IGNORE INTO revoked_refresh_tokens (jti, expires_at_ms) VALUES (?, ?)')
      .run(jti, expiresAtMs);
    this.conn.prepare('DELETE FROM revoked_refresh_tokens WHERE expires_at_ms < ?').run(Date.now());
  }

  getIdempotency(
    key: string,
    method: string,
    reqPath: string,
    userUuid: string,
  ): IdempotencyRecord | null {
    const composite = `${userUuid}:${method}:${reqPath}:${key}`;
    const row = this.conn
      .prepare('SELECT * FROM idempotency_keys WHERE composite_key = ?')
      .get(composite) as
      | {
          key_value: string;
          method: string;
          path: string;
          user_uuid: string;
          status_code: number;
          response_json: string;
          created_at_ms: number;
        }
      | undefined;
    if (!row) return null;
    if (Date.now() - row.created_at_ms > 24 * 60 * 60 * 1000) {
      this.conn.prepare('DELETE FROM idempotency_keys WHERE composite_key = ?').run(composite);
      return null;
    }
    return {
      key: row.key_value,
      method: row.method,
      path: row.path,
      user_uuid: row.user_uuid,
      status_code: row.status_code,
      response_body: JSON.parse(row.response_json),
      created_at: row.created_at_ms,
    };
  }

  setIdempotency(
    key: string,
    method: string,
    reqPath: string,
    userUuid: string,
    statusCode: number,
    responseBody: unknown,
  ) {
    const composite = `${userUuid}:${method}:${reqPath}:${key}`;
    const now = Date.now();
    this.conn
      .prepare(`
        INSERT OR REPLACE INTO idempotency_keys
          (composite_key, key_value, method, path, user_uuid, status_code, response_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(composite, key, method, reqPath, userUuid, statusCode, JSON.stringify(responseBody), now);

    // Opportunistically expire entries older than 24h
    this.conn.prepare('DELETE FROM idempotency_keys WHERE created_at_ms < ?').run(now - 24 * 60 * 60 * 1000);
  }

  // ------------------------------------------------------------------
  // HEALTH & METRICS COUNTS
  // ------------------------------------------------------------------
  getHealthStats(): {
    ok: boolean;
    journal_mode: string;
    users: number;
    listings: number;
    chats: number;
    calls: number;
    spatial_valid: boolean;
  } {
    this.conn.prepare('SELECT 1').get();
    const u = (this.conn.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    const l = (this.conn.prepare('SELECT COUNT(*) AS c FROM listings').get() as { c: number }).c;
    const c = (this.conn.prepare('SELECT COUNT(*) AS c FROM chat_rooms').get() as { c: number }).c;
    const cs = (this.conn.prepare('SELECT COUNT(*) AS c FROM call_sessions').get() as { c: number }).c;
    const badCoords = (
      this.conn
        .prepare('SELECT COUNT(*) AS c FROM listings WHERE latitude IS NULL OR longitude IS NULL')
        .get() as { c: number }
    ).c;

    return {
      ok: true,
      journal_mode: this.journalMode,
      users: u,
      listings: l,
      chats: c,
      calls: cs,
      spatial_valid: badCoords === 0,
    };
  }

  checkpointAndClose() {
    try {
      this.conn.exec('PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // ignore if already closing
    }
    this.conn.close();
  }

  close() {
    this.conn.close();
  }
}

export const db = new SqliteStore();
