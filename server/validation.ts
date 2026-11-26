import type { GeoJsonPolygon, LandType, UserRole } from './types.ts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_REGEX = /^[+0-9()\-\s]{7,20}$/;

export const VALID_ROLES: UserRole[] = ['BUYER', 'SELLER', 'BROKER'];
export const VALID_LAND_TYPES: LandType[] = ['AGRICULTURAL', 'RESIDENTIAL', 'COMMERCIAL', 'INDUSTRIAL'];

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_REGEX.test(email);
}

export function isValidPhone(phone: string): boolean {
  return PHONE_REGEX.test(phone.trim());
}

export function isValidCoords(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isValidPolygonGeoJson(poly: unknown): poly is GeoJsonPolygon {
  if (!poly || typeof poly !== 'object') return false;
  const candidate = poly as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== 'Polygon' || !Array.isArray(candidate.coordinates) || candidate.coordinates.length === 0) {
    return false;
  }
  const ring = candidate.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 200) return false;
  return ring.every(
    (pt) =>
      Array.isArray(pt) &&
      pt.length >= 2 &&
      typeof pt[0] === 'number' &&
      typeof pt[1] === 'number' &&
      Number.isFinite(pt[0]) &&
      Number.isFinite(pt[1]) &&
      pt[0] >= -180 &&
      pt[0] <= 180 &&
      pt[1] >= -90 &&
      pt[1] <= 90,
  );
}

export function verifyImageMagicBytes(buf: Buffer, ext: 'png' | 'jpg' | 'webp'): boolean {
  if (buf.length < 12) return false;
  if (ext === 'png') {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  if (ext === 'jpg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (ext === 'webp') {
    return (
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

export function verifyAttachmentMagicBytes(
  buf: Buffer,
  ext: 'png' | 'jpg' | 'webp' | 'pdf',
): boolean {
  if (ext === 'pdf') {
    return buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  return verifyImageMagicBytes(buf, ext);
}

export function clampString(value: unknown, maxLen: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLen);
}
