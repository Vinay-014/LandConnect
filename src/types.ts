export type UserRole = 'BUYER' | 'SELLER' | 'BROKER';
export type LandType = 'AGRICULTURAL' | 'RESIDENTIAL' | 'COMMERCIAL' | 'INDUSTRIAL';
export type VerificationStatus = 'VERIFIED' | 'RERA_APPROVED' | 'PENDING_SURVEY';
export type CallState = 'RINGING' | 'CONNECTED' | 'ENDED' | 'REJECTED' | 'MISSED' | 'BUSY';
export type CallMode = 'AUDIO' | 'VIDEO';

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
  owner_profile?: PublicUserProfile | null;
  broker_profile?: PublicUserProfile | null;
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
  delivery_state: 'SENT' | 'DELIVERED' | 'READ';
  read_by_uuids: string[];
  created_at: string;
}

export interface ChatRoomSummary {
  id: string;
  room_type: 'DIRECT' | 'MEETING_ROOM';
  title: string;
  listing_id: string;
  participant_uuids: string[];
  created_by_uuid: string;
  created_at: string;
  updated_at: string;
  listing: LandListing | null;
  participants: PublicUserProfile[];
  last_message: ChatMessage | null;
  unread_count: number;
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

export interface CallLogEntry extends CallSession {
  direction: 'INCOMING' | 'OUTGOING';
  caller_profile: PublicUserProfile | null;
  callee_profiles: PublicUserProfile[];
  listing_title: string;
}

export interface ActiveCallUiState {
  call: CallSession;
  direction: 'INCOMING' | 'OUTGOING';
  peerName: string;
  peerRole: UserRole | 'GROUP';
  listingTitle: string;
  listingImage?: string | null;
  roomToken?: string;
  iceServers: RTCIceServer[];
}

export interface ParcelGroundingInsights {
  listing_id: string;
  model: string;
  generated_at: string;
  search_summary: string;
  web_sources: Array<{ uri: string; title: string }>;
  maps_summary: string;
  maps_sources: Array<{ uri: string; title: string; snippets: string[] }>;
}

