import { useCallback, useEffect } from 'react';
import { getConnection, useVoiceStore, useAuthStore } from '@abyss/shared';

const turnUrls = import.meta.env.VITE_TURN_URLS?.split(',') ?? [];
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: import.meta.env.VITE_STUN_URL || 'stun:stun.l.google.com:19302' },
    ...(turnUrls.length > 0
      ? [{
          urls: turnUrls,
          username: import.meta.env.VITE_TURN_USERNAME || '',
          credential: import.meta.env.VITE_TURN_CREDENTIAL || '',
        }]
      : []),
  ],
};

// All state is module-level so it's shared across hook instances
let peers: Map<string, RTCPeerConnection> = new Map();
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let audioElements: Map<string, HTMLAudioElement> = new Map();
let screenVideoStreams: Map<string, MediaStream> = new Map();
let pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
let listenersRegistered = false;

// Per-viewer screen track senders: viewerUserId -> RTCRtpSender
let screenTrackSenders: Map<string, RTCRtpSender> = new Map();

// Audio analysis state
let audioContext: AudioContext | null = null;
let analysers: Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }> = new Map();
let analyserInterval: ReturnType<typeof setInterval> | null = null;
const SPEAKING_THRESHOLD = 0.015;

function ensureAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function addAnalyser(userId: string, stream: MediaStream) {
  // Remove existing analyser for this user
  removeAnalyser(userId);
  const ctx = ensureAudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analysers.set(userId, { analyser, source });
  startAnalyserLoop();
}

function removeAnalyser(userId: string) {
  const entry = analysers.get(userId);
  if (entry) {
    entry.source.disconnect();
    analysers.delete(userId);
  }
  useVoiceStore.getState().setSpeaking(userId, false);
}

function startAnalyserLoop() {
  if (analyserInterval) return;
  const buffer = new Uint8Array(256);
  analyserInterval = setInterval(() => {
    for (const [userId, { analyser }] of analysers) {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const val = (buffer[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / buffer.length);
      useVoiceStore.getState().setSpeaking(userId, rms > SPEAKING_THRESHOLD);
    }
  }, 50);
}

function stopAnalyserLoop() {
  if (analyserInterval) {
    clearInterval(analyserInterval);
    analyserInterval = null;
  }
}

function cleanupAnalysers() {
  stopAnalyserLoop();
  const store = useVoiceStore.getState();
  for (const [userId, entry] of analysers) {
    entry.source.disconnect();
    store.setSpeaking(userId, false);
  }
  analysers.clear();
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
}

// Module-level exports for ScreenShareView to access
export function getScreenVideoStream(userId: string): MediaStream | undefined {
  return screenVideoStreams.get(userId);
}

export function getLocalScreenStream(): MediaStream | null {
  return screenStream;
}

function createPeerConnection(peerId: string): RTCPeerConnection {
  closePeer(peerId);
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const conn = getConnection();
      conn.invoke('SendSignal', peerId, JSON.stringify(event.candidate.toJSON()))
        .catch((err) => console.error('Failed to send ICE candidate:', err));
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`ICE state for ${peerId}: ${pc.iceConnectionState}`);
  };

  pc.ontrack = (event) => {
    const track = event.track;
    console.log(`Got remote ${track.kind} track from ${peerId}`);

    if (track.kind === 'audio') {
      let audio = audioElements.get(peerId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audioElements.set(peerId, audio);
      }
      audio.srcObject = event.streams[0];
      audio.muted = useVoiceStore.getState().isDeafened;
      audio.play().catch((err) => console.error('Audio play failed:', err));
      addAnalyser(peerId, event.streams[0]);
    } else if (track.kind === 'video') {
      screenVideoStreams.set(peerId, event.streams[0]);
      useVoiceStore.getState().bumpScreenStreamVersion();
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
  const audio = audioElements.get(peerId);
  if (audio) {
    audio.srcObject = null;
    audioElements.delete(peerId);
  }
  removeAnalyser(peerId);
  screenVideoStreams.delete(peerId);
  pendingCandidates.delete(peerId);
  screenTrackSenders.delete(peerId);
}

function cleanupAll() {
  peers.forEach((pc) => {
    pc.close();
  });
  peers.clear();
  audioElements.forEach((audio) => {
    audio.srcObject = null;
  });
  audioElements.clear();
  cleanupAnalysers();
  screenVideoStreams.clear();
  pendingCandidates.clear();
  screenTrackSenders.clear();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
}

async function applyPendingCandidates(peerId: string) {
  const pc = peers.get(peerId);
  const candidates = pendingCandidates.get(peerId);
  if (pc && candidates && pc.remoteDescription) {
    for (const candidate of candidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
    }
    pendingCandidates.delete(peerId);
  }
}

async function startScreenShareInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.currentChannelId) return;

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    console.error('Could not get display media:', err);
    return;
  }

  const videoTrack = screenStream.getVideoTracks()[0];

  // Handle browser "Stop sharing" button
  videoTrack.onended = () => {
    stopScreenShareInternal();
  };

  // Do NOT add track to any peer connections — viewers opt-in via RequestWatchStream
  voiceState.setScreenSharing(true);
  const conn = getConnection();
  await conn.invoke('NotifyScreenShare', voiceState.currentChannelId, true);
}

async function stopScreenShareInternal() {
  const voiceState = useVoiceStore.getState();
  const conn = getConnection();

  // Remove video track from all viewers we're sending to and renegotiate
  for (const [viewerId, sender] of screenTrackSenders) {
    const pc = peers.get(viewerId);
    if (pc) {
      pc.removeTrack(sender);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await conn.invoke('SendSignal', viewerId, JSON.stringify({ type: 'offer', sdp: offer.sdp }));
      } catch (err) {
        console.error(`Renegotiation (stop share) failed for ${viewerId}:`, err);
      }
    }
  }
  screenTrackSenders.clear();

  // Stop screen tracks
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }

  voiceState.setScreenSharing(false);

  if (voiceState.currentChannelId) {
    await conn.invoke('NotifyScreenShare', voiceState.currentChannelId, false);
  }
}

// Called when a viewer requests to watch our stream
async function addVideoTrackForViewer(viewerUserId: string) {
  if (!screenStream) return;
  const pc = peers.get(viewerUserId);
  if (!pc) return;

  const videoTrack = screenStream.getVideoTracks()[0];
  if (!videoTrack) return;

  const sender = pc.addTrack(videoTrack, screenStream);
  screenTrackSenders.set(viewerUserId, sender);

  // Renegotiate
  const conn = getConnection();
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await conn.invoke('SendSignal', viewerUserId, JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  } catch (err) {
    console.error(`Renegotiation (add viewer track) failed for ${viewerUserId}:`, err);
  }
}

// Called when a viewer stops watching our stream
async function removeVideoTrackForViewer(viewerUserId: string) {
  const sender = screenTrackSenders.get(viewerUserId);
  const pc = peers.get(viewerUserId);
  if (!sender || !pc) return;

  pc.removeTrack(sender);
  screenTrackSenders.delete(viewerUserId);

  // Renegotiate
  const conn = getConnection();
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await conn.invoke('SendSignal', viewerUserId, JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  } catch (err) {
    console.error(`Renegotiation (remove viewer track) failed for ${viewerUserId}:`, err);
  }
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

function setupSignalRListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const conn = getConnection();

  conn.on('UserJoinedVoice', async (userId: string, displayName: string) => {
    console.log(`UserJoinedVoice: ${displayName} (${userId})`);
    useVoiceStore.getState().addParticipant(userId, displayName);

    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id || !localStream) return;

    // Existing user creates offer for the new peer
    const pc = createPeerConnection(userId);

    // Add audio tracks only — screen track is added lazily on WatchStreamRequested
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream!));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log(`Sending offer to ${userId}`);
    await conn.invoke('SendSignal', userId, JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  });

  conn.on('UserLeftVoice', (userId: string) => {
    console.log(`UserLeftVoice: ${userId}`);
    useVoiceStore.getState().removeParticipant(userId);
    closePeer(userId);
  });

  conn.on('ReceiveSignal', async (fromUserId: string, signal: string) => {
    const data = JSON.parse(signal);

    if (data.type === 'offer') {
      console.log(`Received offer from ${fromUserId}`);

      // Check if peer already exists and is usable — support renegotiation
      let pc = peers.get(fromUserId);
      if (pc && pc.signalingState !== 'closed') {
        // Renegotiation: reuse existing connection
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
        await applyPendingCandidates(fromUserId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`Sending renegotiation answer to ${fromUserId}`);
        await conn.invoke('SendSignal', fromUserId, JSON.stringify({ type: 'answer', sdp: answer.sdp }));
      } else {
        // New connection — audio only, screen track added lazily
        pc = createPeerConnection(fromUserId);
        if (localStream) {
          localStream.getTracks().forEach((track) => pc!.addTrack(track, localStream!));
        }
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
        await applyPendingCandidates(fromUserId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`Sending answer to ${fromUserId}`);
        await conn.invoke('SendSignal', fromUserId, JSON.stringify({ type: 'answer', sdp: answer.sdp }));
      }
    } else if (data.type === 'answer') {
      console.log(`Received answer from ${fromUserId}`);
      const pc = peers.get(fromUserId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
        await applyPendingCandidates(fromUserId);
      }
    } else if (data.candidate) {
      const pc = peers.get(fromUserId);
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
      } else {
        // Buffer candidates until remote description is set
        if (!pendingCandidates.has(fromUserId)) {
          pendingCandidates.set(fromUserId, []);
        }
        pendingCandidates.get(fromUserId)!.push(data);
      }
    }
  });

  conn.on('VoiceChannelUsers', (users: Record<string, string>) => {
    useVoiceStore.getState().setParticipants(new Map(Object.entries(users)));
  });

  // Screen share events (multi-sharer)
  conn.on('ScreenShareStarted', (userId: string, displayName: string) => {
    useVoiceStore.getState().addActiveSharer(userId, displayName);
    // Update own isScreenSharing if it's our own event
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
    // Update own isScreenSharing if it's our own event
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      store.setScreenSharing(false);
    }
  });

  conn.on('ActiveSharers', (sharers: Record<string, string>) => {
    useVoiceStore.getState().setActiveSharers(new Map(Object.entries(sharers)));
  });

  // Sharer receives: viewer wants to watch
  conn.on('WatchStreamRequested', (viewerUserId: string) => {
    console.log(`WatchStreamRequested from ${viewerUserId}`);
    addVideoTrackForViewer(viewerUserId);
  });

  // Sharer receives: viewer stopped watching
  conn.on('StopWatchingRequested', (viewerUserId: string) => {
    console.log(`StopWatchingRequested from ${viewerUserId}`);
    removeVideoTrackForViewer(viewerUserId);
  });
}

export function useWebRTC() {
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const isPttActive = useVoiceStore((s) => s.isPttActive);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const setPttActive = useVoiceStore((s) => s.setPttActive);
  const setCurrentChannel = useVoiceStore((s) => s.setCurrentChannel);
  const setParticipants = useVoiceStore((s) => s.setParticipants);

  // PTT key/mouse listeners
  useEffect(() => {
    if (!currentChannelId || voiceMode !== 'push-to-talk') {
      setPttActive(false);
      return;
    }

    const isMouseBind = pttKey.startsWith('Mouse');
    const mouseButton = isMouseBind ? parseInt(pttKey.slice(5), 10) : -1;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!isMouseBind && e.key === pttKey) {
        setPttActive(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isMouseBind && e.key === pttKey) {
        setPttActive(false);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (isMouseBind && e.button === mouseButton) {
        setPttActive(true);
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (isMouseBind && e.button === mouseButton) {
        setPttActive(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      setPttActive(false);
    };
  }, [currentChannelId, voiceMode, pttKey, setPttActive]);

  // Mute/unmute local tracks (accounts for PTT mode)
  useEffect(() => {
    if (localStream) {
      const enabled = !isMuted && (voiceMode === 'voice-activity' || isPttActive);
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
    }
  }, [isMuted, voiceMode, isPttActive]);

  // Deafen - mute all remote audio
  useEffect(() => {
    audioElements.forEach((audio) => {
      audio.muted = isDeafened;
    });
  }, [isDeafened]);

  // Register SignalR listeners once (module-level flag, not per-instance)
  useEffect(() => {
    setupSignalRListeners();
  }, []);

  const joinVoice = useCallback(async (channelId: string) => {
    // Leave current if any
    if (currentChannelId) {
      const conn = getConnection();
      await conn.invoke('LeaveVoiceChannel', currentChannelId);
      cleanupAll();
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Got local audio stream, tracks:', localStream.getAudioTracks().length);
    } catch (err) {
      console.error('Could not access microphone:', err);
      return;
    }

    // Apply current mute state to the new stream immediately
    const voiceState = useVoiceStore.getState();
    const shouldEnable = !voiceState.isMuted && (voiceState.voiceMode === 'voice-activity' || voiceState.isPttActive);
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = shouldEnable;
    });

    // Set up audio analyser for local user's speaking indicator
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      addAnalyser(currentUser.id, localStream);
    }

    setCurrentChannel(channelId);
    const conn = getConnection();
    await conn.invoke('JoinVoiceChannel', channelId);
  }, [currentChannelId, setCurrentChannel]);

  const leaveVoice = useCallback(async () => {
    if (currentChannelId) {
      const conn = getConnection();
      await conn.invoke('LeaveVoiceChannel', currentChannelId);
    }
    cleanupAll();
    setCurrentChannel(null);
    setParticipants(new Map());
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
  }, [currentChannelId, setCurrentChannel, setParticipants]);

  const startScreenShare = useCallback(async () => {
    await startScreenShareInternal();
  }, []);

  const stopScreenShare = useCallback(async () => {
    await stopScreenShareInternal();
  }, []);

  return { joinVoice, leaveVoice, startScreenShare, stopScreenShare };
}
