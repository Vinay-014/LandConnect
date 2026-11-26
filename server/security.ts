import crypto from 'crypto';
import type { PublicUserProfile, UserRecord, UserRole } from './types.ts';

let jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
let callTokenSecret = process.env.CALL_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

export function configureSecuritySecrets(secrets: {
  jwtSecret?: string;
  callTokenSecret?: string;
}) {
  if (secrets.jwtSecret) jwtSecret = secrets.jwtSecret;
  if (secrets.callTokenSecret) callTokenSecret = secrets.callTokenSecret;
}

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  type: 'access';
  exp: number;
  iat: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
  exp: number;
  iat: number;
}

export interface EphemeralCallTokenPayload {
  call_id: string;
  webrtc_room_name: string;
  user_uuid: string;
  role: UserRole;
  exp: number;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function hashPasswordAsync(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(`scrypt$${salt}$${derived.toString('hex')}`);
    });
  });
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, originalHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(originalHex, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

export function verifyPasswordAsync(password: string, storedHash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      resolve(false);
      return;
    }
    const [, salt, originalHex] = parts;
    const original = Buffer.from(originalHex, 'hex');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      if (derived.length !== original.length) {
        resolve(false);
        return;
      }
      resolve(crypto.timingSafeEqual(derived, original));
    });
  });
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

function signJwt(payload: object, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = base64UrlEncode(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verifyJwt<T>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const expectedSig = base64UrlEncode(crypto.createHmac('sha256', secret).update(data).digest());
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(body)) as T & { exp?: number };
    if (typeof parsed.exp === 'number' && Date.now() / 1000 > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function issueAccessToken(user: UserRecord): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    sub: user.user_uuid,
    role: user.role,
    type: 'access',
    iat: now,
    exp: now + 60 * 60 * 4, // 4 hours for smooth evaluation
  };
  return signJwt(payload, jwtSecret);
}

export function issueRefreshToken(user: UserRecord): { token: string; jti: string } {
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const payload: RefreshTokenPayload = {
    sub: user.user_uuid,
    jti,
    type: 'refresh',
    iat: now,
    exp: now + 60 * 60 * 24 * 7,
  };
  return { token: signJwt(payload, jwtSecret), jti };
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const payload = verifyJwt<AccessTokenPayload>(token, jwtSecret);
  if (!payload || payload.type !== 'access') return null;
  return payload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  const payload = verifyJwt<RefreshTokenPayload>(token, jwtSecret);
  if (!payload || payload.type !== 'refresh') return null;
  return payload;
}

export function issueEphemeralCallToken(
  callId: string,
  webrtcRoomName: string,
  user: UserRecord,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: EphemeralCallTokenPayload = {
    call_id: callId,
    webrtc_room_name: webrtcRoomName,
    user_uuid: user.user_uuid,
    role: user.role,
    exp: now + 300, // 5 minutes ephemeral room token
  };
  return signJwt(payload, callTokenSecret);
}

export function toPrivacySafeProfile(
  target: UserRecord,
  viewerUuid: string | null,
  onlineUserUuids?: Set<string>,
): PublicUserProfile {
  const isSelf = viewerUuid === target.user_uuid;
  const mutualConsent =
    Boolean(viewerUuid) &&
    target.show_contact_after_consent &&
    target.consented_peer_uuids.includes(viewerUuid!);
  const contactRevealed = isSelf || mutualConsent;

  return {
    user_uuid: target.user_uuid,
    display_name: target.display_name,
    role: target.role,
    city: target.city,
    bio: target.bio,
    allow_calls: target.allow_calls,
    show_contact_after_consent: target.show_contact_after_consent,
    contact_revealed: contactRevealed,
    masked_handle: `@${target.user_uuid.slice(0, 12)}`,
    ...(contactRevealed ? { email: target.email, phone: target.phone } : {}),
    ...(isSelf ? { consented_peer_uuids: [...target.consented_peer_uuids] } : {}),
    is_online: onlineUserUuids ? onlineUserUuids.has(target.user_uuid) : undefined,
  };
}

/**
 * Sliding-window in-memory rate limiter (mirrors Redis ZREMRANGEBYSCORE + ZCARD pattern).
 */
export class SlidingWindowRateLimiter {
  private static readonly MAX_BUCKETS = 20_000;
  private buckets = new Map<string, number[]>();
  private lastPruneMs = Date.now();

  private pruneStale(now: number, windowMs: number) {
    if (now - this.lastPruneMs < 60_000 && this.buckets.size < 2000) return;
    this.lastPruneMs = now;
    const cutoff = now - windowMs;
    for (const [key, list] of this.buckets.entries()) {
      if (list.length === 0 || list[list.length - 1] <= cutoff) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size > SlidingWindowRateLimiter.MAX_BUCKETS) {
      const overflow = this.buckets.size - SlidingWindowRateLimiter.MAX_BUCKETS;
      let removed = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  check(key: string, maxRequests: number, windowMs: number): {
    allowed: boolean;
    remaining: number;
    retryAfterSec: number;
  } {
    const now = Date.now();
    this.pruneStale(now, windowMs);
    const cutoff = now - windowMs;
    const timestamps = (this.buckets.get(key) || []).filter((ts) => ts > cutoff);

    if (timestamps.length >= maxRequests) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      this.buckets.delete(key);
      this.buckets.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    timestamps.push(now);
    this.buckets.delete(key);
    this.buckets.set(key, timestamps);
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - timestamps.length),
      retryAfterSec: 0,
    };
  }
}
