import { useCallback, useEffect } from "react";
import * as Sentry from "@sentry/react";
import type { SignalRConnection } from "@abyss/shared";
import {
  ensureConnected,
  getConnection,
  onReconnected,
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
  sfuSetUserVolume,
  sfuSetScreenAudioVolume,
  sfuSetInputDevice,
  sfuSetOutputDevice,
  sfuPublishScreenShare,
  sfuUnpublishScreenShare,
  sfuPublishCamera,
  sfuUnpublishCamera,
  getSfuScreenStream,
  getSfuCameraStream,
  getSfuLocalCameraStream,
  getSfuLocalScreenStream,
  getSfuLocalMicStream,
  sfuUpdateScreenShareQuality,
  sfuUpdateCameraQuality,
  sfuSetScreenShareAudioSubscribed,
  isInSfuMode,
  getLiveKitRoom,
  setSfuRecoveryCallback,
  cancelSfuRecovery,
  attemptSfuAudioUnlock,
  getLiveKitHealth,
  sfuTriggerRecovery,
} from "@abyss/shared";
import type { CameraQuality, ScreenShareQuality } from "@abyss/shared";

// ──────────────────────────────────────────────────────────────────────────────
// SFU-only voice orchestrator.
//
// All media (mic / camera / screen share / audio playback / E2EE / reconnection)
// is owned by livekitService (the LiveKit SFU client). This hook is a thin
// orchestration layer that: drives join/leave, mirrors Zustand store settings
// (mute/deafen/volume/device/quality) onto the SFU, runs push-to-talk hotkeys,
// keeps a local mic-level analyser for the speaking indicator, prevents tab
// throttling with a silent oscillator, and keeps the SignalR presence/sidebar
// listeners wired up. There is no P2P mesh.
// ──────────────────────────────────────────────────────────────────────────────

// Simple sound playback helper for UI sounds in voice context
const soundCache = new Map<string, HTMLAudioElement>();
function playSound(path: string) {
  if (typeof Audio === 'undefined') return;
  let audio = soundCache.get(path);
  if (!audio) {
    audio = new Audio(path);
    audio.preload = 'auto';
    soundCache.set(path, audio);
  }
  audio.currentTime = 0;
  audio.volume = 0.5;
  audio.play().catch(() => {});
}

// Timestamp of the last joinVoice — the input-device effect skips re-applying a
// device the join flow just configured, avoiding a redundant re-publish during
// the connection window.
let lastVoiceJoinTime = 0;
const DEVICE_EFFECT_SKIP_WINDOW_MS = 2000;

// Flag indicating SignalR reconnected while the tab was hidden and voice must be
// rejoined on visibility.
let pendingVisibilityRejoin = false;
// Guard to prevent concurrent visibility-triggered rejoins.
let rejoinInProgress = false;
// Channel ID that needs a server-side LeaveVoiceChannel notification. Set when
// leaveVoice's invoke fails so the onReconnected handler can retry.
let pendingServerLeave: string | null = null;

let listenersRegisteredForConnection: SignalRConnection | null = null;

// Serialized snapshot of the mic capture config (device + processing constraints)
// last applied to LiveKit. The input-device effect compares against this so that
// merely mounting a `useWebRTC` consumer mid-call (e.g. opening the voice view)
// does NOT trigger a redundant mic re-capture (which would glitch audio and, via
// setMicrophoneEnabled(true), risk force-unmuting). null when not connected.
let lastAppliedMicConfig: string | null = null;
function micConfigKey(): string {
  const s = useVoiceStore.getState();
  return `${s.inputDeviceId}|${s.noiseSuppression}|${s.echoCancellation}|${s.autoGainControl}`;
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

// ──────────────────────────────────────────────────────────────────────────────
// Local mic-level analyser (speaking indicator + input meter for the local user).
// Remote speaking indicators come from LiveKit's ActiveSpeakersChanged event
// (handled inside livekitService).
// ──────────────────────────────────────────────────────────────────────────────
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

// Silent audio keepalive to prevent Chrome from throttling the tab when backgrounded.
// Chrome treats tabs with active audio output as high-priority and skips timer throttling.
let audioKeepAliveInterval: ReturnType<typeof setInterval> | null = null;
let silentKeepAliveCtx: AudioContext | null = null;
let silentKeepAliveNodes: { oscillator: OscillatorNode; gain: GainNode } | null = null;

function ensureAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
    console.log(`[AudioCtx] Created new AudioContext (state: ${audioContext.state}, sampleRate: ${audioContext.sampleRate})`);
  }
  if (audioContext.state === "suspended") {
    audioContext.resume().catch((err) => {
      console.warn("[AudioCtx] Resume failed:", err);
    });
  }
  return audioContext;
}

function addAnalyser(userId: string, stream: MediaStream) {
  removeAnalyser(userId);
  const ctx = ensureAudioContext();
  // Clone the stream so the analyser always receives real audio data even if the
  // source track's enabled state is toggled elsewhere.
  const analysisStream = stream.clone();
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
          // In PTT mode, the speaking indicator follows the PTT key state.
          speaking = store.isPttActive;
        }
        store.setLocalInputLevel(store.isMuted ? 0 : rms);
      }
      store.setSpeaking(userId, speaking);
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
    entry.analysisStream.getTracks().forEach((t) => t.stop());
    store.setSpeaking(userId, false);
  }
  analysers.clear();
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
    audioContext = null;
  }
}

// Attach (or re-attach) the local mic-level analyser to the currently-published
// LiveKit microphone track. Safe to call repeatedly (e.g. after a device switch).
function attachLocalAnalyser() {
  const currentUser = useAuthStore.getState().user;
  if (!currentUser) return;
  const micStream = getSfuLocalMicStream();
  if (micStream) {
    addAnalyser(currentUser.id, micStream);
  }
}

function startAudioKeepAlive() {
  if (audioKeepAliveInterval) return;

  // Start a silent oscillator routed through a zero-gain node. Chrome sees
  // active audio output and keeps the tab at full priority even when
  // backgrounded, preventing timer/WebSocket throttling.
  if (!silentKeepAliveNodes) {
    try {
      if (!silentKeepAliveCtx || silentKeepAliveCtx.state === "closed") {
        silentKeepAliveCtx = new AudioContext();
      }
      const oscillator = silentKeepAliveCtx.createOscillator();
      const gain = silentKeepAliveCtx.createGain();
      gain.gain.value = 0; // completely silent
      oscillator.connect(gain);
      gain.connect(silentKeepAliveCtx.destination);
      oscillator.start();
      silentKeepAliveNodes = { oscillator, gain };
      console.log("[AudioKeepAlive] Silent oscillator started to prevent tab throttling");
    } catch (err) {
      console.warn("[AudioKeepAlive] Failed to start silent oscillator:", err);
    }
  }

  audioKeepAliveInterval = setInterval(() => {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch((err) => {
        console.warn("Keep-alive: Failed to resume audio context:", err);
      });
    }
  }, 5000);
}

function stopAudioKeepAlive() {
  if (silentKeepAliveNodes) {
    try {
      silentKeepAliveNodes.oscillator.stop();
      silentKeepAliveNodes.oscillator.disconnect();
      silentKeepAliveNodes.gain.disconnect();
    } catch {}
    silentKeepAliveNodes = null;
  }
  if (silentKeepAliveCtx && silentKeepAliveCtx.state !== "closed") {
    silentKeepAliveCtx.close().catch(() => {});
    silentKeepAliveCtx = null;
  }
  if (audioKeepAliveInterval) {
    clearInterval(audioKeepAliveInterval);
    audioKeepAliveInterval = null;
  }
}

export async function attemptAudioUnlock() {
  console.log(`[audioUnlock] Attempting audio unlock (AudioCtx state=${audioContext?.state ?? "null"})`);
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (err) {
      console.warn("[audioUnlock] Failed to resume audio context:", err);
    }
  }
  let failed = false;
  if (isInSfuMode()) {
    const sfuOk = await attemptSfuAudioUnlock();
    if (!sfuOk) failed = true;
  }
  useVoiceStore.getState().setNeedsAudioUnlock(failed);
}

// ──────────────────────────────────────────────────────────────────────────────
// Connection stats (LiveKit-derived). Kept for VoiceControls / VoiceDebugPanel.
// ──────────────────────────────────────────────────────────────────────────────
export interface ConnectionStats {
  roundTripTime: number | null;
  packetLoss: number | null;
  jitter: number | null;
}

export interface DetailedConnectionStats extends ConnectionStats {
  connectionType: 'sfu' | 'unknown';
  iceConnectionState: string;
  activePeerCount: number;
  e2ee: boolean;
}

let cachedStats: ConnectionStats = { roundTripTime: null, packetLoss: null, jitter: null };
let cachedDetailedStats: DetailedConnectionStats | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function getConnectionStats(): ConnectionStats {
  return cachedStats;
}

export function getDetailedConnectionStats(): DetailedConnectionStats | null {
  return cachedDetailedStats;
}

function startStatsCollection() {
  if (statsInterval) return;
  statsInterval = setInterval(() => {
    const health = getLiveKitHealth();
    if (!health) {
      cachedStats = { roundTripTime: null, packetLoss: null, jitter: null };
      cachedDetailedStats = null;
      return;
    }
    cachedDetailedStats = {
      roundTripTime: null,
      packetLoss: null,
      jitter: null,
      connectionType: 'sfu',
      iceConnectionState: health.state,
      activePeerCount: health.remoteParticipants,
      e2ee: health.isE2EEEnabled,
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

// ──────────────────────────────────────────────────────────────────────────────
// Stream getters (delegated to livekitService) — consumed by ScreenShareView /
// VoiceChannelView.
// ──────────────────────────────────────────────────────────────────────────────
export function setScreenAudioVolume(userId: string, volume: number): void {
  sfuSetScreenAudioVolume(userId, volume);
}

export function getScreenVideoStream(userId: string): MediaStream | undefined {
  return getSfuScreenStream(userId);
}

export function getLocalScreenStream(): MediaStream | null {
  return getSfuLocalScreenStream();
}

export function getCameraVideoStream(userId: string): MediaStream | undefined {
  return getSfuCameraStream(userId);
}

export function getLocalCameraStream(): MediaStream | null {
  return getSfuLocalCameraStream();
}

export function applyUserVolume(peerId: string, volume: number) {
  sfuSetUserVolume(peerId, volume);
}

// ──────────────────────────────────────────────────────────────────────────────
// Teardown
// ──────────────────────────────────────────────────────────────────────────────
function cleanupAll() {
  cleanupAnalysers();
  stopAudioKeepAlive();
  stopStatsCollection();
  lastAppliedMicConfig = null;
  const vs = useVoiceStore.getState();
  vs.setConnectionState("disconnected");
  vs.setConnectionMode("disconnected");
  vs.setNeedsAudioUnlock(false);
}

// ──────────────────────────────────────────────────────────────────────────────
// Screen share
// ──────────────────────────────────────────────────────────────────────────────
async function startScreenShareInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.currentChannelId) return;

  voiceState.setScreenShareLoading(true);
  try {
    // LiveKit handles capture + publish. On Linux, sfuPublishScreenShare uses
    // getUserMedia+chromeMediaSource internally because desktopCapturer.getSources
    // crashes PipeWire on many setups.
    const screenPreset = SCREEN_SHARE_QUALITY_CONSTRAINTS[voiceState.screenShareQuality];
    await sfuPublishScreenShare({
      maxFramerate: screenPreset.frameRate,
      maxBitrate: screenPreset.maxBitrate,
    });
    voiceState.setScreenSharing(true);
    voiceState.bumpScreenStreamVersion();
    const conn = getConnection();
    await conn.invoke("NotifyScreenShare", voiceState.currentChannelId, true);
  } catch (err: any) {
    console.error("Could not start screen share:", err);
    if (err?.name !== "NotAllowedError") {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        level: 'error',
        tags: { 'diagnostic.category': 'webrtc', 'webrtc.phase': 'screen-share' },
      });
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
    await sfuUnpublishScreenShare();
    voiceState.setScreenSharing(false);
    if (voiceState.currentChannelId) {
      const conn = getConnection();
      await conn.invoke("NotifyScreenShare", voiceState.currentChannelId, false);
    }
  } finally {
    voiceState.setScreenShareLoading(false);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Camera
// ──────────────────────────────────────────────────────────────────────────────
async function startCameraInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.currentChannelId) return;

  voiceState.setCameraLoading(true);
  try {
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
  } catch (err) {
    console.error("Could not get camera:", err);
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      level: 'error',
      tags: { 'diagnostic.category': 'webrtc', 'webrtc.phase': 'camera' },
    });
    useToastStore.getState().addToast("Could not access camera. Check permissions.", "error");
  } finally {
    voiceState.setCameraLoading(false);
  }
}

async function stopCameraInternal() {
  const voiceState = useVoiceStore.getState();
  voiceState.setCameraLoading(true);
  try {
    await sfuUnpublishCamera();
    voiceState.setCameraOn(false);
    if (voiceState.currentChannelId) {
      const conn = getConnection();
      await conn.invoke("NotifyCamera", voiceState.currentChannelId, false);
    }
  } finally {
    voiceState.setCameraLoading(false);
  }
}

async function switchCameraInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.isCameraOn) return;

  // Toggle between front (user) and back (environment) camera.
  const newFacingMode = voiceState.cameraFacingMode === 'user' ? 'environment' : 'user';
  voiceState.setCameraFacingMode(newFacingMode);

  // Restart camera with the new facing mode.
  await stopCameraInternal();
  await startCameraInternal();
}

// ──────────────────────────────────────────────────────────────────────────────
// Watch (screen share opt-in)
// ──────────────────────────────────────────────────────────────────────────────
export async function requestWatch(sharerUserId: string) {
  // Subscribe to the watched user's screen audio, unsubscribe the previous one.
  // The screen video track auto-subscribes via LiveKit adaptiveStream.
  const oldWatching = useVoiceStore.getState().watchingUserId;
  if (oldWatching && oldWatching !== sharerUserId) {
    sfuSetScreenShareAudioSubscribed(oldWatching, false);
  }
  sfuSetScreenShareAudioSubscribed(sharerUserId, true);
  useVoiceStore.getState().setWatching(sharerUserId);
  useVoiceStore.getState().bumpScreenStreamVersion();
}

export async function stopWatching() {
  const store = useVoiceStore.getState();
  const sharerUserId = store.watchingUserId;
  if (!sharerUserId) return;
  sfuSetScreenShareAudioSubscribed(sharerUserId, false);
  store.setWatching(null);
  store.bumpScreenStreamVersion();
}

// ──────────────────────────────────────────────────────────────────────────────
// SignalR presence / sidebar listeners (no media signaling — LiveKit owns media).
// ──────────────────────────────────────────────────────────────────────────────
let postReconnectHealthCheckInProgress = false;

/**
 * Verifies LiveKit room state after a SignalR reconnect. A network blip that
 * killed the SignalR WebSocket can also silently break LiveKit's signalling
 * socket without firing the Disconnected event — leaving the room in a zombie
 * state where no ParticipantConnected events arrive. Clients in that state hear
 * nothing from anyone who joined during or after the blip.
 */
async function performPostReconnectLiveKitHealthCheck(channelId: string): Promise<void> {
  if (postReconnectHealthCheckInProgress) return;
  postReconnectHealthCheckInProgress = true;
  try {
    const vs = useVoiceStore.getState();
    if (vs.currentChannelId !== channelId) return;
    if (vs.connectionMode !== 'sfu' && vs.connectionMode !== 'connecting') return;

    const health = getLiveKitHealth();
    const currentUser = useAuthStore.getState().user;
    const signalrRemoteCount = Math.max(0, vs.participants.size - (currentUser && vs.participants.has(currentUser.id) ? 1 : 0));

    let unhealthyReason: string | null = null;
    if (!health) {
      unhealthyReason = 'no-room';
    } else if (health.state !== 'connected') {
      unhealthyReason = `state=${health.state}`;
    } else if (signalrRemoteCount > 0 && health.remoteParticipants === 0) {
      unhealthyReason = `divergence: signalr=${signalrRemoteCount} livekit=0`;
    }

    if (!unhealthyReason) {
      console.log(`[voice-health] LiveKit OK after SignalR reconnect | state=${health?.state} signalr=${signalrRemoteCount} livekit=${health?.remoteParticipants}`);
      return;
    }

    console.warn(`[voice-health] LiveKit unhealthy after SignalR reconnect (${unhealthyReason}) — triggering SFU recovery for channel ${channelId}`);
    Sentry.addBreadcrumb({
      category: 'webrtc',
      message: `Post-reconnect LiveKit health check failed: ${unhealthyReason}`,
      level: 'warning',
    });
    try {
      await sfuTriggerRecovery(channelId);
    } catch (err) {
      console.error('[voice-health] sfuTriggerRecovery threw:', err);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        level: 'error',
        tags: { 'diagnostic.category': 'webrtc', 'webrtc.phase': 'post-reconnect-health-check' },
      });
    }
  } finally {
    postReconnectHealthCheckInProgress = false;
  }
}

async function attemptVoiceRejoin(reason: string) {
  if (rejoinInProgress) {
    console.log(`Rejoin already in progress, skipping (${reason})`);
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

  try {
    if (isInSfuMode()) {
      try { await disconnectFromLiveKit(); } catch { /* ignore */ }
    }
    cleanupAll();
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
    useVoiceStore.getState().setCameraOn(false);
    useVoiceStore.getState().setActiveCameras(new Map());
    useVoiceStore.getState().setFocusedUserId(null);
    useVoiceStore.getState().setParticipants(new Map());

    const vs = useVoiceStore.getState();
    lastVoiceJoinTime = Date.now();
    const conn = getConnection();
    await conn.invoke("JoinVoiceChannel", channelId, vs.isMuted, vs.isDeafened);
    await connectToLiveKit(channelId);
    lastAppliedMicConfig = micConfigKey();
    attachLocalAnalyser();
    startAudioKeepAlive();
    startStatsCollection();

    const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
    useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);
    useToastStore.getState().addToast("Reconnected to voice channel", "success");
  } catch (err) {
    console.error(`Failed to rejoin voice (${reason}):`, err);
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      level: 'error',
      tags: { 'diagnostic.category': 'webrtc', 'webrtc.phase': 'rejoin' },
      contexts: { voice: { reason, channelId } },
    });
    useToastStore.getState().addToast("Failed to reconnect to voice channel.", "error");
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

  // Register SFU recovery callback so livekitService can trigger a full reconnect
  // when LiveKit unexpectedly drops.
  setSfuRecoveryCallback(async (channelId: string) => {
    console.log(`[sfu-recovery] Reconnecting to LiveKit for channel ${channelId}`);
    await connectToLiveKit(channelId);
    lastAppliedMicConfig = micConfigKey();
    attachLocalAnalyser();
  });

  conn.on("UserJoinedVoice", (userId: string, displayName: string) => {
    console.log(`UserJoinedVoice: ${displayName} (${userId})`);
    // LiveKit handles the media; we just track the participant for the UI.
    useVoiceStore.getState().addParticipant(userId, displayName);
  });

  conn.on("UserLeftVoice", (userId: string) => {
    const vs = useVoiceStore.getState();
    console.log(`UserLeftVoice: ${userId} | remaining participants: ${vs.participants.size - 1}`);
    // If LiveKit still has this participant connected, defer to its
    // ParticipantDisconnected event as authoritative.
    const room = getLiveKitRoom();
    if (room && room.remoteParticipants.has(userId)) {
      console.log(`[sfu] Skipping removeParticipant for ${userId} — still in LiveKit room (${room.remoteParticipants.size} remote participants)`);
      return;
    }
    vs.removeParticipant(userId);
  });

  conn.on("VoiceChannelUsers", (users: Record<string, string>) => {
    const authoritative = new Map(Object.entries(users));
    useVoiceStore.getState().setParticipants(authoritative);

    // Keep the sidebar's voice user list (serverStore) consistent. VoiceChannelUsers
    // only carries display names, so merge with existing state to preserve
    // mute/deafen flags — missing users get defaults.
    const channelId = useVoiceStore.getState().currentChannelId;
    if (channelId) {
      const ss = useServerStore.getState();
      const existing = ss.voiceChannelUsers.get(channelId);
      for (const [userId, displayName] of authoritative) {
        if (!existing?.has(userId)) {
          ss.voiceUserJoined(channelId, userId, { displayName, isMuted: false, isDeafened: false, isServerMuted: false, isServerDeafened: false });
        }
      }
    }
    console.log(`VoiceChannelUsers received: ${authoritative.size} participants`);
  });

  // Screen share events (multi-sharer)
  conn.on("ScreenShareStarted", (userId: string, displayName: string) => {
    useVoiceStore.getState().addActiveSharer(userId, displayName);
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      useVoiceStore.getState().setScreenSharing(true);
    }
    if (!useVoiceStore.getState().isDeafened) {
      playSound('/sounds/screenshare-start.ogg');
    }
  });

  conn.on("ScreenShareStopped", (userId: string) => {
    const store = useVoiceStore.getState();
    store.removeActiveSharer(userId);
    if (store.watchingUserId === userId) {
      store.setWatching(null);
      store.bumpScreenStreamVersion();
    }
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      store.setScreenSharing(false);
    }
    if (!useVoiceStore.getState().isDeafened) {
      playSound('/sounds/screenshare-end.ogg');
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
    store.bumpCameraStreamVersion();
    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id) {
      store.setCameraOn(false);
    }
  });

  conn.on("ActiveCameras", (cameras: Record<string, string>) => {
    useVoiceStore.getState().setActiveCameras(new Map(Object.entries(cameras)));
  });

  // Voice session replaced (joined voice from another device)
  conn.on("VoiceSessionReplaced", (message: string) => {
    console.warn("Voice session replaced:", message);
    pendingVisibilityRejoin = false;
    rejoinInProgress = false;
    cancelSfuRecovery();
    void disconnectFromLiveKit().catch(() => {});
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

// ──────────────────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────────────────
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

  // Mute/unmute (accounts for PTT mode)
  useEffect(() => {
    const shouldMute = voiceMode === "push-to-talk" ? (isMuted || !isPttActive) : isMuted;
    void sfuToggleMute(shouldMute);
  }, [isMuted, voiceMode, isPttActive]);

  // Deafen — mute all remote audio
  useEffect(() => {
    sfuSetDeafened(isDeafened);
  }, [isDeafened]);

  // Sync per-user volume from store to the SFU
  useEffect(() => {
    let prevVolumes = useVoiceStore.getState().userVolumes;
    const unsub = useVoiceStore.subscribe((state) => {
      if (state.userVolumes !== prevVolumes) {
        prevVolumes = state.userVolumes;
        for (const [peerId] of state.participants) {
          const vol = state.userVolumes.get(peerId) ?? 100;
          sfuSetUserVolume(peerId, vol);
        }
      }
    });
    return unsub;
  }, []);

  // Apply output device changes to all remote audio elements
  useEffect(() => {
    void sfuSetOutputDevice(outputDeviceId || "default");
  }, [outputDeviceId]);

  // Re-publish the mic when the input device or audio-processing constraints
  // (noise suppression / echo cancellation / auto-gain) change mid-call. LiveKit
  // applies these as getUserMedia capture constraints, so they require a
  // re-capture to take effect.
  useEffect(() => {
    if (!currentChannelId) return;
    if (!isInSfuMode()) return;
    // Only re-publish when the config actually changed since it was last applied
    // (on join, or by a prior run). Guards against redundant re-capture when a
    // consumer simply mounts mid-call. The synchronous compare-and-set also
    // de-dupes the effect firing across multiple hook instances.
    const key = micConfigKey();
    if (key === lastAppliedMicConfig) return;
    if (Date.now() - lastVoiceJoinTime < DEVICE_EFFECT_SKIP_WINDOW_MS) return;
    lastAppliedMicConfig = key;
    (async () => {
      try {
        await sfuSetInputDevice(inputDeviceId);
        attachLocalAnalyser();
      } catch (err) {
        console.error("Failed to switch microphone:", err);
        useToastStore.getState().addToast("Failed to switch microphone.", "error");
      }
    })();
  }, [inputDeviceId, noiseSuppression, echoCancellation, autoGainControl, currentChannelId]);

  // React to camera quality changes mid-stream
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
          await sfuUpdateCameraQuality({
            width: preset.width,
            height: preset.height,
            frameRate: preset.frameRate,
            maxBitrate: preset.maxBitrate,
          });
          useVoiceStore.getState().bumpCameraStreamVersion();
          console.log(`[cameraQuality] Switched to ${state.cameraQuality} (${preset.width}x${preset.height}@${preset.frameRate}fps)`);
        } catch (err) {
          console.error("[cameraQuality] Failed to change camera quality:", err);
        }
      })();
    });
    return unsub;
  }, [currentChannelId]);

  // React to screen share quality changes mid-stream
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
          await sfuUpdateScreenShareQuality({
            maxFramerate: preset.frameRate,
            maxBitrate: preset.maxBitrate,
          });
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
    setupSignalRListeners();
  }, []);

  // Resume audio when the window becomes visible / focused
  useEffect(() => {
    if (!currentChannelId) return;

    const handleVisibilityChange = () => {
      if (!document.hidden) attemptAudioUnlock();
    };
    const handleWindowFocus = () => attemptAudioUnlock();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [currentChannelId]);

  const joinVoice = useCallback(
    async (channelId: string) => {
      const sfuJoinT0 = performance.now();
      useVoiceStore.getState().setJoiningVoice(true);
      pendingVisibilityRejoin = false;
      rejoinInProgress = false;
      pendingServerLeave = null; // starting a new join supersedes any pending leave
      try {
        // Leave current channel if any
        if (currentChannelId) {
          if (isInSfuMode()) {
            await disconnectFromLiveKit();
          }
          cleanupAll();
          try {
            const conn = getConnection();
            await conn.invoke("LeaveVoiceChannel", currentChannelId);
          } catch (e) {
            // Best-effort — JoinVoiceChannel below handles the server-side leave
            // atomically (single voice session enforcement).
            console.warn("[joinVoice] LeaveVoiceChannel failed, server will clean up on join:", e);
          }
        }

        console.log(`[join] Starting voice join for channel: ${channelId} | previousChannel: ${currentChannelId ?? 'none'}`);

        // Set lastVoiceJoinTime BEFORE setCurrentChannel so the device-switch
        // effect (which depends on currentChannelId) is skipped during the join.
        lastVoiceJoinTime = Date.now();
        setCurrentChannel(channelId);
        useVoiceStore.getState().setConnectionMode('connecting');

        // Join the SignalR voice group first (presence / sidebar / state).
        const conn = getConnection();
        const voiceState = useVoiceStore.getState();
        try {
          await conn.invoke('JoinVoiceChannel', channelId, voiceState.isMuted, voiceState.isDeafened);
        } catch (err) {
          console.error("Failed to join voice channel:", err);
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
            level: 'error',
            tags: { 'diagnostic.category': 'webrtc', 'webrtc.phase': 'join' },
            contexts: { voice: { channelId } },
          });
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
        console.log(`[join] SignalR JoinVoiceChannel completed in ${Math.round(performance.now() - sfuJoinT0)}ms — connecting LiveKit`);

        // Connect to the LiveKit SFU (token → room → publish mic). On failure,
        // back out of the channel cleanly — there is no P2P fallback, so a
        // failed connect must not leave the user "in" a silent channel.
        try {
          await connectToLiveKit(channelId);
        } catch (err) {
          console.error("[join] LiveKit connection failed, leaving voice channel:", err);
          try {
            const c = getConnection();
            await c.invoke("LeaveVoiceChannel", channelId);
          } catch { /* best-effort */ }
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
          useVoiceChatStore.getState().clear();
          // connectToLiveKit already surfaced a toast to the user.
          return;
        }
        console.log(`[join] LiveKit connected — total join: ${Math.round(performance.now() - sfuJoinT0)}ms`);

        // publishAudio already captured the mic with the current config — record it
        // so the input-device effect doesn't redundantly re-publish.
        lastAppliedMicConfig = micConfigKey();

        // Local mic-level analyser for the speaking indicator / input meter.
        attachLocalAnalyser();

        startAudioKeepAlive();
        startStatsCollection();
        lastVoiceJoinTime = Date.now();

        const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
        useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);
      } finally {
        useVoiceStore.getState().setJoiningVoice(false);
      }
    },
    [currentChannelId, setCurrentChannel, setParticipants],
  );

  const leaveVoice = useCallback(async () => {
    const channelId = currentChannelId;
    if (!channelId) return; // already disconnected

    // === IMMEDIATE UI UPDATE ===
    // Clear channel + UI state FIRST so the disconnect button responds instantly.
    pendingVisibilityRejoin = false;
    rejoinInProgress = false;
    cancelSfuRecovery();
    setCurrentChannel(null);
    setParticipants(new Map());
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
    useVoiceStore.getState().setCameraOn(false);
    useVoiceStore.getState().setActiveCameras(new Map());
    useVoiceStore.getState().setFocusedUserId(null);
    useVoiceStore.getState().setVoiceChatOpen(false);
    useVoiceStore.getState().setConnectionMode('disconnected');
    useVoiceChatStore.getState().clear();
    useWatchPartyStore.getState().setActiveParty(null);

    // === CLEANUP ===
    if (isInSfuMode()) {
      try { await disconnectFromLiveKit(); } catch (e) {
        console.warn("Failed to disconnect from LiveKit:", e);
      }
    }
    cleanupAll();

    // === SERVER NOTIFICATION ===
    // If the invoke fails (e.g. connection being restarted), stash the channel so
    // the onReconnected handler can retry — otherwise the server keeps
    // broadcasting us as a voice member until the 30s grace period expires.
    try {
      const conn = getConnection();
      await conn.invoke("LeaveVoiceChannel", channelId);
      pendingServerLeave = null;
    } catch (error) {
      console.warn("Failed to notify server when leaving voice channel:", error);
      pendingServerLeave = channelId;
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

  // Send periodic heartbeat + refresh the authoritative participant list
  useEffect(() => {
    if (!currentChannelId) return;
    const interval = setInterval(() => {
      const conn = getConnection();
      if (conn.state === "Connected") {
        conn.invoke("VoiceHeartbeat").catch(() => {});
        conn.invoke("GetVoiceChannelUsers", currentChannelId)
          .then((users: Record<string, string>) => {
            useVoiceStore.getState().setParticipants(new Map(Object.entries(users)));
          })
          .catch(() => {});
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [currentChannelId]);

  // Re-register voice session after SignalR reconnects. The LiveKit session is
  // independent of SignalR and survives reconnection, so we only update the
  // server with our new connectionId and health-check LiveKit afterwards.
  useEffect(() => {
    return onReconnected(async () => {
      // If leaveVoice failed to notify the server (connection died mid-leave),
      // retry the leave now that the connection is back.
      if (pendingServerLeave) {
        const leaveChannelId = pendingServerLeave;
        pendingServerLeave = null;
        console.log(`[voice] SignalR reconnected, retrying pending LeaveVoiceChannel for ${leaveChannelId}`);
        try {
          const conn = getConnection();
          await conn.invoke("LeaveVoiceChannel", leaveChannelId);
        } catch (err) {
          console.warn("[voice] Retry LeaveVoiceChannel failed:", (err as Error)?.message);
        }
        return;
      }

      const vs = useVoiceStore.getState();
      const channelId = vs.currentChannelId;
      if (!channelId) return;

      console.log(`[voice] SignalR reconnected, re-registering voice session for channel ${channelId}`);

      // Brief delay to let the new connection stabilize.
      await new Promise(r => setTimeout(r, 500));

      const reregister = async () => {
        const conn = getConnection();
        await conn.invoke("JoinVoiceChannel", channelId, vs.isMuted, vs.isDeafened);
      };

      try {
        await reregister();
      } catch (firstErr) {
        console.warn("[voice] First re-register attempt failed, retrying in 2s:", (firstErr as Error)?.message);
        await new Promise(r => setTimeout(r, 2000));
        try {
          await reregister();
        } catch (err) {
          console.error("[voice] Failed to re-register voice after SignalR reconnect:", err);
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
            level: 'error',
            tags: { 'diagnostic.category': 'webrtc', 'webrtc.phase': 'reconnect-reregister' },
          });
          if (document.hidden) {
            pendingVisibilityRejoin = true;
            console.log("[voice] Tab hidden, will attempt full rejoin when visible");
          } else {
            await attemptVoiceRejoin("signalr-reconnect-recovery");
          }
          return;
        }
      }

      // Health-check LiveKit after a successful re-register (give LiveKit its own
      // reconnect window before intervening).
      const postVs = useVoiceStore.getState();
      if (postVs.currentChannelId !== channelId) return;
      setTimeout(() => { void performPostReconnectLiveKitHealthCheck(channelId); }, 5000);
    });
  }, []);

  // Tab visibility: rejoin if we missed reconnection while hidden; otherwise just
  // make sure audio is unlocked (the SFU mic is owned by LiveKit).
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.hidden) return;

      const channelId = useVoiceStore.getState().currentChannelId;
      if (!channelId) {
        pendingVisibilityRejoin = false;
        return;
      }

      if (pendingVisibilityRejoin) {
        const conn = getConnection();
        if (conn.state === "Connected") {
          await attemptVoiceRejoin("visibility-pending");
        }
        return;
      }

      attemptAudioUnlock();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return { joinVoice, leaveVoice, startScreenShare, stopScreenShare, startCamera, stopCamera, switchCamera };
}
