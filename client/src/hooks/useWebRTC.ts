import { useCallback, useEffect } from "react";
import type { HubConnection } from "@microsoft/signalr";
import {
  ensureConnected,
  getConnection,
  getTurnCredentials,
  onReconnected,
  subscribeTurnCredentials,
  useVoiceStore,
  useAuthStore,
  useServerStore,
  useVoiceChatStore,
  useToastStore,
  useWatchPartyStore,
  connectToLiveKit,
  disconnectFromLiveKit,
  sfuToggleMute,
  sfuSetDeafened,
  sfuSetScreenAudioVolume,
  sfuSetInputDevice,
  sfuPublishScreenShare,
  sfuUnpublishScreenShare,
  sfuPublishCamera,
  sfuUnpublishCamera,
  getSfuScreenStream,
  getSfuCameraStream,
  getSfuLocalCameraStream,
  getSfuLocalScreenStream,
  sfuUpdateScreenShareQuality,
  sfuUpdateCameraQuality,
  isInSfuMode,
} from "@abyss/shared";
import type { CameraQuality, ScreenShareQuality } from "@abyss/shared";
// Lazy-imported to avoid crashing on platforms without AudioWorkletNode (e.g. iOS WebView)
type NoiseSuppressorType = import("../audio/NoiseSuppressor").NoiseSuppressor;
async function createNoiseSuppressor(): Promise<NoiseSuppressorType> {
  const { NoiseSuppressor } = await import("../audio/NoiseSuppressor");
  return new NoiseSuppressor();
}

const STUN_URL =
  import.meta.env.VITE_STUN_URL || "stun:stun.l.google.com:19302";
let currentIceServers: RTCIceServer[] = [{ urls: STUN_URL }];
let turnInitPromise: Promise<void> | null = null;
const iceRestartInFlight: Set<string> = new Set();

// Per-peer cooldown to prevent rapid ICE restart loops (exponential backoff)
const lastIceRestartTime: Map<string, number> = new Map();
const iceRestartAttempts: Map<string, number> = new Map();
const ICE_RESTART_BASE_COOLDOWN = 30_000; // 30s base cooldown
const ICE_RESTART_MAX_COOLDOWN = 120_000; // 2 min max cooldown
const MAX_ICE_RESTARTS = 5;

// Timestamp of the last joinVoice or rejoin — the input device effect skips
// re-acquiring a stream if we joined within the last 2 seconds to avoid a
// redundant replaceTrack during the critical initial negotiation window.
let lastVoiceJoinTime = 0;
const DEVICE_EFFECT_SKIP_WINDOW_MS = 2000;

// Flag to buffer UserJoinedVoice events while waiting for initial VoiceChannelUsers
let waitingForInitialParticipants = false;
const INITIAL_PARTICIPANTS_TIMEOUT_MS = 5000;
let initialParticipantsTimeout: ReturnType<typeof setTimeout> | null = null;
// Buffered UserJoinedVoice events (userId -> displayName) while initial participant list is pending
const bufferedUserJoinedVoiceEvents: Map<string, string> = new Map();
// Flag indicating SignalR reconnected while tab was hidden and voice must be rejoined on visibility
let pendingVisibilityRejoin = false;
// Flag set when the server reports relay users in the channel during join
let channelRelayDetected = false;
// Guard to prevent concurrent visibility-triggered rejoins
let rejoinInProgress = false;
// Flag set when user intentionally leaves voice — prevents auto-rejoin
let intentionalLeave = false;
// Timestamp of last successful rejoin — prevents rapid successive rejoins
let lastRejoinTime = 0;
const REJOIN_COOLDOWN_MS = 5000;

// Monotonically-increasing session ID — incremented on cleanupAll() so that
// any async work enqueued before cleanup can detect the session ended and bail.
let voiceSessionId = 0;

// ──────────────────────────────────────────────────────────────────────────────
// SFU fallback detection
// ──────────────────────────────────────────────────────────────────────────────
const p2pFailedPeers = new Set<string>();
const P2P_FAILURE_THRESHOLD = 1; // Fall back after first ICE failure

function shouldFallbackToSFU(): boolean {
  const voiceState = useVoiceStore.getState();
  if (voiceState.connectionMode === 'sfu' || voiceState.connectionMode === 'attempting-sfu') return false;
  if (voiceState.forceSfuMode) return true;
  // Use cumulative failure count (not unique peer count) so a single peer
  // failing twice (e.g. after ICE restart) still triggers the fallback.
  if (voiceState.p2pFailureCount >= P2P_FAILURE_THRESHOLD) return true;
  if (voiceState.participants.size > 8) return true;
  return false;
}

// Tear down P2P connections without leaving the voice channel or setting
// connectionState to "disconnected". Used during P2P → SFU transition so the
// participant list and SignalR group membership stay intact.
function cleanupP2PConnections() {
  voiceSessionId++;
  if (noiseSuppressor) {
    noiseSuppressor.destroy();
    noiseSuppressor = null;
  }
  peerStream = null;
  peers.forEach((pc) => pc.close());
  peers.clear();
  audioElements.forEach((audio) => {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  });
  audioElements.clear();
  screenAudioElements.forEach((audio) => {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  });
  screenAudioElements.clear();
  cleanupAnalysers();
  peerStreams.clear();
  gainNodes.forEach((entry) => entry.source.disconnect());
  gainNodes.clear();
  screenVideoStreams.clear();
  cameraVideoStreams.clear();
  pendingCandidates.clear();
  gatheredCandidates.clear();
  clearAllPendingTrackState();
  screenTrackSenders.clear();
  cameraTrackSenders.clear();
  signalingQueues.clear();
  lastIceRestartTime.clear();
  iceRestartAttempts.clear();
  prevBytesReceived.clear();
  zombieStaleCount.clear();
  lastZombieRecreate.clear();
  iceReconnectTimers.forEach((t) => clearTimeout(t));
  iceReconnectTimers.clear();
  iceNewStateTimers.forEach((t) => clearTimeout(t));
  iceNewStateTimers.clear();
  cancelInitialParticipantWait();
  stopStatsCollection();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
}

async function fallbackToSFU(reason: string): Promise<void> {
  const voiceState = useVoiceStore.getState();
  const channelId = voiceState.currentChannelId;
  if (!channelId) return;

  console.warn(`[fallback] Switching to SFU mode: ${reason}`);
  voiceState.setFallbackReason(reason);
  voiceState.setConnectionMode('attempting-sfu');

  try {
    // Tear down P2P connections but stay in the SignalR voice group.
    // This preserves the participant list and avoids leave/join sound
    // spam for other users in the channel.
    cleanupP2PConnections();

    // Connect via LiveKit SFU (sets mode to 'sfu' on success)
    await connectToLiveKit(channelId);

    // Notify other peers in the channel that relay is active
    const conn = getConnection();
    conn.invoke('NotifyRelayMode', channelId).catch(() => {});

    useToastStore.getState().addToast('Switched to relay mode', 'info');

    p2pFailedPeers.clear();
    voiceState.resetP2PFailures();
  } catch (err) {
    console.error('[fallback] SFU connection failed:', err);
    voiceState.setConnectionState('disconnected');
    voiceState.setConnectionMode('p2p');
    useToastStore.getState().addToast('Connection failed. Please try again.', 'error');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Video quality presets
// ──────────────────────────────────────────────────────────────────────────────
const CAMERA_QUALITY_CONSTRAINTS: Record<CameraQuality, { width: number; height: number; frameRate: number; maxBitrate: number }> = {
  low:       { width: 640,  height: 360,  frameRate: 15, maxBitrate: 400_000 },
  medium:    { width: 640,  height: 480,  frameRate: 30, maxBitrate: 800_000 },
  high:      { width: 1280, height: 720,  frameRate: 30, maxBitrate: 1_500_000 },
  'very-high': { width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_000_000 },
};

const SCREEN_SHARE_QUALITY_CONSTRAINTS: Record<ScreenShareQuality, { frameRate: number; maxBitrate: number }> = {
  'quality':     { frameRate: 5,  maxBitrate: 1_500_000 },
  'balanced':    { frameRate: 15, maxBitrate: 2_500_000 },
  'motion':      { frameRate: 30, maxBitrate: 4_000_000 },
  'high-motion': { frameRate: 60, maxBitrate: 6_000_000 },
};

async function applyBitrateToSender(sender: RTCRtpSender, maxBitrate: number) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = maxBitrate;
  await sender.setParameters(params);
}

// ──────────────────────────────────────────────────────────────────────────────
// Module-level PTT listener management.
// Uses a Zustand subscription so the lifecycle is independent of which React
// components happen to mount/unmount `useWebRTC()`.
// ──────────────────────────────────────────────────────────────────────────────
let pttCleanup: (() => void) | null = null;

function teardownPttListeners() {
  if (pttCleanup) {
    pttCleanup();
    pttCleanup = null;
  }
}

function setupPttListeners(pttKey: string) {
  teardownPttListeners();
  const { setPttActive } = useVoiceStore.getState();
  const isElectronEnv = typeof window !== "undefined" && window.electron;

  if (isElectronEnv) {
    window.electron!.registerPttKey(pttKey);
    const unsubPress = window.electron!.onGlobalPttPress(() => setPttActive(true));
    const unsubRelease = window.electron!.onGlobalPttRelease(() => setPttActive(false));
    pttCleanup = () => {
      unsubPress();
      unsubRelease();
      window.electron!.unregisterPttKey();
      setPttActive(false);
    };
  } else {
    const isMouseBind = pttKey.startsWith("Mouse");
    const mouseButton = isMouseBind ? parseInt(pttKey.slice(5), 10) : -1;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!isMouseBind && e.key === pttKey) setPttActive(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isMouseBind && e.key === pttKey) setPttActive(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (isMouseBind && e.button === mouseButton) setPttActive(true);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (isMouseBind && e.button === mouseButton) setPttActive(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    pttCleanup = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      setPttActive(false);
    };
  }
}

// Subscribe to the store slices that determine whether PTT listeners should be
// active and which key to bind. The subscription fires synchronously whenever
// any of the relevant values change.
{
  let prevChannelId = useVoiceStore.getState().currentChannelId;
  let prevMode = useVoiceStore.getState().voiceMode;
  let prevKey = useVoiceStore.getState().pttKey;

  const syncPtt = () => {
    const shouldBeActive = !!prevChannelId && prevMode === "push-to-talk";
    if (shouldBeActive) {
      setupPttListeners(prevKey);
    } else {
      teardownPttListeners();
    }
  };

  useVoiceStore.subscribe((state) => {
    const { currentChannelId, voiceMode, pttKey } = state;
    if (currentChannelId === prevChannelId && voiceMode === prevMode && pttKey === prevKey) return;
    prevChannelId = currentChannelId;
    prevMode = voiceMode;
    prevKey = pttKey;
    syncPtt();
  });
}

// All state is module-level so it's shared across hook instances
const peers: Map<string, RTCPeerConnection> = new Map();
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
const audioElements: Map<string, HTMLAudioElement> = new Map();
const screenAudioElements: Map<string, HTMLAudioElement> = new Map();
const screenVideoStreams: Map<string, MediaStream> = new Map();
const pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
let listenersRegisteredForConnection: HubConnection | null = null;
let currentOutputDeviceId: string = "default";

// Per-viewer screen track senders: viewerUserId -> RTCRtpSender[]
const screenTrackSenders: Map<string, RTCRtpSender[]> = new Map();

// Noise suppression state
let noiseSuppressor: NoiseSuppressorType | null = null;
let peerStream: MediaStream | null = null; // processed stream sent to peers (or localStream if suppressor inactive)

// Camera state
let cameraStream: MediaStream | null = null;
const cameraVideoStreams: Map<string, MediaStream> = new Map(); // peerId → remote camera stream
const cameraTrackSenders: Map<string, RTCRtpSender> = new Map(); // peerId → sender
type TrackInfoType = "camera" | "screen" | "screen-audio";
interface PendingRemoteTrack {
  track: MediaStreamTrack;
  stream: MediaStream;
  timeout: ReturnType<typeof setTimeout>;
}
const TRACK_INFO_WAIT_TIMEOUT_MS = 400;
// peerId -> trackId -> track type
const pendingTrackInfoById: Map<string, Map<string, TrackInfoType>> = new Map();
// Backward-compat queue for track-info messages without trackId
const pendingLegacyTrackTypes: Map<string, TrackInfoType[]> = new Map();
// peerId -> trackId -> pending track waiting for matching track-info
const pendingRemoteTracks: Map<string, Map<string, PendingRemoteTrack>> = new Map();

// Per-peer GainNode chain for volume boost (>100% only)
const gainNodes: Map<string, { source: MediaStreamAudioSourceNode; gain: GainNode; dest: MediaStreamAudioDestinationNode | null }> = new Map();
// Per-peer raw stream reference for volume changes that need to set up/teardown GainNode boost
const peerStreams: Map<string, MediaStream> = new Map();

// Connection stats
export interface ConnectionStats {
  roundTripTime: number | null;
  packetLoss: number | null;
  jitter: number | null;
}

export interface CandidateStats {
  hostCount: number;
  srflxCount: number;
  relayCount: number;
  protocol: 'udp' | 'tcp' | 'mixed' | 'unknown';
}

export interface PeerDebugInfo {
  userId: string;
  iceState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  connectionType: 'direct' | 'relay' | 'unknown';
  roundTripTime: number | null;
  packetLoss: number | null;
  jitter: number | null;
  bytesReceived: number;
  bytesSent: number;
  localCandidateType?: string;
  remoteCandidateType?: string;
  transportProtocol?: string;
  consent?: 'granted' | 'checking' | 'unknown';
}

export interface DetailedConnectionStats extends ConnectionStats {
  connectionType: 'direct' | 'relay' | 'mixed' | 'unknown';
  iceConnectionState: string;
  activePeerCount: number;
  perPeerStats: PeerDebugInfo[];
  natType: 'open' | 'cone' | 'symmetric' | 'unknown';
  localCandidates: CandidateStats;
  iceGatheringComplete: boolean;
}

let cachedStats: ConnectionStats = { roundTripTime: null, packetLoss: null, jitter: null };
let cachedDetailedStats: DetailedConnectionStats | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;

// Track gathered ICE candidates for NAT detection
interface CandidateInfo {
  type: string;
  protocol: string;
  hasRelatedAddress: boolean;
}
const gatheredCandidates: Map<string, CandidateInfo[]> = new Map(); // peerId → candidates
let localCandidateSummary: CandidateStats = { hostCount: 0, srflxCount: 0, relayCount: 0, protocol: 'unknown' };

// Zombie track detection: after ICE restart, monitor bytesReceived to detect
// tracks that appear live but stop delivering audio data.
const prevBytesReceived: Map<string, number> = new Map(); // peerId → last bytesReceived
const zombieStaleCount: Map<string, number> = new Map(); // peerId → consecutive stale intervals
const lastZombieRecreate: Map<string, number> = new Map(); // peerId → timestamp of last zombie recreation
const ZOMBIE_STALE_THRESHOLD = 3; // 3 consecutive stale intervals (9s at 3s stats interval)
const ZOMBIE_COOLDOWN_MS = 30_000; // don't zombie-recreate same peer within 30s

export function getConnectionStats(): ConnectionStats {
  return cachedStats;
}

export function getDetailedConnectionStats(): DetailedConnectionStats | null {
  return cachedDetailedStats;
}

/**
 * Detect NAT type based on gathered ICE candidates pattern.
 * - Open: Host candidates work directly
 * - Cone: Consistent srflx mapping (same public address for different destinations)
 * - Symmetric: Different srflx for each destination (worst for P2P)
 */
function detectNatType(): 'open' | 'cone' | 'symmetric' | 'unknown' {
  const allCandidates = Array.from(gatheredCandidates.values()).flat();
  if (allCandidates.length === 0) return 'unknown';

  const hasHost = allCandidates.some(c => c.type === 'host');
  const hasSrflx = allCandidates.some(c => c.type === 'srflx');
  const hasRelay = allCandidates.some(c => c.type === 'relay');

  // If we only have host candidates and they work, likely open internet
  if (hasHost && !hasSrflx && !hasRelay) {
    return 'open';
  }

  // If we have srflx candidates, we're behind NAT
  if (hasSrflx) {
    // Cone NAT is most common - true symmetric detection would require
    // comparing srflx candidates across multiple peers to see if the
    // public address changes per destination
    return 'cone';
  }

  return 'unknown';
}

/**
 * Compute summary of local ICE candidates gathered across all peers.
 */
function computeLocalCandidateSummary(): CandidateStats {
  const allCandidates = Array.from(gatheredCandidates.values()).flat();
  const hostCount = allCandidates.filter(c => c.type === 'host').length;
  const srflxCount = allCandidates.filter(c => c.type === 'srflx').length;
  const relayCount = allCandidates.filter(c => c.type === 'relay').length;

  const protocols = new Set(allCandidates.map(c => c.protocol));
  let protocol: 'udp' | 'tcp' | 'mixed' | 'unknown' = 'unknown';
  if (protocols.size === 0) {
    protocol = 'unknown';
  } else if (protocols.size === 1) {
    const p = Array.from(protocols)[0];
    protocol = (p === 'udp' || p === 'tcp') ? p : 'unknown';
  } else {
    protocol = 'mixed';
  }

  return { hostCount, srflxCount, relayCount, protocol };
}

function startStatsCollection() {
  if (statsInterval) return;
  statsInterval = setInterval(async () => {
    let totalRtt = 0, rttCount = 0;
    let totalLoss = 0, lossCount = 0;
    let totalJitter = 0, jitterCount = 0;

    const perPeerData: Map<string, PeerDebugInfo> = new Map();
    const connectionTypes: Set<string> = new Set();

    for (const [peerId, pc] of peers) {
      try {
        const stats = await pc.getStats();
        let peerBytesReceived = 0;
        let peerBytesSent = 0;
        let peerRtt: number | null = null;
        let peerLoss: number | null = null;
        let peerJitter: number | null = null;
        let peerConnectionType: 'direct' | 'relay' | 'unknown' = 'unknown';
        let localCandidateType: string | undefined;
        let remoteCandidateType: string | undefined;
        let transportProtocol: string | undefined;
        let consent: 'granted' | 'checking' | 'unknown' = 'unknown';

        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded") {
            if (report.currentRoundTripTime != null) {
              const rttMs = report.currentRoundTripTime * 1000;
              peerRtt = rttMs;
              totalRtt += rttMs;
              rttCount++;
            }

            // Determine connection type from candidate types
            const localCandidateId = report.localCandidateId;
            const remoteCandidateId = report.remoteCandidateId;
            const localCandidate = localCandidateId ? stats.get(localCandidateId) : null;
            const remoteCandidate = remoteCandidateId ? stats.get(remoteCandidateId) : null;

            // Store candidate types for debugging (no IP addresses)
            localCandidateType = localCandidate?.candidateType;
            remoteCandidateType = remoteCandidate?.candidateType;
            transportProtocol = localCandidate?.protocol;

            // Determine connection type category
            if (localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay') {
              peerConnectionType = 'relay';
            } else if (localCandidate?.candidateType === 'host' && remoteCandidate?.candidateType === 'host') {
              peerConnectionType = 'direct';
            } else if (localCandidate?.candidateType === 'srflx' || remoteCandidate?.candidateType === 'srflx') {
              peerConnectionType = 'direct'; // STUN-assisted is still P2P
            }
            connectionTypes.add(peerConnectionType);

            // Check consent status for connectivity
            if (report.consentRequestsSent != null) {
              consent = report.responsesReceived > 0 ? 'granted' : 'checking';
            }
          }

          if (report.type === "inbound-rtp" && report.kind === "audio") {
            if (report.packetsLost != null && report.packetsReceived != null) {
              const total = report.packetsLost + report.packetsReceived;
              if (total > 0) {
                const lossPercent = (report.packetsLost / total) * 100;
                peerLoss = lossPercent;
                totalLoss += lossPercent;
                lossCount++;
              }
            }
            if (report.jitter != null) {
              const jitterMs = report.jitter * 1000;
              peerJitter = jitterMs;
              totalJitter += jitterMs;
              jitterCount++;
            }
            if (report.bytesReceived != null) {
              peerBytesReceived += report.bytesReceived;
            }
          }

          if (report.type === "outbound-rtp" && report.kind === "audio") {
            if (report.bytesSent != null) {
              peerBytesSent += report.bytesSent;
            }
          }
        });

        // Store per-peer debug info
        perPeerData.set(peerId, {
          userId: peerId,
          iceState: pc.iceConnectionState,
          signalingState: pc.signalingState,
          connectionType: peerConnectionType,
          roundTripTime: peerRtt,
          packetLoss: peerLoss,
          jitter: peerJitter,
          bytesReceived: peerBytesReceived,
          bytesSent: peerBytesSent,
          localCandidateType,
          remoteCandidateType,
          transportProtocol,
          consent,
        });

        // Zombie track detection: if ICE is connected but bytesReceived isn't
        // increasing, the remote audio sender is likely in a corrupted state
        // (e.g. after ICE restart). Recreate the peer to force a fresh connection.
        const iceState = pc.iceConnectionState;
        const prev = prevBytesReceived.get(peerId);
        prevBytesReceived.set(peerId, peerBytesReceived);

        if ((iceState === "connected" || iceState === "completed") && prev != null && peerBytesReceived === prev) {
          // Check if remote user is muted — no data is expected, so skip zombie detection
          const zombieChannelId = useVoiceStore.getState().currentChannelId;
          if (zombieChannelId) {
            const channelUsers = useServerStore.getState().voiceChannelUsers.get(zombieChannelId);
            const peerVoiceState = channelUsers?.get(peerId);
            if (peerVoiceState && (peerVoiceState.isMuted || peerVoiceState.isDeafened || peerVoiceState.isServerMuted || peerVoiceState.isServerDeafened)) {
              // Remote user is muted/deafened — bytesReceived stall is expected, not a zombie
              zombieStaleCount.delete(peerId);
              continue;
            }
          }

          const count = (zombieStaleCount.get(peerId) ?? 0) + 1;
          zombieStaleCount.set(peerId, count);
          if (count >= ZOMBIE_STALE_THRESHOLD) {
            const lastRecreate = lastZombieRecreate.get(peerId) ?? 0;
            if (Date.now() - lastRecreate < ZOMBIE_COOLDOWN_MS) {
              console.warn(`[zombie] Skipping recreation for ${peerId}, cooldown active (${Math.round((ZOMBIE_COOLDOWN_MS - (Date.now() - lastRecreate)) / 1000)}s remaining)`);
              zombieStaleCount.delete(peerId);
            } else {
              console.warn(`[zombie] Audio track for ${peerId} has not received data for ${count * 3}s after ICE connected, recreating peer | bytesReceived=${peerBytesReceived} bytesSent=${peerBytesSent} connectionType=${peerConnectionType} local=${localCandidateType} remote=${remoteCandidateType} proto=${transportProtocol}`);
              zombieStaleCount.delete(peerId);
              prevBytesReceived.delete(peerId);
              lastZombieRecreate.set(peerId, Date.now());
              void recreatePeer(peerId).catch((err) => {
                console.error(`[zombie] Peer recreation failed for ${peerId}:`, err);
              });
            }
          }
        } else {
          zombieStaleCount.delete(peerId);
          // Log recovery after a zombie recreation so we can confirm the fix worked
          if (lastZombieRecreate.has(peerId) && prev != null && peerBytesReceived > prev) {
            const elapsed = Math.round((Date.now() - lastZombieRecreate.get(peerId)!) / 1000);
            console.log(`[zombie] Audio recovered for ${peerId} — ${peerBytesReceived - prev} new bytes received ${elapsed}s after recreation`);
            lastZombieRecreate.delete(peerId);
          }
        }
      } catch {
        // peer may have closed
      }
    }

    cachedStats = {
      roundTripTime: rttCount > 0 ? totalRtt / rttCount : null,
      packetLoss: lossCount > 0 ? totalLoss / lossCount : null,
      jitter: jitterCount > 0 ? totalJitter / jitterCount : null,
    };

    // Determine overall connection type
    let overallConnectionType: 'direct' | 'relay' | 'mixed' | 'unknown' = 'unknown';
    if (connectionTypes.size === 0) {
      overallConnectionType = 'unknown';
    } else if (connectionTypes.size === 1) {
      overallConnectionType = Array.from(connectionTypes)[0] as 'direct' | 'relay';
    } else {
      overallConnectionType = 'mixed';
    }

    // Compute NAT type and candidate summary
    const natType = detectNatType();
    localCandidateSummary = computeLocalCandidateSummary();

    // Check if ICE gathering is complete (all peers have gathered)
    const iceGatheringComplete = Array.from(peers.values()).every(
      pc => pc.iceGatheringState === 'complete'
    );

    // Store detailed stats
    cachedDetailedStats = {
      ...cachedStats,
      connectionType: overallConnectionType,
      iceConnectionState: peers.size > 0 ? Array.from(peers.values())[0].iceConnectionState : 'new',
      activePeerCount: peers.size,
      perPeerStats: Array.from(perPeerData.values()),
      natType,
      localCandidates: localCandidateSummary,
      iceGatheringComplete,
    };
  }, 3000);
}

function stopStatsCollection() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  cachedStats = { roundTripTime: null, packetLoss: null, jitter: null };
  cachedDetailedStats = null;
}

// ICE reconnection timers per peer
const iceReconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
// Timers for peers stuck at ICE "new" state (offer sent but never answered)
const iceNewStateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const ICE_NEW_STATE_TIMEOUT_MS = 10_000;

/**
 * Determine the established local DTLS role from a peer connection.
 * Returns "active" | "passive" | null (null if no established session).
 */
function getEstablishedDtlsRole(pc: RTCPeerConnection): string | null {
  const prevLocal = pc.currentLocalDescription;
  if (!prevLocal) return null;

  const localSetupMatch = prevLocal.sdp.match(/a=setup:(\w+)/);
  if (!localSetupMatch) return null;

  const role = localSetupMatch[1];
  // actpass means we were the offerer — actual role was determined by the remote answer.
  // Check currentRemoteDescription to find out what role we ended up with.
  if (role === "actpass") {
    const prevRemote = pc.currentRemoteDescription;
    if (!prevRemote) return null;
    const remoteSetupMatch = prevRemote.sdp.match(/a=setup:(\w+)/);
    if (!remoteSetupMatch) return null;
    // Remote chose active → we are passive (server). Remote chose passive → we are active (client).
    return remoteSetupMatch[1] === "active" ? "passive" : "active";
  }
  return role; // "active" or "passive"
}

/**
 * Fix DTLS role in a remote answer SDP for renegotiation on existing connections.
 * Chrome throws "Failed to set SSL role for the transport" when the answer's
 * a=setup: line conflicts with the established DTLS transport role — this
 * happens when offer direction flips (the original answerer becomes the offerer).
 */
function fixDtlsRoleInAnswerSdp(pc: RTCPeerConnection, answerSdp: string): string {
  const ourRole = getEstablishedDtlsRole(pc);
  if (!ourRole) return answerSdp;

  // Remote's role must be the opposite of ours
  const requiredRemoteRole = ourRole === "passive" ? "active" : "passive";
  return answerSdp.replace(/a=setup:\w+/g, `a=setup:${requiredRemoteRole}`);
}

/**
 * Fix DTLS role in a locally-created answer SDP before setLocalDescription.
 * createAnswer() defaults to a=setup:passive, but if our established DTLS role
 * is "active" (we were originally the offerer/client), setLocalDescription will
 * fail with "Failed to set SSL role for the transport".
 */
function fixDtlsRoleInLocalAnswerSdp(pc: RTCPeerConnection, answerSdp: string): string {
  const ourRole = getEstablishedDtlsRole(pc);
  if (!ourRole) return answerSdp;

  return answerSdp.replace(/a=setup:\w+/g, `a=setup:${ourRole}`);
}

// Signaling queue — serializes WebRTC signaling operations per peer to prevent races
const signalingQueues: Map<string, Promise<void>> = new Map();

function enqueueSignaling(
  peerId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const sessionAtEnqueue = voiceSessionId;
  const prev = signalingQueues.get(peerId) ?? Promise.resolve();
  const guarded = async () => {
    if (voiceSessionId !== sessionAtEnqueue) return; // session ended, abort
    await fn();
  };
  const next = prev.then(guarded, guarded).catch((err) => {
    console.error(`Signaling error for ${peerId}:`, err);
  });
  signalingQueues.set(peerId, next);
  return next;
}

// Audio analysis state
let audioContext: AudioContext | null = null;
const analysers: Map<
  string,
  {
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    analysisStream: MediaStream;
  }
> = new Map();
let analyserInterval: ReturnType<typeof setInterval> | null = null;
const SPEAKING_THRESHOLD = 0.015;
const INPUT_THRESHOLD_MIN = 0.005;
const INPUT_THRESHOLD_MAX = 0.05;
// Hysteresis for voice-activity gate: once mic opens, keep it open for this many ms
// after RMS drops below threshold to avoid rapid toggling during natural speech pauses
const VA_HOLD_OPEN_MS = 200;
let vaLastAboveThresholdAt = 0;

// Keep-alive interval to prevent browser from suspending audio
let audioKeepAliveInterval: ReturnType<typeof setInterval> | null = null;

// Track if device resolution is causing issues
let deviceResolutionFailed = false;
// Firefox interoperability: toggling track.enabled for voice-activity can
// stick remote audio as muted in Firefox -> Chromium sessions. Keep sender
// enabled on Firefox and gate only by mute/PTT state.
const SHOULD_GATE_VA_WITH_TRACK_ENABLED =
  typeof navigator === "undefined" ||
  !navigator.userAgent.toLowerCase().includes("firefox");

function ensureAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
    console.log(`[AudioCtx] Created new AudioContext (state: ${audioContext.state}, sampleRate: ${audioContext.sampleRate})`);
  }
  // Resume if suspended (can happen when tab is backgrounded)
  if (audioContext.state === "suspended") {
    console.log("[AudioCtx] AudioContext is suspended, attempting resume...");
    audioContext.resume().then(() => {
      console.log(`[AudioCtx] Resume succeeded (state: ${audioContext?.state})`);
    }).catch((err) => {
      console.warn("[AudioCtx] Resume failed:", err);
    });
  }
  return audioContext;
}

/** Returns the stream to add to peer connections — processed if suppressor is active, raw otherwise. */
function getPeerStream(): MediaStream | null {
  return peerStream ?? localStream;
}

/**
 * Create and initialize a NoiseSuppressor for the given raw stream.
 * Sets module-level `noiseSuppressor` and `peerStream`.
 * On failure, peerStream falls back to localStream.
 */
async function applySuppressor(rawStream: MediaStream): Promise<void> {
  const vs = useVoiceStore.getState();
  if (!vs.noiseSuppression) {
    peerStream = rawStream;
    return;
  }
  const suppressor = await createNoiseSuppressor();
  const ctx = ensureAudioContext();
  const processed = await suppressor.initialize(rawStream, ctx);
  if (processed) {
    noiseSuppressor = suppressor;
    peerStream = processed;
  } else {
    // Fallback — suppressor failed, use raw stream
    peerStream = rawStream;
  }
}

function canSetSinkId(audio: HTMLAudioElement): audio is HTMLAudioElement & {
  setSinkId: (deviceId: string) => Promise<void>;
} {
  return (
    typeof (
      audio as HTMLAudioElement & {
        setSinkId?: (deviceId: string) => Promise<void>;
      }
    ).setSinkId === "function"
  );
}

async function validateOutputDevice(deviceId: string): Promise<boolean> {
  // Test if a device ID is valid by attempting to set it on a temporary audio element
  if (!deviceId || deviceId === "") return false;

  try {
    const testAudio = new Audio();
    if (!canSetSinkId(testAudio)) return true; // Can't validate, assume valid

    await testAudio.setSinkId(deviceId);
    return true;
  } catch (err) {
    console.warn(`Device ${deviceId} failed validation:`, err);
    return false;
  }
}

async function resolveDefaultOutputDevice(): Promise<string> {
  // When "default" is selected, resolve it to the actual device ID
  // This prevents audio from cutting out when window loses focus
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");

    if (outputs.length === 0) {
      console.warn("No output devices found");
      return "default";
    }

    // Strategy 1: Find device with same groupId as "default"
    const defaultOutput = outputs.find((d) => d.deviceId === "default");
    if (defaultOutput && defaultOutput.groupId) {
      const actualDevice = outputs.find(
        (d) =>
          d.deviceId !== "default" &&
          d.deviceId !== "" &&
          d.groupId === defaultOutput.groupId,
      );
      if (actualDevice?.deviceId) {
        const isValid = await validateOutputDevice(actualDevice.deviceId);
        if (isValid) {
          console.log(
            `Resolved default output to: ${actualDevice.label || actualDevice.deviceId}`,
          );
          return actualDevice.deviceId;
        }
      }
    }

    // Strategy 2: Use first non-default device with a label
    const firstLabeledDevice = outputs.find(
      (d) => d.deviceId !== "default" && d.deviceId !== "" && d.label,
    );
    if (firstLabeledDevice?.deviceId) {
      const isValid = await validateOutputDevice(firstLabeledDevice.deviceId);
      if (isValid) {
        console.log(
          `Using first labeled output: ${firstLabeledDevice.label || firstLabeledDevice.deviceId}`,
        );
        return firstLabeledDevice.deviceId;
      }
    }

    // Strategy 3: Use first non-default device
    const firstDevice = outputs.find(
      (d) => d.deviceId !== "default" && d.deviceId !== "",
    );
    if (firstDevice?.deviceId) {
      const isValid = await validateOutputDevice(firstDevice.deviceId);
      if (isValid) {
        console.log(`Using first output device: ${firstDevice.deviceId}`);
        return firstDevice.deviceId;
      }
    }
  } catch (err) {
    console.warn("Failed to resolve default output device:", err);
  }

  // Fallback: keep using "default" (original behavior)
  console.log("Keeping default output device");
  return "default";
}

async function resolveDefaultInputDevice(): Promise<string> {
  // When "default" is selected, resolve it to the actual device ID
  // This prevents microphone from cutting out when window loses focus
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");

    if (inputs.length === 0) {
      console.warn("No input devices found");
      return "default";
    }

    // Strategy 1: Find device with same groupId as "default"
    const defaultInput = inputs.find((d) => d.deviceId === "default");
    if (defaultInput && defaultInput.groupId) {
      const actualDevice = inputs.find(
        (d) =>
          d.deviceId !== "default" &&
          d.deviceId !== "" &&
          d.groupId === defaultInput.groupId,
      );
      if (actualDevice?.deviceId) {
        console.log(
          `Resolved default input to: ${actualDevice.label || actualDevice.deviceId}`,
        );
        return actualDevice.deviceId;
      }
    }

    // Strategy 2: Use first non-default device with a label
    const firstLabeledDevice = inputs.find(
      (d) => d.deviceId !== "default" && d.deviceId !== "" && d.label,
    );
    if (firstLabeledDevice?.deviceId) {
      console.log(
        `Using first labeled input: ${firstLabeledDevice.label || firstLabeledDevice.deviceId}`,
      );
      return firstLabeledDevice.deviceId;
    }

    // Strategy 3: Use first non-default device
    const firstDevice = inputs.find(
      (d) => d.deviceId !== "default" && d.deviceId !== "",
    );
    if (firstDevice?.deviceId) {
      console.log(`Using first input device: ${firstDevice.deviceId}`);
      return firstDevice.deviceId;
    }
  } catch (err) {
    console.warn("Failed to resolve default input device:", err);
  }

  // Fallback: keep using "default" (original behavior)
  console.log("Keeping default input device");
  return "default";
}

function applyOutputDevice(audio: HTMLAudioElement, deviceId: string) {
  if (!canSetSinkId(audio)) return;

  const applyDevice = async () => {
    const target = deviceId || "default";
    let resolvedTarget = target;

    // Resolve "default" to actual device ID to prevent audio cutouts on window blur
    // Skip resolution if it previously failed
    if (target === "default" && !deviceResolutionFailed) {
      resolvedTarget = await resolveDefaultOutputDevice();
    }

    try {
      await audio.setSinkId(resolvedTarget);
      console.log(`Successfully set output device: ${resolvedTarget}`);
    } catch (err) {
      console.warn(
        `Failed to set audio output device to "${resolvedTarget}":`,
        err,
      );

      // If the resolved device failed, try falling back to "default"
      if (resolvedTarget !== "default") {
        try {
          await audio.setSinkId("default");
          console.log("Fell back to default output device");
          // Mark that resolution is causing issues
          if (target === "default") {
            deviceResolutionFailed = true;
            console.warn(
              "Device resolution failed, will use 'default' directly from now on",
            );
          }
        } catch (fallbackErr) {
          console.error("Even default output device failed:", fallbackErr);
        }
      }
    }
  };

  applyDevice();
}

export async function attemptAudioUnlock() {
  console.log(`[audioUnlock] Attempting audio unlock (AudioCtx state=${audioContext?.state ?? "null"}, audioElements=${audioElements.size}, screenAudioElements=${screenAudioElements.size})`);
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume();
      console.log(`[audioUnlock] AudioContext resumed successfully (state=${audioContext.state})`);
    } catch (err) {
      console.warn("[audioUnlock] Failed to resume audio context:", err);
    }
  }

  const store = useVoiceStore.getState();
  let failed = false;
  const plays: Promise<void>[] = [];
  audioElements.forEach((audio) => {
    if (!audio.srcObject) return;
    plays.push(
      audio.play().catch((err) => {
        console.warn("Audio unlock play failed:", err);
        failed = true;
      }),
    );
  });
  screenAudioElements.forEach((audio) => {
    if (!audio.srcObject) return;
    plays.push(
      audio.play().catch((err) => {
        console.warn("Screen audio unlock play failed:", err);
        failed = true;
      }),
    );
  });
  if (plays.length > 0) {
    await Promise.all(plays);
  }
  store.setNeedsAudioUnlock(failed);
}

function addAnalyser(userId: string, stream: MediaStream) {
  // Remove existing analyser for this user
  removeAnalyser(userId);
  const ctx = ensureAudioContext();
  // Clone the stream so the analyser always receives real audio data,
  // even when track.enabled is toggled off on the original (voice activity mode).
  // Without this, disabling track.enabled causes the analyser to read silence,
  // preventing voice activity detection from ever re-enabling the track.
  const analysisStream = stream.clone();
  // Ensure analyser input is always active even if the source stream was muted
  // when the clone was created (e.g. joining while muted, then unmuting later).
  analysisStream.getAudioTracks().forEach((track) => {
    track.enabled = true;
  });
  const source = ctx.createMediaStreamSource(analysisStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analysers.set(userId, { analyser, source, analysisStream });
  startAnalyserLoop();
}

function removeAnalyser(userId: string) {
  const entry = analysers.get(userId);
  if (entry) {
    entry.source.disconnect();
    entry.analysisStream.getTracks().forEach((t) => t.stop());
    analysers.delete(userId);
  }
  useVoiceStore.getState().setSpeaking(userId, false);
}

function startAnalyserLoop() {
  if (analyserInterval) return;
  const buffer = new Uint8Array(256);
  analyserInterval = setInterval(() => {
    const store = useVoiceStore.getState();
    const currentUserId = useAuthStore.getState().user?.id;
    for (const [userId, { analyser }] of analysers) {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const val = (buffer[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / buffer.length);
      const isLocal = !!currentUserId && userId === currentUserId;
      let speaking = rms > SPEAKING_THRESHOLD;
      if (isLocal) {
        if (store.isMuted) {
          speaking = false;
        } else if (store.voiceMode === "push-to-talk") {
          // In PTT mode, the speaking indicator follows the PTT key state
          // rather than relying on the analyser's cloned stream RMS,
          // which can break in some browsers when track.enabled is toggled.
          speaking = store.isPttActive;
        }
      }
      store.setSpeaking(userId, speaking);

      if (currentUserId && userId === currentUserId) {
        store.setLocalInputLevel(store.isMuted ? 0 : rms);
        if (localStream && store.voiceMode === "voice-activity") {
          const sensitivity = Math.min(1, Math.max(0, store.inputSensitivity));
          const threshold =
            INPUT_THRESHOLD_MAX -
            (INPUT_THRESHOLD_MAX - INPUT_THRESHOLD_MIN) * sensitivity;
          const now = Date.now();
          const aboveThreshold = rms >= threshold;
          if (aboveThreshold) vaLastAboveThresholdAt = now;
          const shouldGateByActivity = SHOULD_GATE_VA_WITH_TRACK_ENABLED;
          // Hold mic open for VA_HOLD_OPEN_MS after last above-threshold sample.
          // On Firefox, avoid toggling track.enabled for VA; keep sender active.
          const enabled =
            !store.isMuted &&
            (!shouldGateByActivity ||
              now - vaLastAboveThresholdAt < VA_HOLD_OPEN_MS);
          localStream.getAudioTracks().forEach((track) => {
            if (track.enabled !== enabled) track.enabled = enabled;
          });
        }
      }
    }
  }, 50);
}

function stopAnalyserLoop() {
  if (analyserInterval) {
    clearInterval(analyserInterval);
    analyserInterval = null;
  }
}

function startAudioKeepAlive() {
  if (audioKeepAliveInterval) return;

  audioKeepAliveInterval = setInterval(() => {
    // Keep audio context running
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch((err) => {
        console.warn("Keep-alive: Failed to resume audio context:", err);
      });
    }

    // Ensure all remote audio elements are playing
    audioElements.forEach((audio) => {
      if (audio.srcObject && audio.paused) {
        audio.play().catch((err) => {
          console.warn("Keep-alive: Failed to resume audio element:", err);
        });
      }
    });
    screenAudioElements.forEach((audio) => {
      if (audio.srcObject && audio.paused) {
        audio.play().catch((err) => {
          console.warn("Keep-alive: Failed to resume screen audio element:", err);
        });
      }
    });
  }, 5000); // Check every 5 seconds
}

function stopAudioKeepAlive() {
  if (audioKeepAliveInterval) {
    clearInterval(audioKeepAliveInterval);
    audioKeepAliveInterval = null;
  }
}

function cleanupAnalysers() {
  stopAnalyserLoop();
  stopAudioKeepAlive();
  const store = useVoiceStore.getState();
  for (const [userId, entry] of analysers) {
    entry.source.disconnect();
    entry.analysisStream.getTracks().forEach((t) => t.stop());
    store.setSpeaking(userId, false);
  }
  analysers.clear();
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
    audioContext = null;
  }
}

// Module-level exports for ScreenShareView to access
export function setScreenAudioVolume(userId: string, volume: number): void {
  if (isInSfuMode()) {
    sfuSetScreenAudioVolume(userId, volume);
  } else {
    const audio = screenAudioElements.get(userId);
    if (audio) {
      audio.volume = volume;
      audio.muted = volume === 0;
    }
  }
}

export function getScreenVideoStream(userId: string): MediaStream | undefined {
  // Check SFU streams first (when in relay mode)
  if (isInSfuMode()) {
    return getSfuScreenStream(userId);
  }
  return screenVideoStreams.get(userId);
}

export function getLocalScreenStream(): MediaStream | null {
  if (isInSfuMode()) {
    return getSfuLocalScreenStream();
  }
  return screenStream;
}

export function getCameraVideoStream(userId: string): MediaStream | undefined {
  // Check SFU streams first (when in relay mode)
  if (isInSfuMode()) {
    return getSfuCameraStream(userId);
  }
  return cameraVideoStreams.get(userId);
}

export function getLocalCameraStream(): MediaStream | null {
  if (isInSfuMode()) {
    return getSfuLocalCameraStream();
  }
  return cameraStream;
}

export function applyUserVolume(peerId: string, volume: number) {
  const audio = audioElements.get(peerId);
  const stream = peerStreams.get(peerId);

  if (volume <= 100) {
    // 0-100%: use audio.volume, tear down any GainNode boost
    const entry = gainNodes.get(peerId);
    if (entry) {
      entry.source.disconnect();
      gainNodes.delete(peerId);
      // Restore raw stream on audio element (GainNode was routing to ctx.destination)
      if (audio && stream) {
        audio.srcObject = stream;
        audio.play().catch(() => {});
      }
    }
    if (audio) audio.volume = volume / 100;
  } else {
    // >100%: route through GainNode → audioContext.destination for boost
    const entry = gainNodes.get(peerId);
    if (entry) {
      // Already boosted, just update gain
      const now = entry.gain.context.currentTime;
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.linearRampToValueAtTime(volume / 100, now + 0.05);
    } else if (stream) {
      // Set up boost chain
      try {
        const ctx = ensureAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = volume / 100;
        source.connect(gain);
        gain.connect(ctx.destination);
        gainNodes.set(peerId, { source, gain, dest: null as any });
        if (audio) audio.volume = 0; // mute element, GainNode handles output
      } catch (err) {
        console.warn("[applyUserVolume] GainNode boost setup failed:", err);
        if (audio) audio.volume = 1.0; // fallback to max non-boosted
      }
    }
  }
}

function buildIceServersFromTurn(creds: {
  urls: string[];
  username: string;
  credential: string;
}): RTCIceServer[] {
  const expandedTurnUrls = Array.from(
    new Set(
      creds.urls.flatMap((rawUrl) => {
        const url = rawUrl.trim();
        if (!url) return [];

        const lower = url.toLowerCase();
        // If backend gives a bare `turn:` URL, add explicit UDP/TCP variants
        // so browsers can fall back when one transport is blocked.
        if (lower.startsWith("turn:") && !lower.includes("transport=")) {
          const sep = url.includes("?") ? "&" : "?";
          return [url, `${url}${sep}transport=udp`, `${url}${sep}transport=tcp`];
        }
        return [url];
      }),
    ),
  );

  return [
    { urls: STUN_URL },
    {
      urls: expandedTurnUrls,
      username: creds.username,
      credential: creds.credential,
    },
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
      console.warn("Failed to fetch TURN credentials:", err);
      turnInitPromise = null;
    }
  })();
  return turnInitPromise;
}

async function applyIceServersToPeers(iceServers: RTCIceServer[]) {
  for (const [peerId, pc] of peers) {
    try {
      if (typeof pc.setConfiguration === "function") {
        pc.setConfiguration({ iceServers });
      }
    } catch (err) {
      console.warn(`Failed to set ICE servers for ${peerId}:`, err);
    }
  }
}

// Nuclear recovery: tear down a broken PC and build a fresh one with a new offer.
// Used when ICE restart fails (e.g. ERROR_CONTENT from SDP state corruption).
async function recreatePeer(peerId: string) {
  // Remember if this peer had screen tracks before closePeer() clears them
  const hadScreenTracks = screenTrackSenders.has(peerId);
  await enqueueSignaling(peerId, async () => {
    console.warn(`[recreate] Recreating peer connection for ${peerId} (hadScreenTracks=${hadScreenTracks}, hasLocalStream=${!!localStream}, hasCamera=${!!cameraStream}, hasScreenStream=${!!screenStream})`);
    // Tell the remote peer to close their existing PC so they create a fresh
    // one when our offer arrives.  Without this, the remote side renegotiates
    // on a stale PC whose DTLS/SRTP pipeline may not restart properly,
    // causing one-directional audio (zombie audio that never resolves).
    const preConn = getConnection();
    await preConn.invoke(
      "SendSignal",
      peerId,
      JSON.stringify({ type: "peer-reset" }),
    );
    const pc = createPeerConnection(peerId, { preserveZombieRecreateCooldown: true });
    const outStream = getPeerStream();
    if (outStream) {
      outStream.getTracks().forEach((track) => pc.addTrack(track, outStream));
    }
    const conn = getConnection();
    if (cameraStream) {
      const camTrack = cameraStream.getVideoTracks()[0];
      if (camTrack) {
        await sendTrackInfo(conn, peerId, "camera", camTrack.id);
        const sender = pc.addTrack(camTrack, cameraStream);
        cameraTrackSenders.set(peerId, sender);
      }
    }
    // Restore screen share tracks for viewers who were watching
    if (hadScreenTracks && screenStream) {
      const videoTrack = screenStream.getVideoTracks()[0];
      if (videoTrack) {
        await sendTrackInfo(conn, peerId, "screen", videoTrack.id);
        const senders: RTCRtpSender[] = [pc.addTrack(videoTrack, screenStream)];
        const audioTrack = screenStream.getAudioTracks()[0];
        if (audioTrack) {
          await sendTrackInfo(conn, peerId, "screen-audio", audioTrack.id);
          senders.push(pc.addTrack(audioTrack, screenStream));
        }
        screenTrackSenders.set(peerId, senders);
      }
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await conn.invoke(
      "SendSignal",
      peerId,
      JSON.stringify({ type: "offer", sdp: offer.sdp }),
    );
  });
}

interface RestartIceOptions {
  force?: boolean;
  reason?: string;
}

async function restartIceForPeer(
  peerId: string,
  options: RestartIceOptions = {},
) {
  const { force = false, reason = "unspecified" } = options;
  if (iceRestartInFlight.has(peerId)) return;

  // Max restart limit — give up after MAX_ICE_RESTARTS consecutive failures
  const attempts = iceRestartAttempts.get(peerId) ?? 0;
  if (attempts >= MAX_ICE_RESTARTS) {
    console.warn(`ICE restart limit reached for ${peerId} (${attempts} attempts), giving up`);
    useToastStore.getState().addToast("Connection to a peer failed after multiple retries.", "error");
    return;
  }

  // Exponential backoff cooldown: min(30s * 2^attempts, 120s)
  const cooldown = Math.min(ICE_RESTART_BASE_COOLDOWN * Math.pow(2, attempts), ICE_RESTART_MAX_COOLDOWN);
  const lastRestart = lastIceRestartTime.get(peerId);
  if (!force && lastRestart && Date.now() - lastRestart < cooldown) {
    console.log(`Skipping ICE restart for ${peerId} (cooldown, ${Math.round((cooldown - (Date.now() - lastRestart)) / 1000)}s remaining, attempt ${attempts})`);
    return;
  }

  iceRestartInFlight.add(peerId);
  try {
    await enqueueSignaling(peerId, async () => {
      // Always use the current PC from the map — the passed-in reference may be stale
      const pc = peers.get(peerId);
      if (!pc || pc.signalingState !== "stable") {
        console.log(
          `[ice] Skipping ICE restart for ${peerId} (reason=${reason}, signalingState=${pc?.signalingState ?? "none"})`,
        );
        return;
      }
      lastIceRestartTime.set(peerId, Date.now());
      iceRestartAttempts.set(peerId, attempts + 1);
      console.log(
        `[ice] Sending ICE restart offer to ${peerId} (reason=${reason}, attempt=${attempts + 1})`,
      );
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      const conn = getConnection();
      await conn.invoke(
        "SendSignal",
        peerId,
        JSON.stringify({ type: "offer", sdp: offer.sdp }),
      );
    });
  } catch (err) {
    console.warn(`ICE restart failed for ${peerId}, recreating peer:`, err);
    await recreatePeer(peerId).catch((e) =>
      console.error(`Peer recreation also failed for ${peerId}:`, e),
    );
  } finally {
    iceRestartInFlight.delete(peerId);
  }
}

async function restartIceForAllPeers() {
  const entries = Array.from(peers.entries());
  for (const [peerId] of entries) {
    await restartIceForPeer(peerId, { reason: "all-peers" });
  }
}

function queueTrackInfo(peerId: string, trackType: TrackInfoType, trackId?: string) {
  if (trackId) {
    if (!pendingTrackInfoById.has(peerId)) {
      pendingTrackInfoById.set(peerId, new Map());
    }
    pendingTrackInfoById.get(peerId)!.set(trackId, trackType);
    return;
  }

  if (!pendingLegacyTrackTypes.has(peerId)) {
    pendingLegacyTrackTypes.set(peerId, []);
  }
  pendingLegacyTrackTypes.get(peerId)!.push(trackType);
}

function consumeTrackInfo(peerId: string, trackId: string, trackKind?: string): TrackInfoType | undefined {
  const byId = pendingTrackInfoById.get(peerId);
  if (byId?.has(trackId)) {
    const trackType = byId.get(trackId)!;
    byId.delete(trackId);
    if (byId.size === 0) pendingTrackInfoById.delete(peerId);
    return trackType;
  }

  // Fallback: trackId didn't match — try to find a pending track-info whose
  // expected media kind matches.  WebRTC can assign different track IDs on the
  // receiver side across renegotiation in some browser combinations.
  if (byId && trackKind) {
    const audioTypes: TrackInfoType[] = ["screen-audio"];
    const videoTypes: TrackInfoType[] = ["screen", "camera"];
    const kindTypes = trackKind === "audio" ? audioTypes : videoTypes;
    for (const [storedId, trackType] of byId) {
      if (kindTypes.includes(trackType)) {
        console.warn(`consumeTrackInfo: trackId mismatch for ${peerId} (expected ${storedId}, got ${trackId}), using kind-based fallback → ${trackType}`);
        byId.delete(storedId);
        if (byId.size === 0) pendingTrackInfoById.delete(peerId);
        return trackType;
      }
    }
  }

  const legacyQueue = pendingLegacyTrackTypes.get(peerId);
  if (legacyQueue?.length) {
    const trackType = legacyQueue.shift();
    if (!legacyQueue.length) pendingLegacyTrackTypes.delete(peerId);
    return trackType;
  }

  return undefined;
}

function clearPendingTrackStateForPeer(peerId: string) {
  pendingTrackInfoById.delete(peerId);
  pendingLegacyTrackTypes.delete(peerId);
  const pendingTracks = pendingRemoteTracks.get(peerId);
  if (pendingTracks) {
    for (const entry of pendingTracks.values()) {
      clearTimeout(entry.timeout);
    }
    pendingRemoteTracks.delete(peerId);
  }
}

function clearAllPendingTrackState() {
  pendingTrackInfoById.clear();
  pendingLegacyTrackTypes.clear();
  pendingRemoteTracks.forEach((tracks) => {
    tracks.forEach((entry) => clearTimeout(entry.timeout));
  });
  pendingRemoteTracks.clear();
}

function inferVideoTrackType(peerId: string): TrackInfoType {
  const store = useVoiceStore.getState();
  if (store.watchingUserId === peerId && !screenVideoStreams.has(peerId)) {
    console.warn(`track-info missing: inferring screen track from ${peerId} (watching)`);
    return "screen";
  }
  if (
    store.activeSharers.has(peerId) &&
    !screenVideoStreams.has(peerId) &&
    cameraVideoStreams.has(peerId)
  ) {
    console.warn(`track-info missing: inferring screen track from ${peerId} (sharer + has camera)`);
    return "screen";
  }

  console.warn(`track-info missing: defaulting to camera track from ${peerId}`);
  return "camera";
}

function inferAudioTrackType(peerId: string): TrackInfoType | undefined {
  // If we already have mic audio playing for this peer, a second audio track
  // is almost certainly screen-audio (tab/system audio from their screen share).
  if (audioElements.has(peerId)) {
    const store = useVoiceStore.getState();
    if (store.watchingUserId === peerId || store.activeSharers.has(peerId)) {
      console.warn(`track-info missing: inferring screen-audio from ${peerId} (already have mic audio)`);
      return "screen-audio";
    }
  }
  // First audio track — treat as mic audio (undefined = mic)
  return undefined;
}

function applyIncomingRemoteTrack(
  peerId: string,
  track: MediaStreamTrack,
  stream: MediaStream,
  trackType?: TrackInfoType,
) {
  console.log(`[applyTrack] peerId=${peerId} kind=${track.kind} trackType=${trackType ?? "undefined"} trackId=${track.id.slice(0,8)} readyState=${track.readyState} | existing: audioEl=${audioElements.has(peerId)} screenAudioEl=${screenAudioElements.has(peerId)} screenVideo=${screenVideoStreams.has(peerId)} cameraVideo=${cameraVideoStreams.has(peerId)}`);
  if (track.kind === "audio") {
    const resolvedAudioType = trackType ?? inferAudioTrackType(peerId);
    console.log(`[applyTrack] Audio resolved type: ${resolvedAudioType ?? "mic"} (explicit trackType=${trackType ?? "none"}, inferred=${resolvedAudioType ?? "mic"})`);
    const isScreenAudio = resolvedAudioType === "screen-audio";
    if (isScreenAudio) {
      let audio = screenAudioElements.get(peerId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute("playsinline", "true");
        const savedSsVol = parseFloat(localStorage.getItem('ss-volume') ?? '1');
        audio.volume = savedSsVol;
        audio.muted = savedSsVol === 0;
        screenAudioElements.set(peerId, audio);
      }
      applyOutputDevice(audio, currentOutputDeviceId);
      audio.srcObject = stream;
      audio.muted = useVoiceStore.getState().isDeafened;
      track.onmute = () => {
        console.log(`[applyTrack] Screen audio track muted for ${peerId} (${track.id.slice(0,8)})`);
      };
      track.onunmute = () => {
        console.log(`[applyTrack] Screen audio track unmuted for ${peerId} (${track.id.slice(0,8)}), retrying play()`);
        audio
          .play()
          .then(() => {
            console.log(`[applyTrack] Screen audio play() on unmute succeeded for ${peerId} (paused=${audio!.paused})`);
            useVoiceStore.getState().setNeedsAudioUnlock(false);
          })
          .catch((err) => {
            console.error(`[applyTrack] Screen audio play() on unmute FAILED for ${peerId}:`, err);
            useVoiceStore.getState().setNeedsAudioUnlock(true);
          });
      };
      console.log(`[applyTrack] Screen audio element for ${peerId}: muted=${audio.muted} volume=${audio.volume}`);
      audio
        .play()
        .then(() => {
          console.log(`[applyTrack] Screen audio play() succeeded for ${peerId}`);
          useVoiceStore.getState().setNeedsAudioUnlock(false);
        })
        .catch((err) => {
          console.error(`[applyTrack] Screen audio play() FAILED for ${peerId}:`, err);
          useVoiceStore.getState().setNeedsAudioUnlock(true);
        });
      return;
    }

    // Mic audio
    let audio = audioElements.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.volume = 1.0;
      audioElements.set(peerId, audio);
    }
    applyOutputDevice(audio, currentOutputDeviceId);

    // Use raw WebRTC stream directly on the audio element for reliable playback.
    // createMediaStreamDestination() streams don't play reliably in all browsers.
    // Volume control uses audio.volume (0-100%) with GainNode boost for >100%.
    audio.srcObject = stream;
    const vol = useVoiceStore.getState().userVolumes.get(peerId) ?? 100;
    if (vol <= 100) {
      audio.volume = vol / 100;
    } else {
      // For >100% boost, route through GainNode → audioContext.destination
      // and mute the direct audio element to avoid double playback
      audio.volume = 1.0;
      try {
        const ctx = ensureAudioContext();
        const setupBoost = () => {
          try {
            const prev = gainNodes.get(peerId);
            if (prev) prev.source.disconnect();
            const source = ctx.createMediaStreamSource(stream);
            const gain = ctx.createGain();
            gain.gain.value = vol / 100;
            source.connect(gain);
            gain.connect(ctx.destination);
            gainNodes.set(peerId, { source, gain, dest: null as any });
            audio.volume = 0; // mute element, GainNode handles output
            console.log(`[applyTrack] GainNode boost active for ${peerId} (gain=${gain.gain.value})`);
          } catch (err) {
            console.warn("[applyTrack] GainNode boost failed, using audio.volume=1:", err);
            audio.volume = 1.0;
          }
        };
        if (ctx.state === "running") {
          setupBoost();
        } else {
          ctx.resume().then(setupBoost).catch(() => {});
        }
      } catch (err) {
        console.warn("[applyTrack] AudioContext error:", err);
        audio.volume = 1.0;
      }
    }
    console.log(`[applyTrack] Raw stream set for ${peerId} (volume=${audio.volume})`);
    peerStreams.set(peerId, stream);

    const isDeafened = useVoiceStore.getState().isDeafened;
    audio.muted = isDeafened;
    track.onmute = () => {
      console.log(`[applyTrack] Mic audio track muted for ${peerId} (${track.id.slice(0,8)})`);
    };
    track.onunmute = () => {
      console.log(`[applyTrack] Mic audio track unmuted for ${peerId} (${track.id.slice(0,8)}), retrying play()`);
      audio
        .play()
        .then(() => {
          console.log(`[applyTrack] Mic audio play() on unmute succeeded for ${peerId} (paused=${audio!.paused})`);
          useVoiceStore.getState().setNeedsAudioUnlock(false);
        })
        .catch((err) => {
          console.error(`[applyTrack] Mic audio play() on unmute FAILED for ${peerId}:`, err);
          useVoiceStore.getState().setNeedsAudioUnlock(true);
        });
    };
    console.log(`[applyTrack] Mic audio element for ${peerId}: muted=${audio.muted} volume=${audio.volume} deafened=${isDeafened} srcObject=${audio.srcObject ? "set" : "null"}`);
    audio
      .play()
      .then(() => {
        console.log(`[applyTrack] Mic audio play() succeeded for ${peerId} (paused=${audio!.paused})`);
        useVoiceStore.getState().setNeedsAudioUnlock(false);
      })
      .catch((err) => {
        console.error(`[applyTrack] Mic audio play() FAILED for ${peerId}:`, err);
        useVoiceStore.getState().setNeedsAudioUnlock(true);
      });
    // Analyser uses original raw stream (unaffected by volume)
    addAnalyser(peerId, stream);
    return;
  }

  if (track.kind === "video") {
    const resolvedType = trackType === "screen" ? "screen" : trackType === "camera" ? "camera" : inferVideoTrackType(peerId);
    if (resolvedType === "screen") {
      screenVideoStreams.set(peerId, stream);
      useVoiceStore.getState().bumpScreenStreamVersion();
    } else {
      cameraVideoStreams.set(peerId, stream);
      useVoiceStore.getState().bumpCameraStreamVersion();
    }
  }
}

function resolvePendingRemoteTrack(peerId: string, trackId: string) {
  const pendingForPeer = pendingRemoteTracks.get(peerId);
  const pendingTrack = pendingForPeer?.get(trackId);
  if (!pendingTrack) return;

  clearTimeout(pendingTrack.timeout);
  pendingForPeer!.delete(trackId);
  if (!pendingForPeer!.size) pendingRemoteTracks.delete(peerId);

  const trackType = consumeTrackInfo(peerId, trackId, pendingTrack.track.kind);
  console.log(`[resolve] Resolved pending ${pendingTrack.track.kind} track ${trackId.slice(0,8)} from ${peerId} → type=${trackType ?? "mic"}`);
  applyIncomingRemoteTrack(peerId, pendingTrack.track, pendingTrack.stream, trackType);
}

function queuePendingRemoteTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream) {
  if (!pendingRemoteTracks.has(peerId)) {
    pendingRemoteTracks.set(peerId, new Map());
  }
  const pendingForPeer = pendingRemoteTracks.get(peerId)!;
  const existing = pendingForPeer.get(track.id);
  if (existing) clearTimeout(existing.timeout);

  // Dump pending track-info state for debugging
  const pendingInfos = pendingTrackInfoById.get(peerId);
  const infoEntries = pendingInfos ? Array.from(pendingInfos.entries()).map(([id, type]) => `${id.slice(0,8)}→${type}`).join(", ") : "none";
  console.log(`[queue] Queuing ${track.kind} track ${track.id.slice(0,8)} from ${peerId} (pending track-infos: [${infoEntries}])`);

  const timeout = setTimeout(() => {
    console.log(`[queue] Timeout expired for ${track.kind} track ${track.id.slice(0,8)} from ${peerId}, resolving now`);
    resolvePendingRemoteTrack(peerId, track.id);
  }, TRACK_INFO_WAIT_TIMEOUT_MS);

  pendingForPeer.set(track.id, { track, stream, timeout });
}

async function sendTrackInfo(
  conn: ReturnType<typeof getConnection>,
  peerId: string,
  trackType: TrackInfoType,
  trackId: string,
) {
  await conn.invoke(
    "SendSignal",
    peerId,
    JSON.stringify({ type: "track-info", trackType, trackId }),
  );
}

interface CreatePeerConnectionOptions {
  preserveZombieRecreateCooldown?: boolean;
}

function createPeerConnection(
  peerId: string,
  options: CreatePeerConnectionOptions = {},
): RTCPeerConnection {
  const { preserveZombieRecreateCooldown = false } = options;
  console.log(`[peer] Creating new peer connection for ${peerId} (existing peers: ${Array.from(peers.keys()).join(", ") || "none"}, ICE servers: ${currentIceServers.map(s => Array.isArray(s.urls) ? s.urls[0] : s.urls).join(", ")})`);
  closePeer(peerId, { preserveZombieRecreateCooldown });
  pendingCandidates.delete(peerId);
  const pc = new RTCPeerConnection({ iceServers: currentIceServers });
  peers.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const c = event.candidate;

      // Track candidate for NAT detection (no IP addresses stored)
      if (!gatheredCandidates.has(peerId)) {
        gatheredCandidates.set(peerId, []);
      }
      gatheredCandidates.get(peerId)!.push({
        type: c.type || 'unknown',
        protocol: c.protocol || 'unknown',
        hasRelatedAddress: !!(c.relatedAddress || c.relatedPort),
      });

      const conn = getConnection();
      conn
        .invoke("SendSignal", peerId, JSON.stringify(event.candidate.toJSON()))
        .catch((err) => console.error("Failed to send ICE candidate:", err));
    } else {
      // ICE gathering complete for this peer
      console.log(`[ICE] Gathering complete for ${peerId}`);
    }
  };
  pc.onicecandidateerror = (event) => {
    console.warn(
      `[ice] Candidate error for ${peerId}: code=${event.errorCode ?? "unknown"} text=${event.errorText ?? "unknown"} url=${event.url ?? "unknown"}`,
    );
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`ICE state for ${peerId}: ${pc.iceConnectionState}`);
    const voiceState = useVoiceStore.getState();

    // Clear "new state" timer once ICE progresses past "new"
    if (pc.iceConnectionState !== 'new') {
      const newTimer = iceNewStateTimers.get(peerId);
      if (newTimer) { clearTimeout(newTimer); iceNewStateTimers.delete(peerId); }
    }

    if (pc.iceConnectionState === "checking") {
      // Browsers (especially Firefox) can stall at "checking" without ever
      // reaching "failed". Set a hard timeout so we don't wait forever.
      if (!iceReconnectTimers.has(peerId) && !iceRestartInFlight.has(peerId)) {
        const timer = setTimeout(() => {
          iceReconnectTimers.delete(peerId);
          if (pc.iceConnectionState === "checking") {
            console.warn(`ICE stuck at checking for ${peerId}`);
            p2pFailedPeers.add(peerId);
            voiceState.incrementP2PFailures();
            if (shouldFallbackToSFU()) {
              void fallbackToSFU('ICE stuck at checking (likely blocked by VPN/firewall)');
              return;
            }
            restartIceForPeer(peerId, { reason: "checking-timeout" });
          }
        }, 10_000);
        iceReconnectTimers.set(peerId, timer);
      }
    } else if (pc.iceConnectionState === "disconnected") {
      voiceState.setConnectionState("reconnecting");
      // Clear any checking timer, start a shorter recovery timer
      const existing = iceReconnectTimers.get(peerId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        if (pc.iceConnectionState === "disconnected") {
          console.warn(`ICE still disconnected for ${peerId}, restarting...`);
          restartIceForPeer(peerId, { reason: "disconnected-timeout" });
        }
        iceReconnectTimers.delete(peerId);
      }, 5000);
      iceReconnectTimers.set(peerId, timer);
    } else if (pc.iceConnectionState === "failed") {
      console.warn(`ICE failed for ${peerId}`);
      p2pFailedPeers.add(peerId);
      voiceState.incrementP2PFailures();
      if (shouldFallbackToSFU()) {
        const reason = voiceState.p2pFailureCount >= P2P_FAILURE_THRESHOLD
          ? `P2P connection failed (${voiceState.p2pFailureCount} attempts, likely VPN/firewall)`
          : `Room too large (${voiceState.participants.size} participants)`;
        void fallbackToSFU(reason);
        return;
      }
      voiceState.setConnectionState("reconnecting");
      useToastStore.getState().addToast("Connection issue detected. Reconnecting...", "error");
      restartIceForPeer(peerId, { force: true, reason: "ice-failed" });
    } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      // Log peer summary on successful connection
      const senders = pc.getSenders();
      const receivers = pc.getReceivers();
      console.log(`[ice] Connected to ${peerId} | senders: [${senders.map(s => `${s.track?.kind ?? "null"}:${s.track?.id.slice(0,8) ?? "none"} enabled=${s.track?.enabled}`).join(", ")}] | receivers: [${receivers.map(r => `${r.track?.kind ?? "null"}:${r.track?.id.slice(0,8) ?? "none"} readyState=${r.track?.readyState}`).join(", ")}] | audioEls=${audioElements.has(peerId)} screenAudioEls=${screenAudioElements.has(peerId)} gainNode=${gainNodes.has(peerId)}`);
      // Retry play() on paused audio elements — browsers can leave them paused
      // when play() was called before ICE connected (no data flowing yet)
      for (const [label, elMap] of [["mic", audioElements], ["screen", screenAudioElements]] as const) {
        const audio = elMap.get(peerId);
        if (audio && audio.paused && audio.srcObject) {
          console.log(`[ice] Retrying ${label} audio play() for ${peerId} after ICE connected`);
          audio.play().then(() => {
            console.log(`[ice] ${label} audio play() succeeded for ${peerId} (paused=${audio.paused})`);
          }).catch((err) => {
            console.warn(`[ice] ${label} audio play() failed for ${peerId}:`, err);
          });
        }
      }
      // Clear reconnect timer and reset backoff
      const timer = iceReconnectTimers.get(peerId);
      if (timer) { clearTimeout(timer); iceReconnectTimers.delete(peerId); }
      iceRestartAttempts.delete(peerId);
      // Check if ALL peers are connected
      let allConnected = true;
      for (const [, p] of peers) {
        const s = p.iceConnectionState;
        if (s !== "connected" && s !== "completed" && s !== "closed") {
          allConnected = false;
          break;
        }
      }
      if (allConnected) voiceState.setConnectionState("connected");
    }
  };

  pc.ontrack = (event) => {
    const track = event.track;
    const stream =
      event.streams && event.streams.length > 0
        ? event.streams[0]
        : new MediaStream([track]);
    console.log(`[ontrack] Got remote ${track.kind} track from ${peerId} | trackId=${track.id} readyState=${track.readyState} enabled=${track.enabled} muted=${track.muted} | stream tracks: ${stream.getTracks().map(t => `${t.kind}:${t.id.slice(0,8)}`).join(", ")} | hasStreams=${!!event.streams?.length}`);
    const trackType = consumeTrackInfo(peerId, track.id, track.kind);
    if (trackType) {
      console.log(`[ontrack] Matched track-info immediately: ${trackType}`);
      applyIncomingRemoteTrack(peerId, track, stream, trackType);
      return;
    }
    console.log(`[ontrack] No track-info match, queuing for ${TRACK_INFO_WAIT_TIMEOUT_MS}ms`);
    queuePendingRemoteTrack(peerId, track, stream);
  };

  // Start a "new state" timer — if ICE never progresses past "new" (e.g. the
  // remote peer is in SFU mode and ignores our offer), trigger SFU fallback.
  const existingNewTimer = iceNewStateTimers.get(peerId);
  if (existingNewTimer) clearTimeout(existingNewTimer);
  const newStateTimer = setTimeout(() => {
    iceNewStateTimers.delete(peerId);
    if (pc.iceConnectionState === 'new' && peers.get(peerId) === pc) {
      console.warn(`[ice] Peer ${peerId} stuck at "new" for ${ICE_NEW_STATE_TIMEOUT_MS}ms (offer likely unanswered)`);
      p2pFailedPeers.add(peerId);
      useVoiceStore.getState().incrementP2PFailures();
      if (shouldFallbackToSFU()) {
        void fallbackToSFU('P2P offer unanswered (remote peer may be using relay mode)');
        return;
      }
      // If not falling back, close the dead peer
      closePeer(peerId);
    }
  }, ICE_NEW_STATE_TIMEOUT_MS);
  iceNewStateTimers.set(peerId, newStateTimer);

  return pc;
}

interface ClosePeerOptions {
  preserveZombieRecreateCooldown?: boolean;
}

function closePeer(peerId: string, options: ClosePeerOptions = {}) {
  const { preserveZombieRecreateCooldown = false } = options;
  // Clear "new state" timer
  const newTimer = iceNewStateTimers.get(peerId);
  if (newTimer) { clearTimeout(newTimer); iceNewStateTimers.delete(peerId); }
  const pc = peers.get(peerId);
  if (pc) {
    console.log(`[peer] Closing peer ${peerId} (connectionState=${pc.connectionState}, iceState=${pc.iceConnectionState}, sigState=${pc.signalingState}, senders=${pc.getSenders().length}, receivers=${pc.getReceivers().length})`);
    // If the peer never made it past "checking", count it as a P2P failure
    // so the fallback threshold accumulates even when peers leave/rejoin
    if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new') {
      p2pFailedPeers.add(peerId);
      useVoiceStore.getState().incrementP2PFailures();
      console.log(`[closePeer] Counted as P2P failure (iceState=${pc.iceConnectionState}, failureCount=${useVoiceStore.getState().p2pFailureCount})`);
    }
    pc.close();
    peers.delete(peerId);
  }
  const audio = audioElements.get(peerId);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    audioElements.delete(peerId);
  }
  const screenAudio = screenAudioElements.get(peerId);
  if (screenAudio) {
    screenAudio.pause();
    screenAudio.srcObject = null;
    screenAudio.remove();
    screenAudioElements.delete(peerId);
  }
  removeAnalyser(peerId);
  peerStreams.delete(peerId);
  const gainEntry = gainNodes.get(peerId);
  if (gainEntry) { gainEntry.source.disconnect(); gainNodes.delete(peerId); }
  const hadScreen = screenVideoStreams.delete(peerId);
  const hadCamera = cameraVideoStreams.delete(peerId);
  if (hadScreen) useVoiceStore.getState().bumpScreenStreamVersion();
  if (hadCamera) useVoiceStore.getState().bumpCameraStreamVersion();
  // Clear UI state so phantom sharers/cameras don't linger
  useVoiceStore.getState().removeActiveSharer(peerId);
  useVoiceStore.getState().removeActiveCamera(peerId);
  pendingCandidates.delete(peerId);
  gatheredCandidates.delete(peerId);
  clearPendingTrackStateForPeer(peerId);
  screenTrackSenders.delete(peerId);
  cameraTrackSenders.delete(peerId);
  iceRestartInFlight.delete(peerId);
  signalingQueues.delete(peerId);
  lastIceRestartTime.delete(peerId);
  iceRestartAttempts.delete(peerId);
  prevBytesReceived.delete(peerId);
  zombieStaleCount.delete(peerId);
  if (!preserveZombieRecreateCooldown) {
    lastZombieRecreate.delete(peerId);
  }
  const timer = iceReconnectTimers.get(peerId);
  if (timer) { clearTimeout(timer); iceReconnectTimers.delete(peerId); }
}

function cleanupAll() {
  voiceSessionId++;
  if (noiseSuppressor) {
    noiseSuppressor.destroy();
    noiseSuppressor = null;
  }
  peerStream = null;
  peers.forEach((pc) => {
    pc.close();
  });
  peers.clear();
  audioElements.forEach((audio) => {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  });
  audioElements.clear();
  screenAudioElements.forEach((audio) => {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  });
  screenAudioElements.clear();
  cleanupAnalysers();
  peerStreams.clear();
  gainNodes.forEach((entry) => entry.source.disconnect());
  gainNodes.clear();
  screenVideoStreams.clear();
  cameraVideoStreams.clear();
  pendingCandidates.clear();
  gatheredCandidates.clear();
  clearAllPendingTrackState();
  screenTrackSenders.clear();
  cameraTrackSenders.clear();
  signalingQueues.clear();
  lastIceRestartTime.clear();
  iceRestartAttempts.clear();
  prevBytesReceived.clear();
  zombieStaleCount.clear();
  lastZombieRecreate.clear();
  // Clear ICE reconnect timers
  iceReconnectTimers.forEach((t) => clearTimeout(t));
  iceReconnectTimers.clear();
  iceNewStateTimers.forEach((t) => clearTimeout(t));
  iceNewStateTimers.clear();
  cancelInitialParticipantWait();
  stopStatsCollection();
  channelRelayDetected = false;
  const vs = useVoiceStore.getState();
  vs.setConnectionState("disconnected");
  vs.setNeedsAudioUnlock(false);
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
}

async function replaceLocalAudioStream(newStream: MediaStream) {
  const newTrack = newStream.getAudioTracks()[0];
  if (!newTrack) return;

  console.log(`[replaceAudio] Replacing local audio stream (newTrackId=${newTrack.id.slice(0,8)} enabled=${newTrack.enabled} readyState=${newTrack.readyState})`);

  if (noiseSuppressor) {
    // Suppressor is active — swap its input source. The processed output track
    // identity stays the same, so no sender.replaceTrack() is needed for peers.
    noiseSuppressor.replaceInput(newStream);
    console.log("[replaceAudio] Swapped noise suppressor input (output track unchanged)");
  } else {
    // No suppressor — replace track on each peer connection directly
    // Collect screen-audio track IDs so we skip them — only replace the mic sender
    const screenAudioTrackIds = new Set<string>();
    for (const senders of screenTrackSenders.values()) {
      for (const s of senders) {
        if (s.track?.kind === "audio") screenAudioTrackIds.add(s.track.id);
      }
    }
    if (screenAudioTrackIds.size > 0) {
      console.log(`[replaceAudio] Skipping ${screenAudioTrackIds.size} screen-audio senders`);
    }

    for (const [peerId, pc] of peers) {
      const allAudioSenders = pc.getSenders().filter(s => s.track?.kind === "audio");
      const sender = allAudioSenders.find(s => !screenAudioTrackIds.has(s.track!.id));
      if (sender) {
        console.log(`[replaceAudio] Replacing mic sender for ${peerId} (oldTrackId=${sender.track?.id.slice(0,8)}, ${allAudioSenders.length} total audio senders)`);
        try {
          await sender.replaceTrack(newTrack);
        } catch (err) {
          console.warn(`[replaceAudio] Failed to replace audio track for ${peerId}:`, err);
        }
      } else {
        console.log(`[replaceAudio] No mic sender found for ${peerId}, adding new track (${allAudioSenders.length} audio senders, all screen-audio)`);
        pc.addTrack(newTrack, newStream);
      }
    }
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = newStream;

  const voiceState = useVoiceStore.getState();
  const shouldEnable =
    !voiceState.isMuted &&
    (voiceState.voiceMode === "voice-activity" || voiceState.isPttActive);
  newTrack.enabled = shouldEnable;

  const currentUser = useAuthStore.getState().user;
  if (currentUser) {
    addAnalyser(currentUser.id, newStream);
  }
}

async function applyPendingCandidates(peerId: string) {
  const pc = peers.get(peerId);
  const candidates = pendingCandidates.get(peerId);
  if (pc && candidates && pc.remoteDescription) {
    for (const candidate of candidates) {
      await pc
        .addIceCandidate(new RTCIceCandidate(candidate))
        .catch(console.error);
    }
    pendingCandidates.delete(peerId);
  }
}

async function startScreenShareInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.currentChannelId) return;

  voiceState.setScreenShareLoading(true);
  try {
    if (isInSfuMode()) {
      // SFU mode: LiveKit handles capture + publish
      const screenPreset = SCREEN_SHARE_QUALITY_CONSTRAINTS[voiceState.screenShareQuality];
      await sfuPublishScreenShare({
        maxFramerate: screenPreset.frameRate,
        maxBitrate: screenPreset.maxBitrate,
      });
      voiceState.setScreenSharing(true);
      voiceState.bumpScreenStreamVersion();
      const conn = getConnection();
      await conn.invoke("NotifyScreenShare", voiceState.currentChannelId, true);
      return;
    }

    const isLinuxElectron = window.electron?.platform === 'linux';
    const screenPreset = SCREEN_SHARE_QUALITY_CONSTRAINTS[voiceState.screenShareQuality];

    if (isLinuxElectron) {
      // On Linux Electron, use getUserMedia with chromeMediaSource to avoid the
      // PipeWire double-dialog issue (getDisplayMedia + setDisplayMediaRequestHandler
      // each trigger separate PipeWire portal sessions)
      screenStream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            maxFrameRate: screenPreset.frameRate,
          },
        } as any,
        audio: false,
      });
    } else {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: screenPreset.frameRate } },
        audio: true,
      });
    }

    const videoTracks = screenStream.getVideoTracks();
    const audioTracks = screenStream.getAudioTracks();
    console.log(`[screenShare] Started screen capture: ${videoTracks.length} video + ${audioTracks.length} audio tracks (isLinuxElectron=${isLinuxElectron})`);
    const videoTrack = videoTracks[0];

    // Handle browser "Stop sharing" button
    videoTrack.onended = () => {
      stopScreenShareInternal();
    };

    // Do NOT add track to any peer connections — viewers opt-in via RequestWatchStream
    voiceState.setScreenSharing(true);
    const conn = getConnection();
    await conn.invoke("NotifyScreenShare", voiceState.currentChannelId, true);
  } catch (err: any) {
    console.error("Could not get display media:", err);
    // Don't toast for user cancel (NotAllowedError)
    if (err?.name !== "NotAllowedError") {
      useToastStore.getState().addToast("Could not start screen share.", "error");
    }
  } finally {
    voiceState.setScreenShareLoading(false);
  }
}

async function stopScreenShareInternal() {
  const voiceState = useVoiceStore.getState();
  voiceState.setScreenShareLoading(true);
  try {
    if (isInSfuMode()) {
      // SFU mode: LiveKit handles track removal
      await sfuUnpublishScreenShare();
      voiceState.setScreenSharing(false);
      if (voiceState.currentChannelId) {
        const conn = getConnection();
        await conn.invoke("NotifyScreenShare", voiceState.currentChannelId, false);
      }
      return;
    }

    const conn = getConnection();

    // Mark as not sharing BEFORE renegotiation so queued addVideoTrackForViewer calls bail out
    const stoppingStream = screenStream;
    screenStream = null;
    voiceState.setScreenSharing(false);

    // Remove all screen tracks from all viewers we're sending to and renegotiate
    const shareEntries = Array.from(screenTrackSenders.entries());
    console.log(`[screenShare] Stopping screen share, removing tracks from ${shareEntries.length} viewer(s): ${shareEntries.map(([id]) => id).join(", ")}`);
    await Promise.all(
      shareEntries.map(([viewerId, senders]) =>
        enqueueSignaling(viewerId, async () => {
          const pc = peers.get(viewerId);
          if (!pc) return;
          senders.forEach((sender) => pc.removeTrack(sender));

          if (
            pc.signalingState === "stable" &&
            pc.iceConnectionState !== "failed"
          ) {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await conn.invoke(
                "SendSignal",
                viewerId,
                JSON.stringify({ type: "offer", sdp: offer.sdp }),
              );
            } catch (err) {
              console.warn(`Renegotiation after screen stop failed for ${viewerId}, recreating:`, err);
              await recreatePeer(viewerId).catch(console.error);
            }
          } else {
            console.warn(
              `Skipping renegotiation for ${viewerId} - signaling: ${pc.signalingState}, ICE: ${pc.iceConnectionState}`,
            );
          }
        }),
      ),
    );
    screenTrackSenders.clear();

    // Stop screen tracks
    if (stoppingStream) {
      stoppingStream.getTracks().forEach((track) => track.stop());
    }

    if (voiceState.currentChannelId) {
      await conn.invoke("NotifyScreenShare", voiceState.currentChannelId, false);
    }
  } finally {
    voiceState.setScreenShareLoading(false);
  }
}

// Camera functions
async function startCameraInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.currentChannelId) return;

  voiceState.setCameraLoading(true);
  try {
    if (isInSfuMode()) {
      // SFU mode: LiveKit handles capture + publish
      const camPreset = CAMERA_QUALITY_CONSTRAINTS[voiceState.cameraQuality];
      await sfuPublishCamera({
        deviceId: voiceState.cameraDeviceId,
        frameRate: camPreset.frameRate,
        maxBitrate: camPreset.maxBitrate,
        width: camPreset.width,
        height: camPreset.height,
      });
      voiceState.setCameraOn(true);
      voiceState.bumpCameraStreamVersion();
      const conn = getConnection();
      await conn.invoke("NotifyCamera", voiceState.currentChannelId, true);
      return;
    }

    const camPreset = CAMERA_QUALITY_CONSTRAINTS[voiceState.cameraQuality];
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: camPreset.width },
      height: { ideal: camPreset.height },
      frameRate: { ideal: camPreset.frameRate },
    };

    // On Capacitor (mobile), use facingMode for reliable front/back switching
    // On desktop, use deviceId for specific camera selection
    const isNativeMobile = (await import('@capacitor/core')).Capacitor.isNativePlatform();
    if (isNativeMobile) {
      videoConstraints.facingMode = { ideal: voiceState.cameraFacingMode };
    } else if (voiceState.cameraDeviceId && voiceState.cameraDeviceId !== "default") {
      videoConstraints.deviceId = { exact: voiceState.cameraDeviceId };
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
    } catch (firstErr: any) {
      if ((firstErr?.name === "OverconstrainedError" || firstErr?.name === "NotFoundError") &&
          voiceState.cameraDeviceId && voiceState.cameraDeviceId !== "default") {
        console.warn(`Saved camera device unavailable (${firstErr.name}), falling back to default`);
        const { deviceId: _, ...fallbackConstraints } = videoConstraints;
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: fallbackConstraints,
          audio: false,
        });
      } else {
        throw firstErr;
      }
    }

    const videoTrack = cameraStream.getVideoTracks()[0];
    videoTrack.onended = () => {
      stopCameraInternal();
    };

    // Add camera track to all existing peers (eager)
    const conn = getConnection();
    for (const [peerId, pc] of peers) {
      await addCameraTrackToPeer(peerId, pc, conn);
    }

    voiceState.setCameraOn(true);
    await conn.invoke("NotifyCamera", voiceState.currentChannelId, true);
  } catch (err) {
    console.error("Could not get camera:", err);
    useToastStore.getState().addToast("Could not access camera. Check permissions.", "error");
  } finally {
    voiceState.setCameraLoading(false);
  }
}

async function stopCameraInternal() {
  const voiceState = useVoiceStore.getState();
  voiceState.setCameraLoading(true);
  try {
    if (isInSfuMode()) {
      // SFU mode: LiveKit handles track removal
      await sfuUnpublishCamera();
      voiceState.setCameraOn(false);
      if (voiceState.currentChannelId) {
        const conn = getConnection();
        await conn.invoke("NotifyCamera", voiceState.currentChannelId, false);
      }
      return;
    }

    const conn = getConnection();

    // Remove camera track from all peers and renegotiate
    const camEntries = Array.from(cameraTrackSenders.entries());
    await Promise.all(
      camEntries.map(([peerId, sender]) =>
        enqueueSignaling(peerId, async () => {
          const pc = peers.get(peerId);
          if (!pc) return;
          pc.removeTrack(sender);
          if (pc.signalingState === "stable" && pc.iceConnectionState !== "failed") {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await conn.invoke(
                "SendSignal",
                peerId,
                JSON.stringify({ type: "offer", sdp: offer.sdp }),
              );
            } catch (err) {
              console.warn(`Renegotiation after camera stop failed for ${peerId}, recreating:`, err);
              await recreatePeer(peerId).catch(console.error);
            }
          } else {
            console.warn(
              `Skipping camera-stop renegotiation for ${peerId} - signaling: ${pc.signalingState}, ICE: ${pc.iceConnectionState}`,
            );
          }
        }),
      ),
    );
    cameraTrackSenders.clear();

    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }

    voiceState.setCameraOn(false);

    if (voiceState.currentChannelId) {
      await conn.invoke("NotifyCamera", voiceState.currentChannelId, false);
    }
  } finally {
    voiceState.setCameraLoading(false);
  }
}

async function switchCameraInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.isCameraOn) return;

  // Toggle between front (user) and back (environment) camera
  const newFacingMode = voiceState.cameraFacingMode === 'user' ? 'environment' : 'user';
  voiceState.setCameraFacingMode(newFacingMode);

  // Restart camera with new facing mode
  await stopCameraInternal();
  await startCameraInternal();
}

async function addCameraTrackToPeer(
  peerId: string,
  pc: RTCPeerConnection,
  conn: ReturnType<typeof getConnection>,
) {
  await enqueueSignaling(peerId, async () => {
    if (!cameraStream) return;
    const videoTrack = cameraStream.getVideoTracks()[0];
    if (!videoTrack) return;

    // Send track-info before adding track
    await sendTrackInfo(conn, peerId, "camera", videoTrack.id);

    const sender = pc.addTrack(videoTrack, cameraStream);
    cameraTrackSenders.set(peerId, sender);

    // Apply bitrate limit
    const camPreset = CAMERA_QUALITY_CONSTRAINTS[useVoiceStore.getState().cameraQuality];
    await applyBitrateToSender(sender, camPreset.maxBitrate);

    // Renegotiate
    if (pc.signalingState === "stable" && pc.iceConnectionState !== "failed") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await conn.invoke(
        "SendSignal",
        peerId,
        JSON.stringify({ type: "offer", sdp: offer.sdp }),
      );
    }
  });
}

// Called when a viewer requests to watch our stream
async function addVideoTrackForViewer(viewerUserId: string) {
  await enqueueSignaling(viewerUserId, async () => {
    if (!screenStream || !useVoiceStore.getState().isScreenSharing) {
      console.log(`Ignoring watch request from ${viewerUserId}: not sharing`);
      return;
    }
    const activeScreenStream = screenStream;
    const pc = peers.get(viewerUserId);
    if (!pc) return;

    const conn = getConnection();
    const senders: RTCRtpSender[] = [];
    const existingSenders = pc.getSenders();
    console.log(`[screenShare] Adding screen tracks for viewer ${viewerUserId} (existing senders: ${existingSenders.map(s => `${s.track?.kind}:${s.track?.id.slice(0,8)}`).join(", ")})`);

    // Add video tracks with track-info so the receiver knows it's a screen track
    for (const track of activeScreenStream.getVideoTracks()) {
      await sendTrackInfo(conn, viewerUserId, "screen", track.id);
      console.log(`[screenShare] Adding screen video track for viewer ${viewerUserId} (trackId=${track.id.slice(0,8)})`);
      senders.push(pc.addTrack(track, activeScreenStream));
    }

    // Add audio tracks (tab/system audio) with a distinct track-info type
    // so the receiver plays them through a separate element instead of
    // overwriting the mic audio.
    for (const track of activeScreenStream.getAudioTracks()) {
      await sendTrackInfo(conn, viewerUserId, "screen-audio", track.id);
      console.log(`[screenShare] Adding screen audio track for viewer ${viewerUserId} (trackId=${track.id.slice(0,8)})`);
      senders.push(pc.addTrack(track, activeScreenStream));
    }

    if (senders.length === 0) return;
    screenTrackSenders.set(viewerUserId, senders);

    // Apply bitrate limit to video senders
    const screenPreset = SCREEN_SHARE_QUALITY_CONSTRAINTS[useVoiceStore.getState().screenShareQuality];
    for (const sender of senders) {
      if (sender.track?.kind === "video") {
        await applyBitrateToSender(sender, screenPreset.maxBitrate);
      }
    }

    // Only renegotiate if signaling state is stable and ICE isn't failed
    if (
      pc.signalingState !== "stable" ||
      pc.iceConnectionState === "failed"
    ) {
      console.warn(
        `Skipping renegotiation for ${viewerUserId} - signaling: ${pc.signalingState}, ICE: ${pc.iceConnectionState}`,
      );
      senders.forEach((sender) => pc.removeTrack(sender));
      screenTrackSenders.delete(viewerUserId);
      return;
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await conn.invoke(
      "SendSignal",
      viewerUserId,
      JSON.stringify({ type: "offer", sdp: offer.sdp }),
    );
  });
}

// Called when a viewer stops watching our stream
async function removeVideoTrackForViewer(viewerUserId: string) {
  await enqueueSignaling(viewerUserId, async () => {
    const senders = screenTrackSenders.get(viewerUserId);
    const pc = peers.get(viewerUserId);
    if (!senders || !pc) return;

    senders.forEach((sender) => pc.removeTrack(sender));
    screenTrackSenders.delete(viewerUserId);

    if (
      pc.signalingState !== "stable" ||
      pc.iceConnectionState === "failed"
    ) {
      console.warn(
        `Skipping renegotiation for ${viewerUserId} - signaling: ${pc.signalingState}, ICE: ${pc.iceConnectionState}`,
      );
      return;
    }

    const conn = getConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await conn.invoke(
      "SendSignal",
      viewerUserId,
      JSON.stringify({ type: "offer", sdp: offer.sdp }),
    );
  });
}

// Exported for ScreenShareView to call
export async function requestWatch(sharerUserId: string) {
  if (isInSfuMode()) {
    // SFU mode: tracks are auto-subscribed, just set watching state
    useVoiceStore.getState().setWatching(sharerUserId);
    useVoiceStore.getState().bumpScreenStreamVersion();
    return;
  }

  const conn = getConnection();
  useVoiceStore.getState().setWatching(sharerUserId);
  await conn.invoke("RequestWatchStream", sharerUserId);

  // Timeout: if no screen stream arrives within 10s, clear watching state
  setTimeout(() => {
    if (useVoiceStore.getState().watchingUserId === sharerUserId &&
        !screenVideoStreams.has(sharerUserId)) {
      useVoiceStore.getState().setWatching(null);
      useToastStore.getState().addToast("Failed to load screen share", "error");
    }
  }, 10_000);
}

export async function stopWatching() {
  const store = useVoiceStore.getState();
  const sharerUserId = store.watchingUserId;
  if (!sharerUserId) return;

  if (isInSfuMode()) {
    // SFU mode: just clear watching state (track stays subscribed)
    store.setWatching(null);
    store.bumpScreenStreamVersion();
    return;
  }

  const conn = getConnection();
  await conn.invoke("StopWatchingStream", sharerUserId);
  store.setWatching(null);
  screenVideoStreams.delete(sharerUserId);
  store.bumpScreenStreamVersion();
}

async function handleUserJoinedVoice(
  conn: HubConnection,
  userId: string,
  displayName: string,
) {
  useVoiceStore.getState().addParticipant(userId, displayName);

  const currentUser = useAuthStore.getState().user;
  if (userId === currentUser?.id || !localStream) return;

  await enqueueSignaling(userId, async () => {
    // Idempotency: skip if we already have a healthy peer for this user.
    // This prevents duplicate handleUserJoinedVoice calls (e.g. from both
    // buffered replay and VoiceChannelUsers reconciliation) from tearing
    // down a working connection and triggering repeated renegotiation.
    const existingPc = peers.get(userId);
    if (
      existingPc &&
      existingPc.connectionState !== "failed" &&
      existingPc.connectionState !== "closed"
    ) {
      console.log(
        `Skipping duplicate peer setup for ${userId} (state: ${existingPc.connectionState})`,
      );
      return;
    }

    const pc = createPeerConnection(userId);

    // Add audio tracks only - screen track is added lazily on WatchStreamRequested
    const outStream = getPeerStream()!;
    const localTracks = outStream.getTracks();
    console.log(`[join] Adding ${localTracks.length} local tracks for ${userId}: ${localTracks.map(t => `${t.kind}:${t.id.slice(0,8)} enabled=${t.enabled} readyState=${t.readyState}`).join(", ")}`);
    localTracks.forEach((track) => pc.addTrack(track, outStream));

    // Add camera track if camera is on (eager - send track-info first)
    if (cameraStream) {
      const camTrack = cameraStream.getVideoTracks()[0];
      if (camTrack) {
        await sendTrackInfo(conn, userId, "camera", camTrack.id);
        const sender = pc.addTrack(camTrack, cameraStream);
        cameraTrackSenders.set(userId, sender);
      }
    }

    const offer = await pc.createOffer();
    const audioLines = (offer.sdp?.match(/m=audio/g) || []).length;
    const videoLines = (offer.sdp?.match(/m=video/g) || []).length;
    await pc.setLocalDescription(offer);
    console.log(`Sending offer to ${userId} (m=audio:${audioLines}, m=video:${videoLines}, senders=${pc.getSenders().length})`);
    await conn.invoke(
      "SendSignal",
      userId,
      JSON.stringify({ type: "offer", sdp: offer.sdp }),
    );
  });
}

function replayBufferedUserJoinedVoiceEvents(conn: HubConnection) {
  if (bufferedUserJoinedVoiceEvents.size === 0) return;
  const bufferedEvents = Array.from(bufferedUserJoinedVoiceEvents.entries());
  bufferedUserJoinedVoiceEvents.clear();

  for (const [userId, displayName] of bufferedEvents) {
    console.log(`Replaying buffered UserJoinedVoice: ${displayName} (${userId})`);
    void handleUserJoinedVoice(conn, userId, displayName).catch((err) => {
      console.warn(`Failed to process buffered UserJoinedVoice for ${userId}:`, err);
    });
  }
}

function cancelInitialParticipantWait() {
  waitingForInitialParticipants = false;
  if (initialParticipantsTimeout) {
    clearTimeout(initialParticipantsTimeout);
    initialParticipantsTimeout = null;
  }
  bufferedUserJoinedVoiceEvents.clear();
}

function completeInitialParticipantWait(conn: HubConnection) {
  waitingForInitialParticipants = false;
  if (initialParticipantsTimeout) {
    clearTimeout(initialParticipantsTimeout);
    initialParticipantsTimeout = null;
  }
  replayBufferedUserJoinedVoiceEvents(conn);
}

function beginInitialParticipantWait(conn: HubConnection) {
  cancelInitialParticipantWait();
  waitingForInitialParticipants = true;
  initialParticipantsTimeout = setTimeout(() => {
    if (!waitingForInitialParticipants) return;
    console.warn("VoiceChannelUsers not received within 5s, replaying buffered join events");
    completeInitialParticipantWait(conn);
  }, INITIAL_PARTICIPANTS_TIMEOUT_MS);
}

async function attemptVoiceRejoin(reason: string) {
  if (intentionalLeave) {
    console.log(`Skipping voice rejoin — user intentionally left (${reason})`);
    return;
  }
  if (rejoinInProgress) {
    console.log(`Rejoin already in progress, skipping (${reason})`);
    return;
  }
  // Cooldown: don't rejoin if we just completed one recently
  if (lastRejoinTime > 0 && Date.now() - lastRejoinTime < REJOIN_COOLDOWN_MS) {
    console.log(`Rejoin cooldown active, skipping (${reason})`);
    return;
  }
  rejoinInProgress = true;
  pendingVisibilityRejoin = false;

  const channelId = useVoiceStore.getState().currentChannelId;
  if (!channelId) {
    rejoinInProgress = false;
    return;
  }

  console.log(`Attempting voice rejoin (${reason}):`, channelId);
  useToastStore.getState().addToast("Reconnecting to voice channel...", "info");

  // Clean up stale WebRTC state — this increments voiceSessionId
  cleanupAll();
  const sessionAtStart = voiceSessionId;
  useVoiceStore.getState().setScreenSharing(false);
  useVoiceStore.getState().setActiveSharers(new Map());
  useVoiceStore.getState().setWatching(null);
  useVoiceStore.getState().setCameraOn(false);
  useVoiceStore.getState().setActiveCameras(new Map());
  useVoiceStore.getState().setFocusedUserId(null);

  try {
    await initializeTurn();
    if (voiceSessionId !== sessionAtStart) { console.log("Rejoin aborted: session changed after TURN init"); return; }

    deviceResolutionFailed = false;

    // Re-acquire microphone with current audio settings
    const vs = useVoiceStore.getState();
    const base: MediaTrackConstraints = {
      noiseSuppression: vs.noiseSuppression,
      echoCancellation: vs.echoCancellation,
      autoGainControl: vs.autoGainControl,
    };
    let audioConstraints = base;
    if (!vs.inputDeviceId || vs.inputDeviceId === "default") {
      const resolvedId = await resolveDefaultInputDevice();
      if (voiceSessionId !== sessionAtStart) { console.log("Rejoin aborted: session changed after device resolution"); return; }
      if (resolvedId !== "default") {
        audioConstraints = { ...base, deviceId: { exact: resolvedId } };
      }
    } else {
      audioConstraints = { ...base, deviceId: { exact: vs.inputDeviceId } };
    }

    localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    if (voiceSessionId !== sessionAtStart) {
      console.log("Rejoin aborted: session changed after getUserMedia");
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      return;
    }

    // Initialize noise suppressor (creates processed peerStream)
    await applySuppressor(localStream);
    if (voiceSessionId !== sessionAtStart) { console.log("Rejoin aborted: session changed after suppressor"); return; }

    // Apply mute state
    const shouldEnable = !vs.isMuted && (vs.voiceMode === "voice-activity" || vs.isPttActive);
    localStream.getAudioTracks().forEach((t) => { t.enabled = shouldEnable; });

    // Set up analyser for speaking indicator
    const currentUser = useAuthStore.getState().user;
    if (currentUser) addAnalyser(currentUser.id, localStream);

    startAudioKeepAlive();
    vs.setConnectionState("connected");

    // Clear participants right before rejoining
    useVoiceStore.getState().setParticipants(new Map());

    // Rejoin on server - this will send us VoiceChannelUsers with authoritative state
    lastVoiceJoinTime = Date.now();
    const conn = getConnection();
    beginInitialParticipantWait(conn);
    await Promise.race([
      conn.invoke("JoinVoiceChannel", channelId, vs.isMuted, vs.isDeafened),
      new Promise((_, reject) => setTimeout(() => reject(new Error("JoinVoiceChannel timeout")), 10000)),
    ]);
    if (voiceSessionId !== sessionAtStart) { console.log("Rejoin aborted: session changed after JoinVoiceChannel"); return; }

    startStatsCollection();

    // Re-initialize voice chat
    const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
    useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);

    lastRejoinTime = Date.now();
    useToastStore.getState().addToast("Reconnected to voice channel", "success");
  } catch (err) {
    cancelInitialParticipantWait();
    console.error(`Failed to rejoin voice (${reason}):`, err);
    useToastStore.getState().addToast("Failed to reconnect to voice channel.", "error");
    // Full cleanup on failure — drop user out of voice
    cleanupAll();
    useVoiceStore.getState().setCurrentChannel(null);
    useVoiceStore.getState().setParticipants(new Map());
    useVoiceChatStore.getState().clear();
  } finally {
    rejoinInProgress = false;
  }
}

function setupSignalRListeners() {
  const conn = getConnection();
  if (listenersRegisteredForConnection === conn) return;
  listenersRegisteredForConnection = conn;

  conn.on("UserJoinedVoice", (userId: string, displayName: string) => {
    console.log(`UserJoinedVoice: ${displayName} (${userId})`);

    // In SFU mode, just track the participant — LiveKit handles the media
    if (isInSfuMode() || useVoiceStore.getState().connectionMode === 'sfu' || useVoiceStore.getState().connectionMode === 'attempting-sfu') {
      useVoiceStore.getState().addParticipant(userId, displayName);
      return;
    }

    // If we've already accumulated enough P2P failures, go straight to SFU
    // instead of creating another doomed peer connection
    const vs = useVoiceStore.getState();
    console.log(`[UserJoinedVoice] Fallback check: mode=${vs.connectionMode} forceSfu=${vs.forceSfuMode} failureCount=${vs.p2pFailureCount} participants=${vs.participants.size} isInSfu=${isInSfuMode()}`);
    if (shouldFallbackToSFU()) {
      vs.addParticipant(userId, displayName);
      void fallbackToSFU('P2P connection failed (peer reconnected but previous attempts failed)');
      return;
    }

    // Buffer joins until we get initial VoiceChannelUsers, then replay.
    if (waitingForInitialParticipants) {
      console.log(`Buffering UserJoinedVoice for ${displayName} while waiting for initial participants`);
      bufferedUserJoinedVoiceEvents.set(userId, displayName);
      return;
    }

    void handleUserJoinedVoice(conn, userId, displayName).catch((err) => {
      console.warn(`Failed to process UserJoinedVoice for ${userId}:`, err);
    });
  });

  conn.on("UserLeftVoice", (userId: string) => {
    console.log(`UserLeftVoice: ${userId}`);
    bufferedUserJoinedVoiceEvents.delete(userId);
    useVoiceStore.getState().removeParticipant(userId);
    closePeer(userId);
  });

  conn.on("ChannelRelayActive", () => {
    console.log('[relay] Channel has relay users');
    channelRelayDetected = true;

    // If already fully connected in P2P, upgrade immediately (cascade)
    const vs = useVoiceStore.getState();
    if (vs.connectionMode === 'p2p') {
      void fallbackToSFU('Channel peers are using relay');
    }
  });

  conn.on("ReceiveSignal", async (fromUserId: string, signal: string) => {
    // Ignore signals if we're not in a voice channel — prevents a non-voice
    // browser tab from creating broken peer connections that interfere with
    // the real voice session on another client (e.g. Electron).
    if (!useVoiceStore.getState().currentChannelId) return;

    // Skip P2P signaling when in SFU mode (or transitioning to it)
    const sigMode = useVoiceStore.getState().connectionMode;
    if (isInSfuMode() || sigMode === 'sfu' || sigMode === 'attempting-sfu') return;

    const data = JSON.parse(signal);

    if (data.type === "peer-reset") {
      // Remote peer is about to recreate their PeerConnection (e.g. zombie
      // recovery).  Close our existing PC so the incoming offer creates a
      // fresh one on both sides — prevents stale DTLS/SRTP state that causes
      // one-directional audio.
      const existingPc = peers.get(fromUserId);
      console.log(`[peer-reset] ${fromUserId} requested peer reset, closing existing PC (exists=${!!existingPc}${existingPc ? ` connectionState=${existingPc.connectionState} iceState=${existingPc.iceConnectionState} senders=${existingPc.getSenders().length} receivers=${existingPc.getReceivers().length}` : ""})`);
      closePeer(fromUserId);
      return;
    }

    if (data.type === "track-info") {
      if (
        data.trackType !== "camera" &&
        data.trackType !== "screen" &&
        data.trackType !== "screen-audio"
      ) {
        return;
      }
      const trackId = typeof data.trackId === "string" ? data.trackId : undefined;
      console.log(`[track-info] Received from ${fromUserId}: type=${data.trackType} trackId=${trackId?.slice(0,8) ?? "none"}`);
      queueTrackInfo(fromUserId, data.trackType, trackId);
      if (trackId) {
        resolvePendingRemoteTrack(fromUserId, trackId);
      }
      return;
    }

    if (data.type === "offer") {
      await enqueueSignaling(fromUserId, async () => {
        console.log(`Received offer from ${fromUserId}`);

        // Remote peer's offer handles reconnection — cancel our own pending restart
        const existingTimer = iceReconnectTimers.get(fromUserId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          iceReconnectTimers.delete(fromUserId);
          // Only update cooldown when a remote offer arrived while we were
          // already in a reconnect path. Normal offers should not throttle
          // future ICE restart attempts.
          lastIceRestartTime.set(fromUserId, Date.now());
        }

        const currentUser = useAuthStore.getState().user;

        let pc = peers.get(fromUserId);
        if (pc && pc.signalingState !== "closed") {
          // Glare detection: both sides sent offers simultaneously
          let didRollback = false;
          if (pc.signalingState === "have-local-offer") {
            // Deterministic tiebreaker — "polite" peer yields its offer
            const isPolite = currentUser!.id > fromUserId;
            console.log(`[glare] Detected with ${fromUserId} | myId=${currentUser!.id} > remoteId=${fromUserId} → ${isPolite ? "polite (we yield)" : "impolite (we win)"}`);
            if (!isPolite) {
              console.log(`[glare] Ignoring remote offer, waiting for answer to our offer`);
              return;
            }
            console.log(`[glare] Rolling back our offer, will answer remote offer instead`);
            await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
            console.log(`[glare] Rollback complete, signalingState=${pc.signalingState}`);
            didRollback = true;
          }

          // Renegotiation: reuse existing connection — flush stale candidates
          pendingCandidates.delete(fromUserId);
          try {
            const audioLines = (data.sdp.match(/m=audio/g) || []).length;
            const videoLines = (data.sdp.match(/m=video/g) || []).length;
            console.log(`[offer] Renegotiating with ${fromUserId} (sigState=${pc.signalingState}, m=audio:${audioLines}, m=video:${videoLines}, senders=${pc.getSenders().length}, receivers=${pc.getReceivers().length})`);
            await pc.setRemoteDescription(
              new RTCSessionDescription({ type: "offer", sdp: data.sdp }),
            );
            await applyPendingCandidates(fromUserId);
            const answer = await pc.createAnswer();
            answer.sdp = fixDtlsRoleInLocalAnswerSdp(pc, answer.sdp!);
            await pc.setLocalDescription(answer);
            console.log(`Sending renegotiation answer to ${fromUserId}`);
            await conn.invoke(
              "SendSignal",
              fromUserId,
              JSON.stringify({ type: "answer", sdp: answer.sdp }),
            );

            // After glare rollback, our rolled-back offer may have contained
            // camera/screen tracks that the remote offer didn't include.
            // Re-offer so those senders get negotiated.
            if (didRollback) {
              const hasScreenSenders = screenTrackSenders.has(fromUserId);
              const hasCameraSender = cameraTrackSenders.has(fromUserId);
              if (hasScreenSenders || hasCameraSender) {
                console.log(`[glare] Scheduling renegotiation for ${fromUserId} to restore tracks lost in rollback (screen=${hasScreenSenders}, camera=${hasCameraSender})`);
                void enqueueSignaling(fromUserId, async () => {
                  const rePc = peers.get(fromUserId);
                  if (!rePc || rePc.signalingState !== "stable") return;
                  const reOffer = await rePc.createOffer();
                  await rePc.setLocalDescription(reOffer);
                  await conn.invoke(
                    "SendSignal",
                    fromUserId,
                    JSON.stringify({ type: "offer", sdp: reOffer.sdp }),
                  );
                  console.log(`[glare] Renegotiation offer sent to ${fromUserId}`);
                }).catch(console.error);
              }
            }
          } catch (err) {
            console.warn(`Renegotiation failed for ${fromUserId}, recreating:`, err);
            // SDP state is likely corrupt — rebuild with a fresh connection
            // Accept the remote offer on a clean PC instead
            pc = createPeerConnection(fromUserId);
            const recoveryStream = getPeerStream();
            if (recoveryStream) {
              recoveryStream.getTracks().forEach((track) => pc!.addTrack(track, recoveryStream));
            }
            if (cameraStream) {
              const camTrack = cameraStream.getVideoTracks()[0];
              if (camTrack) {
                await sendTrackInfo(conn, fromUserId, "camera", camTrack.id);
                const sender = pc!.addTrack(camTrack, cameraStream);
                cameraTrackSenders.set(fromUserId, sender);
              }
            }
            await pc!.setRemoteDescription(
              new RTCSessionDescription({ type: "offer", sdp: data.sdp }),
            );
            const answer = await pc!.createAnswer();
            await pc!.setLocalDescription(answer);
            console.log(`Sending fresh answer to ${fromUserId}`);
            await conn.invoke(
              "SendSignal",
              fromUserId,
              JSON.stringify({ type: "answer", sdp: answer.sdp }),
            );
          }
        } else {
          // New connection — audio only, screen track added lazily
          console.log(`[offer] New connection from ${fromUserId} (hasLocalStream=${!!localStream}, hasCamera=${!!cameraStream})`);
          pc = createPeerConnection(fromUserId);
          const offerStream = getPeerStream();
          if (offerStream) {
            const tracks = offerStream.getTracks();
            console.log(`[offer] Adding ${tracks.length} local tracks: ${tracks.map(t => `${t.kind}:${t.id.slice(0,8)} enabled=${t.enabled}`).join(", ")}`);
            tracks.forEach((track) => pc!.addTrack(track, offerStream));
          }
          // Add camera track if camera is on (eager — send track-info before answer)
          if (cameraStream) {
            const camTrack = cameraStream.getVideoTracks()[0];
            if (camTrack) {
              await sendTrackInfo(conn, fromUserId, "camera", camTrack.id);
              const sender = pc.addTrack(camTrack, cameraStream);
              cameraTrackSenders.set(fromUserId, sender);
            }
          }
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "offer", sdp: data.sdp }),
          );
          await applyPendingCandidates(fromUserId);
          const answer = await pc.createAnswer();
          const aLines = (answer.sdp?.match(/m=audio/g) || []).length;
          const vLines = (answer.sdp?.match(/m=video/g) || []).length;
          await pc.setLocalDescription(answer);
          console.log(`Sending answer to ${fromUserId} (m=audio:${aLines}, m=video:${vLines}, senders=${pc.getSenders().length})`);
          await conn.invoke(
            "SendSignal",
            fromUserId,
            JSON.stringify({ type: "answer", sdp: answer.sdp }),
          );
        }
      });
    } else if (data.type === "answer") {
      await enqueueSignaling(fromUserId, async () => {
        console.log(`Received answer from ${fromUserId}`);

        // Got a response — cancel pending restart timer
        const existingTimer = iceReconnectTimers.get(fromUserId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          iceReconnectTimers.delete(fromUserId);
        }

        const pc = peers.get(fromUserId);
        if (!pc) {
          console.warn(`[answer] No peer connection for ${fromUserId}, ignoring answer`);
          return;
        }
        if (pc.signalingState !== "have-local-offer") {
          console.warn(`[answer] Ignoring stale answer from ${fromUserId} (state: ${pc.signalingState})`);
          return;
        }
        const audioLines = (data.sdp.match(/m=audio/g) || []).length;
        const videoLines = (data.sdp.match(/m=video/g) || []).length;
        console.log(`[answer] Applying answer from ${fromUserId} (m=audio:${audioLines}, m=video:${videoLines}, senders=${pc.getSenders().length}, receivers=${pc.getReceivers().length})`);
        const fixedSdp = fixDtlsRoleInAnswerSdp(pc, data.sdp);
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: fixedSdp }),
        );
        await applyPendingCandidates(fromUserId);
        console.log(`[answer] Answer applied for ${fromUserId}, receivers now: ${pc.getReceivers().map(r => `${r.track?.kind}:${r.track?.id.slice(0,8)}`).join(", ")}`);
      });
    } else if (data.candidate) {
      await enqueueSignaling(fromUserId, async () => {
        const pc = peers.get(fromUserId);
        if (pc && pc.remoteDescription) {
          await pc
            .addIceCandidate(new RTCIceCandidate(data))
            .catch(() => {}); // Silently ignore stale candidates (e.g. unknown ufrag after renegotiation)
        } else {
          // Buffer candidates until remote description is set
          if (!pendingCandidates.has(fromUserId)) {
            pendingCandidates.set(fromUserId, []);
          }
          const buf = pendingCandidates.get(fromUserId)!;
          if (buf.length > 50) buf.shift(); // cap at 50, drop oldest
          buf.push(data);
        }
      });
    }
  });

  conn.on("VoiceChannelUsers", (users: Record<string, string>) => {
    const authoritative = new Map(Object.entries(users));
    useVoiceStore.getState().setParticipants(authoritative);

    // Capture which users are pending in the buffer before replay clears them,
    // so reconciliation below doesn't double-trigger handleUserJoinedVoice.
    const pendingFromBuffer = new Set(bufferedUserJoinedVoiceEvents.keys());

    completeInitialParticipantWait(conn);
    console.log(`VoiceChannelUsers received: ${authoritative.size} participants`);

    // Reconcile WebRTC peers against authoritative participant list
    // Skip P2P peer creation/management when in SFU mode
    if (isInSfuMode() || useVoiceStore.getState().connectionMode === 'sfu' || useVoiceStore.getState().connectionMode === 'attempting-sfu') {
      console.log('[reconcile] Skipping P2P reconciliation (SFU mode)');
    } else if (shouldFallbackToSFU()) {
      console.log('[reconcile] P2P failure threshold reached, falling back to SFU');
      void fallbackToSFU('P2P connection failed (accumulated failures across peer reconnects)');
    } else {
      const currentUser = useAuthStore.getState().user;
      const myId = currentUser?.id;
      // Close peers for users no longer in the channel
      for (const peerId of peers.keys()) {
        if (!authoritative.has(peerId)) {
          console.log(`Reconciliation: closing stale peer ${peerId}`);
          closePeer(peerId);
        }
      }
      // Create peers for users present on server but missing locally (not during initial join —
      // those are handled by buffered join replay above)
      if (localStream) {
        for (const [userId, displayName] of authoritative) {
          if (userId === myId) continue;
          if (!peers.has(userId) && !pendingFromBuffer.has(userId)) {
            console.log(`Reconciliation: creating missing peer for ${userId}`);
            void handleUserJoinedVoice(conn, userId, displayName).catch((err) => {
              console.warn(`Reconciliation: failed to create peer for ${userId}:`, err);
            });
          }
        }
      }
    }
  });

  // Screen share events (multi-sharer)
  conn.on("ScreenShareStarted", (userId: string, displayName: string) => {
    useVoiceStore.getState().addActiveSharer(userId, displayName);
    // Update own isScreenSharing if it's our own event
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      useVoiceStore.getState().setScreenSharing(true);
    }
  });

  conn.on("ScreenShareStopped", (userId: string) => {
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

  conn.on("ActiveSharers", (sharers: Record<string, string>) => {
    useVoiceStore.getState().setActiveSharers(new Map(Object.entries(sharers)));
  });

  // Camera events
  conn.on("CameraStarted", (userId: string, displayName: string) => {
    useVoiceStore.getState().addActiveCamera(userId, displayName);
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      useVoiceStore.getState().setCameraOn(true);
    }
  });

  conn.on("CameraStopped", (userId: string) => {
    const store = useVoiceStore.getState();
    store.removeActiveCamera(userId);
    cameraVideoStreams.delete(userId);
    store.bumpCameraStreamVersion();
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      store.setCameraOn(false);
    }
  });

  conn.on("ActiveCameras", (cameras: Record<string, string>) => {
    useVoiceStore.getState().setActiveCameras(new Map(Object.entries(cameras)));
  });

  // Sharer receives: viewer wants to watch
  conn.on("WatchStreamRequested", (viewerUserId: string) => {
    console.log(`WatchStreamRequested from ${viewerUserId}`);
    addVideoTrackForViewer(viewerUserId);
  });

  // Sharer receives: viewer stopped watching
  conn.on("StopWatchingRequested", (viewerUserId: string) => {
    console.log(`StopWatchingRequested from ${viewerUserId}`);
    removeVideoTrackForViewer(viewerUserId);
  });

  // Voice session replaced (joined voice from another device)
  conn.on("VoiceSessionReplaced", (message: string) => {
    console.warn("Voice session replaced:", message);
    // Force leave voice - clean up all WebRTC state
    pendingVisibilityRejoin = false;
    rejoinInProgress = false;
    cleanupAll();
    useVoiceStore.getState().setCurrentChannel(null);
    useVoiceStore.getState().setParticipants(new Map());
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
    useVoiceStore.getState().setCameraOn(false);
    useVoiceStore.getState().setActiveCameras(new Map());
    useVoiceStore.getState().setFocusedUserId(null);
    useVoiceChatStore.getState().clear();
    useWatchPartyStore.getState().setActiveParty(null);
    useToastStore.getState().addToast("Voice session replaced — you joined from another device.", "info");
  });
}

export function useWebRTC() {
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const isPttActive = useVoiceStore((s) => s.isPttActive);
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const setCurrentChannel = useVoiceStore((s) => s.setCurrentChannel);
  const setParticipants = useVoiceStore((s) => s.setParticipants);

  // PTT listeners are now module-level (see setupPttListeners / useVoiceStore.subscribe above).

  // Mute/unmute local tracks (accounts for PTT mode)
  useEffect(() => {
    if (isInSfuMode()) {
      // In SFU mode, delegate to LiveKit
      const shouldMute = voiceMode === "push-to-talk" ? (isMuted || !isPttActive) : isMuted;
      void sfuToggleMute(shouldMute);
    } else if (localStream) {
      if (voiceMode === "push-to-talk") {
        const enabled = !isMuted && isPttActive;
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = enabled;
        });
      } else {
        const enabled = !isMuted;
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = enabled;
        });
      }
    }
  }, [isMuted, voiceMode, isPttActive]);

  // Deafen - mute all remote audio (mic + screen audio)
  useEffect(() => {
    if (isInSfuMode()) {
      sfuSetDeafened(isDeafened);
    }
    audioElements.forEach((audio) => {
      audio.muted = isDeafened;
    });
    screenAudioElements.forEach((audio) => {
      audio.muted = isDeafened;
    });
  }, [isDeafened]);

  // Sync per-user volume from store to audio elements & GainNodes
  useEffect(() => {
    let prevVolumes = useVoiceStore.getState().userVolumes;
    const unsub = useVoiceStore.subscribe((state) => {
      if (state.userVolumes !== prevVolumes) {
        prevVolumes = state.userVolumes;
        for (const [peerId] of audioElements) {
          const vol = state.userVolumes.get(peerId) ?? 100;
          applyUserVolume(peerId, vol);
        }
      }
    });
    return unsub;
  }, []);

  // Apply output device changes to all remote audio elements
  useEffect(() => {
    currentOutputDeviceId = outputDeviceId || "default";
    audioElements.forEach((audio) =>
      applyOutputDevice(audio, currentOutputDeviceId),
    );
    screenAudioElements.forEach((audio) =>
      applyOutputDevice(audio, currentOutputDeviceId),
    );
  }, [outputDeviceId]);

  // const buildAudioConstraints = useCallback(():
  //   | MediaTrackConstraints
  //   | boolean => {
  //   const base: MediaTrackConstraints = {
  //     noiseSuppression,
  //     echoCancellation,
  //     autoGainControl,
  //   };
  //   if (inputDeviceId && inputDeviceId !== "default") {
  //     return { ...base, deviceId: { exact: inputDeviceId } };
  //   }
  //   return base;
  // }, [inputDeviceId, noiseSuppression, echoCancellation, autoGainControl]);

  const buildAudioConstraintsResolved =
    useCallback(async (): Promise<MediaTrackConstraints> => {
      const base: MediaTrackConstraints = {
        noiseSuppression,
        echoCancellation,
        autoGainControl,
      };
      // Resolve "default" to actual device ID to prevent microphone cutouts on window blur
      if (!inputDeviceId || inputDeviceId === "default") {
        const resolvedDeviceId = await resolveDefaultInputDevice();
        if (resolvedDeviceId !== "default") {
          return { ...base, deviceId: { exact: resolvedDeviceId } };
        }
        return base;
      }
      return { ...base, deviceId: { exact: inputDeviceId } };
    }, [inputDeviceId, noiseSuppression, echoCancellation, autoGainControl]);

  // Switch input device / processing while connected
  useEffect(() => {
    if (!currentChannelId) return;
    if (Date.now() - lastVoiceJoinTime < DEVICE_EFFECT_SKIP_WINDOW_MS) {
      return;
    }
    // In SFU mode, delegate device switching to LiveKit
    if (isInSfuMode()) {
      void sfuSetInputDevice(inputDeviceId);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        deviceResolutionFailed = false;
        const audioConstraints = await buildAudioConstraintsResolved();
        const constraints: MediaStreamConstraints = {
          audio: audioConstraints,
        };
        let newStream: MediaStream;
        try {
          newStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (firstErr: any) {
          if (firstErr?.name === "OverconstrainedError" || firstErr?.name === "NotFoundError") {
            console.warn(`Saved audio device unavailable (${firstErr.name}), falling back to default`);
            const { noiseSuppression: ns, echoCancellation: ec, autoGainControl: agc } = useVoiceStore.getState();
            newStream = await navigator.mediaDevices.getUserMedia({
              audio: { noiseSuppression: ns, echoCancellation: ec, autoGainControl: agc },
            });
          } else {
            throw firstErr;
          }
        }
        if (cancelled) {
          newStream.getTracks().forEach((track) => track.stop());
          return;
        }
        await replaceLocalAudioStream(newStream);
      } catch (err) {
        console.error("Failed to switch microphone:", err);
        useToastStore.getState().addToast("Failed to switch microphone.", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildAudioConstraintsResolved, currentChannelId]);

  // Toggle RNNoise suppressor mid-call when noiseSuppression setting changes
  useEffect(() => {
    if (!currentChannelId || !localStream) return;
    // Skip if we just joined — applySuppressor already ran
    if (Date.now() - lastVoiceJoinTime < DEVICE_EFFECT_SKIP_WINDOW_MS) return;

    let cancelled = false;
    (async () => {
      try {
        if (noiseSuppression && !noiseSuppressor) {
          // Enable: create suppressor, replace peer tracks with processed output
          const suppressor = await createNoiseSuppressor();
          const ctx = ensureAudioContext();
          const processed = await suppressor.initialize(localStream!, ctx);
          if (cancelled) {
            suppressor.destroy();
            return;
          }
          if (processed) {
            noiseSuppressor = suppressor;
            peerStream = processed;
            const processedTrack = processed.getAudioTracks()[0];
            if (processedTrack) {
              // Collect screen-audio track IDs to skip
              const screenAudioTrackIds = new Set<string>();
              for (const senders of screenTrackSenders.values()) {
                for (const s of senders) {
                  if (s.track?.kind === "audio") screenAudioTrackIds.add(s.track.id);
                }
              }
              for (const [peerId, pc] of peers) {
                const sender = pc.getSenders().find(
                  s => s.track?.kind === "audio" && !screenAudioTrackIds.has(s.track!.id)
                );
                if (sender) {
                  try {
                    await sender.replaceTrack(processedTrack);
                  } catch (err) {
                    console.warn(`[noiseSuppression] Failed to replace track for ${peerId}:`, err);
                  }
                }
              }
            }
            console.log("[noiseSuppression] RNNoise enabled mid-call");
          }
        } else if (!noiseSuppression && noiseSuppressor) {
          // Disable: destroy suppressor, replace peer tracks with raw localStream
          noiseSuppressor.destroy();
          noiseSuppressor = null;
          peerStream = localStream;
          const rawTrack = localStream!.getAudioTracks()[0];
          if (rawTrack) {
            const screenAudioTrackIds = new Set<string>();
            for (const senders of screenTrackSenders.values()) {
              for (const s of senders) {
                if (s.track?.kind === "audio") screenAudioTrackIds.add(s.track.id);
              }
            }
            for (const [peerId, pc] of peers) {
              const sender = pc.getSenders().find(
                s => s.track?.kind === "audio" && !screenAudioTrackIds.has(s.track!.id)
              );
              if (sender) {
                try {
                  await sender.replaceTrack(rawTrack);
                } catch (err) {
                  console.warn(`[noiseSuppression] Failed to replace track for ${peerId}:`, err);
                }
              }
            }
          }
          console.log("[noiseSuppression] RNNoise disabled mid-call");
        }
      } catch (err) {
        console.error("[noiseSuppression] Failed to toggle RNNoise:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noiseSuppression, currentChannelId]);

  // React to camera quality changes mid-stream (re-acquire camera + replaceTrack + bitrate)
  useEffect(() => {
    if (!currentChannelId) return;
    let prevQuality = useVoiceStore.getState().cameraQuality;
    const unsub = useVoiceStore.subscribe((state) => {
      if (state.cameraQuality === prevQuality) return;
      prevQuality = state.cameraQuality;
      if (!state.isCameraOn) return;
      const preset = CAMERA_QUALITY_CONSTRAINTS[state.cameraQuality];
      (async () => {
        try {
          if (isInSfuMode()) {
            await sfuUpdateCameraQuality({
              width: preset.width,
              height: preset.height,
              frameRate: preset.frameRate,
              maxBitrate: preset.maxBitrate,
            });
            useVoiceStore.getState().bumpCameraStreamVersion();
            console.log(`[cameraQuality] SFU: Switched to ${state.cameraQuality} (${preset.width}x${preset.height}@${preset.frameRate}fps)`);
            return;
          }
          if (!cameraStream) return;
          const voiceState = useVoiceStore.getState();
          const videoConstraints: MediaTrackConstraints = {
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: preset.frameRate },
          };
          if (voiceState.cameraDeviceId && voiceState.cameraDeviceId !== "default") {
            videoConstraints.deviceId = { exact: voiceState.cameraDeviceId };
          }
          const newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
          const newTrack = newStream.getVideoTracks()[0];
          // Stop old tracks
          cameraStream?.getTracks().forEach((t) => t.stop());
          cameraStream = newStream;
          newTrack.onended = () => { stopCameraInternal(); };
          // Replace track on all peers and apply bitrate
          for (const [peerId, sender] of cameraTrackSenders) {
            try {
              await sender.replaceTrack(newTrack);
              await applyBitrateToSender(sender, preset.maxBitrate);
            } catch (err) {
              console.warn(`[cameraQuality] Failed to replace track for ${peerId}:`, err);
            }
          }
          useVoiceStore.getState().bumpCameraStreamVersion();
          console.log(`[cameraQuality] Switched to ${state.cameraQuality} (${preset.width}x${preset.height}@${preset.frameRate}fps)`);
        } catch (err) {
          console.error("[cameraQuality] Failed to change camera quality:", err);
        }
      })();
    });
    return unsub;
  }, [currentChannelId]);

  // React to screen share quality changes mid-stream (applyConstraints + bitrate, no re-prompt)
  useEffect(() => {
    if (!currentChannelId) return;
    let prevQuality = useVoiceStore.getState().screenShareQuality;
    const unsub = useVoiceStore.subscribe((state) => {
      if (state.screenShareQuality === prevQuality) return;
      prevQuality = state.screenShareQuality;
      if (!state.isScreenSharing) return;
      const preset = SCREEN_SHARE_QUALITY_CONSTRAINTS[state.screenShareQuality];
      (async () => {
        try {
          if (isInSfuMode()) {
            await sfuUpdateScreenShareQuality({
              maxFramerate: preset.frameRate,
              maxBitrate: preset.maxBitrate,
            });
            console.log(`[screenShareQuality] SFU: Switched to ${state.screenShareQuality} (${preset.frameRate}fps, ${preset.maxBitrate / 1000}kbps)`);
            return;
          }
          if (!screenStream) return;
          // Apply frameRate constraint to the existing video track
          const videoTrack = screenStream?.getVideoTracks()[0];
          if (videoTrack) {
            await videoTrack.applyConstraints({ frameRate: { ideal: preset.frameRate } });
          }
          // Apply bitrate to all screen share video senders
          for (const [, senders] of screenTrackSenders) {
            for (const sender of senders) {
              if (sender.track?.kind === "video") {
                await applyBitrateToSender(sender, preset.maxBitrate);
              }
            }
          }
          console.log(`[screenShareQuality] Switched to ${state.screenShareQuality} (${preset.frameRate}fps, ${preset.maxBitrate / 1000}kbps)`);
        } catch (err) {
          console.error("[screenShareQuality] Failed to change screen share quality:", err);
        }
      })();
    });
    return unsub;
  }, [currentChannelId]);

  // Broadcast mute/deafen state to everyone in the server
  useEffect(() => {
    if (!currentChannelId) return;
    let cancelled = false;
    (async () => {
      try {
        const conn = await ensureConnected();
        if (cancelled) return;
        await conn.invoke("UpdateVoiceState", isMuted, isDeafened);
      } catch (err) {
        console.warn("Failed to update voice state", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentChannelId, isMuted, isDeafened]);

  // Register SignalR listeners once (module-level flag, not per-instance)
  useEffect(() => {
    void initializeTurn();
    const unsubscribe = subscribeTurnCredentials((creds) => {
      const iceServers = buildIceServersFromTurn(creds);
      setIceServers(iceServers);
      void applyIceServersToPeers(iceServers).then(() =>
        restartIceForAllPeers(),
      );
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Register SignalR listeners once (module-level flag, not per-instance)
  useEffect(() => {
    setupSignalRListeners();
  }, []);

  // Handle window visibility changes to resume audio
  useEffect(() => {
    if (!currentChannelId) return;

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Window became visible again - attempt to unlock/resume audio
        attemptAudioUnlock();
      }
    };

    const handleWindowFocus = () => {
      // Window gained focus - attempt to unlock/resume audio
      attemptAudioUnlock();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [currentChannelId]);

  const joinVoice = useCallback(
    async (channelId: string) => {
      useVoiceStore.getState().setJoiningVoice(true);
      intentionalLeave = false;
      pendingVisibilityRejoin = false;
      rejoinInProgress = false;
      try {
        // Leave current if any (both P2P and SFU)
        if (currentChannelId) {
          if (isInSfuMode()) {
            await disconnectFromLiveKit();
          }
          const conn = getConnection();
          await Promise.race([
            conn.invoke("LeaveVoiceChannel", currentChannelId),
            new Promise((_, reject) => setTimeout(() => reject(new Error("LeaveVoiceChannel timeout")), 5000)),
          ]);
          cleanupAll();
        }

        // Reset failure tracking for new session
        p2pFailedPeers.clear();
        channelRelayDetected = false;
        useVoiceStore.getState().resetP2PFailures();
        useVoiceStore.getState().setFallbackReason(null);

        // Check if user wants SFU mode
        if (useVoiceStore.getState().forceSfuMode) {
          console.log('[join] User preference: using SFU relay mode');
          setCurrentChannel(channelId);
          useVoiceStore.getState().setConnectionMode('attempting-sfu');

          // Join SignalR voice group first (for sidebar/state updates)
          const conn = getConnection();
          const voiceState = useVoiceStore.getState();
          await Promise.race([
            conn.invoke('JoinVoiceChannel', channelId, voiceState.isMuted, voiceState.isDeafened),
            new Promise((_, reject) => setTimeout(() => reject(new Error("JoinVoiceChannel timeout")), 10000)),
          ]);

          // Connect via LiveKit
          await connectToLiveKit(channelId);

          // Notify other peers in the channel that relay is active
          conn.invoke('NotifyRelayMode', channelId).catch(() => {});

          voiceState.setConnectionState('connected');
          lastVoiceJoinTime = Date.now();
          startStatsCollection();
          const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
          useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);
          return;
        }

        await initializeTurn();

        // Reset device resolution flag so each voice session gets a fresh attempt
        deviceResolutionFailed = false;
        useVoiceStore.getState().setConnectionMode('attempting-p2p');

        try {
          const audioConstraints = await buildAudioConstraintsResolved();
          const constraints: MediaStreamConstraints = {
            audio: audioConstraints,
          };
          try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
          } catch (firstErr: any) {
            // If the saved device ID is stale/invalid, retry with no device constraint
            if (firstErr?.name === "OverconstrainedError" || firstErr?.name === "NotFoundError") {
              console.warn(`Saved audio device unavailable (${firstErr.name}), falling back to default`);
              const { noiseSuppression, echoCancellation, autoGainControl } = useVoiceStore.getState();
              localStream = await navigator.mediaDevices.getUserMedia({
                audio: { noiseSuppression, echoCancellation, autoGainControl },
              });
            } else {
              throw firstErr;
            }
          }
          const audioTracks = localStream.getAudioTracks();
          console.log(
            `Got local audio stream, tracks: ${audioTracks.length}`,
            audioTracks.map(t => `id=${t.id.slice(0,8)} enabled=${t.enabled} readyState=${t.readyState} label="${t.label}"`).join(", "),
          );
        } catch (err) {
          console.error("Could not access microphone:", err);
          useToastStore.getState().addToast("Could not access microphone. Check permissions.", "error");
          return;
        }

        // Initialize noise suppressor (creates processed peerStream)
        await applySuppressor(localStream);

        // Apply current mute state to the new stream immediately
        const voiceState = useVoiceStore.getState();
        const shouldEnable =
          !voiceState.isMuted &&
          (voiceState.voiceMode === "voice-activity" || voiceState.isPttActive);
        console.log(`[join] Track enabled=${shouldEnable} (muted=${voiceState.isMuted}, voiceMode=${voiceState.voiceMode}, pttActive=${voiceState.isPttActive})`);
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = shouldEnable;
        });

        // Set up audio analyser for local user's speaking indicator
        const currentUser = useAuthStore.getState().user;
        if (currentUser) {
          addAnalyser(currentUser.id, localStream);
        }

        // Start keep-alive to prevent audio suspension in background
        startAudioKeepAlive();

        const conn = getConnection();
        beginInitialParticipantWait(conn);
        try {
          await Promise.race([
            conn.invoke("JoinVoiceChannel", channelId, voiceState.isMuted, voiceState.isDeafened),
            new Promise((_, reject) => setTimeout(() => reject(new Error("JoinVoiceChannel timeout")), 10000)),
          ]);
        } catch (err) {
          cancelInitialParticipantWait();
          console.error("Failed to join voice channel:", err);
          cleanupAll();
          setCurrentChannel(null);
          setParticipants(new Map());
          voiceState.setScreenSharing(false);
          voiceState.setActiveSharers(new Map());
          voiceState.setWatching(null);
          voiceState.setCameraOn(false);
          voiceState.setActiveCameras(new Map());
          voiceState.setFocusedUserId(null);
          voiceState.setVoiceChatOpen(false);
          voiceState.setConnectionState("disconnected");
          useVoiceChatStore.getState().clear();
          useToastStore.getState().addToast("Failed to join voice channel.", "error");
          return;
        }

        // Yield to event loop so queued SignalR events (ChannelRelayActive) can process
        await new Promise(resolve => setTimeout(resolve, 0));

        // If relay users exist in this channel, skip P2P and connect via SFU
        if (channelRelayDetected) {
          console.log('[join] Channel has relay users, connecting via SFU');
          cleanupP2PConnections();
          setCurrentChannel(channelId);
          await connectToLiveKit(channelId);
          conn.invoke('NotifyRelayMode', channelId).catch(() => {});
          voiceState.setConnectionState('connected');
          lastVoiceJoinTime = Date.now();
          startStatsCollection();
          const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
          useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);
          return;
        }

        voiceState.setConnectionState("connected");
        voiceState.setConnectionMode("p2p");
        // Prevent the input device effect from re-obtaining a stream
        // — joinVoice already has the right stream
        lastVoiceJoinTime = Date.now();
        setCurrentChannel(channelId);

        // Start collecting connection quality stats
        startStatsCollection();

        // Initialize voice chat store
        const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
        useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);
      } finally {
        useVoiceStore.getState().setJoiningVoice(false);
      }
    },
    [buildAudioConstraintsResolved, currentChannelId, setCurrentChannel, setParticipants],
  );

  const leaveVoice = useCallback(async () => {
    // Set intentional leave flag FIRST to prevent auto-rejoin from racing
    intentionalLeave = true;
    pendingVisibilityRejoin = false;
    rejoinInProgress = false;

    // Immediate local cleanup — don't wait for server response
    cleanupAll();
    p2pFailedPeers.clear();
    setCurrentChannel(null);
    setParticipants(new Map());
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
    useVoiceStore.getState().setCameraOn(false);
    useVoiceStore.getState().setActiveCameras(new Map());
    useVoiceStore.getState().setFocusedUserId(null);
    useVoiceStore.getState().setVoiceChatOpen(false);
    useVoiceStore.getState().setConnectionMode('p2p');
    useVoiceStore.getState().setFallbackReason(null);
    useVoiceStore.getState().resetP2PFailures();
    useVoiceChatStore.getState().clear();
    useWatchPartyStore.getState().setActiveParty(null);

    // Disconnect from LiveKit if in SFU mode (fire and forget)
    if (isInSfuMode()) {
      disconnectFromLiveKit().catch(() => {});
    }

    // Notify server with timeout — fire and forget so button is never stuck
    if (currentChannelId) {
      const conn = getConnection();
      Promise.race([
        conn.invoke("LeaveVoiceChannel", currentChannelId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Leave timeout")), 5000),
        ),
      ]).catch((error) => {
        console.warn("Failed to notify server when leaving voice channel:", error);
      });
    }
  }, [currentChannelId, setCurrentChannel, setParticipants]);

  const startScreenShare = useCallback(async () => {
    await startScreenShareInternal();
  }, []);

  const stopScreenShare = useCallback(async () => {
    await stopScreenShareInternal();
  }, []);

  const startCamera = useCallback(async () => {
    await startCameraInternal();
  }, []);

  const stopCamera = useCallback(async () => {
    await stopCameraInternal();
  }, []);

  const switchCamera = useCallback(async () => {
    await switchCameraInternal();
  }, []);

  // Send periodic heartbeat + reconcile WebRTC peers against server state
  useEffect(() => {
    if (!currentChannelId) return;
    const interval = setInterval(() => {
      const conn = getConnection();
      if (conn.state === "Connected") {
        conn.invoke("VoiceHeartbeat").catch(() => {});
        // Periodic peer reconciliation: fetch authoritative participant list
        // and let the VoiceChannelUsers handler reconcile peers
        conn.invoke("GetVoiceChannelUsers", currentChannelId)
          .then((users: Record<string, string>) => {
            const authoritative = new Map(Object.entries(users));
            useVoiceStore.getState().setParticipants(authoritative);

            // Skip P2P peer management when in SFU mode
            if (isInSfuMode() || useVoiceStore.getState().connectionMode === 'sfu' || useVoiceStore.getState().connectionMode === 'attempting-sfu') {
              return;
            }

            const currentUser = useAuthStore.getState().user;
            const myId = currentUser?.id;
            for (const peerId of peers.keys()) {
              if (!authoritative.has(peerId)) {
                console.log(`Periodic reconciliation: closing stale peer ${peerId}`);
                closePeer(peerId);
              }
            }
            if (localStream) {
              for (const [userId, displayName] of authoritative) {
                if (userId === myId) continue;
                if (!peers.has(userId)) {
                  console.log(`Periodic reconciliation: creating missing peer for ${userId}`);
                  void handleUserJoinedVoice(conn, userId, displayName).catch(console.error);
                }
              }
            }
          })
          .catch(() => {});
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [currentChannelId]);

  // Auto-rejoin voice channel after SignalR reconnects (e.g. server restart)
  useEffect(() => {
    return onReconnected(async () => {
      if (intentionalLeave) return;
      const channelId = useVoiceStore.getState().currentChannelId;
      if (!channelId) return;

      // If tab is hidden, delay rejoin until tab becomes visible
      // getUserMedia requires user gesture or visible tab
      if (document.hidden) {
        pendingVisibilityRejoin = true;
        console.log("SignalR reconnected but tab is hidden, will rejoin when visible");
        return;
      }
      await attemptVoiceRejoin("signalr-reconnect");
    });
  }, []);

  // Handle tab visibility changes - rejoin voice if we missed reconnection while hidden
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.hidden) return;
      if (intentionalLeave) {
        pendingVisibilityRejoin = false;
        return;
      }

      const channelId = useVoiceStore.getState().currentChannelId;
      if (!channelId) {
        pendingVisibilityRejoin = false;
        return;
      }

      // Only rejoin if SignalR actually reconnected while hidden (the proper trigger).
      // Previously this also had a "disconnectedRecovery" path that fired when
      // connectionState wasn't "connected" — but that was overeager and raced
      // with other reconnect paths, causing unnecessary teardown/rejoin cycles.
      if (pendingVisibilityRejoin) {
        const conn = getConnection();
        if (conn.state === "Connected") {
          await attemptVoiceRejoin("visibility-pending");
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return { joinVoice, leaveVoice, startScreenShare, stopScreenShare, startCamera, stopCamera, switchCamera };
}
