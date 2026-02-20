import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  ExternalE2EEKeyProvider,
  type RemoteTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useToastStore } from '../stores/toastStore.js';
import { clearChannelKey } from './e2eeKeyManager.js';
import api from './api.js';

interface LiveKitTokenResponse {
  token: string;
  url: string;
}

let currentRoom: Room | null = null;
// Whether we manually published a mic track (e.g. RNNoise-processed) rather than
// letting LiveKit capture its own. When true, mute/unmute uses publication-level
// mute instead of setMicrophoneEnabled (which would destroy and recapture the track).
let isManualMicPublish = false;

// Audio elements created for remote participants (cleaned up on disconnect)
const sfuAudioElements = new Map<string, HTMLAudioElement>();
// Separate audio elements for screen share audio (ScreenShareAudio source)
const sfuScreenAudioElements = new Map<string, HTMLAudioElement>();

// GainNode entries for participants whose volume is boosted above 100%
interface SfuGainEntry {
  audioCtx: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
}
const sfuGainNodes = new Map<string, SfuGainEntry>();

// Video streams from remote participants via SFU (screen share + camera)
const sfuScreenStreams = new Map<string, MediaStream>();
const sfuCameraStreams = new Map<string, MediaStream>();

export async function connectToLiveKit(channelId: string): Promise<void> {
  console.log('[livekit] Connecting to SFU for channel:', channelId);

  const voiceState = useVoiceStore.getState();
  voiceState.setConnectionMode('attempting-sfu');

  try {
    // Get token from backend
    const res = await api.post('/voice/livekit-token', { channelId });
    const { token, url } = res.data as LiveKitTokenResponse;

    // Set up E2EE key provider with channel-derived passphrase
    let e2eeWorker: Worker | undefined;
    let keyProvider: ExternalE2EEKeyProvider | undefined;
    try {
      // The worker is bundled with livekit-client but not in its exports map,
      // so we reference the file directly via node_modules path
      e2eeWorker = new Worker(
        new URL('../../../../node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs', import.meta.url),
        { type: 'module' },
      );
      keyProvider = new ExternalE2EEKeyProvider();
      // Use channel ID as passphrase — all participants in the same channel
      // derive the same key via PBKDF2 inside the worker
      await keyProvider.setKey(`abyss-e2ee-${channelId}`);
      console.log('[livekit] E2EE key provider initialized');
    } catch (e2eeErr) {
      console.warn('[livekit] E2EE setup failed, connecting without encryption:', e2eeErr);
      e2eeWorker = undefined;
      keyProvider = undefined;
    }

    // Create room (with E2EE if available)
    const roomOptions: ConstructorParameters<typeof Room>[0] = {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        autoGainControl: voiceState.autoGainControl,
        echoCancellation: voiceState.echoCancellation,
        noiseSuppression: voiceState.noiseSuppression,
      },
    };

    if (e2eeWorker && keyProvider) {
      roomOptions.e2ee = {
        keyProvider,
        worker: e2eeWorker,
      };
    }

    const room = new Room(roomOptions);

    // Set up event listeners BEFORE connecting
    setupRoomListeners(room);

    // Connect
    await room.connect(url, token);
    console.log('[livekit] Connected to room:', room.name, 'E2EE:', room.isE2EEEnabled);

    currentRoom = room;
    voiceState.setConnectionMode('sfu');
    voiceState.setConnectionState('connected');

    // Add existing participants
    for (const participant of room.remoteParticipants.values()) {
      voiceState.addParticipant(participant.identity, participant.name || participant.identity);
    }

    // Publish local audio
    await publishAudio();

  } catch (err) {
    console.error('[livekit] Connection failed:', err);
    voiceState.setConnectionMode('p2p');
    voiceState.setConnectionState('disconnected');
    useToastStore.getState().addToast('Failed to connect to voice relay server', 'error');
    throw err;
  }
}

function setupRoomListeners(room: Room): void {
  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    console.log('[livekit] Participant joined:', participant.identity);
    useVoiceStore.getState().addParticipant(participant.identity, participant.name || participant.identity);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    console.log('[livekit] Participant left:', participant.identity);
    useVoiceStore.getState().removeParticipant(participant.identity);
    cleanupParticipantAudio(participant.identity);
  });

  room.on(RoomEvent.TrackSubscribed, (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind === Track.Kind.Audio) {
      const isScreenAudio = publication.source === Track.Source.ScreenShareAudio;
      const audioElement = track.attach();
      document.body.appendChild(audioElement);
      const voiceState = useVoiceStore.getState();
      if (isScreenAudio) {
        console.log('[livekit] Screen audio track subscribed from:', participant.identity);
        sfuScreenAudioElements.set(participant.identity, audioElement);
        const savedVol = parseFloat(localStorage.getItem('ss-volume') ?? '1');
        audioElement.volume = voiceState.isDeafened ? 0 : savedVol;
        audioElement.muted = voiceState.isDeafened || savedVol === 0;
      } else {
        console.log('[livekit] Audio track subscribed from:', participant.identity);
        sfuAudioElements.set(participant.identity, audioElement);
        if (voiceState.isDeafened) {
          audioElement.volume = 0;
        } else {
          const userVol = voiceState.userVolumes.get(participant.identity) ?? 100;
          sfuSetUserVolume(participant.identity, userVol);
        }
      }
    } else if (track.kind === Track.Kind.Video) {
      const source = publication.source;
      const mediaStream = new MediaStream([track.mediaStreamTrack]);
      if (source === Track.Source.ScreenShare) {
        console.log('[livekit] Screen share track subscribed from:', participant.identity);
        sfuScreenStreams.set(participant.identity, mediaStream);
        const voiceState = useVoiceStore.getState();
        // Auto-watch if we don't have a current watch target
        if (!voiceState.watchingUserId) {
          voiceState.setWatching(participant.identity);
        }
        voiceState.bumpScreenStreamVersion();
      } else if (source === Track.Source.Camera) {
        console.log('[livekit] Camera track subscribed from:', participant.identity);
        sfuCameraStreams.set(participant.identity, mediaStream);
        useVoiceStore.getState().bumpCameraStreamVersion();
      }
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind === Track.Kind.Audio) {
      const isScreenAudio = publication.source === Track.Source.ScreenShareAudio;
      track.detach();
      if (isScreenAudio) {
        console.log('[livekit] Screen audio track unsubscribed from:', participant.identity);
        const audio = sfuScreenAudioElements.get(participant.identity);
        if (audio) {
          audio.pause();
          audio.srcObject = null;
          audio.remove();
          sfuScreenAudioElements.delete(participant.identity);
        }
      } else {
        console.log('[livekit] Audio track unsubscribed from:', participant.identity);
        cleanupParticipantAudio(participant.identity);
      }
    } else if (track.kind === Track.Kind.Video) {
      const source = publication.source;
      if (source === Track.Source.ScreenShare) {
        console.log('[livekit] Screen share track unsubscribed from:', participant.identity);
        sfuScreenStreams.delete(participant.identity);
        const voiceState = useVoiceStore.getState();
        if (voiceState.watchingUserId === participant.identity) {
          voiceState.setWatching(null);
        }
        voiceState.bumpScreenStreamVersion();
      } else if (source === Track.Source.Camera) {
        console.log('[livekit] Camera track unsubscribed from:', participant.identity);
        sfuCameraStreams.delete(participant.identity);
        useVoiceStore.getState().bumpCameraStreamVersion();
      }
    }
  });

  room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
    console.log('[livekit] Connection state:', state);
    const voiceState = useVoiceStore.getState();
    if (state === ConnectionState.Connected) {
      voiceState.setConnectionState('connected');
    } else if (state === ConnectionState.Reconnecting) {
      voiceState.setConnectionState('reconnecting');
    } else if (state === ConnectionState.Disconnected) {
      voiceState.setConnectionState('disconnected');
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log('[livekit] Disconnected from room');
    cleanup();
  });

  // Track active speakers for speaking indicators
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const voiceState = useVoiceStore.getState();
    for (const [userId] of voiceState.participants) {
      voiceState.setSpeaking(userId, false);
    }
    for (const speaker of speakers) {
      voiceState.setSpeaking(speaker.identity, true);
    }
  });
}

async function publishAudio(): Promise<void> {
  if (!currentRoom) return;

  const voiceState = useVoiceStore.getState();

  await currentRoom.localParticipant.setMicrophoneEnabled(true, {
    deviceId: voiceState.inputDeviceId !== 'default' ? voiceState.inputDeviceId : undefined,
    autoGainControl: voiceState.autoGainControl,
    echoCancellation: voiceState.echoCancellation,
    noiseSuppression: voiceState.noiseSuppression,
  });

  console.log('[livekit] Published audio track');

  // Apply initial mute state (PTT starts muted until key is held)
  const shouldBeMuted = voiceState.isMuted ||
    (voiceState.voiceMode === 'push-to-talk' && !voiceState.isPttActive);
  if (shouldBeMuted) {
    await currentRoom.localParticipant.setMicrophoneEnabled(false);
  }
}

/**
 * Replace the currently published mic audio track with a new one.
 * Used to swap in an RNNoise-processed track after LiveKit has published
 * its own mic capture, or when toggling RNNoise mid-call.
 * After replacement, mute/unmute uses publication-level mute instead of
 * setMicrophoneEnabled (which would destroy and recapture the mic).
 */
export async function sfuReplaceAudioTrack(newTrack: MediaStreamTrack): Promise<void> {
  if (!currentRoom) return;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!pub?.track) return;
  await pub.track.replaceTrack(newTrack);
  isManualMicPublish = true;
  console.log('[livekit] Replaced audio track');
}

export async function sfuToggleMute(muted: boolean): Promise<void> {
  if (!currentRoom) return;
  if (isManualMicPublish) {
    // When we manually published the track (RNNoise), use publication-level
    // mute/unmute to avoid LiveKit destroying and recapturing the mic.
    const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (pub) {
      if (muted) await pub.mute();
      else await pub.unmute();
    }
  } else {
    await currentRoom.localParticipant.setMicrophoneEnabled(!muted);
  }
}

export function sfuSetDeafened(deafened: boolean): void {
  if (deafened) {
    for (const audio of sfuAudioElements.values()) {
      audio.volume = 0;
    }
    for (const entry of sfuGainNodes.values()) {
      entry.gain.gain.setValueAtTime(0, entry.audioCtx.currentTime);
    }
    for (const audio of sfuScreenAudioElements.values()) {
      audio.volume = 0;
    }
  } else {
    const { userVolumes } = useVoiceStore.getState();
    for (const [userId, audio] of sfuAudioElements) {
      const vol = userVolumes.get(userId) ?? 100;
      const entry = sfuGainNodes.get(userId);
      if (entry) {
        audio.volume = 0;
        entry.gain.gain.setValueAtTime(vol / 100, entry.audioCtx.currentTime);
      } else {
        audio.volume = vol / 100;
      }
    }
    const savedVol = parseFloat(localStorage.getItem('ss-volume') ?? '1');
    for (const audio of sfuScreenAudioElements.values()) {
      audio.volume = savedVol;
      audio.muted = savedVol === 0;
    }
  }
}

export function sfuSetScreenAudioVolume(userId: string, volume: number): void {
  const audio = sfuScreenAudioElements.get(userId);
  if (audio && !useVoiceStore.getState().isDeafened) {
    audio.volume = volume;
    audio.muted = volume === 0;
  }
}

export function sfuSetUserVolume(userId: string, volume: number): void {
  const audio = sfuAudioElements.get(userId);
  if (!audio || useVoiceStore.getState().isDeafened) return;

  if (volume > 100) {
    // Boost via AudioContext GainNode
    let entry = sfuGainNodes.get(userId);
    if (!entry) {
      const stream = audio.srcObject as MediaStream | null;
      if (!stream) { audio.volume = 1; return; }
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const gain = audioCtx.createGain();
      source.connect(gain);
      gain.connect(audioCtx.destination);
      entry = { audioCtx, source, gain };
      sfuGainNodes.set(userId, entry);
      audio.volume = 0; // mute direct playback; gain handles output
    }
    const now = entry.audioCtx.currentTime;
    entry.gain.gain.cancelScheduledValues(now);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
    entry.gain.gain.linearRampToValueAtTime(volume / 100, now + 0.05);
  } else {
    // Normal range — remove gain node if one exists
    const entry = sfuGainNodes.get(userId);
    if (entry) {
      entry.gain.disconnect();
      entry.source.disconnect();
      entry.audioCtx.close();
      sfuGainNodes.delete(userId);
    }
    audio.volume = volume / 100;
  }
}

export async function sfuSetInputDevice(deviceId: string): Promise<void> {
  if (!currentRoom) return;
  // When using manual mic publish (RNNoise), device switching is handled
  // by useWebRTC which recaptures the mic and calls noiseSuppressor.replaceInput().
  if (isManualMicPublish) return;
  const voiceState = useVoiceStore.getState();
  await currentRoom.localParticipant.setMicrophoneEnabled(false);
  await currentRoom.localParticipant.setMicrophoneEnabled(true, {
    deviceId: deviceId !== 'default' ? deviceId : undefined,
    autoGainControl: voiceState.autoGainControl,
    echoCancellation: voiceState.echoCancellation,
    noiseSuppression: voiceState.noiseSuppression,
  });
}

export async function sfuPublishScreenShare(opts?: {
  maxFramerate?: number;
  maxBitrate?: number;
}): Promise<void> {
  if (!currentRoom) return;
  console.log('[livekit] Publishing screen share', opts);
  const publishOpts = {
    screenShareEncoding: opts?.maxBitrate ? {
      maxBitrate: opts.maxBitrate,
      maxFramerate: opts.maxFramerate,
    } : undefined,
  };
  try {
    await currentRoom.localParticipant.setScreenShareEnabled(true, { audio: true }, publishOpts);
  } catch (err: any) {
    if (err?.name === 'NotSupportedError') {
      // Audio capture via getDisplayMedia is not supported on this platform (e.g. Linux)
      console.warn('[livekit] Screen share audio not supported, retrying without audio');
      await currentRoom.localParticipant.setScreenShareEnabled(true, { audio: false }, publishOpts);
    } else {
      throw err;
    }
  }
}

export async function sfuUnpublishScreenShare(): Promise<void> {
  if (!currentRoom) return;
  console.log('[livekit] Unpublishing screen share');
  await currentRoom.localParticipant.setScreenShareEnabled(false);
}

export async function sfuPublishCamera(opts?: {
  deviceId?: string;
  frameRate?: number;
  maxBitrate?: number;
  width?: number;
  height?: number;
}): Promise<void> {
  if (!currentRoom) return;
  console.log('[livekit] Publishing camera', opts);
  await currentRoom.localParticipant.setCameraEnabled(true, {
    deviceId: opts?.deviceId && opts.deviceId !== 'default' ? opts.deviceId : undefined,
    frameRate: opts?.frameRate,
    resolution: opts?.width && opts?.height ? {
      width: opts.width,
      height: opts.height,
      frameRate: opts.frameRate,
    } : undefined,
  }, {
    videoEncoding: opts?.maxBitrate ? {
      maxBitrate: opts.maxBitrate,
      maxFramerate: opts.frameRate,
    } : undefined,
  });
}

export async function sfuUnpublishCamera(): Promise<void> {
  if (!currentRoom) return;
  console.log('[livekit] Unpublishing camera');
  await currentRoom.localParticipant.setCameraEnabled(false);
}

export function getSfuScreenStream(userId: string): MediaStream | undefined {
  return sfuScreenStreams.get(userId);
}

export function getSfuCameraStream(userId: string): MediaStream | undefined {
  return sfuCameraStreams.get(userId);
}

// Cached local streams — avoids creating new MediaStream objects each call
// which would cause constant video element re-assignment
let cachedLocalCameraStream: MediaStream | null = null;
let cachedLocalCameraTrackId: string | null = null;
let cachedLocalScreenStream: MediaStream | null = null;
let cachedLocalScreenTrackId: string | null = null;

export function getSfuLocalCameraStream(): MediaStream | null {
  if (!currentRoom) return null;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Camera);
  const track = pub?.track?.mediaStreamTrack;
  if (!track) { cachedLocalCameraStream = null; cachedLocalCameraTrackId = null; return null; }
  if (track.id !== cachedLocalCameraTrackId) {
    cachedLocalCameraStream = new MediaStream([track]);
    cachedLocalCameraTrackId = track.id;
  }
  return cachedLocalCameraStream;
}

export function getSfuLocalScreenStream(): MediaStream | null {
  if (!currentRoom) return null;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const track = pub?.track?.mediaStreamTrack;
  if (!track) { cachedLocalScreenStream = null; cachedLocalScreenTrackId = null; return null; }
  if (track.id !== cachedLocalScreenTrackId) {
    cachedLocalScreenStream = new MediaStream([track]);
    cachedLocalScreenTrackId = track.id;
  }
  return cachedLocalScreenStream;
}

export async function sfuUpdateScreenShareQuality(opts: {
  maxFramerate: number;
  maxBitrate: number;
}): Promise<void> {
  if (!currentRoom) return;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  if (!pub) return;
  console.log('[livekit] Updating screen share quality — re-publishing', opts);
  // LiveKit doesn't expose a direct encoding update API on LocalTrackPublication,
  // so we re-publish the screen share with the new encoding settings.
  await currentRoom.localParticipant.setScreenShareEnabled(false);
  await currentRoom.localParticipant.setScreenShareEnabled(true, {
    audio: true,
  }, {
    screenShareEncoding: {
      maxBitrate: opts.maxBitrate,
      maxFramerate: opts.maxFramerate,
    },
  });
}

export async function sfuUpdateCameraQuality(opts: {
  frameRate?: number;
  maxBitrate: number;
  width?: number;
  height?: number;
}): Promise<void> {
  if (!currentRoom) return;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Camera);
  if (!pub?.track) return;
  console.log('[livekit] Updating camera quality', opts);
  // Apply constraints to the capture track
  const mediaTrack = pub.track.mediaStreamTrack;
  if (mediaTrack && opts.width && opts.height) {
    await mediaTrack.applyConstraints({
      width: { ideal: opts.width },
      height: { ideal: opts.height },
      frameRate: { ideal: opts.frameRate },
    });
  }
}

export async function disconnectFromLiveKit(): Promise<void> {
  if (!currentRoom) return;
  console.log('[livekit] Disconnecting...');

  // Clear E2EE key for the channel
  const channelId = useVoiceStore.getState().currentChannelId;
  if (channelId) {
    clearChannelKey(channelId);
  }

  await currentRoom.disconnect();
  cleanup();
}

function cleanupParticipantAudio(participantId: string): void {
  const entry = sfuGainNodes.get(participantId);
  if (entry) {
    entry.gain.disconnect();
    entry.source.disconnect();
    entry.audioCtx.close();
    sfuGainNodes.delete(participantId);
  }
  const audio = sfuAudioElements.get(participantId);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    sfuAudioElements.delete(participantId);
  }
  const screenAudio = sfuScreenAudioElements.get(participantId);
  if (screenAudio) {
    screenAudio.pause();
    screenAudio.srcObject = null;
    screenAudio.remove();
    sfuScreenAudioElements.delete(participantId);
  }
}

function cleanup(): void {
  for (const entry of sfuGainNodes.values()) {
    entry.gain.disconnect();
    entry.source.disconnect();
    entry.audioCtx.close();
  }
  sfuGainNodes.clear();
  for (const [, audio] of sfuAudioElements) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
  sfuAudioElements.clear();
  for (const [, audio] of sfuScreenAudioElements) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
  sfuScreenAudioElements.clear();
  sfuScreenStreams.clear();
  sfuCameraStreams.clear();
  currentRoom = null;
  isManualMicPublish = false;
}

export function getLiveKitRoom(): Room | null {
  return currentRoom;
}

export function isInSfuMode(): boolean {
  return currentRoom !== null;
}
