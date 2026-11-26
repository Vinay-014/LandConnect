import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import zlib from 'zlib';
import { CallSignalingEngine, callEngine as defaultCallEngine } from './server/callEngine.ts';
import { metrics } from './server/metrics.ts';
import {
  SlidingWindowRateLimiter,
  hashPasswordAsync,
  issueAccessToken,
  issueRefreshToken,
  toPrivacySafeProfile,
  verifyAccessToken,
  verifyPasswordAsync,
  verifyRefreshToken,
  type AccessTokenPayload,
} from './server/security.ts';
import {
  LocalDiskStorageProvider,
  type StorageProvider,
} from './server/storage.ts';
import { db as defaultStore, type SqliteStore } from './server/store.ts';
import type {
  CallMode,
  ChatMessage,
  ChatRoom,
  LandListing,
  LandType,
  ListingReport,
  UserRecord,
  UserRole,
} from './server/types.ts';
import {
  VALID_LAND_TYPES,
  VALID_ROLES,
  clampString,
  isValidCoords,
  isValidEmail,
  isValidPhone,
  isValidPolygonGeoJson,
  verifyAttachmentMagicBytes,
  verifyImageMagicBytes,
} from './server/validation.ts';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      auth?: AccessTokenPayload;
    }
  }
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

function structuredLog(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'test') return;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: 'landconnect-api',
      message,
      ...meta,
    }),
  );
}

function defaultPolygonAround(lat: number, lng: number) {
  const d = 0.0011;
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [lng - d, lat + d],
        [lng + d, lat + d],
        [lng + d, lat - d],
        [lng - d, lat - d],
        [lng - d, lat + d],
      ],
    ],
  };
}

export function createLandConnectApp(options?: {
  store?: SqliteStore;
  callEngine?: CallSignalingEngine;
  uploadsDir?: string;
  storage?: StorageProvider;
  isShuttingDown?: () => boolean;
}) {
  const store = options?.store ?? defaultStore;
  const engine = options?.callEngine ?? defaultCallEngine;
  const isShuttingDown = options?.isShuttingDown ?? (() => false);
  const uploadsDir = options?.uploadsDir ?? path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const storage = options?.storage ?? new LocalDiskStorageProvider(uploadsDir);
  const isDemoAuthEnabled = () => process.env.ENABLE_DEMO_AUTH !== 'false';

  const rateLimiter = new SlidingWindowRateLimiter();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));

  // Lightweight native gzip compression for JSON & text responses >= 1 KB
  app.use((req, res, next) => {
    res.vary('Accept-Encoding');
    const accept = String(req.headers['accept-encoding'] || '');
    if (req.method === 'HEAD' || !/\bgzip\b/i.test(accept)) {
      next();
      return;
    }
    const origSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (
        res.headersSent ||
        res.statusCode === 204 ||
        res.statusCode === 304 ||
        res.getHeader('Content-Encoding')
      ) {
        return origSend(body);
      }
      const contentType = String(res.getHeader('Content-Type') || '');
      const isCompressible =
        !contentType ||
        contentType.startsWith('application/json') ||
        contentType.startsWith('text/') ||
        contentType.startsWith('application/javascript') ||
        contentType.startsWith('image/svg+xml');
      if (!isCompressible) {
        return origSend(body);
      }
      const buf = Buffer.isBuffer(body)
        ? body
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : null;
      if (!buf || buf.length < 1024) {
        return origSend(body);
      }
      if (!contentType && typeof body === 'string') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
      zlib.gzip(buf, (err, compressed) => {
        if (err || res.headersSent) {
          if (!res.headersSent) origSend(body);
          return;
        }
        res.removeHeader('Content-Length');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(compressed.length));
        origSend(compressed);
      });
      return res;
    }) as express.Response['send'];
    next();
  });

  // Reconcile any orphaned call sessions from a previous server crash/restart
  engine.reconcileOnBoot();

  function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ detail: 'Missing or invalid Bearer token', request_id: req.requestId });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    const payload = verifyAccessToken(token);
    if (!payload) {
      res.status(401).json({ detail: 'Access token expired or invalid', request_id: req.requestId });
      return;
    }
    const user = store.findUserByUuid(payload.sub);
    if (!user) {
      res.status(401).json({ detail: 'Account no longer exists', request_id: req.requestId });
      return;
    }
    req.auth = { ...payload, role: user.role };
    next();
  }

  function requireRoles(...roles: UserRole[]) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!req.auth) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      if (!roles.includes(req.auth.role)) {
        res.status(403).json({
          detail: `Role ${req.auth.role} is not permitted for this operation. Allowed: ${roles.join(', ')}`,
        });
        return;
      }
      next();
    };
  }

  function applyRateLimit(bucketPrefix: string, maxRequests: number, windowMs: number) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const actor = req.auth?.sub || req.ip || 'anonymous';
      const result = rateLimiter.check(`${bucketPrefix}:${actor}`, maxRequests, windowMs);
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSec));
        res.status(429).json({
          detail: 'Rate limit exceeded. Please retry shortly.',
          retry_after_seconds: result.retryAfterSec,
        });
        return;
      }
      next();
    };
  }

  // Structured Request-ID & Observability Middleware
  app.use((req, res, next) => {
    const reqId = (req.headers['x-request-id'] as string) || `req_${crypto.randomUUID().slice(0, 12)}`;
    req.requestId = reqId;
    res.setHeader('X-Request-ID', reqId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
        metrics.inc('landconnect_http_requests_total', {
          method: req.method,
          status: res.statusCode,
        });
        structuredLog('INFO', 'http_request', {
          request_id: reqId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Date.now() - start,
          actor: req.auth?.sub ?? null,
        });
      }
    });
    next();
  });

  app.get('/metrics', (req, res) => {
    const expectedToken = process.env.METRICS_TOKEN?.trim();
    if (expectedToken) {
      const authHeader = req.headers.authorization || '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
      const expectedBuf = Buffer.from(expectedToken, 'utf8');
      const providedBuf = Buffer.from(provided, 'utf8');
      if (
        expectedBuf.length !== providedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        res.status(401).json({ detail: 'Metrics authentication required' });
        return;
      }
    }
    const stats = store.getHealthStats();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(
      metrics.toPrometheusText({
        landconnect_ws_online_users: engine.getOnlineUserUuids().size,
        landconnect_calls_active: engine.getActiveCallCount(),
        landconnect_listings_total: stats.listings,
        landconnect_users_total: stats.users,
      }),
    );
  });

  // Safe local uploads serving
  app.use(
    '/uploads',
    express.static(uploadsDir, {
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    }),
  );

  // Liveness & Readiness Probes (Kubernetes / container orchestrator compatible)
  app.get('/health/live', (_req, res) => {
    res.json({
      status: 'alive',
      uptime_sec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/health/ready', (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'draining', timestamp: new Date().toISOString() });
      return;
    }
    try {
      const stats = store.getHealthStats();
      if (!stats.ok) {
        res.status(503).json({ status: 'not_ready', timestamp: new Date().toISOString() });
        return;
      }
      res.json({
        status: 'ready',
        journal_mode: stats.journal_mode,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ status: 'not_ready', timestamp: new Date().toISOString() });
    }
  });

  // Deep Health Check (Transactional SQLite WAL + spatial bounds + live WebSocket hub)
  app.get('/health/deep', (_req, res) => {
    try {
      const stats = store.getHealthStats();
      res.json({
        status: stats.ok ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        checks: {
          datastore: {
            status: 'up',
            engine: 'sqlite_wal',
            journal_mode: stats.journal_mode,
            users: stats.users,
            listings: stats.listings,
            chats: stats.chats,
            calls: stats.calls,
          },
          geospatial_index: { status: stats.spatial_valid ? 'up' : 'degraded', srid: 4326 },
          realtime_ws_hub: {
            status: 'up',
            online_users: engine.getOnlineUserUuids().size,
            active_calls: engine.getActiveCallCount(),
          },
          rate_limiter: { status: 'up', algorithm: 'sliding_window' },
        },
      });
    } catch {
      res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
    }
  });

  // Public Google Maps Platform & runtime feature flags (browser-scoped only)
  app.get('/api/v1/config/maps', (_req, res) => {
    const apiKey =
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY ||
      '';
    res.json({
      apiKey,
      configured: Boolean(apiKey),
      demoAuthEnabled: isDemoAuthEnabled(),
    });
  });

  app.get('/api/v1/config/public', (_req, res) => {
    const apiKey =
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY ||
      '';
    res.json({
      mapsConfigured: Boolean(apiKey),
      demoAuthEnabled: isDemoAuthEnabled(),
    });
  });

  // ------------------------------------------------------------------
  // 1. AUTHENTICATION, DEMO SWITCHER, RBAC & PRIVACY LAYER
  // ------------------------------------------------------------------
  app.post('/api/v1/auth/register', applyRateLimit('auth_register', 15, 60_000), async (req, res) => {
    const { email, phone, password, display_name, role, city, bio } = req.body ?? {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const passwordStr = typeof password === 'string' ? password : '';
    const nameStr = clampString(display_name, 80);

    if (!isValidEmail(normalizedEmail)) {
      res.status(400).json({ detail: 'Please provide a valid email address' });
      return;
    }
    if (passwordStr.length < 8 || passwordStr.length > 128) {
      res.status(400).json({ detail: 'Password must be between 8 and 128 characters' });
      return;
    }
    if (nameStr.length < 2) {
      res.status(400).json({ detail: 'Display name must be at least 2 characters' });
      return;
    }
    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ detail: 'role must be BUYER, SELLER, or BROKER' });
      return;
    }
    const phoneStr = typeof phone === 'string' && phone.trim() ? phone.trim() : '+91-90000-00000';
    if (!isValidPhone(phoneStr)) {
      res.status(400).json({ detail: 'Please provide a valid phone number' });
      return;
    }
    if (store.findUserByEmail(normalizedEmail)) {
      res.status(409).json({ detail: 'An account with this email already exists' });
      return;
    }

    const passwordHash = await hashPasswordAsync(passwordStr);
    const user: UserRecord = {
      user_uuid: `usr_${String(role).toLowerCase()}_${crypto.randomBytes(5).toString('hex')}`,
      email: normalizedEmail,
      phone: phoneStr,
      password_hash: passwordHash,
      display_name: nameStr,
      role,
      city: clampString(city, 80, 'Bengaluru') || 'Bengaluru',
      bio: clampString(bio, 300, 'Verified LandConnect member') || 'Verified LandConnect member',
      allow_calls: true,
      show_contact_after_consent: false,
      consented_peer_uuids: [],
      is_demo: false,
      created_at: new Date().toISOString(),
    };

    try {
      store.createUser(user);
    } catch {
      res.status(409).json({ detail: 'An account with this email already exists' });
      return;
    }

    const accessToken = issueAccessToken(user);
    const { token: refreshToken } = issueRefreshToken(user);
    res.status(201).json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      user: toPrivacySafeProfile(user, user.user_uuid, engine.getOnlineUserUuids()),
    });
  });

  app.post('/api/v1/auth/login', applyRateLimit('auth_login', 30, 60_000), async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      res.status(400).json({ detail: 'email and password are required' });
      return;
    }
    const user = store.findUserByEmail(email.trim());
    if (!user || !(await verifyPasswordAsync(password, user.password_hash))) {
      res.status(401).json({ detail: 'Invalid email or password' });
      return;
    }
    const accessToken = issueAccessToken(user);
    const { token: refreshToken } = issueRefreshToken(user);
    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      user: toPrivacySafeProfile(user, user.user_uuid, engine.getOnlineUserUuids()),
    });
  });

  // 1-Click Evaluator Demo Role Switcher (explicitly scoped to seeded is_demo = 1 profiles and gated by ENABLE_DEMO_AUTH)
  app.post('/api/v1/auth/demo-login', applyRateLimit('auth_demo', 40, 60_000), (req, res) => {
    if (!isDemoAuthEnabled()) {
      res.status(403).json({ detail: 'Demo workspace login is disabled in this environment' });
      return;
    }
    const { role } = req.body ?? {};
    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ detail: 'role must be BUYER, SELLER, or BROKER' });
      return;
    }
    const demoUser = store.findDemoUserByRole(role);
    if (!demoUser) {
      res.status(404).json({ detail: 'Demo workspace profile not available' });
      return;
    }
    const accessToken = issueAccessToken(demoUser);
    const { token: refreshToken } = issueRefreshToken(demoUser);
    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      user: toPrivacySafeProfile(demoUser, demoUser.user_uuid, engine.getOnlineUserUuids()),
    });
  });

  app.post('/api/v1/auth/refresh', (req, res) => {
    const { refresh_token } = req.body ?? {};
    if (typeof refresh_token !== 'string' || !refresh_token.trim()) {
      res.status(400).json({ detail: 'refresh_token is required' });
      return;
    }
    const payload = verifyRefreshToken(refresh_token);
    if (!payload || store.isRefreshTokenRevoked(payload.jti)) {
      res.status(401).json({ detail: 'Refresh token invalid or revoked' });
      return;
    }
    const user = store.findUserByUuid(payload.sub);
    if (!user) {
      res.status(401).json({ detail: 'User no longer exists' });
      return;
    }
    store.revokeRefreshToken(payload.jti, payload.exp * 1000);
    const accessToken = issueAccessToken(user);
    const { token: nextRefresh } = issueRefreshToken(user);
    res.json({
      access_token: accessToken,
      refresh_token: nextRefresh,
      token_type: 'bearer',
    });
  });

  app.post('/api/v1/auth/logout', (req, res) => {
    const { refresh_token } = req.body ?? {};
    if (typeof refresh_token === 'string' && refresh_token.trim()) {
      const payload = verifyRefreshToken(refresh_token);
      if (payload) {
        store.revokeRefreshToken(payload.jti, payload.exp * 1000);
      }
    }
    res.json({ status: 'ok' });
  });

  app.get('/api/v1/auth/me', requireAuth, (req, res) => {
    const user = store.findUserByUuid(req.auth!.sub);
    if (!user) {
      res.status(404).json({ detail: 'User not found' });
      return;
    }
    res.json(toPrivacySafeProfile(user, user.user_uuid, engine.getOnlineUserUuids()));
  });

  app.patch('/api/v1/auth/privacy', requireAuth, (req, res) => {
    const { allow_calls, show_contact_after_consent, consent_peer_uuid, revoke_peer_uuid } = req.body ?? {};
    const updated = store.updateUserPrivacy(req.auth!.sub, {
      allow_calls: typeof allow_calls === 'boolean' ? allow_calls : undefined,
      show_contact_after_consent:
        typeof show_contact_after_consent === 'boolean' ? show_contact_after_consent : undefined,
      consent_peer_uuid: typeof consent_peer_uuid === 'string' ? consent_peer_uuid : undefined,
      revoke_peer_uuid: typeof revoke_peer_uuid === 'string' ? revoke_peer_uuid : undefined,
    });

    if (!updated) {
      res.status(404).json({ detail: 'User not found' });
      return;
    }

    const online = engine.getOnlineUserUuids();
    if (typeof consent_peer_uuid === 'string' && consent_peer_uuid !== updated.user_uuid) {
      engine.sendToUser(consent_peer_uuid, {
        event: 'privacy.consent_updated',
        payload: {
          peer_uuid: updated.user_uuid,
          profile: toPrivacySafeProfile(updated, consent_peer_uuid, online),
        },
      });
    }
    if (typeof revoke_peer_uuid === 'string' && revoke_peer_uuid !== updated.user_uuid) {
      engine.sendToUser(revoke_peer_uuid, {
        event: 'privacy.consent_updated',
        payload: {
          peer_uuid: updated.user_uuid,
          profile: toPrivacySafeProfile(updated, revoke_peer_uuid, online),
        },
      });
    }
    res.json(toPrivacySafeProfile(updated, updated.user_uuid, online));
  });

  app.patch('/api/v1/auth/profile', requireAuth, (req, res) => {
    const { display_name, city, bio } = req.body ?? {};
    const nextName = display_name !== undefined ? clampString(display_name, 80) : undefined;
    const nextCity = city !== undefined ? clampString(city, 80) : undefined;
    const nextBio = bio !== undefined ? clampString(bio, 300) : undefined;

    if (nextName !== undefined && nextName.length < 2) {
      res.status(400).json({ detail: 'Display name must be at least 2 characters' });
      return;
    }
    const updated = store.updateUserProfile(req.auth!.sub, {
      display_name: nextName,
      city: nextCity,
      bio: nextBio,
    });
    if (!updated) {
      res.status(404).json({ detail: 'User not found' });
      return;
    }
    res.json(toPrivacySafeProfile(updated, updated.user_uuid, engine.getOnlineUserUuids()));
  });

  app.post('/api/v1/auth/change-password', requireAuth, applyRateLimit('auth_pw', 10, 60_000), async (req, res) => {
    const { current_password, new_password } = req.body ?? {};
    if (typeof current_password !== 'string' || typeof new_password !== 'string') {
      res.status(400).json({ detail: 'current_password and new_password are required' });
      return;
    }
    if (new_password.length < 8 || new_password.length > 128) {
      res.status(400).json({ detail: 'New password must be between 8 and 128 characters' });
      return;
    }
    const user = store.findUserByUuid(req.auth!.sub);
    if (!user) {
      res.status(404).json({ detail: 'User not found' });
      return;
    }
    if (!(await verifyPasswordAsync(current_password, user.password_hash))) {
      res.status(401).json({ detail: 'Current password is incorrect' });
      return;
    }
    store.updateUserPassword(user.user_uuid, await hashPasswordAsync(new_password));
    res.json({ status: 'ok' });
  });

  app.get('/api/v1/users', requireAuth, (req, res) => {
    const online = engine.getOnlineUserUuids();
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const limit =
      req.query.limit !== undefined ? Math.min(500, Math.max(1, Number(req.query.limit) || 100)) : 100;
    const offset = req.query.offset !== undefined ? Math.max(0, Number(req.query.offset) || 0) : 0;
    const { items, total } = store.listUsersPage({ q, limit, offset });
    const profiles = items.map((u) => toPrivacySafeProfile(u, req.auth!.sub, online));
    res.json({
      users: profiles,
      total,
      limit,
      offset,
      has_more: offset + profiles.length < total,
    });
  });

  app.get('/api/v1/users/blocked', requireAuth, (req, res) => {
    const blockedIds = store.listBlockedUsers(req.auth!.sub);
    const online = engine.getOnlineUserUuids();
    const blockedMap = store.findUsersByUuids(blockedIds);
    const blockedProfiles = blockedIds
      .map((id) => blockedMap.get(id))
      .filter((u): u is UserRecord => Boolean(u))
      .map((u) => toPrivacySafeProfile(u, req.auth!.sub, online));
    res.json({ blocked_uuids: blockedIds, blocked_users: blockedProfiles });
  });

  app.post('/api/v1/users/:userUuid/block', requireAuth, (req, res) => {
    const targetUuid = req.params.userUuid;
    if (targetUuid === req.auth!.sub) {
      res.status(400).json({ detail: 'You cannot block your own account' });
      return;
    }
    const reason = clampString(req.body?.reason, 240);
    const ok = store.blockUser(req.auth!.sub, targetUuid, reason);
    if (!ok) {
      res.status(404).json({ detail: 'Target user not found' });
      return;
    }
    res.status(201).json({ status: 'blocked', blocked_uuid: targetUuid });
  });

  app.delete('/api/v1/users/:userUuid/block', requireAuth, (req, res) => {
    store.unblockUser(req.auth!.sub, req.params.userUuid);
    res.json({ status: 'unblocked', unblocked_uuid: req.params.userUuid });
  });

  // ------------------------------------------------------------------
  // 2. GEOSPATIAL SEARCH & LISTINGS CRUD (ACID + OPTIMISTIC CONCURRENCY)
  // ------------------------------------------------------------------
  function enrichListingsWithProfiles(items: LandListing[], viewerUuid: string) {
    const online = engine.getOnlineUserUuids();
    const userIds: string[] = [];
    for (const l of items) {
      userIds.push(l.owner_uuid);
      if (l.broker_uuid) userIds.push(l.broker_uuid);
    }
    const userMap = store.findUsersByUuids(userIds);
    return items.map((l) => {
      const owner = userMap.get(l.owner_uuid);
      const broker = l.broker_uuid ? userMap.get(l.broker_uuid) : undefined;
      return {
        ...l,
        owner_profile: owner ? toPrivacySafeProfile(owner, viewerUuid, online) : null,
        broker_profile: broker ? toPrivacySafeProfile(broker, viewerUuid, online) : null,
      };
    });
  }

  app.get('/api/v1/listings/nearby', requireAuth, (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Math.min(500, Math.max(0.5, Number(req.query.radius_km || 25)));
    if (!isValidCoords(lat, lng)) {
      res.status(400).json({ detail: 'Valid numeric lat and lng query parameters are required' });
      return;
    }
    const items = store.queryListingsNearby(lat, lng, radiusKm);
    const enriched = enrichListingsWithProfiles(items, req.auth!.sub);

    res.json({
      query: { lat, lng, radius_km: radiusKm },
      count: enriched.length,
      listings: enriched,
    });
  });

  app.get('/api/v1/listings/bbox', requireAuth, (req, res) => {
    const minLng = Number(req.query.min_lng);
    const minLat = Number(req.query.min_lat);
    const maxLng = Number(req.query.max_lng);
    const maxLat = Number(req.query.max_lat);
    if (!isValidCoords(minLat, minLng) || !isValidCoords(maxLat, maxLng) || minLat > maxLat || minLng > maxLng) {
      res.status(400).json({ detail: 'Valid min_lng, min_lat, max_lng, max_lat bounding box is required' });
      return;
    }
    const items = store.queryListingsBbox(minLng, minLat, maxLng, maxLat);
    const enriched = enrichListingsWithProfiles(items, req.auth!.sub);
    res.json({
      query: { min_lng: minLng, min_lat: minLat, max_lng: maxLng, max_lat: maxLat },
      count: enriched.length,
      listings: enriched,
    });
  });

  // Public Marketing Showcase Listings (sanitized — no private owner handles or emails)
  app.get('/api/v1/public/listings', (req, res) => {
    const landType = typeof req.query.land_type === 'string' ? req.query.land_type : undefined;
    const city = typeof req.query.city === 'string' ? req.query.city : undefined;
    const limitNum = req.query.limit !== undefined ? Math.min(100, Math.max(1, Number(req.query.limit) || 24)) : 24;
    const offsetNum = req.query.offset !== undefined ? Math.max(0, Number(req.query.offset) || 0) : 0;
    const sort =
      req.query.sort === 'price_asc' || req.query.sort === 'price_desc'
        ? req.query.sort
        : 'price_asc';
    const { items, total } = store.queryListings({ landType, city, sort, limit: limitNum, offset: offsetNum });
    const sanitized = items.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      price_inr: l.price_inr,
      area_sqft: l.area_sqft,
      area_acres: l.area_acres,
      land_type: l.land_type,
      zoning_status: l.zoning_status,
      verification_status: l.verification_status,
      locality: l.locality,
      city: l.city,
      images: l.images,
    }));
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({
      count: sanitized.length,
      total,
      limit: limitNum,
      offset: offsetNum,
      has_more: offsetNum + sanitized.length < total,
      listings: sanitized,
    });
  });

  app.get('/api/v1/listings', requireAuth, (req, res) => {
    const { land_type, city, min_price, max_price, q, sort, limit, offset } = req.query;
    const minPriceNum = min_price !== undefined ? Number(min_price) : undefined;
    const maxPriceNum = max_price !== undefined ? Number(max_price) : undefined;
    const limitNum = limit !== undefined ? Math.min(100, Math.max(1, Number(limit) || 50)) : 50;
    const offsetNum = offset !== undefined ? Math.max(0, Number(offset) || 0) : 0;
    const sortMode =
      sort === 'price_asc' || sort === 'price_desc' || sort === 'updated_desc'
        ? sort
        : 'updated_desc';

    const { items, total } = store.queryListings({
      landType: typeof land_type === 'string' ? land_type : undefined,
      city: typeof city === 'string' ? city : undefined,
      minPrice: Number.isFinite(minPriceNum) ? minPriceNum : undefined,
      maxPrice: Number.isFinite(maxPriceNum) ? maxPriceNum : undefined,
      q: typeof q === 'string' ? q : undefined,
      sort: sortMode,
      limit: limitNum,
      offset: offsetNum,
    });

    const enriched = enrichListingsWithProfiles(items, req.auth!.sub);
    res.json({
      count: enriched.length,
      total,
      limit: limitNum,
      offset: offsetNum,
      has_more: offsetNum + enriched.length < total,
      listings: enriched,
    });
  });

  app.post(
    '/api/v1/listings',
    requireAuth,
    requireRoles('SELLER', 'BROKER'),
    (req, res) => {
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      if (idempotencyKey) {
        const cached = store.getIdempotency(idempotencyKey, 'POST', '/api/v1/listings', req.auth!.sub);
        if (cached) {
          res.setHeader('X-Idempotent-Replay', 'true');
          res.status(cached.status_code).json(cached.response_body);
          return;
        }
      }

      const {
        title,
        description,
        price_inr,
        area_sqft,
        land_type,
        zoning_status,
        locality,
        city,
        latitude,
        longitude,
        polygon_geojson,
        images,
      } = req.body ?? {};

      const cleanTitle = clampString(title, 160);
      const cleanDesc = clampString(description, 4000, 'Verified parcel with clear title history.');
      const priceNum = Number(price_inr);
      const areaSqftNum = Number(area_sqft);
      const latNum = Number(latitude);
      const lngNum = Number(longitude);

      if (
        cleanTitle.length < 3 ||
        !Number.isFinite(priceNum) ||
        priceNum < 100000 ||
        !Number.isFinite(areaSqftNum) ||
        areaSqftNum <= 0 ||
        !VALID_LAND_TYPES.includes(land_type) ||
        !isValidCoords(latNum, lngNum)
      ) {
        res.status(400).json({
          detail:
            'Valid title (3+ chars), price_inr (>= 100000), area_sqft (> 0), land_type, latitude, and longitude are required',
        });
        return;
      }

      const typedLandType = land_type as LandType;
      const safeImages = Array.isArray(images)
        ? images.filter(
            (img): img is string =>
              typeof img === 'string' && (img.startsWith('/uploads/') || img.startsWith('/src/assets/')),
          )
        : [];

      const fallbackImageByType: Record<LandType, string> = {
        AGRICULTURAL: '/src/assets/images/land_devanahalli_farm_1795332740140.jpg',
        RESIDENTIAL: '/src/assets/images/land_sarjapur_residential_1795332739674.jpg',
        COMMERCIAL: '/src/assets/images/land_whitefield_commercial_1795332740192.jpg',
        INDUSTRIAL: '/src/assets/images/land_peenya_industrial_1795332740018.jpg',
      };

      const now = new Date().toISOString();
      const listing: LandListing = {
        id: `lst_${crypto.randomBytes(5).toString('hex')}`,
        title: cleanTitle,
        description: cleanDesc,
        price_inr: Math.round(priceNum),
        area_sqft: Math.round(areaSqftNum),
        area_acres: Number((areaSqftNum / 43560).toFixed(2)),
        land_type: typedLandType,
        zoning_status: clampString(zoning_status, 140, 'Clear Title · Survey Pending') || 'Clear Title · Survey Pending',
        verification_status: req.auth!.role === 'BROKER' ? 'VERIFIED' : 'PENDING_SURVEY',
        locality: clampString(locality, 100, 'Bengaluru') || 'Bengaluru',
        city: clampString(city, 100, 'Bengaluru') || 'Bengaluru',
        latitude: latNum,
        longitude: lngNum,
        polygon_geojson: isValidPolygonGeoJson(polygon_geojson)
          ? polygon_geojson
          : defaultPolygonAround(latNum, lngNum),
        images: safeImages.length > 0 ? safeImages.slice(0, 6) : [fallbackImageByType[typedLandType]],
        owner_uuid: req.auth!.sub,
        broker_uuid: req.auth!.role === 'BROKER' ? req.auth!.sub : undefined,
        version: 1,
        created_at: now,
        updated_at: now,
      };

      store.createListing(listing);

      if (idempotencyKey) {
        store.setIdempotency(idempotencyKey, 'POST', '/api/v1/listings', req.auth!.sub, 201, listing);
      }

      res.status(201).json(listing);
    },
  );

  app.patch(
    '/api/v1/listings/:id',
    requireAuth,
    requireRoles('SELLER', 'BROKER'),
    (req, res) => {
      const { title, description, price_inr, zoning_status } = req.body ?? {};
      const expectedVersionRaw = req.body?.version ?? req.headers['if-match'];
      const expectedVersion =
        expectedVersionRaw !== undefined && expectedVersionRaw !== ''
          ? Number(expectedVersionRaw)
          : undefined;

      if (price_inr !== undefined && (!Number.isFinite(Number(price_inr)) || Number(price_inr) < 100000)) {
        res.status(400).json({ detail: 'price_inr must be a valid number >= 100000' });
        return;
      }

      const result = store.updateListingOptimistic({
        id: req.params.id,
        actorUuid: req.auth!.sub,
        actorRole: req.auth!.role,
        expectedVersion,
        patch: {
          title: typeof title === 'string' ? clampString(title, 160) : undefined,
          description: typeof description === 'string' ? clampString(description, 4000) : undefined,
          price_inr: price_inr !== undefined ? Math.round(Number(price_inr)) : undefined,
          zoning_status: typeof zoning_status === 'string' ? clampString(zoning_status, 140) : undefined,
        },
      });

      if (result.status === 'NOT_FOUND') {
        res.status(404).json({ detail: 'Listing not found' });
        return;
      }
      if (result.status === 'FORBIDDEN') {
        res.status(403).json({ detail: 'Sellers may only modify their own listings' });
        return;
      }
      if (result.status === 'CONFLICT') {
        res.status(409).json({
          detail: `Optimistic concurrency conflict: expected version ${result.currentVersion}, received ${expectedVersion}`,
          current_version: result.currentVersion,
        });
        return;
      }

      res.json(result.listing);
    },
  );

  app.patch(
    '/api/v1/listings/:id/verify',
    requireAuth,
    requireRoles('BROKER'),
    (req, res) => {
      const nextStatus = req.body?.verification_status;
      if (!['VERIFIED', 'RERA_APPROVED', 'PENDING_SURVEY'].includes(nextStatus)) {
        res.status(400).json({ detail: 'Invalid verification_status' });
        return;
      }
      const updated = store.verifyListing(req.params.id, req.auth!.sub, nextStatus);
      if (!updated) {
        res.status(404).json({ detail: 'Listing not found' });
        return;
      }
      res.json(updated);
    },
  );

  app.delete(
    '/api/v1/listings/:id',
    requireAuth,
    requireRoles('SELLER', 'BROKER'),
    (req, res) => {
      const outcome = store.deleteListing(req.params.id, req.auth!.sub, req.auth!.role);
      if (outcome === 'NOT_FOUND') {
        res.status(404).json({ detail: 'Listing not found' });
        return;
      }
      if (outcome === 'FORBIDDEN') {
        res.status(403).json({ detail: 'Sellers may only delete their own listings' });
        return;
      }
      res.status(204).send();
    },
  );

  app.post(
    '/api/v1/listings/:id/report',
    requireAuth,
    applyRateLimit('listing_report', 10, 60_000),
    (req, res) => {
      const listing = store.findListingById(req.params.id);
      if (!listing) {
        res.status(404).json({ detail: 'Listing not found' });
        return;
      }
      const reason = clampString(req.body?.reason, 120);
      if (reason.length < 3) {
        res.status(400).json({ detail: 'A valid report reason is required' });
        return;
      }
      const details = clampString(req.body?.details, 500);
      const report: ListingReport = {
        id: `rep_${crypto.randomBytes(6).toString('hex')}`,
        listing_id: listing.id,
        reporter_uuid: req.auth!.sub,
        reason,
        details,
        created_at: new Date().toISOString(),
      };
      store.createListingReport(report);
      res.status(201).json(report);
    },
  );

  app.post(
    '/api/v1/listings/upload-image',
    requireAuth,
    requireRoles('SELLER', 'BROKER'),
    applyRateLimit('upload_image', 20, 60_000),
    async (req, res) => {
      const { filename, data_url } = req.body ?? {};
      if (!filename || typeof data_url !== 'string' || !data_url.startsWith('data:image/')) {
        res.status(400).json({ detail: 'Valid base64 image data_url and filename are required' });
        return;
      }
      const match = data_url.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) {
        res.status(400).json({ detail: 'Unsupported image format. Allowed: png, jpeg, webp' });
        return;
      }
      const ext = (match[1] === 'jpeg' ? 'jpg' : match[1]) as 'png' | 'jpg' | 'webp';
      const decoded = Buffer.from(match[2], 'base64');
      if (decoded.length === 0 || decoded.length > MAX_UPLOAD_BYTES) {
        res.status(400).json({ detail: 'Image file size must be under 5 MB' });
        return;
      }
      if (!verifyImageMagicBytes(decoded, ext)) {
        res.status(400).json({ detail: 'File bytes do not match declared image format' });
        return;
      }

      const saved = await storage.saveBuffer({ prefix: 'parcel', ext, buffer: decoded });
      res.status(201).json({ url: saved.url });
    },
  );

  // Server-side Gemini Search Grounding & Google Maps Grounding for a parcel
  app.post(
    '/api/v1/listings/:id/grounding-insights',
    requireAuth,
    applyRateLimit('grounding_insights', 10, 60_000),
    async (req, res) => {
      const listing = store.findListingById(req.params.id);
      if (!listing) {
        res.status(404).json({ detail: 'Listing not found' });
        return;
      }

      const customFocus =
        typeof req.body?.focus === 'string' ? req.body.focus.trim().slice(0, 240) : '';
      const focusKey = customFocus.toLowerCase();
      const ttlHours = Math.max(1, Number(process.env.GROUNDING_CACHE_TTL_HOURS || 12) || 12);
      const forceRefresh = req.body?.force_refresh === true;

      if (!forceRefresh) {
        const cachedInsights = store.getGroundingCache(listing.id, focusKey, ttlHours);
        if (cachedInsights) {
          res.setHeader('X-Cache', 'HIT');
          res.json(cachedInsights);
          return;
        }
      }

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        res.status(503).json({
          detail: 'GEMINI_API_KEY is not configured in server secrets.',
        });
        return;
      }

      const ai = new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });

      const searchPrompt = [
        `Provide an objective real estate and regulatory research brief for a ${listing.land_type.toLowerCase()} land parcel in ${listing.locality}, ${listing.city}.`,
        `Parcel details: "${listing.title}", ${listing.area_acres} acres, zoning status "${listing.zoning_status}".`,
        customFocus ? `Specific buyer focus: ${customFocus}` : '',
        `Summarize recent public news or regulatory context regarding Karnataka regional urban/industrial authorities (BDA, BMRDA, MUDA, HDMC, BUDA, KIADB, RERA Karnataka), Bhoomi RTC / conversion guidance, local circle rate trends, and planned highway, airport, or rail corridors affecting ${listing.locality}, ${listing.city}. Keep it concise with bullet points.`,
      ]
        .filter(Boolean)
        .join('\n');

      const mapsPrompt = [
        `Identify key verified nearby infrastructure, arterial highways, metro or railway stations, industrial parks, hospitals, and commercial hubs near coordinates (${listing.latitude}, ${listing.longitude}) in ${listing.locality}, ${listing.city}.`,
        customFocus ? `Also address: ${customFocus}` : '',
        `Provide factual proximity and road connectivity notes relevant for evaluating this ${listing.land_type.toLowerCase()} land parcel.`,
      ]
        .filter(Boolean)
        .join('\n');

      try {
        const [searchOutcome, mapsOutcome] = await Promise.allSettled([
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: searchPrompt,
            config: {
              tools: [{ googleSearch: {} }],
            },
          }),
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: mapsPrompt,
            config: {
              tools: [{ googleMaps: {} }],
              toolConfig: {
                retrievalConfig: {
                  latLng: {
                    latitude: listing.latitude,
                    longitude: listing.longitude,
                  },
                },
              },
            },
          }),
        ]);

        if (searchOutcome.status === 'rejected' && mapsOutcome.status === 'rejected') {
          const searchMsg =
            searchOutcome.reason instanceof Error ? searchOutcome.reason.message : String(searchOutcome.reason || '');
          const mapsMsg =
            mapsOutcome.reason instanceof Error ? mapsOutcome.reason.message : String(mapsOutcome.reason || '');
          const combined = `${searchMsg} ${mapsMsg}`;
          const isQuota =
            combined.includes('429') ||
            combined.includes('RESOURCE_EXHAUSTED') ||
            combined.toLowerCase().includes('quota');
          res.status(isQuota ? 429 : 502).json({
            detail: isQuota
              ? 'Gemini or Maps grounding quota temporarily exhausted. Please retry shortly.'
              : `Grounding error: ${searchMsg || mapsMsg || 'Request failed'}`,
          });
          return;
        }

        const searchRes = searchOutcome.status === 'fulfilled' ? searchOutcome.value : null;
        const mapsRes = mapsOutcome.status === 'fulfilled' ? mapsOutcome.value : null;

        const searchChunks = searchRes?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const webSources = searchChunks
          .map((chunk: { web?: { uri?: string; title?: string } }) => chunk.web)
          .filter((w): w is { uri: string; title?: string } => Boolean(w?.uri))
          .map((w) => ({ uri: w.uri, title: w.title || w.uri }));

        const mapsChunks = mapsRes?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const mapsSources: Array<{
          uri: string;
          title: string;
          snippets: string[];
        }> = [];
        for (const chunk of mapsChunks as Array<{
          maps?: {
            uri?: string;
            title?: string;
            placeAnswerSources?: { reviewSnippets?: Array<{ content?: string }> };
          };
        }>) {
          if (chunk.maps?.uri) {
            const snippets =
              chunk.maps.placeAnswerSources?.reviewSnippets
                ?.map((s) => s.content)
                .filter((s): s is string => Boolean(s)) ?? [];
            mapsSources.push({
              uri: chunk.maps.uri,
              title: chunk.maps.title || 'Google Maps Place',
              snippets,
            });
          }
        }

        const responsePayload = {
          listing_id: listing.id,
          model: 'gemini-4-hydrogen',
          generated_at: new Date().toISOString(),
          search_summary:
            searchRes?.text ||
            (searchOutcome.status === 'rejected'
              ? 'Web regulatory search is temporarily busy. Maps proximity data is shown below.'
              : ''),
          web_sources: webSources,
          maps_summary:
            mapsRes?.text ||
            (mapsOutcome.status === 'rejected'
              ? 'Nearby Maps place summary is temporarily unavailable due to API quota.'
              : ''),
          maps_sources: mapsSources,
        };

        if (searchOutcome.status === 'fulfilled' && mapsOutcome.status === 'fulfilled') {
          store.setGroundingCache(listing.id, focusKey, responsePayload);
        }

        res.setHeader('X-Cache', 'MISS');
        res.json(responsePayload);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Grounding request failed';
        const isQuota =
          message.includes('429') ||
          message.includes('RESOURCE_EXHAUSTED') ||
          message.toLowerCase().includes('quota');
        res.status(isQuota ? 429 : 502).json({
          detail: isQuota
            ? 'Gemini or Maps grounding quota temporarily exhausted. Please retry shortly.'
            : `Grounding error: ${message}`,
        });
      }
    },
  );

  // ------------------------------------------------------------------
  // 3. PROPERTY-ANCHORED CHATS & BROKER DEAL ROOMS
  // ------------------------------------------------------------------
  app.get('/api/v1/chats', requireAuth, (req, res) => {
    const viewerUuid = req.auth!.sub;
    const online = engine.getOnlineUserUuids();
    const rows = store.listChatsForUser(viewerUuid);
    const userMap = store.findUsersByUuids(rows.flatMap((r) => r.room.participant_uuids));
    const summaries = rows.map(({ room, listing, last_message, unread_count }) => {
      const participants = room.participant_uuids
        .map((uid) => userMap.get(uid))
        .filter((u): u is UserRecord => Boolean(u))
        .map((u) => toPrivacySafeProfile(u, viewerUuid, online));
      return {
        ...room,
        listing,
        participants,
        last_message,
        unread_count,
      };
    });

    res.json({ chats: summaries });
  });

  app.post('/api/v1/chats/direct', requireAuth, (req, res) => {
    const { listing_id, peer_uuid } = req.body ?? {};
    const viewerUuid = req.auth!.sub;
    const listing = typeof listing_id === 'string' ? store.findListingById(listing_id) : undefined;
    if (!listing) {
      res.status(404).json({ detail: 'Listing not found' });
      return;
    }
    const targetUuid = typeof peer_uuid === 'string' && peer_uuid ? peer_uuid : listing.broker_uuid || listing.owner_uuid;
    if (targetUuid === viewerUuid) {
      res.status(400).json({ detail: 'Cannot start a direct chat with yourself' });
      return;
    }
    const targetUser = store.findUserByUuid(targetUuid);
    if (!targetUser) {
      res.status(404).json({ detail: 'Peer account not found' });
      return;
    }
    if (store.isBlockedBetween(viewerUuid, targetUuid)) {
      res.status(403).json({ detail: 'Messaging is unavailable because a participant block is active' });
      return;
    }
    const existing = store.findDirectChat(listing.id, viewerUuid, targetUuid);
    if (existing) {
      res.json(existing);
      return;
    }
    const now = new Date().toISOString();
    const room: ChatRoom = {
      id: `chat_${crypto.randomBytes(5).toString('hex')}`,
      room_type: 'DIRECT',
      title: listing.title,
      listing_id: listing.id,
      participant_uuids: [viewerUuid, targetUuid],
      created_by_uuid: viewerUuid,
      created_at: now,
      updated_at: now,
    };
    store.createChatRoom(room);
    engine.sendToUsers(room.participant_uuids, { event: 'chat.room_created', payload: room });
    res.status(201).json(room);
  });

  app.post(
    '/api/v1/chats/meeting-room',
    requireAuth,
    requireRoles('BROKER'),
    (req, res) => {
      const { listing_id, title, participant_uuids } = req.body ?? {};
      const broker = store.findUserByUuid(req.auth!.sub)!;
      const listing = typeof listing_id === 'string' ? store.findListingById(listing_id) : undefined;
      if (!listing) {
        res.status(404).json({ detail: 'Listing not found' });
        return;
      }
      const uniqueIds = Array.from(
        new Set([broker.user_uuid, ...(Array.isArray(participant_uuids) ? participant_uuids : [])]),
      ).filter((id) => typeof id === 'string' && Boolean(store.findUserByUuid(id)));

      if (uniqueIds.length < 2) {
        res.status(400).json({ detail: 'Select at least one additional participant for the deal room' });
        return;
      }

      const now = new Date().toISOString();
      const room: ChatRoom = {
        id: `room_${crypto.randomBytes(5).toString('hex')}`,
        room_type: 'MEETING_ROOM',
        title: clampString(title, 120, `${listing.locality} Deal Room`) || `${listing.locality} Deal Room`,
        listing_id: listing.id,
        participant_uuids: uniqueIds,
        created_by_uuid: broker.user_uuid,
        created_at: now,
        updated_at: now,
      };

      const addedNames = uniqueIds
        .filter((id) => id !== broker.user_uuid)
        .map((id) => {
          const u = store.findUserByUuid(id)!;
          return `${u.role.charAt(0) + u.role.slice(1).toLowerCase()} ${u.display_name.split(' ')[0]}`;
        })
        .join(' and ');

      const sysMsg: ChatMessage = {
        id: `msg_${crypto.randomBytes(6).toString('hex')}`,
        room_id: room.id,
        sender_uuid: broker.user_uuid,
        message_type: 'SYSTEM',
        body: `Broker ${broker.display_name.split(' ')[0]} added ${addedNames} to the deal room`,
        delivery_state: 'DELIVERED',
        read_by_uuids: [broker.user_uuid],
        created_at: now,
      };
      store.createChatRoom(room, [sysMsg]);

      engine.sendToUsers(uniqueIds, {
        event: 'chat.room_created',
        payload: { room, system_message: sysMsg },
      });
      res.status(201).json({ room, system_message: sysMsg });
    },
  );

  app.post(
    '/api/v1/chats/:roomId/participants',
    requireAuth,
    requireRoles('BROKER'),
    (req, res) => {
      const room = store.findChatRoomById(req.params.roomId);
      if (!room || room.room_type !== 'MEETING_ROOM') {
        res.status(404).json({ detail: 'Deal room not found' });
        return;
      }
      if (!room.participant_uuids.includes(req.auth!.sub)) {
        res.status(403).json({ detail: 'Only participating broker may add members' });
        return;
      }
      const peerUuid = String(req.body?.user_uuid || '');
      const peer = store.findUserByUuid(peerUuid);
      if (!peer) {
        res.status(404).json({ detail: 'Target user not found' });
        return;
      }
      if (!room.participant_uuids.includes(peerUuid)) {
        const broker = store.findUserByUuid(req.auth!.sub)!;
        const now = new Date().toISOString();
        const roleLabel = peer.role.charAt(0) + peer.role.slice(1).toLowerCase();
        const sysMsg: ChatMessage = {
          id: `msg_${crypto.randomBytes(6).toString('hex')}`,
          room_id: room.id,
          sender_uuid: broker.user_uuid,
          message_type: 'SYSTEM',
          body: `Broker ${broker.display_name.split(' ')[0]} added ${roleLabel} ${peer.display_name.split(' ')[0]} to the deal room`,
          delivery_state: 'DELIVERED',
          read_by_uuids: [broker.user_uuid],
          created_at: now,
        };
        const updatedRoom = store.addParticipantToRoom(room.id, peerUuid, sysMsg)!;
        engine.sendToUsers(updatedRoom.participant_uuids, { event: 'chat.message', payload: sysMsg });
        engine.sendToUsers(updatedRoom.participant_uuids, { event: 'chat.room_created', payload: updatedRoom });
        res.json({ room: updatedRoom });
        return;
      }
      res.json({ room });
    },
  );

  app.get('/api/v1/chats/:roomId/messages', requireAuth, (req, res) => {
    const room = store.findChatRoomById(req.params.roomId);
    if (!room || !room.participant_uuids.includes(req.auth!.sub)) {
      res.status(404).json({ detail: 'Chat room not found or access denied' });
      return;
    }
    const limit = Number(req.query.limit || 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const page = store.getRoomMessages(room.id, Number.isFinite(limit) ? limit : 100, cursor);
    res.json({ room_id: room.id, ...page });
  });

  app.post(
    '/api/v1/chats/:roomId/messages',
    requireAuth,
    applyRateLimit('chat_send', 60, 60_000),
    (req, res) => {
      const room = store.findChatRoomById(req.params.roomId);
      if (!room || !room.participant_uuids.includes(req.auth!.sub)) {
        res.status(404).json({ detail: 'Chat room not found or access denied' });
        return;
      }
      if (
        room.room_type === 'DIRECT' &&
        room.participant_uuids.some(
          (id) => id !== req.auth!.sub && store.isBlockedBetween(req.auth!.sub, id),
        )
      ) {
        res.status(403).json({ detail: 'Messaging is unavailable because a participant block is active' });
        return;
      }
      const bodyText = clampString(req.body?.body, 2000);
      if (!bodyText) {
        res.status(400).json({ detail: 'Message body cannot be empty' });
        return;
      }

      const online = engine.getOnlineUserUuids();
      const anyRecipientOnline = room.participant_uuids.some(
        (id) => id !== req.auth!.sub && online.has(id),
      );
      const now = new Date().toISOString();
      const msg: ChatMessage = {
        id: `msg_${crypto.randomBytes(6).toString('hex')}`,
        room_id: room.id,
        sender_uuid: req.auth!.sub,
        message_type: 'TEXT',
        body: bodyText,
        delivery_state: anyRecipientOnline ? 'DELIVERED' : 'SENT',
        read_by_uuids: [req.auth!.sub],
        created_at: now,
      };
      store.createMessage(msg);

      engine.sendToUsers(room.participant_uuids, {
        event: 'chat.message',
        payload: msg,
      });
      res.status(201).json(msg);
    },
  );

  app.post(
    '/api/v1/chats/:roomId/attachments',
    requireAuth,
    applyRateLimit('chat_attach', 20, 60_000),
    async (req, res) => {
      const room = store.findChatRoomById(req.params.roomId);
      if (!room || !room.participant_uuids.includes(req.auth!.sub)) {
        res.status(404).json({ detail: 'Chat room not found or access denied' });
        return;
      }
      if (
        room.room_type === 'DIRECT' &&
        room.participant_uuids.some(
          (id) => id !== req.auth!.sub && store.isBlockedBetween(req.auth!.sub, id),
        )
      ) {
        res.status(403).json({ detail: 'Messaging is unavailable because a participant block is active' });
        return;
      }

      const { filename, data_url, body } = req.body ?? {};
      const cleanName = clampString(filename, 120, 'document');
      if (!cleanName || typeof data_url !== 'string') {
        res.status(400).json({ detail: 'Valid filename and base64 data_url are required' });
        return;
      }

      const match = data_url.match(
        /^data:(application\/pdf|image\/png|image\/jpeg|image\/jpg|image\/webp);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match) {
        res.status(400).json({ detail: 'Unsupported attachment format. Allowed: PDF, PNG, JPEG, WEBP' });
        return;
      }

      const mime = match[1];
      const ext = (
        mime === 'application/pdf'
          ? 'pdf'
          : mime === 'image/jpeg' || mime === 'image/jpg'
          ? 'jpg'
          : mime === 'image/png'
          ? 'png'
          : 'webp'
      ) as 'png' | 'jpg' | 'webp' | 'pdf';

      const decoded = Buffer.from(match[2], 'base64');
      if (decoded.length === 0 || decoded.length > MAX_UPLOAD_BYTES) {
        res.status(400).json({ detail: 'Attachment file size must be under 5 MB' });
        return;
      }
      if (!verifyAttachmentMagicBytes(decoded, ext)) {
        res.status(400).json({ detail: 'File bytes do not match declared attachment format' });
        return;
      }

      const saved = await storage.saveBuffer({ subdir: 'attachments', prefix: 'doc', ext, buffer: decoded });
      const online = engine.getOnlineUserUuids();
      const anyRecipientOnline = room.participant_uuids.some(
        (id) => id !== req.auth!.sub && online.has(id),
      );
      const now = new Date().toISOString();
      const caption = clampString(body, 500) || `Shared document: ${cleanName}`;
      const msg: ChatMessage = {
        id: `msg_${crypto.randomBytes(6).toString('hex')}`,
        room_id: room.id,
        sender_uuid: req.auth!.sub,
        message_type: 'TEXT',
        body: caption,
        attachment_url: saved.url,
        attachment_name: cleanName,
        attachment_type: mime === 'image/jpg' ? 'image/jpeg' : mime,
        delivery_state: anyRecipientOnline ? 'DELIVERED' : 'SENT',
        read_by_uuids: [req.auth!.sub],
        created_at: now,
      };
      store.createMessage(msg);
      engine.sendToUsers(room.participant_uuids, {
        event: 'chat.message',
        payload: msg,
      });
      res.status(201).json(msg);
    },
  );

  app.post('/api/v1/chats/:roomId/read', requireAuth, (req, res) => {
    const room = store.findChatRoomById(req.params.roomId);
    if (!room || !room.participant_uuids.includes(req.auth!.sub)) {
      res.status(404).json({ detail: 'Chat room not found' });
      return;
    }
    const viewerUuid = req.auth!.sub;
    const updated = store.markRoomRead(room.id, viewerUuid);
    if (updated) {
      engine.sendToUsers(
        room.participant_uuids,
        {
          event: 'chat.read_receipt',
          payload: { room_id: room.id, reader_uuid: viewerUuid },
        },
        viewerUuid,
      );
    }
    res.json({ status: 'ok' });
  });

  // ------------------------------------------------------------------
  // 4. IN-APP AUDIO & VIDEO CALLING + WEBRTC SIGNALING STATE MACHINE
  // ------------------------------------------------------------------
  app.post(
    '/api/v1/calls/initiate',
    requireAuth,
    applyRateLimit('calls_initiate', 12, 60_000),
    (req, res) => {
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      if (idempotencyKey) {
        const cached = store.getIdempotency(idempotencyKey, 'POST', '/api/v1/calls/initiate', req.auth!.sub);
        if (cached) {
          res.setHeader('X-Idempotent-Replay', 'true');
          res.status(cached.status_code).json(cached.response_body);
          return;
        }
      }

      const { room_id, mode } = req.body ?? {};
      const room = typeof room_id === 'string' ? store.findChatRoomById(room_id) : undefined;
      if (!room || !room.participant_uuids.includes(req.auth!.sub)) {
        res.status(404).json({ detail: 'Chat room not found or access denied' });
        return;
      }
      const callMode: CallMode = mode === 'VIDEO' ? 'VIDEO' : 'AUDIO';
      const callees = room.participant_uuids.filter((id) => id !== req.auth!.sub);

      const outcome = engine.initiateCall({
        roomId: room.id,
        listingId: room.listing_id,
        callerUuid: req.auth!.sub,
        calleeUuids: callees,
        mode: callMode,
      });

      if (!outcome.ok) {
        res.status(outcome.statusCode || 400).json({ detail: outcome.error });
        return;
      }

      const responseBody = {
        call: outcome.call,
        room_token: outcome.roomToken,
        ice_servers: engine.getIceServers(),
      };
      if (idempotencyKey) {
        store.setIdempotency(idempotencyKey, 'POST', '/api/v1/calls/initiate', req.auth!.sub, 201, responseBody);
        metrics.inc('landconnect_idempotency_stored_total', { route: 'calls_initiate' });
      }
      res.status(201).json(responseBody);
    },
  );

  app.get('/api/v1/calls/active', requireAuth, (req, res) => {
    const active = engine.getActiveCallForUser(req.auth!.sub);
    if (!active) {
      res.json({ active: null });
      return;
    }
    const listing = active.call.listing_id
      ? store.findListingById(active.call.listing_id)
      : undefined;
    const online = engine.getOnlineUserUuids();
    const caller = store.findUserByUuid(active.call.caller_uuid);
    res.json({
      active: {
        ...active,
        listing_title: listing?.title ?? 'LandConnect Inquiry',
        caller_profile: caller ? toPrivacySafeProfile(caller, req.auth!.sub, online) : null,
      },
    });
  });

  app.post('/api/v1/calls/:callId/accept', requireAuth, (req, res) => {
    const outcome = engine.acceptCall(req.params.callId, req.auth!.sub);
    if (!outcome.ok) {
      res.status(outcome.statusCode || 400).json({ detail: outcome.error });
      return;
    }
    res.json({
      call: outcome.call,
      room_token: outcome.roomToken,
      ice_servers: engine.getIceServers(),
    });
  });

  app.post('/api/v1/calls/:callId/reject', requireAuth, (req, res) => {
    const outcome = engine.rejectCall(req.params.callId, req.auth!.sub, req.body?.reason);
    if (!outcome.ok) {
      res.status(outcome.statusCode || 400).json({ detail: outcome.error });
      return;
    }
    res.json({ call: outcome.call });
  });

  app.post('/api/v1/calls/:callId/end', requireAuth, (req, res) => {
    const outcome = engine.endCall(req.params.callId, req.auth!.sub, req.body?.reason);
    if (!outcome.ok) {
      res.status(outcome.statusCode || 400).json({ detail: outcome.error });
      return;
    }
    res.json({ call: outcome.call });
  });

  app.get('/api/v1/calls/logs', requireAuth, (req, res) => {
    const viewerUuid = req.auth!.sub;
    const online = engine.getOnlineUserUuids();
    const rawLogs = store.getCallLogsForUser(viewerUuid, 50);
    const userMap = store.findUsersByUuids(
      rawLogs.flatMap((c) => [c.caller_uuid, ...c.callee_uuids]),
    );
    const listingMap = store.findListingsByIds(
      rawLogs.map((c) => c.listing_id).filter((id): id is string => Boolean(id)),
    );
    const logs = rawLogs.map((c) => {
      const caller = userMap.get(c.caller_uuid);
      const callees = c.callee_uuids
        .map((id) => userMap.get(id))
        .filter((u): u is UserRecord => Boolean(u))
        .map((u) => toPrivacySafeProfile(u, viewerUuid, online));
      const listing = c.listing_id ? listingMap.get(c.listing_id) : undefined;
      return {
        ...c,
        direction: c.caller_uuid === viewerUuid ? 'OUTGOING' : 'INCOMING',
        caller_profile: caller ? toPrivacySafeProfile(caller, viewerUuid, online) : null,
        callee_profiles: callees,
        listing_title: listing?.title ?? 'Direct Consultation',
      };
    });
    res.json({ logs });
  });

  return { app, store, engine };
}

export function attachWebSocketHub(
  server: http.Server,
  store: SqliteStore = defaultStore,
  engine: CallSignalingEngine = defaultCallEngine,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') {
      return;
    }
    const token = url.searchParams.get('token');
    const auth = token ? verifyAccessToken(token) : null;
    const user = auth ? store.findUserByUuid(auth.sub) : undefined;
    if (!auth || !user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, auth);
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      const sock = client as WebSocket & { isAlive?: boolean };
      if (sock.isAlive === false) {
        sock.terminate();
        continue;
      }
      sock.isAlive = false;
      sock.ping();
    }
  }, 25_000);

  wss.on('connection', (ws: WebSocket, auth: AccessTokenPayload) => {
    const sock = ws as WebSocket & { isAlive?: boolean };
    sock.isAlive = true;
    sock.on('pong', () => {
      sock.isAlive = true;
    });

    const userUuid = auth.sub;
    engine.registerSocket(userUuid, ws);

    ws.send(
      JSON.stringify({
        event: 'ws.connected',
        payload: {
          user_uuid: userUuid,
          online_users: Array.from(engine.getOnlineUserUuids()),
        },
      }),
    );

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { event?: string; payload?: Record<string, unknown> };
        const event = parsed.event;
        const payload = parsed.payload || {};

        if (event === 'chat.typing') {
          const roomId = String(payload.room_id || '');
          const room = store.findChatRoomById(roomId);
          if (room && room.participant_uuids.includes(userUuid)) {
            engine.sendToUsers(
              room.participant_uuids,
              {
                event: 'chat.typing',
                payload: {
                  room_id: room.id,
                  user_uuid: userUuid,
                  is_typing: Boolean(payload.is_typing),
                },
              },
              userUuid,
            );
          }
        } else if (
          event === 'webrtc.offer' ||
          event === 'webrtc.answer' ||
          event === 'webrtc.ice' ||
          event === 'call.mode_switch'
        ) {
          engine.relayWebRtcSignal(userUuid, event, payload as { call_id: string });
        }
      } catch {
        // Ignore malformed frames
      }
    });

    ws.on('close', () => {
      engine.unregisterSocket(userUuid, ws);
    });
  });

  return { wss, heartbeatTimer };
}

async function startServer() {
  const PORT = Number(process.env.PORT || 3000);
  let isShuttingDown = false;
  const { app, store, engine } = createLandConnectApp({
    isShuttingDown: () => isShuttingDown,
  });
  const server = http.createServer(app);
  const { wss, heartbeatTimer } = attachWebSocketHub(server, store, engine);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '1y',
        immutable: true,
      }),
    );
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    structuredLog('INFO', 'server_started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      db_journal: store.journalMode,
    });
  });

  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    structuredLog('INFO', 'graceful_shutdown', { signal });
    clearInterval(heartbeatTimer);
    engine.shutdownTimers();
    wss.close();
    server.close(() => {
      store.checkpointAndClose();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Auto-start only when launched directly (not imported by test runner)
const isDirectEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectEntry && process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error('Failed to start LandConnect server:', err);
    process.exit(1);
  });
}
