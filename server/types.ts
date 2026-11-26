export type UserRole = 'BUYER' | 'SELLER' | 'BROKER';

export type LandType = 'AGRICULTURAL' | 'RESIDENTIAL' | 'COMMERCIAL' | 'INDUSTRIAL';

export type VerificationStatus = 'VERIFIED' | 'RERA_APPROVED' | 'PENDING_SURVEY';

export type CallState = 'RINGING' | 'CONNECTED' | 'ENDED' | 'REJECTED' | 'MISSED' | 'BUSY';

export type CallMode = 'AUDIO' | 'VIDEO';

export type MessageDeliveryState = 'SENT' | 'DELIVERED' | 'READ';

export interface UserRecord {
  user_uuid: string;
  email: string;
  phone: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  city: string;
  bio: string;
  allow_calls: boolean;
  show_contact_after_consent: boolean;
  consented_peer_uuids: string[];
  is_demo?: boolean;
  created_at: string;
}

export interface PublicUserProfile {
  user_uuid: string;
  display_name: string;
  role: UserRole;
  city: string;
  bio: string;
  allow_calls: boolean;
  show_contact_after_consent: boolean;
  contact_revealed: boolean;
  masked_handle: string;
  email?: string;
  phone?: string;
  consented_peer_uuids?: string[];
  is_online?: boolean;
}

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface LandListing {
  id: string;
  title: string;
  description: string;
  price_inr: number;
  area_sqft: number;
  area_acres: number;
  land_type: LandType;
  zoning_status: string;
  verification_status: VerificationStatus;
  locality: string;
  city: string;
  latitude: number;
  longitude: number;
  polygon_geojson: GeoJsonPolygon;
  images: string[];
  owner_uuid: string;
  broker_uuid?: string;
  version: number;
  created_at: string;
  updated_at: string;
  distance_km?: number;
}

export interface ChatRoom {
  id: string;
  room_type: 'DIRECT' | 'MEETING_ROOM';
  title: string;
  listing_id: string;
  participant_uuids: string[];
  created_by_uuid: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  sender_uuid: string;
  message_type: 'TEXT' | 'SYSTEM';
  body: string;
  attachment_url?: string;
  attachment_name?: string;
  attachment_type?: string;
  delivery_state: MessageDeliveryState;
  read_by_uuids: string[];
  created_at: string;
}

export interface ListingReport {
  id: string;
  listing_id: string;
  reporter_uuid: string;
  reason: string;
  details: string;
  created_at: string;
}

export interface CallSession {
  call_id: string;
  room_id: string;
  listing_id?: string;
  caller_uuid: string;
  callee_uuids: string[];
  mode: CallMode;
  state: CallState;
  webrtc_room_name: string;
  started_at: string;
  answered_at?: string;
  ended_at?: string;
  duration_seconds: number;
  end_reason?: string;
}

export interface IdempotencyRecord {
  key: string;
  method: string;
  path: string;
  user_uuid: string;
  status_code: number;
  response_body: unknown;
  created_at: number;
}
