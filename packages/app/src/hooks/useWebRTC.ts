import { useCallback, useEffect } from 'react';
import {
  mediaDevices,
  RTCPeerConnection,
  RTCIceCandidate,
  MediaStream,
} from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import Constants from 'expo-constants';
import {
  getConnection,
  ensureConnected,
  getTurnCredentials,
  subscribeTurnCredentials,
  useVoiceStore,
  useAuthStore,
} from '@abyss/shared';

// ICE config (STUN from app.json extras, TURN from backend)
const extra = Constants.expoConfig?.extra ?? {};
const STUN_URL = extra.stunUrl || 'stun:stun.l.google.com:19302';
let currentIceServers: RTCIceServer[] = [{ urls: STUN_URL }];
let turnInitPromise: Promise<void> | null = null;
const iceRestartInFlight: Set<string> = new Set();

// Module-level state (singleton, shared across hook instances)
let peers: Map<string, RTCPeerConnection> = new Map();
let localStream: MediaStream | null = null;
let remoteStreams: Map<string, MediaStream> = new Map();
let screenVideoStreams: Map<string, MediaStream> = new Map();
let pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
// Track which connection object we registered on, so we can re-register if connection is recreated
let registeredOnConnection: any = null;

// Exported for ScreenShareView to access remote video streams
export function getScreenVideoStream(userId: string): MediaStream | undefined {
  return screenVideoStreams.get(userId);
}

// Exported for ScreenShareView to call
export async function requestWatch(sharerUserId: string) {
  const conn = getConnection();
  useVoiceStore.getState().setWatching(sharerUserId);
  await conn.invoke('RequestWatchStream', sharerUserId);
}

export async function stopWatching() {
  const store = useVoiceStore.getState();
  const sharerUserId = store.watchingUserId;
  if (!sharerUserId) return;

  const conn = getConnection();
  await conn.invoke('StopWatchingStream', sharerUserId);
  store.setWatching(null);
  screenVideoStreams.delete(sharerUserId);
  store.bumpScreenStreamVersion();
}

function createPeerConnection(peerId: string): RTCPeerConnection {
  closePeer(peerId);
  const pc = new RTCPeerConnection({ iceServers: currentIceServers });
  peers.set(peerId, pc);

  (pc as any).onicecandidate = (event: any) => {
    if (event.candidate) {
      const conn = getConnection();
      // Manually serialize — toJSON() may not exist in RN-webrtc
      const candidateData = {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      };
      conn.invoke('SendSignal', peerId, JSON.stringify(candidateData))
        .catch((err: any) => console.error('Failed to send ICE candidate:', err));
    }
  };

  (pc as any).oniceconnectionstatechange = () => {
    console.log(`[WebRTC] ICE state for ${peerId}: ${pc.iceConnectionState}`);
  };

  (pc as any).ontrack = (event: any) => {
    const track = event.track;
    console.log(`[WebRTC] Got remote ${track.kind} track from ${peerId}`);

    if (track.kind === 'audio') {
      // RN-webrtc auto-plays remote audio — store stream for deafen control
      if (event.streams && event.streams.length > 0) {
        remoteStreams.set(peerId, event.streams[0]);
      }

      // Apply current deafen state
      const isDeafened = useVoiceStore.getState().isDeafened;
      track.enabled = !isDeafened;
      console.log(`[WebRTC] Remote audio track enabled=${!isDeafened} for ${peerId}`);
    } else if (track.kind === 'video') {
      // Screen share video track from a sharer
      if (event.streams && event.streams.length > 0) {
        screenVideoStreams.set(peerId, event.streams[0]);
      }
      useVoiceStore.getState().bumpScreenStreamVersion();
      console.log(`[WebRTC] Got remote screen video track from ${peerId}`);
    }
  };

  return pc;
}

function closePeer(peerId: string) {
  const pc = peers.get(peerId);
  if (pc) {
    pc.close();
    peers.delete(peerId);
  }
  remoteStreams.delete(peerId);
  screenVideoStreams.delete(peerId);
  pendingCandidates.delete(peerId);
  iceRestartInFlight.delete(peerId);
}

function cleanupAll() {
  peers.forEach((pc) => pc.close());
  peers.clear();
  remoteStreams.clear();
  screenVideoStreams.clear();
  pendingCandidates.clear();
  if (localStream) {
    localStream.getTracks().forEach((track: any) => track.stop());
    localStream = null;
  }
}

async function applyPendingCandidates(peerId: string) {
  const pc = peers.get(peerId);
  const candidates = pendingCandidates.get(peerId);
  if (pc && candidates && pc.remoteDescription) {
    console.log(`[WebRTC] Applying ${candidates.length} pending ICE candidates for ${peerId}`);
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`[WebRTC] Failed to add pending ICE candidate for ${peerId}:`, err);
      }
    }
    pendingCandidates.delete(peerId);
  }
}

function buildIceServersFromTurn(creds: { urls: string[]; username: string; credential: string }): RTCIceServer[] {
  return [
    { urls: STUN_URL },
    { urls: creds.urls, username: creds.username, credential: creds.credential },
  ];
}

function setIceServers(iceServers: RTCIceServer[]) {
  currentIceServers = iceServers;
}

async function initializeTurn(): Promise<void> {
  if (turnInitPromise) return turnInitPromise;
  turnInitPromise = (async () => {
    try {
      const creds = await getTurnCredentials();
      setIceServers(buildIceServersFromTurn(creds));
    } catch (err) {
      console.warn('[WebRTC] Failed to fetch TURN credentials:', err);
      turnInitPromise = null;
    }
  })();
  return turnInitPromise;
}

async function applyIceServersToPeers(iceServers: RTCIceServer[]) {
  for (const [peerId, pc] of peers) {
    try {
      const anyPc = pc as any;
      if (typeof anyPc.setConfiguration === 'function') {
        anyPc.setConfiguration({ iceServers });
      }
    } catch (err) {
      console.warn(`[WebRTC] Failed to set ICE servers for ${peerId}:`, err);
    }
  }
}

async function restartIceForPeer(peerId: string, pc: RTCPeerConnection) {
  if (iceRestartInFlight.has(peerId)) return;
  if (pc.signalingState !== 'stable') return;
  iceRestartInFlight.add(peerId);
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    const conn = getConnection();
    await conn.invoke('SendSignal', peerId, JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  } catch (err) {
    console.warn(`[WebRTC] ICE restart failed for ${peerId}:`, err);
  } finally {
    iceRestartInFlight.delete(peerId);
  }
}

async function restartIceForAllPeers() {
  const entries = Array.from(peers.entries());
  for (const [peerId, pc] of entries) {
    await restartIceForPeer(peerId, pc);
  }
}

const VOICE_EVENTS = [
  'UserJoinedVoice', 'UserLeftVoice', 'ReceiveSignal', 'VoiceChannelUsers',
  'ScreenShareStarted', 'ScreenShareStopped', 'ActiveSharers',
  'WatchStreamRequested', 'StopWatchingRequested',
];

function setupSignalRListeners() {
  const conn = getConnection();

  // Skip if already registered on this exact connection instance
  if (registeredOnConnection === conn) return;

  // Remove old handlers if re-registering (connection was recreated)
  if (registeredOnConnection) {
    for (const e of VOICE_EVENTS) {
      try { registeredOnConnection.off(e); } catch {}
    }
  }

  registeredOnConnection = conn;
  console.log('[WebRTC] Registering SignalR voice listeners');

  conn.on('UserJoinedVoice', async (userId: string, displayName: string) => {
    try {
      console.log(`[WebRTC] UserJoinedVoice: ${displayName} (${userId})`);
      useVoiceStore.getState().addParticipant(userId, displayName);

      const currentUser = useAuthStore.getState().user;
      if (userId === currentUser?.id || !localStream) {
        console.log(`[WebRTC] Skipping offer (self=${userId === currentUser?.id}, hasStream=${!!localStream})`);
        return;
      }

      const pc = createPeerConnection(userId);
      localStream.getTracks().forEach((track: any) => pc.addTrack(track, localStream!));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`[WebRTC] Sending offer to ${userId}`);
      await conn.invoke('SendSignal', userId, JSON.stringify({ type: 'offer', sdp: offer.sdp }));
    } catch (err) {
      console.error('[WebRTC] Error in UserJoinedVoice handler:', err);
    }
  });

  conn.on('UserLeftVoice', (userId: string) => {
    console.log(`[WebRTC] UserLeftVoice: ${userId}`);
    useVoiceStore.getState().removeParticipant(userId);
    closePeer(userId);
  });

  conn.on('ReceiveSignal', async (fromUserId: string, signal: string) => {
    try {
      const data = JSON.parse(signal);

      if (data.type === 'offer') {
        console.log(`[WebRTC] Received offer from ${fromUserId}`);

        let pc = peers.get(fromUserId);
        if (pc && pc.signalingState !== 'closed') {
          // Renegotiation: reuse existing connection
          await pc.setRemoteDescription(data);
          await applyPendingCandidates(fromUserId);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          console.log(`[WebRTC] Sending renegotiation answer to ${fromUserId}`);
          await conn.invoke('SendSignal', fromUserId, JSON.stringify({ type: 'answer', sdp: answer.sdp }));
        } else {
          pc = createPeerConnection(fromUserId);
          if (localStream) {
            localStream.getTracks().forEach((track: any) => pc!.addTrack(track, localStream!));
          }
          await pc.setRemoteDescription(data);
          await applyPendingCandidates(fromUserId);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          console.log(`[WebRTC] Sending answer to ${fromUserId}`);
          await conn.invoke('SendSignal', fromUserId, JSON.stringify({ type: 'answer', sdp: answer.sdp }));
        }
      } else if (data.type === 'answer') {
        console.log(`[WebRTC] Received answer from ${fromUserId}`);
        const pc = peers.get(fromUserId);
        if (pc) {
          await pc.setRemoteDescription(data);
          await applyPendingCandidates(fromUserId);
        } else {
          console.warn(`[WebRTC] No peer for answer from ${fromUserId}`);
        }
      } else if (data.candidate) {
        const pc = peers.get(fromUserId);
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data));
        } else {
          if (!pendingCandidates.has(fromUserId)) {
            pendingCandidates.set(fromUserId, []);
          }
          pendingCandidates.get(fromUserId)!.push(data);
        }
      }
    } catch (err) {
      console.error('[WebRTC] Error in ReceiveSignal handler:', err);
    }
  });

  conn.on('VoiceChannelUsers', (users: Record<string, string>) => {
    console.log('[WebRTC] VoiceChannelUsers:', Object.keys(users).length, 'users');
    useVoiceStore.getState().setParticipants(new Map(Object.entries(users)));
  });

  // Screen share events — update store only (for sidebar LIVE badges)
  conn.on('ScreenShareStarted', (userId: string, displayName: string) => {
    useVoiceStore.getState().addActiveSharer(userId, displayName);
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      useVoiceStore.getState().setScreenSharing(true);
    }
  });

  conn.on('ScreenShareStopped', (userId: string) => {
    const store = useVoiceStore.getState();
    store.removeActiveSharer(userId);
    // If we were watching this sharer, clean up
    if (store.watchingUserId === userId) {
      store.setWatching(null);
      screenVideoStreams.delete(userId);
      store.bumpScreenStreamVersion();
    }
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      store.setScreenSharing(false);
    }
  });

  conn.on('ActiveSharers', (sharers: Record<string, string>) => {
    useVoiceStore.getState().setActiveSharers(new Map(Object.entries(sharers)));
  });

  // Screen sharing from mobile not supported (Phase 8b) — these are no-ops
  conn.on('WatchStreamRequested', (viewerUserId: string) => {
    console.log(`[WebRTC] WatchStreamRequested from ${viewerUserId} — mobile sharing not supported`);
  });

  conn.on('StopWatchingRequested', (viewerUserId: string) => {
    console.log(`[WebRTC] StopWatchingRequested from ${viewerUserId} — mobile sharing not supported`);
  });

  // Voice session replaced (joined voice from another device)
  conn.on('VoiceSessionReplaced', (message: string) => {
    console.warn('[WebRTC] Voice session replaced:', message);
    // Force leave voice - clean up all WebRTC state
    cleanupAll();
    InCallManager.stop();
    useVoiceStore.getState().setCurrentChannel(null);
    useVoiceStore.getState().setParticipants(new Map());
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
  });
}

export function useWebRTC() {
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const isPttActive = useVoiceStore((s) => s.isPttActive);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const speakerOn = useVoiceStore((s) => s.speakerOn);
  const setCurrentChannel = useVoiceStore((s) => s.setCurrentChannel);
  const setParticipants = useVoiceStore((s) => s.setParticipants);

  // Mute/unmute local tracks (accounts for PTT mode)
  useEffect(() => {
    if (localStream) {
      const enabled = !isMuted && (voiceMode === 'voice-activity' || isPttActive);
      localStream.getAudioTracks().forEach((track: any) => {
        track.enabled = enabled;
      });
    }
  }, [isMuted, voiceMode, isPttActive]);

  // Broadcast mute/deafen state to everyone in the server
  useEffect(() => {
    if (!currentChannelId) return;
    let cancelled = false;
    (async () => {
      try {
        const conn = await ensureConnected();
        if (cancelled) return;
        await conn.invoke('UpdateVoiceState', isMuted, isDeafened);
      } catch (err) {
        console.warn('[WebRTC] Failed to update voice state', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentChannelId, isMuted, isDeafened]);

  // Deafen — disable all remote audio tracks via receivers
  useEffect(() => {
    peers.forEach((pc) => {
      try {
        pc.getReceivers().forEach((receiver: any) => {
          if (receiver.track && receiver.track.kind === 'audio') {
            receiver.track.enabled = !isDeafened;
          }
        });
      } catch (err) {
        // getReceivers may not be available on all RN-webrtc versions
        console.warn('[WebRTC] getReceivers not available, using remoteStreams fallback');
      }
    });
    // Fallback: disable tracks on stored remote streams
    remoteStreams.forEach((stream) => {
      stream.getAudioTracks().forEach((track: any) => {
        track.enabled = !isDeafened;
      });
    });
  }, [isDeafened]);

  // Speaker routing
  useEffect(() => {
    if (!currentChannelId) return;
    InCallManager.setForceSpeakerphoneOn(speakerOn);
  }, [speakerOn, currentChannelId]);

  // Register SignalR listeners once
  useEffect(() => {
    void initializeTurn();
    const unsubscribe = subscribeTurnCredentials((creds) => {
      const iceServers = buildIceServersFromTurn(creds);
      setIceServers(iceServers);
      void applyIceServersToPeers(iceServers).then(() => restartIceForAllPeers());
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Register SignalR listeners once
  useEffect(() => {
    setupSignalRListeners();
  }, []);

  const joinVoice = useCallback(async (channelId: string) => {
    console.log(`[WebRTC] joinVoice(${channelId}), current=${currentChannelId}`);

    // Ensure connection is started and listeners are on the active connection
    await ensureConnected();
    setupSignalRListeners();
    await initializeTurn();

    // Leave current if any
    if (currentChannelId) {
      const conn = getConnection();
      await conn.invoke('LeaveVoiceChannel', currentChannelId);
      cleanupAll();
    }

    InCallManager.start({ media: 'audio' });
    InCallManager.setForceSpeakerphoneOn(useVoiceStore.getState().speakerOn);

    try {
      localStream = await mediaDevices.getUserMedia({
        audio: {
          noiseSuppression,
          echoCancellation,
          autoGainControl,
        },
      }) as MediaStream;
      console.log('[WebRTC] Got local audio stream, tracks:', localStream.getAudioTracks().length);
    } catch (err) {
      console.error('[WebRTC] Could not access microphone:', err);
      InCallManager.stop();
      return;
    }

    // Apply current mute state immediately
    const voiceState = useVoiceStore.getState();
    const shouldEnable = !voiceState.isMuted && (voiceState.voiceMode === 'voice-activity' || voiceState.isPttActive);
    localStream.getAudioTracks().forEach((track: any) => {
      track.enabled = shouldEnable;
    });

    setCurrentChannel(channelId);
    const conn = getConnection();
    await conn.invoke('JoinVoiceChannel', channelId, voiceState.isMuted, voiceState.isDeafened);
    console.log('[WebRTC] JoinVoiceChannel invoked');
  }, [currentChannelId, setCurrentChannel]);

  const leaveVoice = useCallback(async () => {
    if (currentChannelId) {
      const conn = getConnection();
      await conn.invoke('LeaveVoiceChannel', currentChannelId);
    }
    cleanupAll();
    InCallManager.stop();
    setCurrentChannel(null);
    setParticipants(new Map());
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
  }, [currentChannelId, setCurrentChannel, setParticipants]);

  return { joinVoice, leaveVoice };
}
