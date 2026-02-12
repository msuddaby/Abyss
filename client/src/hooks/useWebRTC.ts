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
} from "@abyss/shared";

const STUN_URL =
  import.meta.env.VITE_STUN_URL || "stun:stun.l.google.com:19302";
let currentIceServers: RTCIceServer[] = [{ urls: STUN_URL }];
let turnInitPromise: Promise<void> | null = null;
const iceRestartInFlight: Set<string> = new Set();

// Per-peer cooldown to prevent rapid ICE restart loops
const lastIceRestartTime: Map<string, number> = new Map();
const ICE_RESTART_COOLDOWN = 30_000; // 30s minimum between restarts per peer

// Flag to prevent the input device effect from re-obtaining a stream right after joinVoice
let skipNextDeviceEffect = false;

// Flag to buffer UserJoinedVoice events while waiting for initial VoiceChannelUsers
let waitingForInitialParticipants = false;
const INITIAL_PARTICIPANTS_TIMEOUT_MS = 5000;
let initialParticipantsTimeout: ReturnType<typeof setTimeout> | null = null;
// Buffered UserJoinedVoice events (userId -> displayName) while initial participant list is pending
const bufferedUserJoinedVoiceEvents: Map<string, string> = new Map();
// Flag indicating SignalR reconnected while tab was hidden and voice must be rejoined on visibility
let pendingVisibilityRejoin = false;
// Guard to prevent concurrent visibility-triggered rejoins
let rejoinInProgress = false;

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

// Per-peer GainNode chain for user volume control (0-200%)
const gainNodes: Map<string, { source: MediaStreamAudioSourceNode; gain: GainNode; dest: MediaStreamAudioDestinationNode }> = new Map();

// Connection stats
export interface ConnectionStats {
  roundTripTime: number | null;
  packetLoss: number | null;
  jitter: number | null;
}
let cachedStats: ConnectionStats = { roundTripTime: null, packetLoss: null, jitter: null };
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function getConnectionStats(): ConnectionStats {
  return cachedStats;
}

function startStatsCollection() {
  if (statsInterval) return;
  statsInterval = setInterval(async () => {
    let totalRtt = 0, rttCount = 0;
    let totalLoss = 0, lossCount = 0;
    let totalJitter = 0, jitterCount = 0;

    for (const pc of peers.values()) {
      try {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime != null) {
            totalRtt += report.currentRoundTripTime * 1000; // to ms
            rttCount++;
          }
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            if (report.packetsLost != null && report.packetsReceived != null) {
              const total = report.packetsLost + report.packetsReceived;
              if (total > 0) {
                totalLoss += (report.packetsLost / total) * 100;
                lossCount++;
              }
            }
            if (report.jitter != null) {
              totalJitter += report.jitter * 1000; // to ms
              jitterCount++;
            }
          }
        });
      } catch {
        // peer may have closed
      }
    }

    cachedStats = {
      roundTripTime: rttCount > 0 ? totalRtt / rttCount : null,
      packetLoss: lossCount > 0 ? totalLoss / lossCount : null,
      jitter: jitterCount > 0 ? totalJitter / jitterCount : null,
    };
  }, 3000);
}

function stopStatsCollection() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  cachedStats = { roundTripTime: null, packetLoss: null, jitter: null };
}

// ICE reconnection timers per peer
const iceReconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

// Signaling queue — serializes WebRTC signaling operations per peer to prevent races
const signalingQueues: Map<string, Promise<void>> = new Map();

function enqueueSignaling(
  peerId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = signalingQueues.get(peerId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn()).catch((err) => {
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

function ensureAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }
  // Resume if suspended (can happen when tab is backgrounded)
  if (audioContext.state === "suspended") {
    audioContext.resume().catch((err) => {
      console.warn("Failed to resume audio context:", err);
    });
  }
  return audioContext;
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
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (err) {
      console.warn("Failed to resume audio context:", err);
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
      if (isLocal && store.voiceMode === "push-to-talk") {
        // In PTT mode, the speaking indicator follows the PTT key state
        // rather than relying on the analyser's cloned stream RMS,
        // which can break in some browsers when track.enabled is toggled.
        speaking = store.isPttActive && !store.isMuted;
      }
      store.setSpeaking(userId, speaking);

      if (currentUserId && userId === currentUserId) {
        store.setLocalInputLevel(rms);
        if (localStream && store.voiceMode === "voice-activity") {
          const sensitivity = Math.min(1, Math.max(0, store.inputSensitivity));
          const threshold =
            INPUT_THRESHOLD_MAX -
            (INPUT_THRESHOLD_MAX - INPUT_THRESHOLD_MIN) * sensitivity;
          const now = Date.now();
          const aboveThreshold = rms >= threshold;
          if (aboveThreshold) vaLastAboveThresholdAt = now;
          // Hold mic open for VA_HOLD_OPEN_MS after last above-threshold sample
          const enabled = !store.isMuted && (now - vaLastAboveThresholdAt < VA_HOLD_OPEN_MS);
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
export function getScreenVideoStream(userId: string): MediaStream | undefined {
  return screenVideoStreams.get(userId);
}

export function getLocalScreenStream(): MediaStream | null {
  return screenStream;
}

export function getCameraVideoStream(userId: string): MediaStream | undefined {
  return cameraVideoStreams.get(userId);
}

export function getLocalCameraStream(): MediaStream | null {
  return cameraStream;
}

export function applyUserVolume(peerId: string, volume: number) {
  const entry = gainNodes.get(peerId);
  if (entry) {
    const now = entry.gain.context.currentTime;
    entry.gain.gain.cancelScheduledValues(now);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
    entry.gain.gain.linearRampToValueAtTime(volume / 100, now + 0.05);
  }
}

function buildIceServersFromTurn(creds: {
  urls: string[];
  username: string;
  credential: string;
}): RTCIceServer[] {
  return [
    { urls: STUN_URL },
    {
      urls: creds.urls,
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
  await enqueueSignaling(peerId, async () => {
    console.warn(`Recreating peer connection for ${peerId}`);
    const pc = createPeerConnection(peerId);
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream!));
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
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await conn.invoke(
      "SendSignal",
      peerId,
      JSON.stringify({ type: "offer", sdp: offer.sdp }),
    );
  });
}

async function restartIceForPeer(peerId: string, _pc?: RTCPeerConnection) {
  if (iceRestartInFlight.has(peerId)) return;

  // Enforce cooldown to prevent rapid restart loops
  const lastRestart = lastIceRestartTime.get(peerId);
  if (lastRestart && Date.now() - lastRestart < ICE_RESTART_COOLDOWN) {
    console.log(`Skipping ICE restart for ${peerId} (cooldown, ${Math.round((ICE_RESTART_COOLDOWN - (Date.now() - lastRestart)) / 1000)}s remaining)`);
    return;
  }

  iceRestartInFlight.add(peerId);
  try {
    await enqueueSignaling(peerId, async () => {
      // Always use the current PC from the map — the passed-in reference may be stale
      const pc = peers.get(peerId);
      if (!pc || pc.signalingState !== "stable") return;
      lastIceRestartTime.set(peerId, Date.now());
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
    await restartIceForPeer(peerId);
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

function consumeTrackInfo(peerId: string, trackId: string): TrackInfoType | undefined {
  const byId = pendingTrackInfoById.get(peerId);
  if (byId?.has(trackId)) {
    const trackType = byId.get(trackId)!;
    byId.delete(trackId);
    if (byId.size === 0) pendingTrackInfoById.delete(peerId);
    return trackType;
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

function applyIncomingRemoteTrack(
  peerId: string,
  track: MediaStreamTrack,
  stream: MediaStream,
  trackType?: TrackInfoType,
) {
  if (track.kind === "audio") {
    const isScreenAudio = trackType === "screen-audio";
    if (isScreenAudio) {
      let audio = screenAudioElements.get(peerId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute("playsinline", "true");
        audio.volume = 1.0;
        screenAudioElements.set(peerId, audio);
      }
      applyOutputDevice(audio, currentOutputDeviceId);
      audio.srcObject = stream;
      audio.muted = useVoiceStore.getState().isDeafened;
      audio
        .play()
        .then(() => useVoiceStore.getState().setNeedsAudioUnlock(false))
        .catch((err) => {
          console.error("Screen audio play failed:", err);
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

    // Route through GainNode for per-user volume control (0-200%)
    try {
      const ctx = ensureAudioContext();
      // Clean up previous gain chain for this peer
      const prev = gainNodes.get(peerId);
      if (prev) prev.source.disconnect();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(dest);
      const vol = useVoiceStore.getState().userVolumes.get(peerId) ?? 100;
      gain.gain.value = vol / 100;
      gainNodes.set(peerId, { source, gain, dest });
      audio.srcObject = dest.stream;
    } catch (err) {
      console.warn("GainNode chain failed, using raw stream:", err);
      audio.srcObject = stream;
    }

    audio.muted = useVoiceStore.getState().isDeafened;
    audio
      .play()
      .then(() => useVoiceStore.getState().setNeedsAudioUnlock(false))
      .catch((err) => {
        console.error("Audio play failed:", err);
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

  pendingForPeer!.delete(trackId);
  if (!pendingForPeer!.size) pendingRemoteTracks.delete(peerId);

  const trackType = consumeTrackInfo(peerId, trackId);
  applyIncomingRemoteTrack(peerId, pendingTrack.track, pendingTrack.stream, trackType);
}

function queuePendingRemoteTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream) {
  if (!pendingRemoteTracks.has(peerId)) {
    pendingRemoteTracks.set(peerId, new Map());
  }
  const pendingForPeer = pendingRemoteTracks.get(peerId)!;
  const existing = pendingForPeer.get(track.id);
  if (existing) clearTimeout(existing.timeout);

  const timeout = setTimeout(() => {
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

function createPeerConnection(peerId: string): RTCPeerConnection {
  closePeer(peerId);
  pendingCandidates.delete(peerId);
  const pc = new RTCPeerConnection({ iceServers: currentIceServers });
  peers.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const conn = getConnection();
      conn
        .invoke("SendSignal", peerId, JSON.stringify(event.candidate.toJSON()))
        .catch((err) => console.error("Failed to send ICE candidate:", err));
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`ICE state for ${peerId}: ${pc.iceConnectionState}`);
    const voiceState = useVoiceStore.getState();

    if (pc.iceConnectionState === "checking") {
      // Browsers (especially Firefox) can stall at "checking" without ever
      // reaching "failed". Set a hard timeout so we don't wait forever.
      if (!iceReconnectTimers.has(peerId) && !iceRestartInFlight.has(peerId)) {
        const timer = setTimeout(() => {
          iceReconnectTimers.delete(peerId);
          if (pc.iceConnectionState === "checking") {
            console.warn(`ICE stuck at checking for ${peerId}, restarting...`);
            restartIceForPeer(peerId, pc);
          }
        }, 30_000);
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
          restartIceForPeer(peerId, pc);
        }
        iceReconnectTimers.delete(peerId);
      }, 5000);
      iceReconnectTimers.set(peerId, timer);
    } else if (pc.iceConnectionState === "failed") {
      console.warn(`ICE failed for ${peerId}, attempting restart...`);
      voiceState.setConnectionState("reconnecting");
      useToastStore.getState().addToast("Connection issue detected. Reconnecting...", "error");
      restartIceForPeer(peerId, pc);
    } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      // Clear reconnect timer
      const timer = iceReconnectTimers.get(peerId);
      if (timer) { clearTimeout(timer); iceReconnectTimers.delete(peerId); }
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
    console.log(`Got remote ${track.kind} track from ${peerId}`);
    const stream =
      event.streams && event.streams.length > 0
        ? event.streams[0]
        : new MediaStream([track]);
    const trackType = consumeTrackInfo(peerId, track.id);
    if (trackType) {
      applyIncomingRemoteTrack(peerId, track, stream, trackType);
      return;
    }
    queuePendingRemoteTrack(peerId, track, stream);
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
  const gainEntry = gainNodes.get(peerId);
  if (gainEntry) { gainEntry.source.disconnect(); gainNodes.delete(peerId); }
  const hadScreen = screenVideoStreams.delete(peerId);
  const hadCamera = cameraVideoStreams.delete(peerId);
  if (hadScreen) useVoiceStore.getState().bumpScreenStreamVersion();
  if (hadCamera) useVoiceStore.getState().bumpCameraStreamVersion();
  pendingCandidates.delete(peerId);
  clearPendingTrackStateForPeer(peerId);
  screenTrackSenders.delete(peerId);
  cameraTrackSenders.delete(peerId);
  iceRestartInFlight.delete(peerId);
  signalingQueues.delete(peerId);
  lastIceRestartTime.delete(peerId);
  const timer = iceReconnectTimers.get(peerId);
  if (timer) { clearTimeout(timer); iceReconnectTimers.delete(peerId); }
}

function cleanupAll() {
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
  gainNodes.forEach((entry) => entry.source.disconnect());
  gainNodes.clear();
  screenVideoStreams.clear();
  cameraVideoStreams.clear();
  pendingCandidates.clear();
  clearAllPendingTrackState();
  screenTrackSenders.clear();
  cameraTrackSenders.clear();
  signalingQueues.clear();
  lastIceRestartTime.clear();
  // Clear ICE reconnect timers
  iceReconnectTimers.forEach((t) => clearTimeout(t));
  iceReconnectTimers.clear();
  cancelInitialParticipantWait();
  stopStatsCollection();
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

  for (const pc of peers.values()) {
    const sender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
      } catch (err) {
        console.warn("Failed to replace audio track:", err);
      }
    } else {
      pc.addTrack(newTrack, newStream);
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
    const isLinuxElectron = window.electron?.platform === 'linux';

    if (isLinuxElectron) {
      // On Linux Electron, use getUserMedia with chromeMediaSource to avoid the
      // PipeWire double-dialog issue (getDisplayMedia + setDisplayMediaRequestHandler
      // each trigger separate PipeWire portal sessions)
      screenStream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
          },
        } as any,
        audio: false,
      });
    } else {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    }

    const videoTrack = screenStream.getVideoTracks()[0];

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
    const conn = getConnection();

    // Remove all screen tracks from all viewers we're sending to and renegotiate
    const shareEntries = Array.from(screenTrackSenders.entries());
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
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
    }

    voiceState.setScreenSharing(false);

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
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 640 },
      height: { ideal: 480 },
    };
    if (voiceState.cameraDeviceId && voiceState.cameraDeviceId !== "default") {
      videoConstraints.deviceId = { exact: voiceState.cameraDeviceId };
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

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
    const activeScreenStream = screenStream;
    if (!activeScreenStream) return;
    const pc = peers.get(viewerUserId);
    if (!pc) return;

    const conn = getConnection();
    const senders: RTCRtpSender[] = [];

    // Add video tracks with track-info so the receiver knows it's a screen track
    for (const track of activeScreenStream.getVideoTracks()) {
      await sendTrackInfo(conn, viewerUserId, "screen", track.id);
      console.log(`Adding screen video track for viewer ${viewerUserId}`);
      senders.push(pc.addTrack(track, activeScreenStream));
    }

    // Add audio tracks (tab/system audio) with a distinct track-info type
    // so the receiver plays them through a separate element instead of
    // overwriting the mic audio.
    for (const track of activeScreenStream.getAudioTracks()) {
      await sendTrackInfo(conn, viewerUserId, "screen-audio", track.id);
      console.log(`Adding screen audio track for viewer ${viewerUserId}`);
      senders.push(pc.addTrack(track, activeScreenStream));
    }

    if (senders.length === 0) return;
    screenTrackSenders.set(viewerUserId, senders);

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
  const conn = getConnection();
  useVoiceStore.getState().setWatching(sharerUserId);
  await conn.invoke("RequestWatchStream", sharerUserId);
}

export async function stopWatching() {
  const store = useVoiceStore.getState();
  const sharerUserId = store.watchingUserId;
  if (!sharerUserId) return;

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
    const pc = createPeerConnection(userId);

    // Add audio tracks only - screen track is added lazily on WatchStreamRequested
    localStream!
      .getTracks()
      .forEach((track) => pc.addTrack(track, localStream!));

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
    await pc.setLocalDescription(offer);
    console.log(`Sending offer to ${userId}`);
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

function setupSignalRListeners() {
  const conn = getConnection();
  if (listenersRegisteredForConnection === conn) return;
  listenersRegisteredForConnection = conn;

  conn.on("UserJoinedVoice", (userId: string, displayName: string) => {
    console.log(`UserJoinedVoice: ${displayName} (${userId})`);

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

  conn.on("ReceiveSignal", async (fromUserId: string, signal: string) => {
    // Ignore signals if we're not in a voice channel — prevents a non-voice
    // browser tab from creating broken peer connections that interfere with
    // the real voice session on another client (e.g. Electron).
    if (!useVoiceStore.getState().currentChannelId) return;

    const data = JSON.parse(signal);

    if (data.type === "track-info") {
      if (
        data.trackType !== "camera" &&
        data.trackType !== "screen" &&
        data.trackType !== "screen-audio"
      ) {
        return;
      }
      const trackId = typeof data.trackId === "string" ? data.trackId : undefined;
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
        }
        lastIceRestartTime.set(fromUserId, Date.now());

        const currentUser = useAuthStore.getState().user;

        let pc = peers.get(fromUserId);
        if (pc && pc.signalingState !== "closed") {
          // Glare detection: both sides sent offers simultaneously
          if (pc.signalingState === "have-local-offer") {
            // Deterministic tiebreaker — "polite" peer yields its offer
            const isPolite = currentUser!.id > fromUserId;
            if (!isPolite) {
              console.log(`Glare with ${fromUserId}: we are impolite, ignoring remote offer`);
              return;
            }
            console.log(`Glare with ${fromUserId}: we are polite, rolling back`);
            await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
          }

          // Renegotiation: reuse existing connection — flush stale candidates
          pendingCandidates.delete(fromUserId);
          try {
            await pc.setRemoteDescription(
              new RTCSessionDescription({ type: "offer", sdp: data.sdp }),
            );
            await applyPendingCandidates(fromUserId);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log(`Sending renegotiation answer to ${fromUserId}`);
            await conn.invoke(
              "SendSignal",
              fromUserId,
              JSON.stringify({ type: "answer", sdp: answer.sdp }),
            );
          } catch (err) {
            console.warn(`Renegotiation failed for ${fromUserId}, recreating:`, err);
            // SDP state is likely corrupt — rebuild with a fresh connection
            // Accept the remote offer on a clean PC instead
            pc = createPeerConnection(fromUserId);
            if (localStream) {
              localStream.getTracks().forEach((track) => pc!.addTrack(track, localStream!));
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
          pc = createPeerConnection(fromUserId);
          if (localStream) {
            localStream
              .getTracks()
              .forEach((track) => pc!.addTrack(track, localStream!));
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
          await pc.setLocalDescription(answer);
          console.log(`Sending answer to ${fromUserId}`);
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
        if (!pc) return;
        if (pc.signalingState !== "have-local-offer") {
          console.warn(`Ignoring stale answer from ${fromUserId} (state: ${pc.signalingState})`);
          return;
        }
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: data.sdp }),
        );
        await applyPendingCandidates(fromUserId);
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
          pendingCandidates.get(fromUserId)!.push(data);
        }
      });
    }
  });

  conn.on("VoiceChannelUsers", (users: Record<string, string>) => {
    const authoritative = new Map(Object.entries(users));
    useVoiceStore.getState().setParticipants(authoritative);
    completeInitialParticipantWait(conn);
    console.log(`VoiceChannelUsers received: ${authoritative.size} participants`);

    // Reconcile WebRTC peers against authoritative participant list
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
    // those are handled by buffered join replay)
    if (localStream) {
      for (const [userId, displayName] of authoritative) {
        if (userId === myId) continue;
        if (!peers.has(userId)) {
          console.log(`Reconciliation: creating missing peer for ${userId}`);
          void handleUserJoinedVoice(conn, userId, displayName).catch((err) => {
            console.warn(`Reconciliation: failed to create peer for ${userId}:`, err);
          });
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
  const pttKey = useVoiceStore((s) => s.pttKey);
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const setPttActive = useVoiceStore((s) => s.setPttActive);
  const setCurrentChannel = useVoiceStore((s) => s.setCurrentChannel);
  const setParticipants = useVoiceStore((s) => s.setParticipants);

  // PTT key/mouse listeners
  useEffect(() => {
    if (!currentChannelId || voiceMode !== "push-to-talk") {
      setPttActive(false);
      return;
    }

    const isElectron = typeof window !== 'undefined' && window.electron;

    // Use global shortcuts in Electron, window-level listeners in browser
    if (isElectron) {
      // Register global PTT key with Electron
      window.electron!.registerPttKey(pttKey);

      // Listen for global PTT events
      const unsubPress = window.electron!.onGlobalPttPress(() => {
        setPttActive(true);
      });

      const unsubRelease = window.electron!.onGlobalPttRelease(() => {
        setPttActive(false);
      });

      return () => {
        unsubPress();
        unsubRelease();
        window.electron!.unregisterPttKey();
        setPttActive(false);
      };
    } else {
      // Browser: use window-level event listeners (original implementation)
      const isMouseBind = pttKey.startsWith("Mouse");
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

      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mouseup", onMouseUp);
      return () => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mouseup", onMouseUp);
        setPttActive(false);
      };
    }
  }, [currentChannelId, voiceMode, pttKey, setPttActive]);

  // Mute/unmute local tracks (accounts for PTT mode)
  useEffect(() => {
    if (localStream) {
      if (voiceMode === "push-to-talk") {
        const enabled = !isMuted && isPttActive;
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = enabled;
        });
      } else if (isMuted) {
        localStream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }
    }
  }, [isMuted, voiceMode, isPttActive]);

  // Deafen - mute all remote audio (mic + screen audio)
  useEffect(() => {
    audioElements.forEach((audio) => {
      audio.muted = isDeafened;
    });
    screenAudioElements.forEach((audio) => {
      audio.muted = isDeafened;
    });
  }, [isDeafened]);

  // Sync per-user volume from store to GainNodes
  useEffect(() => {
    let prevVolumes = useVoiceStore.getState().userVolumes;
    const unsub = useVoiceStore.subscribe((state) => {
      if (state.userVolumes !== prevVolumes) {
        prevVolumes = state.userVolumes;
        for (const [peerId] of gainNodes) {
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
    if (skipNextDeviceEffect) {
      skipNextDeviceEffect = false;
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
        const newStream =
          await navigator.mediaDevices.getUserMedia(constraints);
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
      pendingVisibilityRejoin = false;
      rejoinInProgress = false;
      try {
        await initializeTurn();

        // Reset device resolution flag so each voice session gets a fresh attempt
        deviceResolutionFailed = false;

        // Leave current if any
        if (currentChannelId) {
          const conn = getConnection();
          await conn.invoke("LeaveVoiceChannel", currentChannelId);
          cleanupAll();
        }

        try {
          const audioConstraints = await buildAudioConstraintsResolved();
          const constraints: MediaStreamConstraints = {
            audio: audioConstraints,
          };
          localStream = await navigator.mediaDevices.getUserMedia(constraints);
          console.log(
            "Got local audio stream, tracks:",
            localStream.getAudioTracks().length,
          );
        } catch (err) {
          console.error("Could not access microphone:", err);
          useToastStore.getState().addToast("Could not access microphone. Check permissions.", "error");
          return;
        }

        // Apply current mute state to the new stream immediately
        const voiceState = useVoiceStore.getState();
        const shouldEnable =
          !voiceState.isMuted &&
          (voiceState.voiceMode === "voice-activity" || voiceState.isPttActive);
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
          await conn.invoke(
            "JoinVoiceChannel",
            channelId,
            voiceState.isMuted,
            voiceState.isDeafened,
          );
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

        voiceState.setConnectionState("connected");
        // Prevent the input device effect from re-obtaining a stream
        // — joinVoice already has the right stream
        skipNextDeviceEffect = true;
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
    try {
      if (currentChannelId) {
        const conn = getConnection();
        await conn.invoke("LeaveVoiceChannel", currentChannelId);
      }
    } catch (error) {
      console.warn("Failed to notify server when leaving voice channel:", error);
    } finally {
      pendingVisibilityRejoin = false;
      rejoinInProgress = false;
      cleanupAll();
      setCurrentChannel(null);
      setParticipants(new Map());
      useVoiceStore.getState().setScreenSharing(false);
      useVoiceStore.getState().setActiveSharers(new Map());
      useVoiceStore.getState().setWatching(null);
      useVoiceStore.getState().setCameraOn(false);
      useVoiceStore.getState().setActiveCameras(new Map());
      useVoiceStore.getState().setFocusedUserId(null);
      useVoiceStore.getState().setVoiceChatOpen(false);
      useVoiceChatStore.getState().clear();
      useWatchPartyStore.getState().setActiveParty(null);
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
      const channelId = useVoiceStore.getState().currentChannelId;
      if (!channelId) return;

      // If tab is hidden, delay rejoin until tab becomes visible
      // getUserMedia requires user gesture or visible tab
      if (document.hidden) {
        pendingVisibilityRejoin = true;
        console.log("SignalR reconnected but tab is hidden, will rejoin when visible");
        return;
      }
      if (rejoinInProgress) {
        console.log("Rejoin already in progress, skipping reconnect rejoin");
        return;
      }
      rejoinInProgress = true;
      pendingVisibilityRejoin = false;

      console.log("SignalR reconnected while in voice channel, rejoining:", channelId);
      useToastStore.getState().addToast("Reconnecting to voice channel...", "info");

      // Clean up stale WebRTC state (server already removed us on disconnect)
      cleanupAll();
      useVoiceStore.getState().setScreenSharing(false);
      useVoiceStore.getState().setActiveSharers(new Map());
      useVoiceStore.getState().setWatching(null);
      useVoiceStore.getState().setCameraOn(false);
      useVoiceStore.getState().setActiveCameras(new Map());
      useVoiceStore.getState().setFocusedUserId(null);

      try {
        await initializeTurn();
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
          if (resolvedId !== "default") {
            audioConstraints = { ...base, deviceId: { exact: resolvedId } };
          }
        } else {
          audioConstraints = { ...base, deviceId: { exact: vs.inputDeviceId } };
        }

        localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

        // Apply mute state
        const shouldEnable = !vs.isMuted && (vs.voiceMode === "voice-activity" || vs.isPttActive);
        localStream.getAudioTracks().forEach((t) => { t.enabled = shouldEnable; });

        // Set up analyser for speaking indicator
        const currentUser = useAuthStore.getState().user;
        if (currentUser) addAnalyser(currentUser.id, localStream);

        startAudioKeepAlive();
        vs.setConnectionState("connected");

        // Clear participants right before rejoining to prevent race conditions
        // (UserJoinedVoice events from other rejoining users might arrive before this)
        useVoiceStore.getState().setParticipants(new Map());

        // Rejoin on server - this will send us VoiceChannelUsers with authoritative state
        skipNextDeviceEffect = true;
        const conn = getConnection();
        beginInitialParticipantWait(conn);
        await conn.invoke("JoinVoiceChannel", channelId, vs.isMuted, vs.isDeafened);

        startStatsCollection();

        // Re-initialize voice chat
        const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
        useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);
      } catch (err) {
        cancelInitialParticipantWait();
        console.error("Failed to rejoin voice channel after reconnect:", err);
        useToastStore.getState().addToast("Failed to reconnect to voice channel.", "error");
        // Full cleanup on failure — drop user out of voice
        cleanupAll();
        useVoiceStore.getState().setCurrentChannel(null);
        useVoiceStore.getState().setParticipants(new Map());
        useVoiceChatStore.getState().clear();
      } finally {
        rejoinInProgress = false;
      }
    });
  }, []);

  // Handle tab visibility changes - rejoin voice if we missed reconnection while hidden
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.hidden) return;

      const channelId = useVoiceStore.getState().currentChannelId;
      if (!channelId) {
        pendingVisibilityRejoin = false;
        return;
      }

      if (rejoinInProgress) {
        console.log("Rejoin already in progress, skipping visibility rejoin");
        return;
      }

      const connectionState = useVoiceStore.getState().connectionState;
      const forcedRejoinFromHiddenReconnect = pendingVisibilityRejoin;
      // Existing recovery path: if we're supposed to be in voice but not connected, try to rejoin
      const disconnectedRecovery = connectionState !== "connected" && !localStream;

      if (forcedRejoinFromHiddenReconnect || disconnectedRecovery) {
        const conn = getConnection();
        if (conn.state === "Connected") {
          rejoinInProgress = true;
          if (forcedRejoinFromHiddenReconnect) {
            console.log("Tab became visible with pending hidden reconnect, forcing voice rejoin");
          } else {
            console.log("Tab became visible, checking voice state and rejoining if needed");
          }

          try {
            if (forcedRejoinFromHiddenReconnect) {
              // Local media/peer state may still look connected while server-side membership was lost.
              cleanupAll();
              useVoiceStore.getState().setScreenSharing(false);
              useVoiceStore.getState().setActiveSharers(new Map());
              useVoiceStore.getState().setWatching(null);
              useVoiceStore.getState().setCameraOn(false);
              useVoiceStore.getState().setActiveCameras(new Map());
              useVoiceStore.getState().setFocusedUserId(null);
            }

            // Re-acquire microphone
            const vs = useVoiceStore.getState();
            const base: MediaTrackConstraints = {
              noiseSuppression: vs.noiseSuppression,
              echoCancellation: vs.echoCancellation,
              autoGainControl: vs.autoGainControl,
            };
            let audioConstraints = base;
            if (!vs.inputDeviceId || vs.inputDeviceId === "default") {
              const resolvedId = await resolveDefaultInputDevice();
              if (resolvedId !== "default") {
                audioConstraints = { ...base, deviceId: { exact: resolvedId } };
              }
            } else {
              audioConstraints = { ...base, deviceId: { exact: vs.inputDeviceId } };
            }

            localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

            // Apply mute state
            const shouldEnable = !vs.isMuted && (vs.voiceMode === "voice-activity" || vs.isPttActive);
            localStream.getAudioTracks().forEach((t) => { t.enabled = shouldEnable; });

            // Set up analyser
            const currentUser = useAuthStore.getState().user;
            if (currentUser) addAnalyser(currentUser.id, localStream);

            startAudioKeepAlive();
            vs.setConnectionState("connected");

            // Clear participants and rejoin
            useVoiceStore.getState().setParticipants(new Map());
            beginInitialParticipantWait(conn);

            skipNextDeviceEffect = true;
            await conn.invoke("JoinVoiceChannel", channelId, vs.isMuted, vs.isDeafened);

            startStatsCollection();

            const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
            useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);

            pendingVisibilityRejoin = false;
            useToastStore.getState().addToast("Reconnected to voice channel", "success");
          } catch (err) {
            cancelInitialParticipantWait();
            if (forcedRejoinFromHiddenReconnect) {
              pendingVisibilityRejoin = true;
            }
            console.error("Failed to rejoin voice on visibility change:", err);
          } finally {
            rejoinInProgress = false;
          }
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return { joinVoice, leaveVoice, startScreenShare, stopScreenShare, startCamera, stopCamera };
}
