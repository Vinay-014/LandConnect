import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, RefreshCw, Video, VideoOff } from 'lucide-react';
import { formatDuration } from '../api/client';
import type { ActiveCallUiState, CallMode } from '../types';

interface CallOverlayProps {
  activeCall: ActiveCallUiState;
  currentUserUuid: string;
  onAccept: (callId: string) => Promise<void>;
  onReject: (callId: string) => Promise<void>;
  onEnd: (callId: string) => Promise<void>;
  sendSignal: (
    event: 'webrtc.offer' | 'webrtc.answer' | 'webrtc.ice' | 'call.mode_switch',
    payload: Record<string, unknown>,
  ) => void;
  incomingSignal: {
    event: string;
    payload: Record<string, unknown>;
    seq: number;
  } | null;
}

function createSyntheticVideoTrack(
  label: string,
  onIntervalCreated?: (id: number) => void,
): MediaStreamTrack | null {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let tick = 0;
  const draw = () => {
    ctx.fillStyle = '#0B141A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#008069';
    ctx.beginPath();
    ctx.arc(320, 210, 56 + Math.sin(tick * 0.08) * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '600 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, 320, 310);
    ctx.fillStyle = '#94A3B8';
    ctx.font = '14px sans-serif';
    ctx.fillText('LandConnect Private Video', 320, 340);
    tick += 1;
  };
  draw();
  const interval = window.setInterval(draw, 120);
  const vidStream = canvas.captureStream(15);
  const track = vidStream.getVideoTracks()[0] ?? null;
  if (track) {
    onIntervalCreated?.(interval);
    track.addEventListener('ended', () => clearInterval(interval));
  } else {
    clearInterval(interval);
  }
  return track;
}

function createSyntheticMediaStream(
  label: string,
  includeVideo: boolean,
  onIntervalCreated?: (id: number) => void,
): MediaStream {
  const stream = new MediaStream();
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.001;
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
  } catch {
    // Ignore restricted audio context
  }

  if (includeVideo) {
    const videoTrack = createSyntheticVideoTrack(label, onIntervalCreated);
    if (videoTrack) {
      stream.addTrack(videoTrack);
    }
  }
  return stream;
}

function RemotePeerVideo({ stream, label }: { stream: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <div className="relative w-full h-full min-h-[200px] bg-[#0B141A] rounded-xl overflow-hidden border border-white/10">
      <video ref={ref} autoPlay playsInline className="w-full h-full object-cover" />
      <div className="absolute bottom-2 left-2 bg-black/70 text-white text-[11px] px-2.5 py-0.5 rounded">
        {label}
      </div>
    </div>
  );
}

function RemotePeerAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

export function CallOverlay({
  activeCall,
  currentUserUuid,
  onAccept,
  onReject,
  onEnd,
  sendSignal,
  incomingSignal,
}: CallOverlayProps) {
  const { call, direction, peerName, peerRole, listingTitle, iceServers } = activeCall;
  const isConnected = call.state === 'CONNECTED';
  const isIncomingRinging = call.state === 'RINGING' && direction === 'INCOMING';

  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(call.mode === 'AUDIO');
  const [mode, setMode] = useState<CallMode>(call.mode);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);
  const [iceStatus, setIceStatus] = useState<string>('signaling');
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const queuedSignalsRef = useRef<Array<{ event: string; payload: Record<string, unknown> }>>([]);
  const syntheticIntervalsRef = useRef<number[]>([]);

  const remotePeerUuids = [call.caller_uuid, ...call.callee_uuids].filter(
    (id, idx, arr) => id !== currentUserUuid && arr.indexOf(id) === idx,
  );

  useEffect(() => {
    setMode(call.mode);
    setCameraOff(call.mode === 'AUDIO');
  }, [call.mode]);

  useEffect(() => {
    if (mode === 'VIDEO' && isConnected && localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [mode, isConnected]);

  useEffect(() => {
    if (!isConnected) {
      setElapsedSeconds(0);
      return;
    }
    const startMs = call.answered_at ? new Date(call.answered_at).getTime() : Date.now();
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [isConnected, call.answered_at]);

  const getOrCreatePeerConnection = (peerUuid: string, localStream: MediaStream) => {
    const existing = peersRef.current.get(peerUuid);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers });
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    pc.ontrack = (evt) => {
      const stream = evt.streams[0];
      if (stream) {
        setRemoteStreams((prev) => ({ ...prev, [peerUuid]: stream }));
      }
    };

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        sendSignal('webrtc.ice', {
          call_id: call.call_id,
          target_uuid: peerUuid,
          candidate: evt.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      setIceStatus(pc.connectionState);
    };

    peersRef.current.set(peerUuid, pc);
    return pc;
  };

  const processSignal = async (
    event: string,
    payload: Record<string, unknown>,
    localStream: MediaStream,
  ) => {
    if (payload.call_id !== call.call_id) return;
    const fromUuid = String(payload.from_uuid || '');
    if (!fromUuid || fromUuid === currentUserUuid) return;

    if (event === 'call.mode_switch' && (payload.mode === 'AUDIO' || payload.mode === 'VIDEO')) {
      setMode(payload.mode as CallMode);
      return;
    }

    const pc = getOrCreatePeerConnection(fromUuid, localStream);

    if (event === 'webrtc.offer' && payload.sdp) {
      await pc.setRemoteDescription(
        new RTCSessionDescription(payload.sdp as RTCSessionDescriptionInit),
      );
      const queued = pendingIceRef.current.get(fromUuid) || [];
      for (const cand of queued) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      pendingIceRef.current.delete(fromUuid);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal('webrtc.answer', {
        call_id: call.call_id,
        target_uuid: fromUuid,
        sdp: pc.localDescription,
      });
    } else if (event === 'webrtc.answer' && payload.sdp) {
      await pc.setRemoteDescription(
        new RTCSessionDescription(payload.sdp as RTCSessionDescriptionInit),
      );
      const queued = pendingIceRef.current.get(fromUuid) || [];
      for (const cand of queued) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      pendingIceRef.current.delete(fromUuid);
    } else if (event === 'webrtc.ice' && payload.candidate) {
      const cand = payload.candidate as RTCIceCandidateInit;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } else {
        const list = pendingIceRef.current.get(fromUuid) || [];
        list.push(cand);
        pendingIceRef.current.set(fromUuid, list);
      }
    }
  };

  // Setup multi-peer WebRTC mesh when CONNECTED
  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;

    async function setupMesh() {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: call.mode === 'VIDEO',
        });
      } catch {
        stream = createSyntheticMediaStream(peerName, call.mode === 'VIDEO', (id) => {
          syntheticIntervalsRef.current.push(id);
        });
        if (!cancelled) {
          setMediaNotice('Camera or microphone unavailable in this browser — using audio/video preview');
        }
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      for (const peerUuid of remotePeerUuids) {
        const pc = getOrCreatePeerConnection(peerUuid, stream);
        // Deterministic offerer tie-breaker avoids SDP glare in 2- and 3-party calls
        if (currentUserUuid < peerUuid && pc.signalingState === 'stable') {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignal('webrtc.offer', {
            call_id: call.call_id,
            target_uuid: peerUuid,
            sdp: pc.localDescription,
          });
        }
      }

      // Flush any SDP/ICE signals that arrived while getUserMedia was resolving
      const buffered = queuedSignalsRef.current.splice(0);
      for (const sig of buffered) {
        await processSignal(sig.event, sig.payload, stream).catch(() => {});
      }
    }

    setupMesh();

    return () => {
      cancelled = true;
      for (const pc of peersRef.current.values()) {
        pc.close();
      }
      peersRef.current.clear();
      pendingIceRef.current.clear();
      queuedSignalsRef.current = [];
      setRemoteStreams({});
      syntheticIntervalsRef.current.forEach((id) => clearInterval(id));
      syntheticIntervalsRef.current = [];
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    };
  }, [isConnected, call.call_id]);

  // Handle incoming targeted SDP/ICE signals (buffering if localStream is still initializing)
  useEffect(() => {
    if (!incomingSignal) return;
    const { event, payload } = incomingSignal;
    if (payload.call_id !== call.call_id) return;
    if (!localStreamRef.current) {
      if (event === 'call.mode_switch' && (payload.mode === 'AUDIO' || payload.mode === 'VIDEO')) {
        setMode(payload.mode as CallMode);
        return;
      }
      queuedSignalsRef.current.push({ event, payload });
      return;
    }
    processSignal(event, payload, localStreamRef.current).catch(() => {});
  }, [incomingSignal, call.call_id]);

  const toggleMic = () => {
    const next = !micMuted;
    setMicMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  };

  const toggleCamera = () => {
    const next = !cameraOff;
    setCameraOff(next);
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
  };

  const switchCallMode = async () => {
    const nextMode: CallMode = mode === 'AUDIO' ? 'VIDEO' : 'AUDIO';
    setMode(nextMode);
    setCameraOff(nextMode === 'AUDIO');

    const stream = localStreamRef.current;
    if (stream) {
      if (nextMode === 'AUDIO') {
        stream.getVideoTracks().forEach((t) => {
          t.enabled = false;
        });
      } else {
        const existingTracks = stream.getVideoTracks();
        if (existingTracks.length > 0) {
          existingTracks.forEach((t) => {
            t.enabled = true;
          });
        } else {
          let newVideoTrack: MediaStreamTrack | null = null;
          try {
            const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
            newVideoTrack = camStream.getVideoTracks()[0] ?? null;
          } catch {
            newVideoTrack = createSyntheticVideoTrack(peerName, (id) => {
              syntheticIntervalsRef.current.push(id);
            });
            setMediaNotice('Camera unavailable in this browser — using video preview');
          }
          if (newVideoTrack) {
            stream.addTrack(newVideoTrack);
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = stream;
            }
            for (const [peerUuid, pc] of peersRef.current.entries()) {
              const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
              if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
              } else {
                pc.addTrack(newVideoTrack, stream);
              }
              if (pc.signalingState === 'stable') {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendSignal('webrtc.offer', {
                  call_id: call.call_id,
                  target_uuid: peerUuid,
                  sdp: pc.localDescription,
                });
              }
            }
          }
        }
      }
    }

    sendSignal('call.mode_switch', {
      call_id: call.call_id,
      mode: nextMode,
    });
  };

  if (isIncomingRinging) {
    return (
      <div
        className="fixed inset-x-0 top-4 z-50 mx-auto max-w-md px-4"
        role="dialog"
        aria-label="Incoming call"
      >
        <div className="rounded-2xl bg-[#111B21] text-white p-5 shadow-2xl border border-white/10">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-medium text-[#25D366] tracking-wide">
                Incoming {call.mode === 'VIDEO' ? 'Video' : 'Audio'} Call · {peerRole}
              </div>
              <h3 className="text-lg font-semibold text-white truncate mt-1">{peerName}</h3>
              <p className="text-xs text-slate-300 truncate mt-0.5">{listingTitle}</p>
              <p className="text-[11px] text-slate-400 mt-1">
                Private consultation · Personal number hidden
              </p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-[#008069] flex items-center justify-center shrink-0">
              {call.mode === 'VIDEO' ? <Video className="w-6 h-6" /> : <Phone className="w-6 h-6" />}
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => onReject(call.call_id)}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <PhoneOff className="w-4 h-4" />
              Reject
            </button>
            <button
              type="button"
              onClick={() => onAccept(call.call_id)}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[#008069] hover:bg-[#075E54] text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <Phone className="w-4 h-4" />
              Accept
            </button>
          </div>
        </div>
      </div>
    );
  }

  const streamEntries = Object.entries(remoteStreams);

  return (
    <div
      className="fixed inset-0 h-[100dvh] z-50 bg-[#0B141A] text-white flex flex-col justify-between p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Active call screen"
    >
      <div className="flex items-center justify-between gap-4 max-w-5xl w-full mx-auto">
        <div className="min-w-0">
          <div className="text-xs text-slate-300 flex items-center gap-2">
            <span>{peerRole}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{listingTitle}</span>
            {remotePeerUuids.length > 1 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{remotePeerUuids.length + 1}-party room</span>
              </>
            )}
          </div>
          <h2 className="text-xl sm:text-2xl font-semibold text-white truncate mt-1">{peerName}</h2>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-mono tabular-nums text-[#25D366]">
            {isConnected ? formatDuration(elapsedSeconds) : 'Ringing...'}
          </div>
          <div className="text-[11px] text-slate-400">
            {mode === 'VIDEO' ? 'Video Call' : 'Voice Call'} · {iceStatus === 'connected' ? 'Connected' : 'Private'}
          </div>
        </div>
      </div>

      <div className="relative flex-1 my-5 max-w-5xl w-full mx-auto rounded-2xl overflow-hidden bg-[#111B21] border border-white/10 p-3 flex items-center justify-center">
        {mode === 'AUDIO' &&
          isConnected &&
          streamEntries.map(([peerId, stream]) => <RemotePeerAudio key={peerId} stream={stream} />)}

        {mode === 'VIDEO' && isConnected && streamEntries.length > 0 ? (
          <div
            className={`w-full h-full grid gap-3 ${
              streamEntries.length > 1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
            }`}
          >
            {streamEntries.map(([peerId, stream], idx) => (
              <RemotePeerVideo
                key={peerId}
                label={streamEntries.length === 1 ? peerName : `Participant ${idx + 1}`}
                stream={stream}
              />
            ))}
          </div>
        ) : (
          <div className="text-center px-6">
            <div className="w-24 h-24 rounded-full bg-[#008069] mx-auto flex items-center justify-center text-3xl font-semibold">
              {peerName.charAt(0)}
            </div>
            <p className="mt-4 text-base font-medium text-white">
              {isConnected
                ? `${mode === 'VIDEO' ? 'Video' : 'Voice'} Call Connected`
                : 'Calling privately...'}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Personal phone numbers stay hidden throughout the call
            </p>
          </div>
        )}

        {mode === 'VIDEO' && isConnected && (
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="absolute bottom-3 right-3 sm:bottom-5 sm:right-5 w-24 sm:w-44 aspect-[4/3] rounded-xl object-cover border border-white/20 bg-black shadow-lg"
          />
        )}

        {mediaNotice && (
          <div className="absolute top-3 left-3 right-3 sm:top-4 sm:left-4 sm:right-auto bg-black/75 text-slate-200 text-xs px-3 py-1.5 rounded-lg">
            {mediaNotice}
          </div>
        )}
      </div>

      <div className="max-w-lg w-full mx-auto flex items-center justify-center flex-wrap sm:flex-nowrap gap-2.5 sm:gap-4 pb-1 sm:pb-2">
        <button
          type="button"
          onClick={toggleMic}
          className={`min-h-[44px] sm:min-h-[48px] min-w-[44px] sm:min-w-[48px] px-3.5 sm:px-4 rounded-xl flex items-center justify-center gap-2 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
            micMuted ? 'bg-white text-[#111B21]' : 'bg-white/10 hover:bg-white/20 text-white'
          }`}
          aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {micMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          <span className="hidden sm:inline">{micMuted ? 'Unmute' : 'Mute'}</span>
        </button>

        <button
          type="button"
          onClick={toggleCamera}
          disabled={mode === 'AUDIO'}
          className={`min-h-[44px] sm:min-h-[48px] min-w-[44px] sm:min-w-[48px] px-3.5 sm:px-4 rounded-xl flex items-center justify-center gap-2 text-xs sm:text-sm font-medium transition-colors disabled:opacity-40 whitespace-nowrap ${
            cameraOff ? 'bg-white text-[#111B21]' : 'bg-white/10 hover:bg-white/20 text-white'
          }`}
          aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'}
        >
          {cameraOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
          <span className="hidden sm:inline">{cameraOff ? 'Cam Off' : 'Cam On'}</span>
        </button>

        <button
          type="button"
          onClick={switchCallMode}
          className="min-h-[44px] sm:min-h-[48px] px-3.5 sm:px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-medium flex items-center justify-center gap-1.5 sm:gap-2 transition-colors whitespace-nowrap"
        >
          <RefreshCw className="w-4 h-4 shrink-0" />
          <span>{mode === 'AUDIO' ? 'Video' : 'Audio'}</span>
        </button>

        <button
          type="button"
          onClick={() => onEnd(call.call_id)}
          className="min-h-[44px] sm:min-h-[48px] px-4 sm:px-5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs sm:text-sm font-medium flex items-center justify-center gap-1.5 sm:gap-2 transition-colors whitespace-nowrap"
        >
          <PhoneOff className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
          <span>End</span>
        </button>
      </div>
    </div>
  );
}
