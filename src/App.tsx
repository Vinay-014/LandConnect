import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Ban,
  Bell,
  Box,
  Check,
  CheckCheck,
  Compass,
  Edit3,
  ExternalLink,
  FileText,
  Flag,
  Globe,
  KeyRound,
  Lock,
  LogOut,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  Paperclip,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Plus,
  Search,
  Send,
  Shield,
  Sparkles,
  Trash2,
  User,
  Users,
  Video,
  X,
} from 'lucide-react';
import {
  apiRequest,
  ApiError,
  formatDuration,
  formatInrPrice,
  getAccessToken,
  getRefreshToken,
  setAuthTokens,
  tryRefreshAccessToken,
} from './api/client';
import { CallOverlay } from './components/CallOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GoogleParcelMap } from './components/GoogleParcelMap';
import { LandingPage } from './components/LandingPage';
import { LeafletMap } from './components/LeafletMap';
import { ListingModal } from './components/ListingModal';
import { MeetingRoomModal } from './components/MeetingRoomModal';
import { ParcelScene3D } from './components/ParcelScene3D';
import type {
  ActiveCallUiState,
  CallLogEntry,
  CallMode,
  CallSession,
  ChatMessage,
  ChatRoomSummary,
  LandListing,
  LandType,
  ParcelGroundingInsights,
  PublicUserProfile,
} from './types';

type AppTab = 'communities' | 'chats' | 'calls' | 'profile';

const LAND_TYPES: Array<{ key: 'ALL' | LandType; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'AGRICULTURAL', label: 'Agricultural' },
  { key: 'RESIDENTIAL', label: 'Residential' },
  { key: 'COMMERCIAL', label: 'Commercial' },
  { key: 'INDUSTRIAL', label: 'Industrial' },
];

function ListingImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="w-full h-full bg-gradient-to-br from-emerald-900/15 to-slate-200 flex items-center justify-center text-slate-500">
        <MapIcon className="w-7 h-7" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="w-full h-full object-cover"
    />
  );
}

function isSafeAttachmentUrl(url?: string): boolean {
  if (!url) return false;
  return url.startsWith('/uploads/') || url.startsWith('https://');
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<PublicUserProfile | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('communities');
  const [toast, setToast] = useState<{ type: 'info' | 'error'; text: string } | null>(null);

  // Listings & Geospatial state
  const [listings, setListings] = useState<LandListing[]>([]);
  const [totalListings, setTotalListings] = useState<number>(0);
  const [hasMoreListings, setHasMoreListings] = useState(false);
  const [listingsLoading, setListingsLoading] = useState(false);
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [landTypeFilter, setLandTypeFilter] = useState<'ALL' | LandType>('ALL');
  const [cityFilter, setCityFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<'price_asc' | 'updated_desc' | 'price_desc'>('price_asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [maxPriceCr, setMaxPriceCr] = useState<number>(25);
  const [radiusEnabled, setRadiusEnabled] = useState(false);
  const [bboxSearchEnabled, setBboxSearchEnabled] = useState(false);
  const [radiusKm, setRadiusKm] = useState(50);
  const [searchCenter, setSearchCenter] = useState<{ lat: number; lng: number }>({ lat: 12.9716, lng: 77.5946 });
  const [viewMode, setViewMode] = useState<'split' | 'map' | 'feed'>('split');
  const [spatialEngine, setSpatialEngine] = useState<'google' | 'threejs' | 'leaflet'>('google');
  const [mapsApiKey, setMapsApiKey] = useState<string>(
    () => (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '',
  );
  const [gmpQuotaExceeded, setGmpQuotaExceeded] = useState(false);
  const [groundingFocus, setGroundingFocus] = useState('');
  const [groundingLoading, setGroundingLoading] = useState(false);
  const [groundingError, setGroundingError] = useState<string | null>(null);
  const [groundingByListing, setGroundingByListing] = useState<Record<string, ParcelGroundingInsights>>({});
  const [listingModalOpen, setListingModalOpen] = useState(false);
  const [editingListing, setEditingListing] = useState<LandListing | null>(null);
  const [reportingListing, setReportingListing] = useState<LandListing | null>(null);
  const [reportReason, setReportReason] = useState('Misleading pricing or area details');
  const [reportDetails, setReportDetails] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);

  // Chats & Deal Rooms state
  const [chats, setChats] = useState<ChatRoomSummary[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [draftMessage, setDraftMessage] = useState('');
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [typingUsersByRoom, setTypingUsersByRoom] = useState<Record<string, string[]>>({});
  const [meetingModalOpen, setMeetingModalOpen] = useState(false);
  const [allUsers, setAllUsers] = useState<PublicUserProfile[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<PublicUserProfile[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());

  // Account & Notification Preferences
  const [profileName, setProfileName] = useState('');
  const [profileCity, setProfileCity] = useState('');
  const [profileBio, setProfileBio] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => typeof Notification !== 'undefined' && Notification.permission === 'granted',
  );
  const notificationsEnabledRef = useRef(notificationsEnabled);
  notificationsEnabledRef.current = notificationsEnabled;

  // Active Call state
  const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);
  const [activeCall, setActiveCall] = useState<ActiveCallUiState | null>(null);
  const activeCallRef = useRef<ActiveCallUiState | null>(null);
  activeCallRef.current = activeCall;
  const [incomingSignal, setIncomingSignal] = useState<{
    event: string;
    payload: Record<string, unknown>;
    seq: number;
  } | null>(null);
  const signalSeqRef = useRef(0);

  // Realtime messaging reference
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const hasLoadedListingsRef = useRef(false);

  const showToast = useCallback((text: string, type: 'info' | 'error' = 'info') => {
    setToast({ text, type });
    window.setTimeout(() => {
      setToast((prev) => (prev?.text === text ? null : prev));
    }, 4000);
  }, []);

  const loadListings = useCallback(async (offset = 0, append = false) => {
    if (!currentUser) return;
    setListingsLoading(true);
    try {
      if (radiusEnabled) {
        const res = await apiRequest<{ listings: LandListing[] }>(
          `/api/v1/listings/nearby?lat=${searchCenter.lat}&lng=${searchCenter.lng}&radius_km=${radiusKm}`,
        );
        setListings(res.listings);
        setTotalListings(res.listings.length);
        setHasMoreListings(false);
      } else {
        const params = new URLSearchParams();
        if (landTypeFilter !== 'ALL') params.set('land_type', landTypeFilter);
        if (cityFilter !== 'ALL') params.set('city', cityFilter);
        if (searchQuery.trim()) params.set('q', searchQuery.trim());
        params.set('max_price', String(Math.round(maxPriceCr * 10000000)));
        params.set('sort', sortBy);
        params.set('limit', '24');
        params.set('offset', String(offset));
        const res = await apiRequest<{
          listings: LandListing[];
          total?: number;
          has_more?: boolean;
        }>(`/api/v1/listings?${params.toString()}`);
        setListings((prev) => (append ? [...prev, ...res.listings] : res.listings));
        setTotalListings(res.total ?? res.listings.length);
        setHasMoreListings(Boolean(res.has_more));
      }
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to load listings', 'error');
    } finally {
      setListingsLoading(false);
    }
  }, [currentUser?.user_uuid, radiusEnabled, searchCenter, radiusKm, landTypeFilter, cityFilter, sortBy, searchQuery, maxPriceCr, showToast]);

  const loadChats = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await apiRequest<{ chats: ChatRoomSummary[] }>('/api/v1/chats');
      setChats(res.chats);
    } catch {
      // silent
    }
  }, [currentUser]);

  const loadCallLogs = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await apiRequest<{ logs: CallLogEntry[] }>('/api/v1/calls/logs');
      setCallLogs(res.logs);
    } catch {
      // silent
    }
  }, [currentUser]);

  const loadUsers = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await apiRequest<{ users: PublicUserProfile[] }>('/api/v1/users');
      setAllUsers(res.users);
    } catch {
      // silent
    }
  }, [currentUser]);

  const loadBlockedUsers = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await apiRequest<{ blocked_users: PublicUserProfile[] }>('/api/v1/users/blocked');
      setBlockedUsers(res.blocked_users);
    } catch {
      // silent
    }
  }, [currentUser]);

  const loadRoomMessages = useCallback(async (roomId: string) => {
    try {
      const res = await apiRequest<{ messages: ChatMessage[] }>(`/api/v1/chats/${roomId}/messages`);
      setMessagesByRoom((prev) => ({ ...prev, [roomId]: res.messages }));
      await apiRequest(`/api/v1/chats/${roomId}/read`, { method: 'POST' });
      setChats((prev) => prev.map((c) => (c.id === roomId ? { ...c, unread_count: 0 } : c)));
    } catch {
      // silent
    }
  }, []);

  const hydrateActiveCall = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await apiRequest<{
        active: {
          call: CallSession;
          roomToken?: string;
          iceServers: RTCIceServer[];
          listing_title: string;
          caller_profile: PublicUserProfile | null;
        } | null;
      }>('/api/v1/calls/active');
      if (res.active && !activeCallRef.current) {
        const c = res.active.call;
        setActiveCall({
          call: c,
          direction: c.caller_uuid === currentUser.user_uuid ? 'OUTGOING' : 'INCOMING',
          peerName: res.active.caller_profile?.display_name || 'LandConnect Call',
          peerRole: res.active.caller_profile?.role || 'BROKER',
          listingTitle: res.active.listing_title,
          roomToken: res.active.roomToken,
          iceServers: res.active.iceServers,
        });
      }
    } catch {
      // silent
    }
  }, [currentUser?.user_uuid]);

  // Global Google Maps Platform Demo Quota listener + public config loader
  useEffect(() => {
    const onQuotaExceeded = () => {
      setGmpQuotaExceeded(true);
      setSpatialEngine((prev) => (prev === 'google' ? 'leaflet' : prev));
    };
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);

    let lastRuntimeToastAt = 0;
    const onRuntimeError = (evt: Event) => {
      const detail = (evt as CustomEvent<{ message?: string }>).detail;
      const now = Date.now();
      if (now - lastRuntimeToastAt < 3000) return;
      lastRuntimeToastAt = now;
      const msg = (detail?.message || 'Unexpected runtime error').slice(0, 140);
      showToast(`Unexpected error: ${msg}`, 'error');
    };
    window.addEventListener('app-runtime-error', onRuntimeError);

    if (!mapsApiKey) {
      fetch('/api/v1/config/maps')
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { apiKey?: string } | null) => {
          if (data?.apiKey) {
            setMapsApiKey(data.apiKey);
          } else {
            setSpatialEngine('leaflet');
          }
        })
        .catch(() => setSpatialEngine('leaflet'));
    }

    return () => {
      window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
      window.removeEventListener('app-runtime-error', onRuntimeError);
    };
  }, [mapsApiKey, showToast]);

  // Initial session hydration on login
  useEffect(() => {
    if (!currentUser) return;
    setProfileName(currentUser.display_name);
    setProfileCity(currentUser.city);
    setProfileBio(currentUser.bio);
    loadChats();
    loadCallLogs();
    loadUsers();
    loadBlockedUsers();
    hydrateActiveCall();
  }, [currentUser?.user_uuid, loadChats, loadCallLogs, loadUsers, loadBlockedUsers, hydrateActiveCall]);

  // Listings fetch: immediate on first login, debounced on filter changes, skipped while bbox pan mode owns spatial query
  useEffect(() => {
    if (!currentUser) return;
    if (bboxSearchEnabled && !radiusEnabled) return;
    if (!hasLoadedListingsRef.current) {
      hasLoadedListingsRef.current = true;
      void loadListings();
      return;
    }
    const timer = window.setTimeout(() => {
      void loadListings();
    }, 160);
    return () => window.clearTimeout(timer);
  }, [currentUser?.user_uuid, bboxSearchEnabled, radiusEnabled, loadListings]);

  // Select first listing on load and clear stale grounding errors when switching parcels
  useEffect(() => {
    if (listings.length > 0 && !selectedListingId) {
      setSelectedListingId(listings[0].id);
    }
  }, [listings, selectedListingId]);

  useEffect(() => {
    setGroundingError(null);
  }, [selectedListingId]);

  // Load messages when active room changes
  useEffect(() => {
    if (activeRoomId) {
      loadRoomMessages(activeRoomId);
    }
  }, [activeRoomId, loadRoomMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesByRoom, activeRoomId]);

  // Real-time WebSocket Connection (Chat + Presence + WebRTC Signaling)
  useEffect(() => {
    if (!currentUser) return;
    const activeUserUuid = currentUser.user_uuid;

    let closedIntentionally = false;
    let reconnectTimer: number | null = null;

    async function connect() {
      let token = getAccessToken();
      if (!token) {
        const ok = await tryRefreshAccessToken();
        if (ok) token = getAccessToken();
      }
      if (!token || closedIntentionally) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onmessage = (evt) => {
        try {
          const { event, payload } = JSON.parse(evt.data) as {
            event: string;
            payload: Record<string, unknown>;
          };

          if (event === 'ws.connected') {
            const online = (payload.online_users as string[]) || [];
            setOnlineUsers(new Set(online));
            loadChats();
            loadCallLogs();
            hydrateActiveCall();
          } else if (event === 'presence.update') {
            const uid = String(payload.user_uuid);
            const isOnline = Boolean(payload.is_online);
            setOnlineUsers((prev) => {
              const next = new Set(prev);
              if (isOnline) next.add(uid);
              else next.delete(uid);
              return next;
            });
          } else if (event === 'chat.message') {
            const msg = payload as unknown as ChatMessage;
            setMessagesByRoom((prev) => {
              const existing = prev[msg.room_id] || [];
              if (existing.some((m) => m.id === msg.id)) return prev;
              return { ...prev, [msg.room_id]: [...existing, msg] };
            });
            if (
              msg.sender_uuid !== activeUserUuid &&
              document.hidden &&
              notificationsEnabledRef.current &&
              typeof Notification !== 'undefined' &&
              Notification.permission === 'granted'
            ) {
              try {
                new Notification('New message on LandConnect', { body: msg.body.slice(0, 120) });
              } catch {
                // ignore notification restrictions
              }
            }
            loadChats();
          } else if (event === 'chat.read_receipt') {
            const roomId = String(payload.room_id);
            const readerUuid = String(payload.reader_uuid);
            setMessagesByRoom((prev) => {
              const existing = prev[roomId];
              if (!existing) return prev;
              return {
                ...prev,
                [roomId]: existing.map((m) => ({
                  ...m,
                  delivery_state: m.sender_uuid !== readerUuid ? 'READ' : m.delivery_state,
                  read_by_uuids: m.read_by_uuids.includes(readerUuid)
                    ? m.read_by_uuids
                    : [...m.read_by_uuids, readerUuid],
                })),
              };
            });
          } else if (event === 'chat.typing') {
            const roomId = String(payload.room_id);
            const uid = String(payload.user_uuid);
            const isTyping = Boolean(payload.is_typing);
            setTypingUsersByRoom((prev) => {
              const list = prev[roomId] || [];
              const updated = isTyping
                ? Array.from(new Set([...list, uid]))
                : list.filter((id) => id !== uid);
              return { ...prev, [roomId]: updated };
            });
          } else if (event === 'chat.room_created') {
            loadChats();
          } else if (event === 'privacy.consent_updated') {
            loadChats();
            loadUsers();
            showToast('Peer contact privacy preference updated');
          } else if (event === 'call.invite') {
            const call = payload.call as CallSession;
            const caller = payload.caller as PublicUserProfile;
            if (
              document.hidden &&
              notificationsEnabledRef.current &&
              typeof Notification !== 'undefined' &&
              Notification.permission === 'granted'
            ) {
              try {
                new Notification(`Incoming ${call.mode === 'VIDEO' ? 'Video' : 'Audio'} Call`, {
                  body: `${caller?.display_name ?? 'LandConnect member'} · ${String(payload.listing_title || 'Parcel Inquiry')}`,
                });
              } catch {
                // ignore notification restrictions
              }
            }
            setActiveCall({
              call,
              direction: 'INCOMING',
              peerName: caller?.display_name ?? 'LandConnect User',
              peerRole: caller?.role ?? 'BUYER',
              listingTitle: String(payload.listing_title || 'Property Inquiry'),
              listingImage: (payload.listing_image as string) || null,
              roomToken: String(payload.room_token || ''),
              iceServers: (payload.ice_servers as RTCIceServer[]) || [],
            });
          } else if (event === 'call.accept') {
            const call = payload.call as CallSession;
            setActiveCall((prev) => (prev && prev.call.call_id === call.call_id ? { ...prev, call } : prev));
          } else if (event === 'call.reject' || event === 'call.end' || event === 'call.timeout') {
            const call = payload.call as CallSession;
            setActiveCall((prev) => {
              if (prev && prev.call.call_id === call.call_id) {
                if (event === 'call.reject') showToast('Call was declined');
                else if (event === 'call.timeout') showToast('Call unanswered (30s timeout)');
                else showToast(`Call ended (${formatDuration(call.duration_seconds)})`);
                return null;
              }
              return prev;
            });
            loadCallLogs();
          } else if (
            event === 'webrtc.offer' ||
            event === 'webrtc.answer' ||
            event === 'webrtc.ice' ||
            event === 'call.mode_switch'
          ) {
            signalSeqRef.current += 1;
            setIncomingSignal({ event, payload, seq: signalSeqRef.current });
          }
        } catch {
          // ignore malformed event
        }
      };

      ws.onclose = async (closeEvt) => {
        wsRef.current = null;
        if (!closedIntentionally) {
          if (closeEvt.code === 1006 || closeEvt.code === 1008) {
            await tryRefreshAccessToken();
          }
          reconnectTimer = window.setTimeout(() => {
            void connect();
          }, 2000);
        }
      };
    }

    void connect();

    return () => {
      closedIntentionally = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [currentUser?.user_uuid, loadChats, loadCallLogs, hydrateActiveCall, showToast]);

  const sendWebRtcSignal = useCallback(
    (
      event: 'webrtc.offer' | 'webrtc.answer' | 'webrtc.ice' | 'call.mode_switch',
      payload: Record<string, unknown>,
    ) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ event, payload }));
      }
    },
    [],
  );

  const selectedListing = useMemo(
    () => listings.find((l) => l.id === selectedListingId) ?? listings[0] ?? null,
    [listings, selectedListingId],
  );

  const filteredListings = useMemo(() => {
    if (!radiusEnabled && !bboxSearchEnabled) return listings;
    return listings.filter((l) => {
      if (landTypeFilter !== 'ALL' && l.land_type !== landTypeFilter) return false;
      if (cityFilter !== 'ALL' && !l.city.toLowerCase().includes(cityFilter.toLowerCase())) return false;
      if (l.price_inr > maxPriceCr * 10000000) return false;
      if (searchQuery.trim()) {
        const needle = searchQuery.toLowerCase();
        return (
          l.title.toLowerCase().includes(needle) ||
          l.locality.toLowerCase().includes(needle) ||
          l.city.toLowerCase().includes(needle)
        );
      }
      return true;
    });
  }, [listings, radiusEnabled, bboxSearchEnabled, landTypeFilter, cityFilter, maxPriceCr, searchQuery]);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeRoomId) ?? null,
    [chats, activeRoomId],
  );

  const totalUnread = useMemo(
    () => chats.reduce((acc, c) => acc + (c.unread_count || 0), 0),
    [chats],
  );

  // Actions
  const handleStartDirectChat = async (listing: LandListing) => {
    if (!currentUser) return;
    const peerUuid =
      listing.broker_uuid && listing.broker_uuid !== currentUser.user_uuid
        ? listing.broker_uuid
        : listing.owner_uuid;

    if (peerUuid === currentUser.user_uuid) {
      showToast('This is your own listing. Switch accounts in another tab to message yourself.', 'info');
      return;
    }

    try {
      const room = await apiRequest<{ id: string }>('/api/v1/chats/direct', {
        method: 'POST',
        body: JSON.stringify({ listing_id: listing.id, peer_uuid: peerUuid }),
      });
      await loadChats();
      setActiveRoomId(room.id);
      setActiveTab('chats');
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Could not open chat', 'error');
    }
  };

  const handleInitiateCall = async (room: ChatRoomSummary, mode: CallMode) => {
    if (!currentUser) return;
    try {
      const idempotencyKey = `call_${crypto.randomUUID()}`;
      const res = await apiRequest<{
        call: CallSession;
        room_token?: string;
        ice_servers: RTCIceServer[];
      }>('/api/v1/calls/initiate', {
        method: 'POST',
        idempotencyKey,
        body: JSON.stringify({ room_id: room.id, mode }),
      });

      if (res.call.state === 'BUSY') {
        showToast('Recipient is currently busy on another call', 'error');
        loadCallLogs();
        return;
      }

      const peers = room.participants.filter((p) => p.user_uuid !== currentUser.user_uuid);
      setActiveCall({
        call: res.call,
        direction: 'OUTGOING',
        peerName:
          room.room_type === 'MEETING_ROOM'
            ? room.title
            : peers[0]?.display_name ?? 'LandConnect Peer',
        peerRole: room.room_type === 'MEETING_ROOM' ? 'GROUP' : peers[0]?.role ?? 'SELLER',
        listingTitle: room.listing?.title ?? room.title,
        listingImage: room.listing?.images?.[0] ?? null,
        roomToken: res.room_token,
        iceServers: res.ice_servers,
      });
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to initiate call', 'error');
    }
  };

  const handleAcceptCall = async (callId: string) => {
    try {
      const res = await apiRequest<{ call: CallSession; room_token?: string }>(
        `/api/v1/calls/${callId}/accept`,
        { method: 'POST' },
      );
      setActiveCall((prev) =>
        prev ? { ...prev, call: res.call, roomToken: res.room_token } : null,
      );
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Unable to accept call', 'error');
      setActiveCall(null);
    }
  };

  const handleRejectCall = async (callId: string) => {
    try {
      await apiRequest(`/api/v1/calls/${callId}/reject`, { method: 'POST' });
    } catch {
      // ignore
    } finally {
      setActiveCall(null);
      loadCallLogs();
    }
  };

  const handleEndCall = async (callId: string) => {
    try {
      await apiRequest(`/api/v1/calls/${callId}/end`, { method: 'POST' });
    } catch {
      // ignore
    } finally {
      setActiveCall(null);
      loadCallLogs();
    }
  };

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeRoomId || !draftMessage.trim()) return;
    const text = draftMessage.trim();
    setDraftMessage('');
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ event: 'chat.typing', payload: { room_id: activeRoomId, is_typing: false } }),
      );
    }
    try {
      const msg = await apiRequest<ChatMessage>(`/api/v1/chats/${activeRoomId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
      setMessagesByRoom((prev) => {
        const list = prev[activeRoomId] || [];
        if (list.some((m) => m.id === msg.id)) return prev;
        return { ...prev, [activeRoomId]: [...list, msg] };
      });
      loadChats();
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to send message', 'error');
    }
  };

  const handleTypingChange = (value: string) => {
    setDraftMessage(value);
    if (!activeRoomId || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({ event: 'chat.typing', payload: { room_id: activeRoomId, is_typing: true } }),
    );
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ event: 'chat.typing', payload: { room_id: activeRoomId, is_typing: false } }),
        );
      }
    }, 1500);
  };

  const handleDeleteListing = async (listingId: string) => {
    try {
      await apiRequest(`/api/v1/listings/${listingId}`, { method: 'DELETE' });
      showToast('Listing removed');
      setListings((prev) => prev.filter((l) => l.id !== listingId));
      if (selectedListingId === listingId) setSelectedListingId(null);
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Delete failed', 'error');
    }
  };

  const handleBoundsChange = useCallback(
    async (bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }) => {
      if (!bboxSearchEnabled || radiusEnabled) return;
      try {
        const res = await apiRequest<{ listings: LandListing[] }>(
          `/api/v1/listings/bbox?min_lng=${bbox.minLng}&min_lat=${bbox.minLat}&max_lng=${bbox.maxLng}&max_lat=${bbox.maxLat}`,
        );
        setListings(res.listings);
      } catch {
        // silent background bbox sync
      }
    },
    [bboxSearchEnabled, radiusEnabled],
  );

  const handleVerifyListing = async (listing: LandListing) => {
    const nextStatus =
      listing.verification_status === 'VERIFIED' ? 'RERA_APPROVED' : 'VERIFIED';
    try {
      const updated = await apiRequest<LandListing>(`/api/v1/listings/${listing.id}/verify`, {
        method: 'PATCH',
        body: JSON.stringify({ verification_status: nextStatus }),
      });
      setListings((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      showToast(`Parcel marked ${nextStatus.replace('_', ' ')}`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Verification failed', 'error');
    }
  };

  const handleAddParticipantToRoom = async (roomId: string, userUuid: string) => {
    if (!userUuid) return;
    try {
      await apiRequest(`/api/v1/chats/${roomId}/participants`, {
        method: 'POST',
        body: JSON.stringify({ user_uuid: userUuid }),
      });
      await loadChats();
      await loadRoomMessages(roomId);
      showToast('Participant added to Deal Room');
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Unable to add participant', 'error');
    }
  };

  const handleTogglePrivacy = async (patch: Record<string, unknown>) => {
    try {
      const updated = await apiRequest<PublicUserProfile>('/api/v1/auth/privacy', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setCurrentUser(updated);
      await loadChats();
      showToast('Privacy settings updated');
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to update privacy', 'error');
    }
  };

  const handleUploadAttachment = async (file: File) => {
    if (!activeRoomId) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast('File size must be under 5 MB', 'error');
      return;
    }
    setUploadingAttachment(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
      const msg = await apiRequest<ChatMessage>(`/api/v1/chats/${activeRoomId}/attachments`, {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          data_url: dataUrl,
          body: draftMessage.trim() || undefined,
        }),
      });
      if (draftMessage.trim()) setDraftMessage('');
      setMessagesByRoom((prev) => {
        const list = prev[activeRoomId] || [];
        if (list.some((m) => m.id === msg.id)) return prev;
        return { ...prev, [activeRoomId]: [...list, msg] };
      });
      loadChats();
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to upload document', 'error');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleBlockUser = async (peerUuid: string, peerName: string) => {
    try {
      await apiRequest(`/api/v1/users/${peerUuid}/block`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Blocked from deal conversation' }),
      });
      await loadBlockedUsers();
      showToast(`${peerName} has been blocked from messaging or calling you`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to block user', 'error');
    }
  };

  const handleUnblockUser = async (peerUuid: string) => {
    try {
      await apiRequest(`/api/v1/users/${peerUuid}/block`, { method: 'DELETE' });
      await loadBlockedUsers();
      showToast('User unblocked');
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to unblock user', 'error');
    }
  };

  const handleSubmitReport = async (e: FormEvent) => {
    e.preventDefault();
    if (!reportingListing) return;
    setReportSubmitting(true);
    try {
      await apiRequest(`/api/v1/listings/${reportingListing.id}/report`, {
        method: 'POST',
        body: JSON.stringify({
          reason: reportReason,
          details: reportDetails.trim(),
        }),
      });
      showToast('Report submitted for moderation review');
      setReportingListing(null);
      setReportDetails('');
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Unable to submit report', 'error');
    } finally {
      setReportSubmitting(false);
    }
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileSaving(true);
    try {
      const updated = await apiRequest<PublicUserProfile>('/api/v1/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: profileName,
          city: profileCity,
          bio: profileBio,
        }),
      });
      setCurrentUser(updated);
      showToast('Profile details saved');
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to update profile', 'error');
    } finally {
      setProfileSaving(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordSaving(true);
    try {
      await apiRequest('/api/v1/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      setCurrentPassword('');
      setNewPassword('');
      showToast('Password updated successfully');
    } catch (err) {
      showToast(err instanceof ApiError ? err.detail : 'Failed to change password', 'error');
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleToggleNotifications = async () => {
    if (typeof Notification === 'undefined') {
      showToast('Browser notifications are not supported on this device', 'error');
      return;
    }
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      showToast('Background alerts muted');
      return;
    }
    if (Notification.permission === 'granted') {
      setNotificationsEnabled(true);
      showToast('Background call & message alerts enabled');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setNotificationsEnabled(true);
      showToast('Background call & message alerts enabled');
    } else {
      showToast('Notification permission was declined by browser', 'error');
    }
  };

  const handleFetchGroundingInsights = async (listing: LandListing) => {
    setGroundingLoading(true);
    setGroundingError(null);
    try {
      const insights = await apiRequest<ParcelGroundingInsights>(
        `/api/v1/listings/${listing.id}/grounding-insights`,
        {
          method: 'POST',
          body: JSON.stringify({ focus: groundingFocus.trim() || undefined }),
        },
      );
      setGroundingByListing((prev) => ({ ...prev, [listing.id]: insights }));
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : 'Failed to fetch grounding insights';
      setGroundingError(msg);
    } finally {
      setGroundingLoading(false);
    }
  };

  const handleLogout = async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }).catch(() => {});
    }
    setAuthTokens(null, null);
    hasLoadedListingsRef.current = false;
    setCurrentUser(null);
    setActiveCall(null);
    setChats([]);
    setListings([]);
    setSelectedListingId(null);
    setActiveRoomId(null);
    setGroundingError(null);
    setBboxSearchEnabled(false);
    setRadiusEnabled(false);
  };

  if (!currentUser) {
    return (
      <LandingPage
        onAuthenticated={(user, focusListingId) => {
          setCurrentUser(user);
          if (focusListingId) {
            setSelectedListingId(focusListingId);
          }
          setActiveTab('communities');
        }}
      />
    );
  }

  const canManageListings = currentUser.role === 'SELLER' || currentUser.role === 'BROKER';
  const canCreateMeetingRoom = currentUser.role === 'BROKER';

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF9F6] text-[#111B21]">
      {gmpQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Clean 3-Zone Desktop / Compact Mobile Top Bar */}
      <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200 px-4 lg:px-6 flex items-center justify-between gap-3 sm:gap-6 lg:gap-8">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('communities');
          }}
          className="font-display text-lg font-bold tracking-tight text-[#075E54] whitespace-nowrap shrink-0"
        >
          LandConnect
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => setActiveTab('communities')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'communities'
                ? 'border-[#008069] text-[#075E54] font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Marketplace
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('chats')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              activeTab === 'chats'
                ? 'border-[#008069] text-[#075E54] font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <span>Messages</span>
            {totalUnread > 0 && (
              <span className="font-mono text-xs text-[#008069] tabular-nums">({totalUnread})</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('calls')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'calls'
                ? 'border-[#008069] text-[#075E54] font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Calls
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'profile'
                ? 'border-[#008069] text-[#075E54] font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            Account
          </button>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {canManageListings ? (
            <button
              type="button"
              onClick={() => {
                setEditingListing(null);
                setListingModalOpen(true);
              }}
              className="min-h-[44px] md:min-h-[40px] px-3 sm:px-4 py-2 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span className="sm:hidden">List Plot</span>
              <span className="hidden sm:inline">List Land Parcel</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActiveTab('chats')}
              className="min-h-[44px] md:min-h-[40px] px-3 sm:px-4 py-2 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0"
            >
              Deal Messages
            </button>
          )}
        </div>
      </header>

      {/* Non-intrusive Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-20 md:bottom-6 right-4 left-4 sm:left-auto sm:max-w-sm z-40 mobile-toast px-4 py-2.5 rounded-xl shadow-lg text-xs font-medium text-white ${
            toast.type === 'error' ? 'bg-red-600' : 'bg-[#111B21]'
          }`}
          role="status"
        >
          {toast.text}
        </div>
      )}

      {/* Main Content Area */}
      <main
        className={`flex-1 ${
          activeTab === 'chats' ? 'app-main-shell--chats' : 'app-main-shell'
        } md:pb-6`}
      >
        {/* ==================== TAB 1: COMMUNITIES & GEOSPATIAL MAP ==================== */}
        {activeTab === 'communities' && (
          <div className="max-w-7xl mx-auto p-4 lg:p-6 space-y-4">
            {/* Search & PostGIS Geospatial Filter Toolbar */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div className="relative flex-1 w-full lg:max-w-md">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search Karnataka cities, localities, or title..."
                    className="w-full h-11 pl-10 pr-4 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  />
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto no-scrollbar w-full lg:w-auto">
                  {LAND_TYPES.map((lt) => (
                    <button
                      key={lt.key}
                      type="button"
                      onClick={() => setLandTypeFilter(lt.key)}
                      className={`min-h-[44px] md:min-h-[32px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        landTypeFilter === lt.key
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {lt.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit max-w-full">
                  <button
                    type="button"
                    onClick={() => setViewMode('split')}
                    className={`min-h-[44px] md:min-h-[32px] px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                      viewMode === 'split' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    <span className="hidden lg:inline">Split View</span>
                    <span className="lg:hidden">List & Map</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('feed')}
                    className={`min-h-[44px] md:min-h-[32px] px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                      viewMode === 'feed' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    Feed
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('map')}
                    className={`min-h-[44px] md:min-h-[32px] px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                      viewMode === 'map' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    Map View
                  </button>
                </div>
              </div>

              {/* Price, Region & Geospatial Radius Controls */}
              <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 sm:gap-4 text-xs text-slate-600">
                <div className="flex items-center gap-3 flex-wrap w-full sm:w-auto">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <label htmlFor="price-range" className="font-medium text-slate-700 whitespace-nowrap">
                      Max Budget:{' '}
                      <span className="font-mono tabular-nums text-[#075E54]">
                        {formatInrPrice(Math.round(maxPriceCr * 10000000))}
                      </span>
                    </label>
                    <input
                      id="price-range"
                      type="range"
                      min={0.5}
                      max={25}
                      step={0.5}
                      value={maxPriceCr}
                      onChange={(e) => setMaxPriceCr(Number(e.target.value))}
                      className="touch-slider accent-[#008069] w-28 sm:w-36"
                    />
                  </div>

                  <div className="grid grid-cols-2 sm:flex sm:items-center gap-2 w-full sm:w-auto">
                    <select
                      aria-label="Filter by Karnataka city"
                      value={cityFilter}
                      onChange={(e) => setCityFilter(e.target.value)}
                      className="h-11 md:h-9 w-full sm:w-auto px-2.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#008069]"
                    >
                      <option value="ALL">All Karnataka</option>
                      <option value="Bengaluru">Bengaluru</option>
                      <option value="Mysuru">Mysuru</option>
                      <option value="Mangaluru">Mangaluru</option>
                      <option value="Hubballi">Hubballi</option>
                      <option value="Chikkamagaluru">Chikkamagaluru</option>
                      <option value="Belagavi">Belagavi</option>
                      <option value="Kodagu">Kodagu</option>
                    </select>

                    <select
                      aria-label="Sort listings"
                      value={sortBy}
                      onChange={(e) =>
                        setSortBy(e.target.value as 'price_asc' | 'updated_desc' | 'price_desc')
                      }
                      className="h-11 md:h-9 w-full sm:w-auto px-2.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#008069]"
                    >
                      <option value="price_asc">Price: ₹50L & Up</option>
                      <option value="updated_desc">Recently Updated</option>
                      <option value="price_desc">Price: High to Low</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !bboxSearchEnabled;
                      setBboxSearchEnabled(next);
                      if (next) setRadiusEnabled(false);
                    }}
                    className={`min-h-[44px] md:min-h-[36px] px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                      bboxSearchEnabled
                        ? 'border-[#008069] bg-[#008069]/10 text-[#075E54]'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <MapIcon className="w-3.5 h-3.5" />
                    <span>{bboxSearchEnabled ? 'Filtering Map Area' : 'Filter by Map Area'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const next = !radiusEnabled;
                      setRadiusEnabled(next);
                      if (next) setBboxSearchEnabled(false);
                    }}
                    className={`min-h-[44px] md:min-h-[36px] px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                      radiusEnabled
                        ? 'border-[#008069] bg-[#008069]/10 text-[#075E54]'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <Compass className="w-3.5 h-3.5" />
                    <span>{radiusEnabled ? 'Near Pin Active' : 'Search Near Pin'}</span>
                  </button>

                  {radiusEnabled && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="range"
                        min={10}
                        max={400}
                        step={10}
                        value={radiusKm}
                        onChange={(e) => setRadiusKm(Number(e.target.value))}
                        className="touch-slider accent-[#008069] w-28 sm:w-36"
                      />
                      <span className="font-mono tabular-nums text-[#075E54]">
                        {radiusKm} km radius (tap map to move)
                      </span>
                    </div>
                  )}

                  <span className="font-mono tabular-nums text-slate-500 ml-auto sm:ml-0">
                    {filteredListings.length} parcels
                  </span>
                </div>
              </div>
            </div>

            {/* Main Marketplace Split Layout */}
            <div
              className={`grid gap-5 items-start ${
                viewMode === 'split'
                  ? 'grid-cols-1 lg:grid-cols-12'
                  : 'grid-cols-1'
              }`}
            >
              {/* Parcel Feed Column */}
              {viewMode !== 'map' && (
                <div
                  className={`${
                    viewMode === 'split' ? 'lg:col-span-7' : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
                  } ${viewMode === 'split' ? 'space-y-4' : ''}`}
                >
                  {listingsLoading && filteredListings.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500">
                      Loading verified land parcels across Karnataka...
                    </div>
                  ) : filteredListings.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500">
                      No land parcels match your current filters. Adjust radius or budget range.
                    </div>
                  ) : (
                    filteredListings.map((listing) => {
                      const isSelected = selectedListing?.id === listing.id;
                      const isOwnerOrBroker =
                        currentUser.user_uuid === listing.owner_uuid ||
                        currentUser.role === 'BROKER';

                      return (
                        <article
                          key={listing.id}
                          onClick={() => setSelectedListingId(listing.id)}
                          className={`bg-white rounded-2xl border transition-colors overflow-hidden cursor-pointer ${
                            isSelected ? 'border-[#008069]' : 'border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-12 items-stretch">
                            <div className="sm:col-span-5 h-48 sm:h-auto min-h-[190px] bg-slate-100">
                              <ListingImage src={listing.images[0]} alt={listing.title} />
                            </div>
                            <div className="sm:col-span-7 p-4 sm:p-5 flex flex-col justify-between gap-3">
                              <div>
                                {/* Unboxed zero-pill metadata line */}
                                <div className="text-xs text-slate-500 flex items-center gap-1.5 flex-wrap">
                                  <span className="font-medium text-[#075E54]">{listing.land_type}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>{listing.verification_status.replace('_', ' ')}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>{listing.locality}, {listing.city}</span>
                                  {typeof listing.distance_km === 'number' && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="font-mono tabular-nums text-[#008069]">
                                        {listing.distance_km} km away
                                      </span>
                                    </>
                                  )}
                                </div>

                                <h3 className="mt-1.5 text-base font-semibold text-[#111B21] leading-snug">
                                  {listing.title}
                                </h3>
                                <p className="mt-1.5 text-xs text-slate-600 line-clamp-2 leading-relaxed">
                                  {listing.description}
                                </p>
                              </div>

                              <div className="pt-3 border-t border-slate-100 flex items-end justify-between gap-3 flex-wrap">
                                <div>
                                  <div className="text-lg font-bold font-mono tabular-nums text-[#111B21]">
                                    {formatInrPrice(listing.price_inr)}
                                  </div>
                                  <div className="text-xs text-slate-500 font-mono tabular-nums">
                                    {listing.area_acres} acres ({listing.area_sqft.toLocaleString('en-IN')} sq.ft)
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 w-full sm:w-auto justify-end" onClick={(e) => e.stopPropagation()}>
                                  {isOwnerOrBroker && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingListing(listing);
                                          setListingModalOpen(true);
                                        }}
                                        className="min-h-[44px] min-w-[44px] md:min-h-[40px] px-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 flex items-center justify-center"
                                        aria-label="Edit listing"
                                      >
                                        <Edit3 className="w-4 h-4" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteListing(listing.id)}
                                        className="min-h-[44px] min-w-[44px] md:min-h-[40px] px-2.5 rounded-xl border border-slate-200 hover:bg-red-50 text-red-600 flex items-center justify-center"
                                        aria-label="Delete listing"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleStartDirectChat(listing)}
                                    className="min-h-[44px] md:min-h-[40px] px-4 py-2 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                                  >
                                    <MessageSquare className="w-3.5 h-3.5" />
                                    <span>Inquire</span>
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </article>
                      );
                    })
                  )}
                  {hasMoreListings && !radiusEnabled && !bboxSearchEnabled && (
                    <div className={viewMode === 'split' ? 'pt-2 flex justify-center' : 'col-span-full pt-2 flex justify-center'}>
                      <button
                        type="button"
                        disabled={listingsLoading}
                        onClick={() => loadListings(listings.length, true)}
                        className="min-h-[44px] px-5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-[#075E54] disabled:opacity-50"
                      >
                        {listingsLoading
                          ? 'Loading parcels...'
                          : `Load More Parcels (${listings.length} of ${totalListings})`}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Geospatial Map, 3D Survey & Selected Parcel Inspector */}
              {viewMode !== 'feed' && (
                <div
                  className={`${
                    viewMode === 'split' ? 'lg:col-span-5 lg:sticky lg:top-20' : ''
                  } space-y-4 min-w-0`}
                >
                  <div className="bg-white rounded-2xl border border-slate-200 p-3 min-w-0 overflow-hidden">
                    <div className="flex items-center justify-between px-1 pb-2.5 gap-2 flex-wrap text-xs text-slate-600">
                      <span className="font-medium text-[#111B21]">
                        {spatialEngine === 'threejs'
                          ? '3D Site Preview'
                          : 'Interactive Parcel Map'}
                      </span>
                      <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg overflow-x-auto no-scrollbar max-w-full">
                        <button
                          type="button"
                          onClick={() => setSpatialEngine('google')}
                          disabled={!mapsApiKey || gmpQuotaExceeded}
                          className={`min-h-[44px] sm:min-h-[30px] px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1 disabled:opacity-40 whitespace-nowrap shrink-0 ${
                            spatialEngine === 'google' && mapsApiKey && !gmpQuotaExceeded
                              ? 'bg-white text-[#075E54] shadow-sm'
                              : 'text-slate-600'
                          }`}
                        >
                          <MapPin className="w-3 h-3" />
                          <span>Google Maps</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setSpatialEngine('threejs')}
                          className={`min-h-[44px] sm:min-h-[30px] px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 ${
                            spatialEngine === 'threejs'
                              ? 'bg-white text-[#075E54] shadow-sm'
                              : 'text-slate-600'
                          }`}
                        >
                          <Box className="w-3 h-3" />
                          <span>3D View</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setSpatialEngine('leaflet')}
                          className={`min-h-[44px] sm:min-h-[30px] px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            spatialEngine === 'leaflet' ||
                            ((!mapsApiKey || gmpQuotaExceeded) && spatialEngine === 'google')
                              ? 'bg-white text-[#075E54] shadow-sm'
                              : 'text-slate-600'
                          }`}
                        >
                          <span>Standard Map</span>
                        </button>
                      </div>
                    </div>

                    <ErrorBoundary
                      fallbackTitle="Map viewport could not render"
                      onReset={() => setSpatialEngine('leaflet')}
                    >
                      {spatialEngine === 'threejs' && selectedListing ? (
                        <ParcelScene3D
                          listing={selectedListing}
                          heightClass={
                            viewMode === 'map'
                              ? 'h-[62dvh] min-h-[360px] lg:h-[560px]'
                              : 'h-[300px] sm:h-[360px] lg:h-[400px]'
                          }
                        />
                      ) : spatialEngine === 'google' && mapsApiKey && !gmpQuotaExceeded ? (
                        <GoogleParcelMap
                          apiKey={mapsApiKey}
                          listings={filteredListings}
                          selectedId={selectedListing?.id ?? null}
                          onSelectListing={(l) => setSelectedListingId(l.id)}
                          searchCenter={radiusEnabled ? { ...searchCenter, radiusKm } : null}
                          onPickCoords={
                            radiusEnabled
                              ? (lat, lng) => setSearchCenter({ lat, lng })
                              : undefined
                          }
                          onBoundsChange={handleBoundsChange}
                          heightClass={
                            viewMode === 'map'
                              ? 'h-[62dvh] min-h-[360px] lg:h-[560px]'
                              : 'h-[300px] sm:h-[360px] lg:h-[400px]'
                          }
                        />
                      ) : (
                        <LeafletMap
                          listings={filteredListings}
                          selectedId={selectedListing?.id ?? null}
                          onSelectListing={(l) => setSelectedListingId(l.id)}
                          searchCenter={radiusEnabled ? { ...searchCenter, radiusKm } : null}
                          onPickCoords={
                            radiusEnabled
                              ? (lat, lng) => setSearchCenter({ lat, lng })
                              : undefined
                          }
                          onBoundsChange={handleBoundsChange}
                          heightClass={
                            viewMode === 'map'
                              ? 'h-[62dvh] min-h-[360px] lg:h-[560px]'
                              : 'h-[300px] sm:h-[360px] lg:h-[400px]'
                          }
                        />
                      )}
                    </ErrorBoundary>
                  </div>

                  {selectedListing && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs text-slate-500">
                            {selectedListing.zoning_status}
                          </div>
                          <h4 className="text-sm font-semibold text-[#111B21] mt-0.5 mobile-safe-wrap">
                            {selectedListing.title}
                          </h4>
                        </div>
                        <span className="text-sm font-bold font-mono tabular-nums text-[#075E54] shrink-0">
                          {formatInrPrice(selectedListing.price_inr)}
                        </span>
                      </div>

                      <div className="text-xs text-slate-600 flex items-center justify-between pt-2 border-t border-slate-100 gap-2 flex-wrap">
                        <div>
                          <span className="text-slate-500">Listed by </span>
                          <span className="font-medium text-[#111B21]">
                            {selectedListing.broker_profile?.display_name ??
                              selectedListing.owner_profile?.display_name ??
                              'Verified Member'}
                          </span>
                          <span className="text-slate-400"> · </span>
                          {onlineUsers.has(
                            selectedListing.broker_uuid && selectedListing.broker_uuid !== currentUser.user_uuid
                              ? selectedListing.broker_uuid
                              : selectedListing.owner_uuid,
                          ) ? (
                            <span className="text-[11px] text-[#008069] font-medium">Online</span>
                          ) : (
                            <span className="text-[11px] text-slate-500">Offline</span>
                          )}
                          <span className="text-slate-400"> · </span>
                          <span className="text-[11px] text-slate-500">
                            Contact protected until consent
                          </span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {currentUser.role === 'BROKER' && (
                            <button
                              type="button"
                              onClick={() => handleVerifyListing(selectedListing)}
                              className="min-h-[44px] sm:min-h-[32px] px-3 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-[11px] font-medium text-[#075E54]"
                            >
                              {selectedListing.verification_status === 'VERIFIED'
                                ? 'Mark RERA Approved'
                                : 'Verify Parcel'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setReportingListing(selectedListing)}
                            className="min-h-[44px] sm:min-h-[32px] px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-red-50 text-[11px] font-medium text-slate-600 hover:text-red-700 flex items-center gap-1"
                            aria-label="Report parcel listing"
                          >
                            <Flag className="w-3 h-3" />
                            <span>Report</span>
                          </button>
                        </div>
                      </div>

                      {/* Locality, Zoning & Nearby Infrastructure Brief */}
                      <div className="pt-3 border-t border-slate-100 space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#111B21]">
                            <Sparkles className="w-3.5 h-3.5 text-[#008069]" />
                            <span>Locality, Zoning & Infrastructure Brief</span>
                          </div>
                          <span className="text-[11px] text-slate-400">
                            Public & Map Data
                          </span>
                        </div>

                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                          <input
                            type="text"
                            value={groundingFocus}
                            onChange={(e) => setGroundingFocus(e.target.value)}
                            placeholder="Optional focus (e.g. metro access, highway widening, CDP zoning)..."
                            className="flex-1 h-11 md:h-9 px-3 rounded-xl border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-[#008069]"
                          />
                          <button
                            type="button"
                            disabled={groundingLoading}
                            onClick={() => handleFetchGroundingInsights(selectedListing)}
                            className="h-11 md:h-9 px-3.5 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium whitespace-nowrap disabled:opacity-50 shrink-0"
                          >
                            {groundingLoading ? 'Researching...' : 'Check Locality'}
                          </button>
                        </div>

                        {groundingError && (
                          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 mobile-safe-wrap">
                            {groundingError}
                          </div>
                        )}

                        {groundingByListing[selectedListing.id] && (
                          <div className="space-y-3 pt-1 text-xs">
                            <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3 space-y-1.5">
                              <div className="flex items-center gap-1.5 font-semibold text-[#075E54]">
                                <Globe className="w-3.5 h-3.5" />
                                <span>Zoning & Corridor Updates</span>
                              </div>
                              <p className="text-slate-700 whitespace-pre-wrap leading-relaxed mobile-safe-wrap">
                                {groundingByListing[selectedListing.id].search_summary}
                              </p>
                              {groundingByListing[selectedListing.id].web_sources.length > 0 && (
                                <div className="pt-1.5 flex flex-wrap gap-x-3 gap-y-2">
                                  {groundingByListing[selectedListing.id].web_sources.map((src, i) => (
                                    <a
                                      key={`${src.uri}-${i}`}
                                      href={src.uri}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 py-1.5 text-[11px] font-medium text-[#008069] hover:underline mobile-safe-wrap"
                                    >
                                      <span>{src.title}</span>
                                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                    </a>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3 space-y-1.5">
                              <div className="flex items-center gap-1.5 font-semibold text-[#075E54]">
                                <MapPin className="w-3.5 h-3.5" />
                                <span>Nearby Connectivity & Landmarks</span>
                              </div>
                              <p className="text-slate-700 whitespace-pre-wrap leading-relaxed mobile-safe-wrap">
                                {groundingByListing[selectedListing.id].maps_summary}
                              </p>
                              {groundingByListing[selectedListing.id].maps_sources.length > 0 && (
                                <div className="pt-1.5 space-y-1.5">
                                  {groundingByListing[selectedListing.id].maps_sources.map((place, i) => (
                                    <div key={`${place.uri}-${i}`} className="text-[11px] mobile-safe-wrap">
                                      <a
                                        href={place.uri}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 py-1 font-medium text-[#008069] hover:underline mobile-safe-wrap"
                                      >
                                        <span>{place.title}</span>
                                        <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                      </a>
                                      {place.snippets[0] && (
                                        <span className="text-slate-500"> · {place.snippets[0]}</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== TAB 2: WHATSAPP-INSPIRED CHATS & DEAL ROOMS ==================== */}
        {activeTab === 'chats' && (
          <div className="max-w-7xl mx-auto p-0 md:p-6">
            <div className="bg-white md:rounded-2xl md:border md:border-slate-200 overflow-hidden grid grid-cols-1 md:grid-cols-12 mobile-chats-frame md:h-[calc(100dvh-7rem)] min-h-[384px]">
              {/* Left Thread List */}
              <aside
                className={`md:col-span-4 lg:col-span-4 border-r border-slate-200 flex-col h-full min-h-0 ${
                  activeRoomId ? 'hidden md:flex' : 'flex'
                }`}
              >
                <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-[#111B21]">Deal Messages</h2>
                    <p className="text-xs text-slate-500">
                      Direct inquiries & Broker Deal Rooms
                    </p>
                  </div>
                  {canCreateMeetingRoom && (
                    <button
                      type="button"
                      onClick={() => setMeetingModalOpen(true)}
                      className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span>Deal Room</span>
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                  {chats.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500">
                      No active chats yet. Click Inquire on any land parcel to start messaging.
                    </div>
                  ) : (
                    chats.map((room) => {
                      const isSelected = room.id === activeRoomId;
                      const peers = room.participants.filter(
                        (p) => p.user_uuid !== currentUser.user_uuid,
                      );
                      const anyOnline = peers.some((p) => onlineUsers.has(p.user_uuid));

                      return (
                        <button
                          key={room.id}
                          type="button"
                          onClick={() => setActiveRoomId(room.id)}
                          className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors min-h-[68px] ${
                            isSelected ? 'bg-[#008069]/10' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="w-11 h-11 rounded-xl overflow-hidden bg-slate-200 shrink-0">
                            <ListingImage
                              src={room.listing?.images?.[0]}
                              alt={room.title}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-semibold text-[#111B21] truncate">
                                {room.title}
                              </span>
                              {room.unread_count > 0 && (
                                <span className="text-xs font-mono tabular-nums font-semibold text-[#008069] shrink-0">
                                  {room.unread_count} new
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                              <span>{room.room_type === 'MEETING_ROOM' ? 'Deal Room' : 'Direct'}</span>
                              <span aria-hidden="true">·</span>
                              <span className="truncate">
                                {peers.map((p) => p.display_name).join(', ')}
                              </span>
                              {anyOnline && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-[#008069] font-medium">Online</span>
                                </>
                              )}
                            </div>
                            <p className="text-xs text-slate-600 truncate mt-1">
                              {room.last_message?.body || 'No messages yet'}
                            </p>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </aside>

              {/* Right Active Conversation Pane */}
              <section
                className={`md:col-span-8 lg:col-span-8 flex-col h-full min-h-0 ${
                  activeRoomId ? 'flex' : 'hidden md:flex'
                }`}
              >
                {!activeChat ? (
                  <div className="flex-1 conversation-canvas flex items-center justify-center p-8 text-center">
                    <div className="bg-white/95 rounded-2xl border border-slate-200 p-8 max-w-md">
                      <MessageSquare className="w-8 h-8 text-[#008069] mx-auto" />
                      <h3 className="mt-3 text-base font-semibold text-[#111B21]">
                        Select a property conversation
                      </h3>
                      <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                        Message landowners directly, collaborate in Broker Deal Rooms, or start a private
                        voice or video call without sharing your phone number.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Property Context Header */}
                    <div className="bg-white border-b border-slate-200 px-3 sm:px-4 py-3 flex items-center justify-between gap-2 sm:gap-3 shrink-0">
                      <div className="flex-1 flex items-center gap-2 sm:gap-3 min-w-0">
                        <button
                          type="button"
                          onClick={() => setActiveRoomId(null)}
                          className="md:hidden min-h-[44px] min-w-[44px] px-2 -ml-1 rounded-xl hover:bg-slate-100 text-xs font-medium text-[#008069] flex items-center justify-center gap-1 shrink-0"
                          aria-label="Back to conversations"
                        >
                          <ArrowLeft className="w-4 h-4" />
                          <span className="sr-only sm:not-sr-only">Back</span>
                        </button>
                        <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl overflow-hidden bg-slate-100 shrink-0">
                          <ListingImage
                            src={activeChat.listing?.images?.[0]}
                            alt={activeChat.title}
                          />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-[#111B21] truncate">
                            {activeChat.title}
                          </h3>
                          <div className="text-xs text-slate-500 flex items-center gap-1.5 truncate">
                            {activeChat.listing && (
                              <span className="font-mono tabular-nums text-[#075E54] font-medium">
                                {formatInrPrice(activeChat.listing.price_inr)}
                              </span>
                            )}
                            <span aria-hidden="true">·</span>
                            <span className="truncate">
                              {activeChat.participants
                                .map((p) =>
                                  `${p.display_name}${p.user_uuid === currentUser.user_uuid ? ' (You)' : ''} [${p.role}]`,
                                )
                                .join(', ')}
                            </span>
                            <span aria-hidden="true">·</span>
                            {activeChat.participants.some(
                              (p) => p.user_uuid !== currentUser.user_uuid && onlineUsers.has(p.user_uuid),
                            ) ? (
                              <span className="text-[#008069] font-medium shrink-0">Online</span>
                            ) : (
                              <span className="text-slate-400 shrink-0">Offline</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleInitiateCall(activeChat, 'AUDIO')}
                          className="min-h-[44px] min-w-[44px] sm:px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-[#075E54] text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap"
                          aria-label="Start audio call"
                        >
                          <PhoneCall className="w-4 h-4" />
                          <span className="hidden sm:inline">Audio</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleInitiateCall(activeChat, 'VIDEO')}
                          className="min-h-[44px] min-w-[44px] sm:px-3 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap"
                          aria-label="Start video call"
                        >
                          <Video className="w-4 h-4" />
                          <span className="hidden sm:inline">Video</span>
                        </button>
                      </div>
                    </div>

                    {/* Privacy & Deal Room Actions Strip */}
                    <div className="bg-slate-50 border-b border-slate-200 px-3 sm:px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 shrink-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Lock className="w-3.5 h-3.5 text-[#008069] shrink-0" />
                        {(() => {
                          const peers = activeChat.participants.filter(
                            (p) => p.user_uuid !== currentUser.user_uuid,
                          );
                          const revealedPeers = peers.filter((p) => p.contact_revealed && p.phone);
                          if (revealedPeers.length > 0) {
                            return (
                              <span className="text-[#075E54] font-medium">
                                Consented contact:{' '}
                                {revealedPeers
                                  .map((p) => `${p.display_name} (${p.phone} · ${p.email})`)
                                  .join(' | ')}
                              </span>
                            );
                          }
                          return <span>Phone numbers & emails remain private until mutual consent</span>;
                        })()}
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        {activeChat.participants
                          .filter((p) => p.user_uuid !== currentUser.user_uuid)
                          .map((peer) => {
                            const hasConsented =
                              Boolean(currentUser.show_contact_after_consent) &&
                              Boolean(currentUser.consented_peer_uuids?.includes(peer.user_uuid));
                            const isBlocked = blockedUsers.some((b) => b.user_uuid === peer.user_uuid);
                            return (
                              <div key={peer.user_uuid} className="flex items-center gap-1.5 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleTogglePrivacy(
                                      hasConsented
                                        ? { revoke_peer_uuid: peer.user_uuid }
                                        : {
                                            show_contact_after_consent: true,
                                            consent_peer_uuid: peer.user_uuid,
                                          },
                                    )
                                  }
                                  className={`min-h-[44px] sm:min-h-[32px] px-3 py-1.5 rounded-lg border text-[11px] font-medium whitespace-nowrap transition-colors ${
                                    hasConsented
                                      ? 'border-[#008069] bg-[#008069]/10 text-[#075E54] hover:bg-red-50 hover:text-red-700 hover:border-red-200'
                                      : 'border-slate-200 bg-white hover:bg-slate-100 text-[#075E54]'
                                  }`}
                                >
                                  {hasConsented
                                    ? `Revoke Contact (${peer.display_name})`
                                    : `Share Contact with ${peer.display_name}`}
                                </button>
                                {activeChat.room_type === 'DIRECT' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      isBlocked
                                        ? handleUnblockUser(peer.user_uuid)
                                        : handleBlockUser(peer.user_uuid, peer.display_name)
                                    }
                                    className={`min-h-[44px] sm:min-h-[32px] px-2.5 py-1.5 rounded-lg border text-[11px] font-medium whitespace-nowrap flex items-center gap-1 transition-colors ${
                                      isBlocked
                                        ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                                        : 'border-slate-200 bg-white hover:bg-red-50 text-slate-600 hover:text-red-700'
                                    }`}
                                  >
                                    <Ban className="w-3 h-3" />
                                    <span>{isBlocked ? 'Unblock' : 'Block'}</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}

                        {currentUser.role === 'BROKER' &&
                          activeChat.room_type === 'MEETING_ROOM' &&
                          allUsers.some((u) => !activeChat.participant_uuids.includes(u.user_uuid)) && (
                            <select
                              aria-label="Add member to deal room"
                              defaultValue=""
                              onChange={(e) => {
                                handleAddParticipantToRoom(activeChat.id, e.target.value);
                                e.target.value = '';
                              }}
                              className="h-11 sm:h-8 w-full sm:w-auto max-w-full px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-[11px] text-slate-700"
                            >
                              <option value="" disabled>
                                + Add Member
                              </option>
                              {allUsers
                                .filter((u) => !activeChat.participant_uuids.includes(u.user_uuid))
                                .map((u) => (
                                  <option key={u.user_uuid} value={u.user_uuid}>
                                    {u.display_name} ({u.role})
                                  </option>
                                ))}
                            </select>
                          )}
                      </div>
                    </div>

                    {/* Messages Scrollable Canvas */}
                    <div className="flex-1 conversation-canvas p-4 space-y-2.5 overflow-y-auto">
                      {(messagesByRoom[activeChat.id] || []).map((msg) => {
                        if (msg.message_type === 'SYSTEM') {
                          return (
                            <div key={msg.id} className="flex justify-center my-2">
                              <div className="bg-white/90 border border-slate-200/80 px-3.5 py-1.5 rounded-lg text-[11px] text-slate-600 text-center max-w-md">
                                {msg.body}
                              </div>
                            </div>
                          );
                        }

                        const isMine = msg.sender_uuid === currentUser.user_uuid;
                        const sender = activeChat.participants.find(
                          (p) => p.user_uuid === msg.sender_uuid,
                        );
                        const timeStr = new Date(msg.created_at).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        });

                        return (
                          <div
                            key={msg.id}
                            className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
                          >
                            <div
                              className={`max-w-[82%] sm:max-w-[70%] rounded-2xl px-3.5 py-2.5 shadow-sm ${
                                isMine
                                  ? 'bg-[#D9FDD3] text-[#111B21]'
                                  : 'bg-white text-[#111B21] border border-slate-200/70'
                              }`}
                            >
                              {!isMine && sender && (
                                <div className="text-[11px] font-semibold text-[#075E54] mb-0.5">
                                  {sender.display_name} · {sender.role}
                                </div>
                              )}
                              {isSafeAttachmentUrl(msg.attachment_url) && (
                                <div className="mb-2">
                                  {msg.attachment_type?.startsWith('image/') ? (
                                    <a
                                      href={msg.attachment_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block rounded-xl overflow-hidden border border-slate-200/80 bg-white"
                                    >
                                      <img
                                        src={msg.attachment_url}
                                        alt={msg.attachment_name || 'Shared image'}
                                        className="max-h-56 w-full object-cover"
                                      />
                                    </a>
                                  ) : (
                                    <a
                                      href={msg.attachment_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white/90 hover:bg-white px-3 py-2 text-xs font-medium text-[#075E54]"
                                    >
                                      <FileText className="w-4 h-4 shrink-0" />
                                      <span className="truncate flex-1">
                                        {msg.attachment_name || 'Deal Document (PDF)'}
                                      </span>
                                      <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                                    </a>
                                  )}
                                </div>
                              )}
                              <p className="text-sm leading-relaxed whitespace-pre-wrap mobile-safe-wrap">{msg.body}</p>
                              <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-500 font-mono tabular-nums">
                                <span>{timeStr}</span>
                                {isMine &&
                                  (msg.delivery_state === 'READ' ? (
                                    <CheckCheck className="w-3.5 h-3.5 text-sky-600" />
                                  ) : (
                                    <Check className="w-3.5 h-3.5 text-slate-400" />
                                  ))}
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {(typingUsersByRoom[activeChat.id] || []).length > 0 && (
                        <div className="text-xs text-slate-600 italic px-2">
                          Typing...
                        </div>
                      )}
                      <div ref={messagesEndRef} />
                    </div>

                    {/* Message Composer & Deal Room Document Vault */}
                    <form
                      onSubmit={handleSendMessage}
                      className="bg-white border-t border-slate-200 p-3 flex items-center gap-2"
                    >
                      <input
                        ref={attachmentInputRef}
                        type="file"
                        accept=".pdf,image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            void handleUploadAttachment(file);
                          }
                          e.target.value = '';
                        }}
                      />
                      <button
                        type="button"
                        disabled={uploadingAttachment}
                        onClick={() => attachmentInputRef.current?.click()}
                        className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 flex items-center justify-center shrink-0 disabled:opacity-50"
                        aria-label="Attach PDF or image document (RTC, EC, Survey Sketch)"
                        title="Attach PDF or image document"
                      >
                        <Paperclip className="w-4 h-4" />
                      </button>
                      <input
                        type="text"
                        value={draftMessage}
                        onChange={(e) => handleTypingChange(e.target.value)}
                        placeholder={
                          uploadingAttachment
                            ? 'Uploading document...'
                            : 'Message or attach RTC/EC/Survey PDF...'
                        }
                        className="flex-1 h-11 px-4 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069] min-w-0"
                      />
                      <button
                        type="submit"
                        disabled={!draftMessage.trim() || uploadingAttachment}
                        className="min-h-[44px] min-w-[44px] px-4 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white flex items-center justify-center gap-1.5 text-sm font-medium transition-colors disabled:opacity-40 shrink-0"
                        aria-label="Send message"
                      >
                        <Send className="w-4 h-4" />
                        <span className="hidden sm:inline">Send</span>
                      </button>
                    </form>
                  </>
                )}
              </section>
            </div>
          </div>
        )}

        {/* ==================== TAB 3: PERSISTENT CALL LOGS ==================== */}
        {activeTab === 'calls' && (
          <div className="max-w-4xl mx-auto p-4 lg:p-6 space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[#111B21]">Call History</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Private voice and video consultations linked to your parcel inquiries
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
                {callLogs.length} sessions
              </span>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
              {callLogs.length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-500">
                  No call logs recorded yet. Start an audio or video call from any chat thread.
                </div>
              ) : (
                callLogs.map((log) => {
                  const isMissedOrRejected =
                    log.state === 'MISSED' || log.state === 'REJECTED' || log.state === 'BUSY';
                  const peers =
                    log.direction === 'OUTGOING'
                      ? log.callee_profiles
                      : log.caller_profile
                      ? [log.caller_profile]
                      : [];
                  const targetRoom = chats.find((c) => c.id === log.room_id);

                  return (
                    <div
                      key={log.call_id}
                      className="p-4 sm:px-5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 sm:gap-4"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                            isMissedOrRejected
                              ? 'bg-red-50 text-red-600'
                              : 'bg-emerald-50 text-[#008069]'
                          }`}
                        >
                          {isMissedOrRejected ? (
                            <PhoneMissed className="w-5 h-5" />
                          ) : log.direction === 'OUTGOING' ? (
                            <PhoneOutgoing className="w-5 h-5" />
                          ) : (
                            <PhoneIncoming className="w-5 h-5" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-[#111B21] truncate">
                            {peers.map((p) => p.display_name).join(', ') || 'Participant'}
                          </div>
                          <div className="text-xs text-slate-500 flex items-center gap-1.5 flex-wrap mt-0.5 min-w-0 max-w-full">
                            <span>{log.direction === 'OUTGOING' ? 'Outgoing' : 'Incoming'}</span>
                            <span aria-hidden="true">·</span>
                            <span>{log.mode}</span>
                            <span aria-hidden="true">·</span>
                            <span className={isMissedOrRejected ? 'text-red-600 font-medium' : ''}>
                              {log.state}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate min-w-0 max-w-full">{log.listing_title}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right">
                          <div className="text-xs font-mono tabular-nums text-[#111B21]">
                            {log.duration_seconds > 0 ? formatDuration(log.duration_seconds) : '00:00'}
                          </div>
                          <div className="text-[11px] font-mono tabular-nums text-slate-400">
                            {new Date(log.started_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                        {targetRoom && (
                          <button
                            type="button"
                            onClick={() => handleInitiateCall(targetRoom, log.mode)}
                            className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 hover:bg-slate-50 text-[#008069] flex items-center justify-center"
                            aria-label="Call back"
                          >
                            {log.mode === 'VIDEO' ? (
                              <Video className="w-4 h-4" />
                            ) : (
                              <Phone className="w-4 h-4" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ==================== TAB 4: ACCOUNT & PRIVACY ==================== */}
        {activeTab === 'profile' && (
          <div className="max-w-4xl mx-auto p-4 lg:p-6 space-y-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-[#008069]">
                  {currentUser.role === 'SELLER'
                    ? 'Landowner'
                    : currentUser.role === 'BROKER'
                    ? 'Licensed Broker'
                    : 'Land Buyer'}
                </div>
                <h2 className="text-xl font-bold text-[#111B21] mt-0.5">
                  {currentUser.display_name}
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  {currentUser.city} · Private Contact Mode Active
                </p>
                <p className="text-xs text-slate-600 mt-2 max-w-xl">{currentUser.bio}</p>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium text-slate-700 flex items-center gap-2 self-start sm:self-center whitespace-nowrap"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>

            {/* Privacy Controls */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-[#008069]" />
                <h3 className="text-base font-semibold text-[#111B21]">
                  Privacy & Contact Preferences
                </h3>
              </div>

              <div className="divide-y divide-slate-100">
                <div className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
                  <div>
                    <div className="text-sm font-medium text-[#111B21]">
                      Allow Incoming In-App Calls
                    </div>
                    <p className="text-xs text-slate-500">
                      When turned off, buyers and brokers cannot call you directly inside the app.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleTogglePrivacy({ allow_calls: !currentUser.allow_calls })}
                    className={`min-h-[44px] md:min-h-[40px] px-4 rounded-xl text-xs font-medium transition-colors self-start sm:self-center shrink-0 ${
                      currentUser.allow_calls
                        ? 'bg-[#008069] text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {currentUser.allow_calls ? 'Enabled' : 'Disabled'}
                  </button>
                </div>

                <div className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#111B21]">
                      Share Contact Details Only After Consent
                    </div>
                    <p className="text-xs text-slate-500 mobile-safe-wrap">
                      Your phone ({currentUser.phone}) and email ({currentUser.email}) remain hidden to
                      other members unless you choose to share them in a deal thread.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      handleTogglePrivacy({
                        show_contact_after_consent: !currentUser.show_contact_after_consent,
                      })
                    }
                    className={`min-h-[44px] md:min-h-[40px] px-4 rounded-xl text-xs font-medium transition-colors self-start sm:self-center shrink-0 ${
                      currentUser.show_contact_after_consent
                        ? 'bg-[#008069] text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {currentUser.show_contact_after_consent ? 'Consent Enabled' : 'Strictly Masked'}
                  </button>
                </div>

                <div className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#111B21] flex items-center gap-1.5">
                      <Bell className="w-4 h-4 text-[#008069]" />
                      <span>Background Call & Message Alerts</span>
                    </div>
                    <p className="text-xs text-slate-500">
                      Receive desktop or mobile browser alerts when new inquiries or calls arrive while this tab is in the background.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleNotifications}
                    className={`min-h-[44px] md:min-h-[40px] px-4 rounded-xl text-xs font-medium transition-colors self-start sm:self-center shrink-0 ${
                      notificationsEnabled
                        ? 'bg-[#008069] text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {notificationsEnabled ? 'Alerts Active' : 'Enable Alerts'}
                  </button>
                </div>
              </div>
            </div>

            {/* Edit Profile & Security */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <form
                onSubmit={handleSaveProfile}
                className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-3.5"
              >
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-[#008069]" />
                  <h3 className="text-base font-semibold text-[#111B21]">Edit Profile</h3>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={80}
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">City</label>
                  <input
                    type="text"
                    maxLength={80}
                    value={profileCity}
                    onChange={(e) => setProfileCity(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Bio / Credentials</label>
                  <textarea
                    rows={2}
                    maxLength={300}
                    value={profileBio}
                    onChange={(e) => setProfileBio(e.target.value)}
                    className="w-full p-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={profileSaving}
                  className="min-h-[44px] px-4 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-xs font-medium disabled:opacity-50"
                >
                  {profileSaving ? 'Saving...' : 'Save Profile'}
                </button>
              </form>

              <form
                onSubmit={handleChangePassword}
                className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-3.5"
              >
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[#008069]" />
                  <h3 className="text-base font-semibold text-[#111B21]">Change Password</h3>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Current Password</label>
                  <input
                    type="password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">New Password (8+ chars)</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    maxLength={128}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#008069]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={passwordSaving}
                  className="min-h-[44px] px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-[#111B21] text-xs font-medium disabled:opacity-50"
                >
                  {passwordSaving ? 'Updating...' : 'Update Password'}
                </button>
              </form>
            </div>

            {blockedUsers.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-3">
                <div className="flex items-center gap-2">
                  <Ban className="w-4 h-4 text-red-600" />
                  <h3 className="text-base font-semibold text-[#111B21]">Blocked Accounts</h3>
                </div>
                <div className="divide-y divide-slate-100">
                  {blockedUsers.map((bu) => (
                    <div key={bu.user_uuid} className="py-2.5 flex items-center justify-between gap-3">
                      <div className="text-sm text-[#111B21]">
                        <span className="font-medium">{bu.display_name}</span>
                        <span className="text-xs text-slate-500 ml-2">{bu.role}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUnblockUser(bu.user_uuid)}
                        className="min-h-[40px] px-3 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700"
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Mobile Fixed Bottom Navigation Bar (safe-area aware, >= 44px hitboxes) */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 mobile-bottom-nav bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-4 items-center"
        aria-label="Primary mobile navigation"
      >
        <button
          type="button"
          onClick={() => setActiveTab('communities')}
          className={`h-full min-w-0 flex flex-col items-center justify-center gap-0.5 ${
            activeTab === 'communities' ? 'text-[#008069]' : 'text-slate-500'
          }`}
        >
          <Compass className="w-5 h-5" />
          <span className="text-[10px] font-medium min-w-0 max-w-full truncate px-1">Parcels</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('chats')}
          className={`h-full min-w-0 flex flex-col items-center justify-center gap-0.5 relative ${
            activeTab === 'chats' ? 'text-[#008069]' : 'text-slate-500'
          }`}
        >
          <MessageSquare className="w-5 h-5" />
          <span className="text-[10px] font-medium min-w-0 max-w-full truncate px-1">
            Messages{totalUnread > 0 ? ` (${totalUnread})` : ''}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('calls')}
          className={`h-full min-w-0 flex flex-col items-center justify-center gap-0.5 ${
            activeTab === 'calls' ? 'text-[#008069]' : 'text-slate-500'
          }`}
        >
          <Phone className="w-5 h-5" />
          <span className="text-[10px] font-medium min-w-0 max-w-full truncate px-1">Calls</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('profile')}
          className={`h-full min-w-0 flex flex-col items-center justify-center gap-0.5 ${
            activeTab === 'profile' ? 'text-[#008069]' : 'text-slate-500'
          }`}
        >
          <User className="w-5 h-5" />
          <span className="text-[10px] font-medium min-w-0 max-w-full truncate px-1">Account</span>
        </button>
      </nav>

      {/* Modals & Active Call Overlay */}
      {listingModalOpen && (
        <ListingModal
          existing={editingListing}
          mapsApiKey={gmpQuotaExceeded ? '' : mapsApiKey}
          onClose={() => {
            setListingModalOpen(false);
            setEditingListing(null);
          }}
          onSaved={(saved) => {
            loadListings();
            setSelectedListingId(saved.id);
            showToast(editingListing ? 'Parcel updated' : 'Parcel published');
          }}
        />
      )}

      {meetingModalOpen && (
        <MeetingRoomModal
          listings={listings}
          users={allUsers}
          currentUserUuid={currentUser.user_uuid}
          onClose={() => setMeetingModalOpen(false)}
          onCreated={async (roomId) => {
            await loadChats();
            setActiveRoomId(roomId);
            setActiveTab('chats');
            showToast('Broker Deal Room created');
          }}
        />
      )}

      {activeCall && (
        <CallOverlay
          activeCall={activeCall}
          currentUserUuid={currentUser.user_uuid}
          peerOnline={[activeCall.call.caller_uuid, ...activeCall.call.callee_uuids].some(
            (id) => id !== currentUser.user_uuid && onlineUsers.has(id),
          )}
          onAccept={handleAcceptCall}
          onReject={handleRejectCall}
          onEnd={handleEndCall}
          sendSignal={sendWebRtcSignal}
          incomingSignal={incomingSignal}
        />
      )}

      {reportingListing && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Report parcel listing"
        >
          <form
            onSubmit={handleSubmitReport}
            className="bg-white rounded-2xl border border-slate-200 w-full max-w-md p-5 space-y-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-[#111B21]">Report Parcel Listing</h3>
                <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{reportingListing.title}</p>
              </div>
              <button
                type="button"
                onClick={() => setReportingListing(null)}
                className="min-h-[40px] min-w-[40px] rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-500"
                aria-label="Close report dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Reason</label>
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-sm"
              >
                <option value="Misleading pricing or area details">Misleading pricing or area details</option>
                <option value="Duplicate or spam listing">Duplicate or spam listing</option>
                <option value="Disputed ownership or title issue">Disputed ownership or title issue</option>
                <option value="Incorrect coordinates or zoning">Incorrect coordinates or zoning</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Additional Context</label>
              <textarea
                rows={3}
                maxLength={500}
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                placeholder="Optional survey number or discrepancy notes..."
                className="w-full p-3 rounded-xl border border-slate-200 text-sm"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setReportingListing(null)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-200 text-xs font-medium text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={reportSubmitting}
                className="min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {reportSubmitting ? 'Submitting...' : 'Submit Report'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
