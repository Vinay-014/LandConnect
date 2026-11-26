import crypto from 'crypto';
import type { WebSocket } from 'ws';
import { metrics } from './metrics.ts';
import { InProcessRealtimeBus, type RealtimeBus } from './realtimeBus.ts';
import { issueEphemeralCallToken, toPrivacySafeProfile } from './security.ts';
import { db, type SqliteStore } from './store.ts';
import type { CallMode, CallSession, CallState } from './types.ts';

export interface ActiveCallRuntime {
  call: CallSession;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  connectedPeers: Set<string>;
}

const RINGING_TTL_MS = 30_000;

export class CallSignalingEngine {
  /** user_uuid -> Set of active WebSocket connections (supports multi-tab) */
  private userSockets = new Map<string, Set<WebSocket>>();
  /** call_id -> active runtime state */
  private activeCalls = new Map<string, ActiveCallRuntime>();
  /** user_uuid -> current active call_id (for BUSY detection) */
  private busyUsers = new Map<string, string>();
  private store: SqliteStore;
  private bus: RealtimeBus;
  private unsubscribeBus: () => void;

  constructor(store: SqliteStore = db, bus: RealtimeBus = new InProcessRealtimeBus()) {
    this.store = store;
    this.bus = bus;
    this.unsubscribeBus = this.bus.subscribe((envelope) => {
      const raw = JSON.stringify(envelope.payload);
      if (envelope.targets === '*') {
        for (const [uid, set] of this.userSockets.entries()) {
          if (envelope.excludeUuid && uid === envelope.excludeUuid) continue;
          for (const sock of set) {
            if (sock.readyState === sock.OPEN) {
              sock.send(raw);
            }
          }
        }
        return;
      }
      for (const uid of envelope.targets) {
        if (envelope.excludeUuid && uid === envelope.excludeUuid) continue;
        const set = this.userSockets.get(uid);
        if (!set) continue;
        for (const sock of set) {
          if (sock.readyState === sock.OPEN) {
            sock.send(raw);
          }
        }
      }
    });
  }

  reconcileOnBoot(): number {
    return this.store.reconcileStaleCallsOnBoot();
  }

  registerSocket(userUuid: string, ws: WebSocket) {
    let set = this.userSockets.get(userUuid);
    const wasOffline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.userSockets.set(userUuid, set);
    }
    set.add(ws);

    if (wasOffline) {
      this.broadcastAll({
        event: 'presence.update',
        payload: { user_uuid: userUuid, is_online: true },
      });
    }
  }

  unregisterSocket(userUuid: string, ws: WebSocket) {
    const set = this.userSockets.get(userUuid);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.userSockets.delete(userUuid);
      this.broadcastAll({
        event: 'presence.update',
        payload: { user_uuid: userUuid, is_online: false },
      });
    }
  }

  getOnlineUserUuids(): Set<string> {
    return new Set(this.userSockets.keys());
  }

  getActiveCallCount(): number {
    return this.activeCalls.size;
  }

  shutdownTimers() {
    for (const runtime of this.activeCalls.values()) {
      if (runtime.timeoutHandle) {
        clearTimeout(runtime.timeoutHandle);
        runtime.timeoutHandle = null;
      }
    }
    this.unsubscribeBus();
    this.bus.close();
  }

  sendToUser(userUuid: string, message: unknown) {
    this.bus.publish({ targets: [userUuid], payload: message });
  }

  sendToUsers(userUuids: string[], message: unknown, excludeUuid?: string) {
    this.bus.publish({ targets: userUuids, excludeUuid, payload: message });
  }

  broadcastAll(message: unknown) {
    this.bus.publish({ targets: '*', payload: message });
  }

  isUserBusy(userUuid: string): boolean {
    return this.busyUsers.has(userUuid);
  }

  getActiveCallForUser(userUuid: string): {
    call: CallSession;
    connectedPeers: string[];
    roomToken?: string;
    iceServers: Array<{ urls: string; username?: string; credential?: string }>;
  } | null {
    const callId = this.busyUsers.get(userUuid);
    if (!callId) return null;
    const runtime = this.activeCalls.get(callId);
    if (!runtime) return null;
    const user = this.store.findUserByUuid(userUuid);
    return {
      call: runtime.call,
      connectedPeers: Array.from(runtime.connectedPeers),
      roomToken: user
        ? issueEphemeralCallToken(callId, runtime.call.webrtc_room_name, user)
        : undefined,
      iceServers: this.getIceServers(),
    };
  }

  initiateCall(params: {
    roomId: string;
    listingId?: string;
    callerUuid: string;
    calleeUuids: string[];
    mode: CallMode;
  }): {
    ok: boolean;
    error?: string;
    statusCode?: number;
    call?: CallSession;
    roomToken?: string;
  } {
    const { roomId, listingId, callerUuid, calleeUuids, mode } = params;
    const caller = this.store.findUserByUuid(callerUuid);
    if (!caller) {
      return { ok: false, error: 'Caller not found', statusCode: 404 };
    }
    if (this.isUserBusy(callerUuid)) {
      return { ok: false, error: 'You already have an active call session', statusCode: 409 };
    }

    const validCallees = calleeUuids
      .map((id) => this.store.findUserByUuid(id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u && u.user_uuid !== callerUuid));

    if (validCallees.length === 0) {
      return { ok: false, error: 'No valid callee participants found', statusCode: 400 };
    }

    for (const callee of validCallees) {
      if (this.store.isBlockedBetween(callerUuid, callee.user_uuid)) {
        return {
          ok: false,
          error: 'Calls are blocked between participants in this thread',
          statusCode: 403,
        };
      }
      if (!callee.allow_calls) {
        return {
          ok: false,
          error: `${callee.display_name} has disabled incoming calls in privacy settings`,
          statusCode: 403,
        };
      }
    }

    const busyCallee = validCallees.find((c) => this.isUserBusy(c.user_uuid));
    const now = new Date().toISOString();
    const callId = `call_${crypto.randomUUID().slice(0, 12)}`;
    const webrtcRoomName = `lc_${crypto.randomBytes(6).toString('hex')}`;

    if (busyCallee && validCallees.length === 1) {
      const busySession: CallSession = {
        call_id: callId,
        room_id: roomId,
        listing_id: listingId,
        caller_uuid: callerUuid,
        callee_uuids: [busyCallee.user_uuid],
        mode,
        state: 'BUSY',
        webrtc_room_name: webrtcRoomName,
        started_at: now,
        ended_at: now,
        duration_seconds: 0,
        end_reason: 'callee_busy',
      };
      this.store.createCallSession(busySession);
      metrics.inc('landconnect_calls_total', { outcome: 'BUSY', mode });
      return { ok: true, call: busySession };
    }

    const callSession: CallSession = {
      call_id: callId,
      room_id: roomId,
      listing_id: listingId,
      caller_uuid: callerUuid,
      callee_uuids: validCallees.map((c) => c.user_uuid),
      mode,
      state: 'RINGING',
      webrtc_room_name: webrtcRoomName,
      started_at: now,
      duration_seconds: 0,
    };

    this.store.createCallSession(callSession);
    metrics.inc('landconnect_calls_initiated_total', { mode });

    const timeoutHandle = setTimeout(() => {
      this.handleRingingTimeout(callId);
    }, RINGING_TTL_MS);

    this.activeCalls.set(callId, {
      call: callSession,
      timeoutHandle,
      connectedPeers: new Set([callerUuid]),
    });

    this.busyUsers.set(callerUuid, callId);
    for (const c of validCallees) {
      if (!this.busyUsers.has(c.user_uuid)) {
        this.busyUsers.set(c.user_uuid, callId);
      }
    }

    const listing = listingId ? this.store.findListingById(listingId) : undefined;
    const callerPublic = toPrivacySafeProfile(caller, null, this.getOnlineUserUuids());

    for (const callee of validCallees) {
      const calleeToken = issueEphemeralCallToken(callId, webrtcRoomName, callee);
      this.sendToUser(callee.user_uuid, {
        event: 'call.invite',
        payload: {
          call: callSession,
          caller: callerPublic,
          listing_title: listing?.title ?? 'LandConnect Inquiry',
          listing_price_inr: listing?.price_inr ?? null,
          listing_image: listing?.images?.[0] ?? null,
          room_token: calleeToken,
          ice_servers: this.getIceServers(),
        },
      });
    }

    const callerToken = issueEphemeralCallToken(callId, webrtcRoomName, caller);
    return { ok: true, call: callSession, roomToken: callerToken };
  }

  acceptCall(callId: string, userUuid: string): {
    ok: boolean;
    error?: string;
    statusCode?: number;
    call?: CallSession;
    roomToken?: string;
    connectedPeers?: string[];
  } {
    const runtime = this.activeCalls.get(callId);
    if (!runtime) {
      return { ok: false, error: 'Call session not found or already closed', statusCode: 404 };
    }
    const { call } = runtime;
    if (!call.callee_uuids.includes(userUuid) && call.caller_uuid !== userUuid) {
      return { ok: false, error: 'Unauthorized to accept this call', statusCode: 403 };
    }
    if (call.state !== 'RINGING' && call.state !== 'CONNECTED') {
      return { ok: false, error: `Cannot accept call in ${call.state} state`, statusCode: 409 };
    }

    if (runtime.timeoutHandle) {
      clearTimeout(runtime.timeoutHandle);
      runtime.timeoutHandle = null;
    }

    if (call.state === 'RINGING') {
      call.state = 'CONNECTED';
      call.answered_at = new Date().toISOString();
    }
    runtime.connectedPeers.add(userUuid);
    this.store.updateCallSession(call);

    const accepter = this.store.findUserByUuid(userUuid);
    const roomToken = accepter
      ? issueEphemeralCallToken(callId, call.webrtc_room_name, accepter)
      : undefined;

    const allParticipants = [call.caller_uuid, ...call.callee_uuids];
    const connectedPeers = Array.from(runtime.connectedPeers);
    this.sendToUsers(allParticipants, {
      event: 'call.accept',
      payload: {
        call,
        accepted_by_uuid: userUuid,
        connected_peers: connectedPeers,
      },
    });

    return { ok: true, call, roomToken, connectedPeers };
  }

  rejectCall(callId: string, userUuid: string, reason = 'declined'): {
    ok: boolean;
    error?: string;
    statusCode?: number;
    call?: CallSession;
  } {
    const runtime = this.activeCalls.get(callId);
    if (!runtime) {
      return { ok: false, error: 'Call session not found or already closed', statusCode: 404 };
    }
    const { call } = runtime;
    if (!call.callee_uuids.includes(userUuid)) {
      return { ok: false, error: 'Only a callee can reject an incoming call', statusCode: 403 };
    }
    if (call.state !== 'RINGING') {
      return { ok: false, error: `Cannot reject call in ${call.state} state`, statusCode: 409 };
    }

    this.finalizeCall(runtime, 'REJECTED', reason);
    const allParticipants = [call.caller_uuid, ...call.callee_uuids];
    this.sendToUsers(allParticipants, {
      event: 'call.reject',
      payload: {
        call,
        rejected_by_uuid: userUuid,
      },
    });
    return { ok: true, call };
  }

  endCall(callId: string, userUuid: string, reason = 'hangup'): {
    ok: boolean;
    error?: string;
    statusCode?: number;
    call?: CallSession;
  } {
    const runtime = this.activeCalls.get(callId);
    if (!runtime) {
      const existing = this.store.findCallById(callId);
      if (existing) {
        if (existing.caller_uuid !== userUuid && !existing.callee_uuids.includes(userUuid)) {
          return { ok: false, error: 'Unauthorized to access this call', statusCode: 403 };
        }
        return { ok: true, call: existing };
      }
      return { ok: false, error: 'Call session not found', statusCode: 404 };
    }
    const { call } = runtime;
    if (call.caller_uuid !== userUuid && !call.callee_uuids.includes(userUuid)) {
      return { ok: false, error: 'Unauthorized to end this call', statusCode: 403 };
    }

    this.finalizeCall(runtime, 'ENDED', reason);

    const allParticipants = [call.caller_uuid, ...call.callee_uuids];
    this.sendToUsers(allParticipants, {
      event: 'call.end',
      payload: {
        call,
        ended_by_uuid: userUuid,
      },
    });
    return { ok: true, call };
  }

  relayWebRtcSignal(
    senderUuid: string,
    event: 'webrtc.offer' | 'webrtc.answer' | 'webrtc.ice' | 'call.mode_switch',
    payload: {
      call_id: string;
      target_uuid?: string;
      sdp?: unknown;
      candidate?: unknown;
      mode?: CallMode;
    },
  ) {
    const runtime = this.activeCalls.get(payload.call_id);
    if (!runtime) return;
    const { call } = runtime;
    const participants = [call.caller_uuid, ...call.callee_uuids];
    if (!participants.includes(senderUuid)) return;

    if (event === 'call.mode_switch' && (payload.mode === 'AUDIO' || payload.mode === 'VIDEO')) {
      call.mode = payload.mode;
      this.store.updateCallSession(call);
    }

    const targets = payload.target_uuid
      ? participants.filter((u) => u === payload.target_uuid && u !== senderUuid)
      : participants.filter((u) => u !== senderUuid);

    this.sendToUsers(targets, {
      event,
      payload: {
        ...payload,
        from_uuid: senderUuid,
      },
    });
  }

  private handleRingingTimeout(callId: string) {
    const runtime = this.activeCalls.get(callId);
    if (!runtime || runtime.call.state !== 'RINGING') return;

    this.finalizeCall(runtime, 'MISSED', 'timeout_30s');
    const allParticipants = [runtime.call.caller_uuid, ...runtime.call.callee_uuids];
    this.sendToUsers(allParticipants, {
      event: 'call.timeout',
      payload: {
        call: runtime.call,
      },
    });
  }

  private finalizeCall(runtime: ActiveCallRuntime, state: CallState, reason: string) {
    if (runtime.timeoutHandle) {
      clearTimeout(runtime.timeoutHandle);
      runtime.timeoutHandle = null;
    }

    const { call } = runtime;
    const endedAt = new Date();
    call.state = state;
    call.ended_at = endedAt.toISOString();
    call.end_reason = reason;
    if (call.answered_at) {
      const elapsedSec = Math.max(
        1,
        Math.round((endedAt.getTime() - new Date(call.answered_at).getTime()) / 1000),
      );
      call.duration_seconds = elapsedSec;
    } else {
      call.duration_seconds = 0;
    }

    this.activeCalls.delete(call.call_id);
    for (const [uid, activeId] of this.busyUsers.entries()) {
      if (activeId === call.call_id) {
        this.busyUsers.delete(uid);
      }
    }
    this.store.updateCallSession(call);
    metrics.inc('landconnect_calls_total', { outcome: state, mode: call.mode });
  }

  getIceServers(): Array<{ urls: string; username?: string; credential?: string }> {
    const servers: Array<{ urls: string; username?: string; credential?: string }> = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    if (process.env.TURN_SERVER_URL) {
      servers.push({
        urls: process.env.TURN_SERVER_URL,
        ...(process.env.TURN_USERNAME ? { username: process.env.TURN_USERNAME } : {}),
        ...(process.env.TURN_CREDENTIAL ? { credential: process.env.TURN_CREDENTIAL } : {}),
      });
    }
    return servers;
  }
}

export const callEngine = new CallSignalingEngine(db);
