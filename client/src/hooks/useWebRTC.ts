import { useCallback, useEffect } from "react";
import {
  ensureConnected,
  getConnection,
  getTurnCredentials,
  subscribeTurnCredentials,
  useVoiceStore,
  useAuthStore,
  useServerStore,
  useVoiceChatStore,
} from "@abyss/shared";

const STUN_URL =
  import.meta.env.VITE_STUN_URL || "stun:stun.l.google.com:19302";
let currentIceServers: RTCIceServer[] = [{ urls: STUN_URL }];
let turnInitPromise: Promise<void> | null = null;
const iceRestartInFlight: Set<string> = new Set();

// All state is module-level so it's shared across hook instances
const peers: Map<string, RTCPeerConnection> = new Map();
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
const audioElements: Map<string, HTMLAudioElement> = new Map();
const screenVideoStreams: Map<string, MediaStream> = new Map();
const pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
let listenersRegistered = false;
let currentOutputDeviceId: string = "default";

// Per-viewer screen track senders: viewerUserId -> RTCRtpSender[]
const screenTrackSenders: Map<string, RTCRtpSender[]> = new Map();

// Camera state
let cameraStream: MediaStream | null = null;
const cameraVideoStreams: Map<string, MediaStream> = new Map(); // peerId → remote camera stream
const cameraTrackSenders: Map<string, RTCRtpSender> = new Map(); // peerId → sender
const pendingTrackTypes: Map<string, string[]> = new Map(); // peerId → FIFO queue of "camera"|"screen"

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
        speaking = speaking && store.isPttActive && !store.isMuted;
      }
      store.setSpeaking(userId, speaking);

      if (currentUserId && userId === currentUserId) {
        store.setLocalInputLevel(rms);
        if (localStream && store.voiceMode === "voice-activity") {
          const sensitivity = Math.min(1, Math.max(0, store.inputSensitivity));
          const threshold =
            INPUT_THRESHOLD_MAX -
            (INPUT_THRESHOLD_MAX - INPUT_THRESHOLD_MIN) * sensitivity;
          const enabled = !store.isMuted && rms >= threshold;
          localStream.getAudioTracks().forEach((track) => {
            track.enabled = enabled;
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

async function restartIceForPeer(peerId: string, pc: RTCPeerConnection) {
  if (iceRestartInFlight.has(peerId)) return;
  iceRestartInFlight.add(peerId);
  try {
    await enqueueSignaling(peerId, async () => {
      if (pc.signalingState !== "stable") return;
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
    console.warn(`ICE restart failed for ${peerId}:`, err);
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

function createPeerConnection(peerId: string): RTCPeerConnection {
  closePeer(peerId);
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
    if (pc.iceConnectionState === "failed") {
      console.warn(`ICE failed for ${peerId}, attempting restart...`);
      restartIceForPeer(peerId, pc);
    }
  };

  pc.ontrack = (event) => {
    const track = event.track;
    console.log(`Got remote ${track.kind} track from ${peerId}`);
    const stream =
      event.streams && event.streams.length > 0
        ? event.streams[0]
        : new MediaStream([track]);

    if (track.kind === "audio") {
      let audio = audioElements.get(peerId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        // Ensure audio continues in background
        audio.setAttribute("playsinline", "true");
        audio.volume = 1.0;
        audioElements.set(peerId, audio);
      }
      applyOutputDevice(audio, currentOutputDeviceId);
      audio.srcObject = stream;
      audio.muted = useVoiceStore.getState().isDeafened;
      audio
        .play()
        .then(() => useVoiceStore.getState().setNeedsAudioUnlock(false))
        .catch((err) => {
          console.error("Audio play failed:", err);
          useVoiceStore.getState().setNeedsAudioUnlock(true);
        });
      addAnalyser(peerId, stream);
    } else if (track.kind === "video") {
      const trackTypes = pendingTrackTypes.get(peerId);
      let trackType = trackTypes?.shift();
      if (!trackTypes?.length) pendingTrackTypes.delete(peerId);

      // Fallback disambiguation if track-info was lost or raced
      if (!trackType) {
        const store = useVoiceStore.getState();
        if (store.watchingUserId === peerId && !screenVideoStreams.has(peerId)) {
          trackType = "screen";
          console.warn(`track-info race: inferring screen track from ${peerId} (watching)`);
        } else if (store.activeSharers.has(peerId) && !screenVideoStreams.has(peerId) && cameraVideoStreams.has(peerId)) {
          trackType = "screen";
          console.warn(`track-info race: inferring screen track from ${peerId} (sharer + has camera)`);
        } else {
          trackType = "camera";
          console.warn(`track-info race: defaulting to camera track from ${peerId}`);
        }
      }

      if (trackType === "screen") {
        screenVideoStreams.set(peerId, stream);
        useVoiceStore.getState().bumpScreenStreamVersion();
      } else {
        cameraVideoStreams.set(peerId, stream);
        useVoiceStore.getState().bumpCameraStreamVersion();
      }
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
  cameraVideoStreams.delete(peerId);
  pendingCandidates.delete(peerId);
  pendingTrackTypes.delete(peerId);
  screenTrackSenders.delete(peerId);
  cameraTrackSenders.delete(peerId);
  iceRestartInFlight.delete(peerId);
  signalingQueues.delete(peerId);
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
  cameraVideoStreams.clear();
  pendingCandidates.clear();
  pendingTrackTypes.clear();
  screenTrackSenders.clear();
  cameraTrackSenders.clear();
  signalingQueues.clear();
  useVoiceStore.getState().setNeedsAudioUnlock(false);
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

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    console.error("Could not get display media:", err);
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
  await conn.invoke("NotifyScreenShare", voiceState.currentChannelId, true);
}

async function stopScreenShareInternal() {
  const voiceState = useVoiceStore.getState();
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
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await conn.invoke(
            "SendSignal",
            viewerId,
            JSON.stringify({ type: "offer", sdp: offer.sdp }),
          );
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
}

// Camera functions
async function startCameraInternal() {
  const voiceState = useVoiceStore.getState();
  if (!voiceState.currentChannelId) return;

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
  } catch (err) {
    console.error("Could not get camera:", err);
    return;
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
}

async function stopCameraInternal() {
  const voiceState = useVoiceStore.getState();
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
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await conn.invoke(
            "SendSignal",
            peerId,
            JSON.stringify({ type: "offer", sdp: offer.sdp }),
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
    await conn.invoke(
      "SendSignal",
      peerId,
      JSON.stringify({ type: "track-info", trackType: "camera" }),
    );

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

    // Send track-info before adding screen video track
    const conn = getConnection();
    await conn.invoke(
      "SendSignal",
      viewerUserId,
      JSON.stringify({ type: "track-info", trackType: "screen" }),
    );

    // Add all tracks from screen stream (video + audio if available)
    const senders: RTCRtpSender[] = [];
    activeScreenStream.getTracks().forEach((track) => {
      console.log(
        `Adding screen ${track.kind} track for viewer ${viewerUserId}`,
      );
      const sender = pc.addTrack(track, activeScreenStream);
      senders.push(sender);
    });

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

function setupSignalRListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const conn = getConnection();

  conn.on("UserJoinedVoice", async (userId: string, displayName: string) => {
    console.log(`UserJoinedVoice: ${displayName} (${userId})`);
    useVoiceStore.getState().addParticipant(userId, displayName);

    const currentUser = useAuthStore.getState().user;
    if (userId === currentUser?.id || !localStream) return;

    await enqueueSignaling(userId, async () => {
      const pc = createPeerConnection(userId);

      // Add audio tracks only — screen track is added lazily on WatchStreamRequested
      localStream!
        .getTracks()
        .forEach((track) => pc.addTrack(track, localStream!));

      // Add camera track if camera is on (eager — send track-info first)
      if (cameraStream) {
        const camTrack = cameraStream.getVideoTracks()[0];
        if (camTrack) {
          await conn.invoke(
            "SendSignal",
            userId,
            JSON.stringify({ type: "track-info", trackType: "camera" }),
          );
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
  });

  conn.on("UserLeftVoice", (userId: string) => {
    console.log(`UserLeftVoice: ${userId}`);
    useVoiceStore.getState().removeParticipant(userId);
    closePeer(userId);
  });

  conn.on("ReceiveSignal", async (fromUserId: string, signal: string) => {
    const data = JSON.parse(signal);

    if (data.type === "track-info") {
      // Queue track type for disambiguation in ontrack
      if (!pendingTrackTypes.has(fromUserId)) {
        pendingTrackTypes.set(fromUserId, []);
      }
      pendingTrackTypes.get(fromUserId)!.push(data.trackType);
      return;
    }

    if (data.type === "offer") {
      await enqueueSignaling(fromUserId, async () => {
        console.log(`Received offer from ${fromUserId}`);

        let pc = peers.get(fromUserId);
        if (pc && pc.signalingState !== "closed") {
          // Renegotiation: reuse existing connection
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
              await conn.invoke(
                "SendSignal",
                fromUserId,
                JSON.stringify({ type: "track-info", trackType: "camera" }),
              );
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
        const pc = peers.get(fromUserId);
        if (pc) {
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: data.sdp }),
          );
          await applyPendingCandidates(fromUserId);
        }
      });
    } else if (data.candidate) {
      const pc = peers.get(fromUserId);
      if (pc && pc.remoteDescription) {
        await pc
          .addIceCandidate(new RTCIceCandidate(data))
          .catch(console.error);
      } else {
        // Buffer candidates until remote description is set
        if (!pendingCandidates.has(fromUserId)) {
          pendingCandidates.set(fromUserId, []);
        }
        pendingCandidates.get(fromUserId)!.push(data);
      }
    }
  });

  conn.on("VoiceChannelUsers", (users: Record<string, string>) => {
    useVoiceStore.getState().setParticipants(new Map(Object.entries(users)));
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
    cleanupAll();
    useVoiceStore.getState().setCurrentChannel(null);
    useVoiceStore.getState().setParticipants(new Map());
    useVoiceStore.getState().setScreenSharing(false);
    useVoiceStore.getState().setActiveSharers(new Map());
    useVoiceStore.getState().setWatching(null);
    useVoiceStore.getState().setCameraOn(false);
    useVoiceStore.getState().setActiveCameras(new Map());
    useVoiceStore.getState().setFocusedUserId(null);
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

  // Deafen - mute all remote audio
  useEffect(() => {
    audioElements.forEach((audio) => {
      audio.muted = isDeafened;
    });
  }, [isDeafened]);

  // Apply output device changes to all remote audio elements
  useEffect(() => {
    currentOutputDeviceId = outputDeviceId || "default";
    audioElements.forEach((audio) =>
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
    let cancelled = false;
    (async () => {
      try {
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
      await initializeTurn();

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

      setCurrentChannel(channelId);
      const conn = getConnection();
      await conn.invoke(
        "JoinVoiceChannel",
        channelId,
        voiceState.isMuted,
        voiceState.isDeafened,
      );

      // Initialize voice chat store
      const channel = useServerStore.getState().channels.find((c) => c.id === channelId);
      useVoiceChatStore.getState().setChannel(channelId, channel?.persistentChat);
    },
    [buildAudioConstraintsResolved, currentChannelId, setCurrentChannel],
  );

  const leaveVoice = useCallback(async () => {
    if (currentChannelId) {
      const conn = getConnection();
      await conn.invoke("LeaveVoiceChannel", currentChannelId);
    }
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

  return { joinVoice, leaveVoice, startScreenShare, stopScreenShare, startCamera, stopCamera };
}
