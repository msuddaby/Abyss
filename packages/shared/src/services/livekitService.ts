import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  ExternalE2EEKeyProvider,
  LocalVideoTrack,
  type RemoteTrack,
  type RemoteVideoTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type VideoCodec,
} from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useServerStore } from '../stores/serverStore.js';
import { useToastStore } from '../stores/toastStore.js';
import { clearChannelKey } from './e2eeKeyManager.js';
import { reportDiagnostic } from './diagnostics.js';
import api from './api.js';

interface LiveKitTokenResponse {
  token: string;
  url: string;
}

let currentRoom: Room | null = null;

// SFU disconnection recovery state
let isManualDisconnect = false;
let sfuRecoveryAttempt = 0;
let sfuRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_SFU_RECOVERY_ATTEMPTS = 3;
type SfuRecoveryCallback = (channelId: string) => Promise<void>;
let sfuRecoveryCallback: SfuRecoveryCallback | null = null;

// On Linux Electron, desktopCapturer.getSources crashes PipeWire on many setups,
// so screen share uses getUserMedia+chromeMediaSource and a manually published
// LocalVideoTrack instead of setScreenShareEnabled (which calls getDisplayMedia).
let linuxScreenShareTrack: LocalVideoTrack | null = null;
let linuxScreenShareStream: MediaStream | null = null;

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

// The underlying LiveKit tracks behind the streams above. adaptiveStream only
// learns an element's size and visibility through `track.attach()`, so views
// must attach the track itself rather than assigning `srcObject` from the
// MediaStream — otherwise `elementInfos` stays empty, the SDK reports the video
// as hidden/0x0 and the SFU drops us to the lowest layer (or pauses the track).
const sfuScreenTracks = new Map<string, RemoteVideoTrack>();
const sfuCameraTracks = new Map<string, RemoteVideoTrack>();

/** Capture + encode settings for one screen-share quality tier. */
export interface ScreenSharePreset {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
  contentHint: 'motion' | 'detail';
  degradationPreference: RTCDegradationPreference;
}

export async function connectToLiveKit(channelId: string): Promise<void> {
  const t0 = performance.now();
  const voiceState = useVoiceStore.getState();
  console.log(`[livekit] Connecting to SFU for channel: ${channelId} | previousMode: ${voiceState.connectionMode}`);
  voiceState.setConnectionMode('connecting');

  try {
    // Get token from backend
    const res = await api.post('/voice/livekit-token', { channelId });
    const { token, url } = res.data as LiveKitTokenResponse;
    const tToken = performance.now();
    console.log(`[livekit] Token obtained in ${Math.round(tToken - t0)}ms`);

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
      // `pixelDensity: 'screen'` makes a HiDPI viewer ask for the full-resolution
      // layer instead of a half-scale one for the same CSS-pixel element size.
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      publishDefaults: {
        // Build-time override (VITE_* vars are inlined by Vite, so switching
        // codecs needs a rebuild, not a code change). VP8 is the safe default:
        // widest hardware support and no SVC interaction with the E2EE worker.
        videoCodec: ((import.meta as any).env?.VITE_LK_VIDEO_CODEC as VideoCodec) ?? 'vp8',
      },
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
    const tConnect0 = performance.now();
    await room.connect(url, token);
    const tConnect1 = performance.now();
    console.log(`[livekit] Connected to room: ${room.name} E2EE: ${room.isE2EEEnabled} — connect took ${Math.round(tConnect1 - tConnect0)}ms (total ${Math.round(tConnect1 - t0)}ms)`);

    currentRoom = room;
    voiceState.setConnectionMode('sfu');
    voiceState.setConnectionState('connected');

    reportDiagnostic({
      category: 'livekit',
      message: `Connected to SFU room: ${room.name} (E2EE: ${room.isE2EEEnabled})`,
      level: 'breadcrumb',
      data: { channelId, e2ee: room.isE2EEEnabled, participants: room.remoteParticipants.size },
    });

    // Add existing participants
    const existingParticipants: string[] = [];
    for (const participant of room.remoteParticipants.values()) {
      voiceState.addParticipant(participant.identity, participant.name || participant.identity);
      existingParticipants.push(`${participant.name || participant.identity} (tracks: ${participant.trackPublications.size})`);
    }
    console.log(`[livekit] Existing participants in room: ${existingParticipants.length === 0 ? 'none' : existingParticipants.join(', ')}`);

    // Publish local audio
    const tPub0 = performance.now();
    await publishAudio();
    console.log(`[livekit] publishAudio took ${Math.round(performance.now() - tPub0)}ms — total join: ${Math.round(performance.now() - t0)}ms`);

  } catch (err) {
    console.error(`[livekit] Connection failed after ${Math.round(performance.now() - t0)}ms:`, err);
    voiceState.setConnectionMode('disconnected');
    voiceState.setConnectionState('disconnected');
    useToastStore.getState().addToast('Failed to connect to voice relay server', 'error');
    reportDiagnostic({
      category: 'livekit',
      message: `SFU connection failed for channel ${channelId}`,
      level: 'error',
      data: { channelId },
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw err;
  }
}

function setupRoomListeners(room: Room): void {
  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    const vs = useVoiceStore.getState();
    console.log(`[livekit] Participant joined: ${participant.identity} (${participant.name}) | room participants: ${room.remoteParticipants.size} | our mode: ${vs.connectionMode}`);
    vs.addParticipant(participant.identity, participant.name || participant.identity);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    const vs = useVoiceStore.getState();
    console.log(`[livekit] Participant left: ${participant.identity} (${participant.name}) | remaining room participants: ${room.remoteParticipants.size} | channel: ${vs.currentChannelId} | had audio element: ${sfuAudioElements.has(participant.identity)} | had gain node: ${sfuGainNodes.has(participant.identity)}`);
    vs.removeParticipant(participant.identity);
    cleanupParticipantAudio(participant.identity);
    // Also clean sidebar state — VoiceUserLeftChannel may have been suppressed
    // if SignalR disconnected before LiveKit did.
    const channelId = vs.currentChannelId;
    if (channelId) {
      useServerStore.getState().voiceUserLeft(channelId, participant.identity);
    }
  });

  // Prevent auto-subscription to screen share audio — only subscribe when
  // the local user is actively watching that participant's screen share.
  room.on(RoomEvent.TrackPublished, (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    console.log(`[livekit] TrackPublished from ${participant.identity}: source=${publication.source} kind=${publication.kind} subscribed=${publication.isSubscribed}`);
    if (publication.source === Track.Source.ScreenShareAudio) {
      const watchingUserId = useVoiceStore.getState().watchingUserId;
      if (watchingUserId !== participant.identity) {
        console.log('[livekit] Blocking screen audio subscription from:', participant.identity, '(not watching)');
        publication.setSubscribed(false);
      }
    }
  });

  room.on(RoomEvent.TrackSubscribed, (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind === Track.Kind.Audio) {
      const isScreenAudio = publication.source === Track.Source.ScreenShareAudio;
      if (isScreenAudio && useVoiceStore.getState().watchingUserId !== participant.identity) {
        // Not watching this participant, so their screen audio must not play.
        // TrackPublished only fires for tracks published after we joined, so a
        // share that was already running when we joined lands here instead.
        console.log('[livekit] Dropping unwatched screen audio from:', participant.identity);
        publication.setSubscribed(false);
        return;
      }
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
      // Route the freshly-attached element to the user's chosen output device
      void sfuSetOutputDevice(voiceState.outputDeviceId || 'default');
      // Diagnostic: check if the audio element is actually playing
      const playPromise = audioElement.play();
      if (playPromise) {
        playPromise.then(() => {
          console.log(`[livekit] Audio element playing for ${participant.identity} — paused=${audioElement.paused} volume=${audioElement.volume} muted=${audioElement.muted} srcObject=${!!audioElement.srcObject}`);
          if (!isScreenAudio) {
            useVoiceStore.getState().setNeedsAudioUnlock(false);
          }
        }).catch((err) => {
          console.warn(`[livekit] Audio element play FAILED for ${participant.identity}:`, err.name, err.message, `— paused=${audioElement.paused} hidden=${document.hidden}`);
          // Mirror the P2P path — surface a "tap to unlock" banner so the user
          // can recover from browser autoplay blocks. Screen-share audio has
          // its own gated subscribe path and shouldn't drive this global flag.
          if (!isScreenAudio) {
            useVoiceStore.getState().setNeedsAudioUnlock(true);
          }
        });
      }
    } else if (track.kind === Track.Kind.Video) {
      const source = publication.source;
      const mediaStream = new MediaStream([track.mediaStreamTrack]);
      if (source === Track.Source.ScreenShare) {
        console.log('[livekit] Screen share track subscribed from:', participant.identity);
        sfuScreenStreams.set(participant.identity, mediaStream);
        sfuScreenTracks.set(participant.identity, track as RemoteVideoTrack);
        // Deliberately no auto-watch: ScreenShareView shows a "Watch Stream"
        // picker instead, and tuning in is what subscribes the share's audio.
        // adaptiveStream keeps the unwatched video track paused, so leaving it
        // subscribed costs no bandwidth.
        useVoiceStore.getState().bumpScreenStreamVersion();
      } else if (source === Track.Source.Camera) {
        console.log('[livekit] Camera track subscribed from:', participant.identity);
        sfuCameraStreams.set(participant.identity, mediaStream);
        sfuCameraTracks.set(participant.identity, track as RemoteVideoTrack);
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
        sfuScreenTracks.delete(participant.identity);
        const voiceState = useVoiceStore.getState();
        if (voiceState.watchingUserId === participant.identity) {
          voiceState.setWatching(null);
        }
        voiceState.bumpScreenStreamVersion();
      } else if (source === Track.Source.Camera) {
        console.log('[livekit] Camera track unsubscribed from:', participant.identity);
        sfuCameraStreams.delete(participant.identity);
        sfuCameraTracks.delete(participant.identity);
        useVoiceStore.getState().bumpCameraStreamVersion();
      }
    }
  });

  room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
    const voiceState = useVoiceStore.getState();
    console.log(`[livekit] Connection state: ${state} | previous: ${voiceState.connectionState} | channel: ${voiceState.currentChannelId} | participants: ${room.remoteParticipants.size} | isManualDisconnect: ${isManualDisconnect}`);
    if (state === ConnectionState.Connected) {
      voiceState.setConnectionState('connected');
    } else if (state === ConnectionState.Reconnecting) {
      voiceState.setConnectionState('reconnecting');
      reportDiagnostic({
        category: 'livekit',
        message: 'SFU connection reconnecting',
        level: 'breadcrumb',
        data: { previousState: voiceState.connectionState },
      });
    } else if (state === ConnectionState.Disconnected) {
      voiceState.setConnectionState('disconnected');
      reportDiagnostic({
        category: 'livekit',
        message: 'SFU connection lost',
        level: 'warning',
        data: { channelId: voiceState.currentChannelId },
      });
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    const vs = useVoiceStore.getState();
    console.log(`[livekit] Disconnected from room | manual: ${isManualDisconnect} | channel: ${vs.currentChannelId} | recoveryAttempt: ${sfuRecoveryAttempt}/${MAX_SFU_RECOVERY_ATTEMPTS} | audioElements: ${sfuAudioElements.size} | screenStreams: ${sfuScreenStreams.size}`);
    reportDiagnostic({
      category: 'livekit',
      message: 'Disconnected from SFU room',
      level: 'warning',
      data: { channelId: vs.currentChannelId },
    });
    cleanup();

    // Attempt automatic recovery if this wasn't a manual disconnect
    if (!isManualDisconnect) {
      console.log(`[livekit] Unexpected disconnect — scheduling recovery (attempt ${sfuRecoveryAttempt + 1}/${MAX_SFU_RECOVERY_ATTEMPTS})`);
      scheduleSfuRecovery();
    } else {
      console.log('[livekit] Manual disconnect — skipping recovery');
    }
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

export async function sfuToggleMute(muted: boolean): Promise<void> {
  if (!currentRoom) { console.log(`[livekit] sfuToggleMute(${muted}) — no room, skipping`); return; }
  console.log(`[livekit] sfuToggleMute(${muted}) via setMicrophoneEnabled`);
  await currentRoom.localParticipant.setMicrophoneEnabled(!muted);
}

export function sfuSetDeafened(deafened: boolean): void {
  console.log(`[livekit] sfuSetDeafened(${deafened}) | audioElements: ${sfuAudioElements.size} | gainNodes: ${sfuGainNodes.size} | screenAudioElements: ${sfuScreenAudioElements.size}`);
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
    for (const [userId] of sfuAudioElements) {
      const vol = userVolumes.get(userId) ?? 100;
      sfuSetUserVolume(userId, vol);
    }
    const savedVol = parseFloat(localStorage.getItem('ss-volume') ?? '1');
    const clampedVol = Math.min(1, Math.max(0, savedVol));
    for (const audio of sfuScreenAudioElements.values()) {
      audio.volume = clampedVol;
      audio.muted = clampedVol === 0;
    }
  }
}

export function sfuSetScreenShareAudioSubscribed(participantId: string, subscribed: boolean): void {
  if (!currentRoom) return;
  const participant = currentRoom.remoteParticipants.get(participantId);
  if (!participant) return;
  for (const pub of participant.trackPublications.values()) {
    if (pub.source === Track.Source.ScreenShareAudio) {
      console.log(`[livekit] ${subscribed ? 'Subscribing' : 'Unsubscribing'} screen audio for:`, participantId);
      pub.setSubscribed(subscribed);
      break;
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
    audio.volume = Math.min(1, volume / 100);
  }
}

export async function sfuSetInputDevice(deviceId: string): Promise<void> {
  if (!currentRoom) { console.log(`[livekit] sfuSetInputDevice(${deviceId}) — no room, skipping`); return; }
  console.log(`[livekit] sfuSetInputDevice — switching to device: ${deviceId}`);
  const voiceState = useVoiceStore.getState();
  await currentRoom.localParticipant.setMicrophoneEnabled(false);
  await currentRoom.localParticipant.setMicrophoneEnabled(true, {
    deviceId: deviceId !== 'default' ? deviceId : undefined,
    autoGainControl: voiceState.autoGainControl,
    echoCancellation: voiceState.echoCancellation,
    noiseSuppression: voiceState.noiseSuppression,
  });
  // setMicrophoneEnabled(true) re-enables the mic — re-apply the current
  // mute / PTT state so re-publishing never force-unmutes a muted user.
  const shouldBeMuted = voiceState.isMuted ||
    (voiceState.voiceMode === 'push-to-talk' && !voiceState.isPttActive);
  if (shouldBeMuted) {
    await currentRoom.localParticipant.setMicrophoneEnabled(false);
  }
}

/**
 * Route all remote audio (mic + screen-share audio) to a specific output device.
 * Called when the user changes their output device and applied to newly-attached
 * audio elements as tracks are subscribed.
 */
export async function sfuSetOutputDevice(deviceId: string): Promise<void> {
  const sinkId = deviceId === 'default' ? '' : deviceId;
  const apply = async (audio: HTMLAudioElement) => {
    const el = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return;
    try {
      await el.setSinkId(sinkId);
    } catch (err) {
      console.warn('[livekit] setSinkId failed:', err);
    }
  };
  for (const audio of sfuAudioElements.values()) await apply(audio);
  for (const audio of sfuScreenAudioElements.values()) await apply(audio);
}

export async function sfuPublishScreenShare(opts: ScreenSharePreset): Promise<void> {
  if (!currentRoom) return;
  console.log('[livekit] Publishing screen share', opts);

  const encoding = { maxBitrate: opts.maxBitrate, maxFramerate: opts.frameRate };

  // On Linux Electron, desktopCapturer.getSources crashes PipeWire, so getDisplayMedia
  // (used internally by setScreenShareEnabled) is unavailable. Capture via
  // getUserMedia+chromeMediaSource and publish as a LocalVideoTrack directly.
  const isLinuxElectron = (window as any).electron?.platform === 'linux';
  if (isLinuxElectron) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          // Without these the desktop is captured at full native resolution and
          // then squeezed into the bitrate ceiling, which looks like mush on
          // anything above 1080p.
          maxWidth: opts.width,
          maxHeight: opts.height,
          maxFrameRate: opts.frameRate,
        },
      } as any,
      audio: false,
    });
    const mediaTrack = stream.getVideoTracks()[0];
    mediaTrack.contentHint = opts.contentHint;
    linuxScreenShareStream = stream;
    linuxScreenShareTrack = new LocalVideoTrack(mediaTrack, undefined, true);
    mediaTrack.onended = () => {
      sfuUnpublishScreenShare().catch(() => {});
    };
    await currentRoom.localParticipant.publishTrack(linuxScreenShareTrack, {
      source: Track.Source.ScreenShare,
      // Must be screenShareEncoding, not videoEncoding: computeVideoEncodings()
      // reads screenShareEncoding for ScreenShare sources and discards
      // videoEncoding entirely, silently falling back to the library default
      // of 1080p15 @ 2.5 Mbps.
      screenShareEncoding: encoding,
      degradationPreference: opts.degradationPreference,
    });
    return;
  }

  // Without an explicit `resolution` livekit-client pins capture to
  // ScreenSharePresets.h1080fps30, which caps the *capture* framerate at 30 and
  // makes the 60fps tier unreachable.
  const captureOpts = {
    resolution: { width: opts.width, height: opts.height, frameRate: opts.frameRate },
    contentHint: opts.contentHint,
  };
  const publishOpts = {
    screenShareEncoding: encoding,
    degradationPreference: opts.degradationPreference,
  };
  try {
    await currentRoom.localParticipant.setScreenShareEnabled(
      true,
      { ...captureOpts, audio: true },
      publishOpts,
    );
  } catch (err: any) {
    if (err?.name === 'NotSupportedError') {
      // Audio capture via getDisplayMedia is not supported on this platform
      console.warn('[livekit] Screen share audio not supported, retrying without audio');
      await currentRoom.localParticipant.setScreenShareEnabled(
        true,
        { ...captureOpts, audio: false },
        publishOpts,
      );
    } else {
      throw err;
    }
  }
}

export async function sfuUnpublishScreenShare(): Promise<void> {
  if (!currentRoom) return;
  console.log('[livekit] Unpublishing screen share');
  if (linuxScreenShareTrack) {
    await currentRoom.localParticipant.unpublishTrack(linuxScreenShareTrack);
    linuxScreenShareStream?.getTracks().forEach((t) => t.stop());
    linuxScreenShareTrack = null;
    linuxScreenShareStream = null;
    return;
  }
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

// Track accessors for adaptiveStream-correct rendering. Views should call
// `track.attach(videoEl)` / `track.detach(videoEl)` instead of assigning
// srcObject, so the SDK can report the element's real size and visibility.
export function getSfuScreenTrack(userId: string): RemoteVideoTrack | undefined {
  return sfuScreenTracks.get(userId);
}

export function getSfuCameraTrack(userId: string): RemoteVideoTrack | undefined {
  return sfuCameraTracks.get(userId);
}

export function getSfuLocalScreenTrack(): LocalVideoTrack | null {
  if (!currentRoom) return null;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  return (pub?.track as LocalVideoTrack | undefined) ?? null;
}

export function getSfuLocalCameraTrack(): LocalVideoTrack | null {
  if (!currentRoom) return null;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Camera);
  return (pub?.track as LocalVideoTrack | undefined) ?? null;
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

/**
 * Returns a MediaStream wrapping the locally-published microphone track, or null
 * if no mic is published. Used by useWebRTC to drive the local speaking
 * indicator / input-level meter via an AnalyserNode (LiveKit owns capture).
 */
export function getSfuLocalMicStream(): MediaStream | null {
  if (!currentRoom) return null;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track?.mediaStreamTrack;
  if (!track) return null;
  return new MediaStream([track]);
}

export async function sfuUpdateScreenShareQuality(opts: ScreenSharePreset): Promise<void> {
  if (!currentRoom) return;
  const pub = currentRoom.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const track = pub?.track as LocalVideoTrack | undefined;
  if (!track) return;
  console.log('[livekit] Updating screen share quality in place', opts);

  // Reconfigure the live track rather than re-publishing. Re-publishing re-opens
  // the OS picker on every quality change, and on Linux it would route through
  // setScreenShareEnabled — the exact API the Linux capture branch exists to
  // avoid — leaving linuxScreenShareTrack dangling.
  try {
    await track.mediaStreamTrack.applyConstraints({
      width: { ideal: opts.width },
      height: { ideal: opts.height },
      frameRate: { ideal: opts.frameRate },
    });
    track.mediaStreamTrack.contentHint = opts.contentHint;
    await track.setDegradationPreference(opts.degradationPreference);

    const sender = track.sender;
    if (sender) {
      const params = sender.getParameters();
      for (const enc of params.encodings ?? []) {
        // Simulcast publishes several encodings; give each its share of the
        // budget based on how far down it is scaled.
        const down = enc.scaleResolutionDownBy ?? 1;
        enc.maxBitrate = Math.floor(opts.maxBitrate / (down * down));
        enc.maxFramerate = opts.frameRate;
      }
      await sender.setParameters(params);
    }
  } catch (err) {
    console.warn('[livekit] In-place quality update failed, re-publishing', err);
    await sfuUnpublishScreenShare();
    await sfuPublishScreenShare(opts);
    // Re-publishing swaps in a new track object, so views must re-attach.
    useVoiceStore.getState().bumpScreenStreamVersion();
  }
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
  if (!currentRoom) { console.log('[livekit] disconnectFromLiveKit — no room, skipping'); return; }
  const vs = useVoiceStore.getState();
  console.log(`[livekit] Disconnecting... | channel: ${vs.currentChannelId} | participants: ${currentRoom.remoteParticipants.size} | audioElements: ${sfuAudioElements.size} | screenStreams: ${sfuScreenStreams.size} | cameraStreams: ${sfuCameraStreams.size}`);

  // Prevent the Disconnected handler from scheduling recovery
  isManualDisconnect = true;
  cancelSfuRecovery();

  // Clear E2EE key for the channel
  const channelId = useVoiceStore.getState().currentChannelId;
  if (channelId) {
    clearChannelKey(channelId);
  }

  await currentRoom.disconnect();
  cleanup();
  isManualDisconnect = false;
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
  console.log(`[livekit] Cleanup — gainNodes: ${sfuGainNodes.size} | audioElements: ${sfuAudioElements.size} | screenAudioElements: ${sfuScreenAudioElements.size} | screenStreams: ${sfuScreenStreams.size} | cameraStreams: ${sfuCameraStreams.size} | linuxScreenShare: ${!!linuxScreenShareTrack}`);
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
  sfuScreenTracks.clear();
  sfuCameraTracks.clear();
  linuxScreenShareStream?.getTracks().forEach((t) => t.stop());
  linuxScreenShareTrack = null;
  linuxScreenShareStream = null;
  currentRoom = null;
}

export function getLiveKitRoom(): Room | null {
  return currentRoom;
}

export function isInSfuMode(): boolean {
  return currentRoom !== null;
}

export interface LiveKitHealthSnapshot {
  state: ConnectionState;
  remoteParticipants: number;
  isE2EEEnabled: boolean;
}

/**
 * Returns the current LiveKit connection health, or null if no room is active.
 * Used to detect silent-zombie LiveKit sessions after a network blip — a Connected
 * room with 0 remote participants when SignalR's authoritative list says otherwise
 * indicates the signalling socket missed ParticipantConnected events.
 */
export function getLiveKitHealth(): LiveKitHealthSnapshot | null {
  if (!currentRoom) return null;
  return {
    state: currentRoom.state,
    remoteParticipants: currentRoom.remoteParticipants.size,
    isE2EEEnabled: currentRoom.isE2EEEnabled,
  };
}

/**
 * Force a full SFU reconnect. Tears down any existing (possibly stale) room
 * without scheduling auto-recovery, then re-runs the registered recovery
 * callback (which re-applies RNNoise) or falls back to connectToLiveKit.
 * Callers are responsible for deciding when to invoke this — see the
 * post-SignalR-reconnect health check in useWebRTC.
 */
export async function sfuTriggerRecovery(channelId: string): Promise<void> {
  console.warn(`[livekit] sfuTriggerRecovery invoked for channel ${channelId} | currentRoom=${!!currentRoom} state=${currentRoom?.state ?? 'none'} remoteParticipants=${currentRoom?.remoteParticipants.size ?? 0}`);
  cancelSfuRecovery();

  if (currentRoom) {
    isManualDisconnect = true;
    try {
      await currentRoom.disconnect();
    } catch (err) {
      console.warn('[livekit] sfuTriggerRecovery: disconnect of stale room threw:', err);
    }
    cleanup();
    isManualDisconnect = false;
  }

  if (sfuRecoveryCallback) {
    await sfuRecoveryCallback(channelId);
  } else {
    await connectToLiveKit(channelId);
  }
}

// --- SFU disconnection recovery ---

/**
 * Register a callback for SFU recovery. When LiveKit unexpectedly disconnects,
 * this callback is invoked with the channel ID so the caller can perform a full
 * reconnect (including re-applying RNNoise, etc.).
 */
export function setSfuRecoveryCallback(cb: SfuRecoveryCallback | null): void {
  sfuRecoveryCallback = cb;
}

export function cancelSfuRecovery(): void {
  if (sfuRecoveryTimer) {
    clearTimeout(sfuRecoveryTimer);
    sfuRecoveryTimer = null;
  }
  sfuRecoveryAttempt = 0;
}

function scheduleSfuRecovery(): void {
  const vs = useVoiceStore.getState();
  const channelId = vs.currentChannelId;
  if (!channelId) { console.log('[livekit] scheduleSfuRecovery — no channel, aborting'); return; }

  if (sfuRecoveryAttempt >= MAX_SFU_RECOVERY_ATTEMPTS) {
    console.error(`[livekit] Max SFU recovery attempts (${MAX_SFU_RECOVERY_ATTEMPTS}) reached, giving up | channel: ${channelId} | connectionMode: ${vs.connectionMode}`);
    sfuRecoveryAttempt = 0;
    useToastStore.getState().addToast('Voice relay connection lost. Please rejoin.', 'error');
    return;
  }

  sfuRecoveryAttempt++;
  const delay = Math.min(2000 * sfuRecoveryAttempt, 10000);
  console.log(`[livekit] Scheduling SFU recovery attempt ${sfuRecoveryAttempt}/${MAX_SFU_RECOVERY_ATTEMPTS} in ${delay}ms | channel: ${channelId} | hasRecoveryCallback: ${!!sfuRecoveryCallback}`);

  sfuRecoveryTimer = setTimeout(async () => {
    sfuRecoveryTimer = null;
    const currentChannelId = useVoiceStore.getState().currentChannelId;
    if (!currentChannelId) {
      sfuRecoveryAttempt = 0;
      return;
    }

    try {
      const recoveryMethod = sfuRecoveryCallback ? 'callback' : 'connectToLiveKit';
      console.log(`[livekit] Starting SFU recovery via ${recoveryMethod} for channel: ${currentChannelId}`);
      if (sfuRecoveryCallback) {
        await sfuRecoveryCallback(currentChannelId);
      } else {
        await connectToLiveKit(currentChannelId);
      }
      sfuRecoveryAttempt = 0;
      console.log(`[livekit] SFU recovery successful via ${recoveryMethod}`);
    } catch (err) {
      console.error(`[livekit] SFU recovery attempt ${sfuRecoveryAttempt}/${MAX_SFU_RECOVERY_ATTEMPTS} failed:`, err);
      // If connectToLiveKit fails early (API error, token failure), no
      // Disconnected event fires, so we must schedule the next retry ourselves.
      // If it fails late (room connected then dropped), Disconnected will fire
      // and call scheduleSfuRecovery again — but the timer guard prevents doubles.
      if (!sfuRecoveryTimer) {
        console.log('[livekit] No pending recovery timer — scheduling next attempt');
        scheduleSfuRecovery();
      } else {
        console.log('[livekit] Recovery timer already pending — Disconnected event will handle next attempt');
      }
    }
  }, delay);
}

// --- SFU audio unlock ---

/**
 * Attempt to play all SFU audio elements. Returns true if all succeeded.
 * Called from attemptAudioUnlock to cover SFU audio elements that may have
 * been blocked by browser autoplay policy.
 */
export async function attemptSfuAudioUnlock(): Promise<boolean> {
  let allOk = true;
  const plays: Promise<void>[] = [];

  for (const audio of sfuAudioElements.values()) {
    if (!audio.srcObject) continue;
    plays.push(
      audio.play().catch((err) => {
        console.warn('[livekit] SFU audio unlock play failed:', err);
        allOk = false;
      }),
    );
  }
  for (const audio of sfuScreenAudioElements.values()) {
    if (!audio.srcObject) continue;
    plays.push(
      audio.play().catch((err) => {
        console.warn('[livekit] SFU screen audio unlock play failed:', err);
        allOk = false;
      }),
    );
  }

  if (plays.length > 0) {
    await Promise.all(plays);
  }
  return allOk;
}
