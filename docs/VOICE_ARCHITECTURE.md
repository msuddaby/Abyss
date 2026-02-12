# Abyss Voice Chat Architecture

Comprehensive reference for the WebRTC voice system — signaling, audio pipeline, TURN configuration, and known pitfalls.

---

## Table of Contents

1. [TURN Server Configuration](#1-turn-server-configuration)
2. [WebRTC Signaling Flow](#2-webrtc-signaling-flow)
3. [Audio Playback Pipeline](#3-audio-playback-pipeline)
4. [Voice Activity Detection & Push-to-Talk](#4-voice-activity-detection--push-to-talk)
5. [ICE Restart & Reconnection](#5-ice-restart--reconnection)
6. [Glare (Simultaneous Offer) Handling](#6-glare-simultaneous-offer-handling)
7. [Screen Sharing Audio](#7-screen-sharing-audio)
8. [Mute, Deafen & Volume Control](#8-mute-deafen--volume-control)
9. [Output Device Selection](#9-output-device-selection)
10. [Backend Voice State](#10-backend-voice-state)
11. [Troubleshooting Guide](#11-troubleshooting-guide)

---

## 1. TURN Server Configuration

### Architecture

The backend generates **ephemeral HMAC-SHA1 credentials** (coturn `use-auth-secret` mode). The client fetches them from `GET /api/voice/turn` and passes them to the `RTCPeerConnection`.

### Required coturn Config

```
listening-port=3478
listening-ip=0.0.0.0
relay-ip=0.0.0.0
external-ip=<PUBLIC_IP>
realm=abyss
use-auth-secret
static-auth-secret=<MUST MATCH TURN_AUTH_SECRET ENV VAR>
fingerprint
no-cli
verbose
```

### Critical Configuration Notes

- **`use-auth-secret`** is required — NOT `lt-cred-mech`. These are completely different auth mechanisms. Using `lt-cred-mech` will cause 401 Unauthorized on every TURN allocation, meaning zero relay candidates and broken connectivity for users behind NAT.
- **`static-auth-secret`** must exactly match the `TURN_AUTH_SECRET` environment variable on the backend. Any mismatch (even trailing whitespace) causes 401s.
- **`realm`** must be set (coturn requires it even with ephemeral auth).
- **Firewall**: UDP 3478 + relay range (49152-65535) must be open.
- **If coturn is behind NAT**: `external-ip` must be set to the public IP.

### Backend Environment Variables

| Variable | Description |
|----------|-------------|
| `TURN_URLS` | Comma-separated TURN URLs (e.g., `turn:142.4.217.154:3478`) |
| `TURN_AUTH_SECRET` | Shared secret matching coturn's `static-auth-secret` |
| `TURN_TTL_SECONDS` | Credential lifetime (default: 3600) |

### Credential Format

- Username: `{unixExpiry}:{userId}` (e.g., `1706950400:user-uuid`)
- Credential: `Base64(HMAC-SHA1(secret, username))`

### Client Credential Refresh

Credentials are cached and auto-refreshed 5 minutes before expiry (or 20% of TTL, whichever is larger). Minimum 30s between refreshes. On failure, retries after 15s.

### Testing TURN

```bash
# Install test tools (Arch)
sudo pacman -S coturn

# Fetch credentials from API, then test:
turnutils_uclient -t -e 8.8.8.8 \
  -u "<username>" -w "<credential>" \
  <TURN_SERVER_IP> -p 3478

# Expected: successful allocation
# 401 = auth secret mismatch
# 403 = firewall/relay IP issue
# Timeout = server unreachable or UDP blocked
```

### Browser-Side TURN Test

```js
// Paste in browser console — forces TURN-only connection
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'turn:<IP>:3478', username: '<u>', credential: '<c>' }],
  iceTransportPolicy: 'relay'
});
pc.createDataChannel('test');
pc.createOffer().then(o => pc.setLocalDescription(o));
pc.onicecandidate = e => {
  if (e.candidate) console.log('candidate:', e.candidate.type);
  else console.log('gathering done');
};
// Should see "relay" candidate. If only "gathering done" with none → TURN broken.
```

---

## 2. WebRTC Signaling Flow

### Key Files

- `client/src/hooks/useWebRTC.ts` — all WebRTC logic
- `server/Abyss.Api/Hubs/ChatHub.cs` — SignalR signal routing

### Connection Establishment

1. User A joins voice → server sends `VoiceChannelUsers` (full participant list)
2. Reconciliation creates `RTCPeerConnection` for each missing peer
3. Local audio tracks added, offer created and sent via `SendSignal`
4. Peer receives offer via `ReceiveSignal`, creates answer
5. ICE candidates exchanged inline via `SendSignal`/`ReceiveSignal`

### Signaling Queue

All signaling operations are serialized per-peer via `enqueueSignaling()` to prevent race conditions. Each operation checks the session ID to abort if the voice session ended.

### Signal Routing (Server)

`SendSignal` routes only to the target user's **voice connection** (`_voiceConnections` map). This prevents signals from reaching non-voice browser tabs, which would create broken peer connections.

### DTLS Role Fix

On renegotiation, answer SDP roles are patched (lines 160-174) to maintain compatibility with the existing DTLS transport. Without this fix, DTLS can fail silently after renegotiation.

---

## 3. Audio Playback Pipeline

### Incoming Track Flow

```
ontrack event
  → track queued (400ms wait for track-info match)
  → timeout/match → applyIncomingRemoteTrack()
    → classify as mic / screen-audio / camera / screen-video
    → for audio: create HTMLAudioElement, set srcObject, play()
```

### Audio Element Setup (Mic Audio)

```
audio = new Audio()
audio.autoplay = true
audio.srcObject = stream        ← raw WebRTC stream (NOT createMediaStreamDestination)
audio.volume = userVolume / 100  ← 0-100% range
applyOutputDevice(audio)         ← setSinkId for output device selection
audio.play()
```

### Why Raw Streams (Not GainNode → createMediaStreamDestination)

**`createMediaStreamDestination()` streams are unreliable for `HTMLAudioElement` playback:**

- **Firefox**: `play()` resolves but `paused` stays `true` — the element never actually plays audio.
- **Chrome**: Can silently produce no output depending on timing of stream creation vs. track data flow.
- This was the root cause of a long-standing "can't hear anyone" bug. The connection was healthy, RTP packets were flowing, but the audio element produced silence.

**Current approach**: Raw WebRTC stream on the audio element. Volume 0-100% uses `audio.volume`. Volume >100% (boost) uses a GainNode chain connected to `audioContext.destination`.

### Volume Boost (>100%)

For per-user volume above 100%, a GainNode chain amplifies the signal:

```
createMediaStreamSource(stream) → GainNode → audioContext.destination
audio.volume = 0  (mute element to avoid double playback)
```

Note: This bypasses `setSinkId` — output goes to the AudioContext's default device. This is an acceptable tradeoff since >100% boost is uncommon.

### Track-Info System

Before adding a track to a peer connection, the sender transmits a `track-info` message (via SignalR) identifying the track type (mic, screen-audio, camera, screen). The receiver uses this to classify incoming tracks in `ontrack`. If no track-info arrives within 400ms, the track type is inferred from context.

---

## 4. Voice Activity Detection & Push-to-Talk

### Voice Activity Detection (VAD)

- Per-user AnalyserNode fed from a **cloned** stream (so `track.enabled` toggling doesn't break RMS readings)
- 50ms polling interval (20Hz)
- RMS threshold: `max(0.005, min(0.05, 0.05 - sensitivity * 0.045))`
- Hysteresis: Mic held open 200ms after RMS drops below threshold
- When below threshold: `track.enabled = false` (silences outgoing audio)

### Firefox VAD Workaround

On Firefox, toggling `track.enabled` for voice-activity can permanently mute the remote audio in Firefox→Chromium sessions. The `SHOULD_GATE_VA_WITH_TRACK_ENABLED` flag is `false` on Firefox — the sender stays enabled and only the UI speaking indicator reflects VAD state.

### Push-to-Talk

- Configurable key (default: backtick)
- Browser: `keydown`/`keyup` + `mousedown`/`mouseup` listeners
- Electron: Native global shortcuts via `window.electron.registerPttKey()`
- Track enabled state: `!isMuted && isPttActive`

---

## 5. ICE Restart & Reconnection

### ICE State Monitoring

| State | Action |
|-------|--------|
| `checking` | 30s hard timeout → restart (Firefox can stall here forever) |
| `disconnected` | 5s timeout → restart if still disconnected |
| `failed` | Immediate restart with `force: true`, shows toast |
| `connected` | Clear timers, reset backoff, retry play() on paused elements |

### Exponential Backoff

- Base cooldown: 30s
- Max cooldown: 120s
- Formula: `min(30s × 2^attempts, 120s)`
- Max 5 consecutive restart attempts before giving up

### ICE Restart Procedure

1. Create offer with `{ iceRestart: true }` — new ICE credentials, same DTLS session
2. Send via SignalR
3. If `setLocalDescription` throws → peer is corrupt → `recreatePeer()` (nuclear option: close + fresh connection)

### Play() Retry on ICE Connected

When ICE reaches `connected`, the handler retries `play()` on any paused audio elements for that peer. This handles the case where `play()` was called before data was flowing (the promise resolves but the element stays paused).

---

## 6. Glare (Simultaneous Offer) Handling

When both peers send offers simultaneously:

```
if (pc.signalingState === "have-local-offer" && incoming is offer):
  isPolite = myUserId > remoteUserId   // deterministic, string comparison
  if polite:  rollback our offer → answer theirs
  if impolite: ignore their offer → wait for our answer
```

### Known Race Condition

The `setLocalDescriptionOnFailure` error ("Called in wrong state: have-remote-offer") can occur when:
1. Reconciliation starts creating an offer (async)
2. Remote offer arrives and is applied first
3. Pending local offer creation completes → `setLocalDescription` fails

The connection typically recovers, but this can leave transceivers in unexpected states. The signaling queue mitigates but doesn't fully prevent this because the initial offer creation on join isn't always queued.

---

## 7. Screen Sharing Audio

- Screen capture via `getDisplayMedia()` (video + optional system audio)
- Audio tracks added as `screen-audio` type (distinct from mic)
- Viewers receive in separate `screenAudioElements` map
- Allows simultaneous mic + screen audio playback
- Lazy model: tracks only added when a viewer calls `requestWatch()`

---

## 8. Mute, Deafen & Volume Control

### Mute (Outgoing)

- Toggles `track.enabled` on local audio tracks
- Server notified via `UpdateVoiceState` for UI indicators
- Server can force-mute via `isServerMuted` (permission-based)

### Deafen (Incoming)

- Sets `audio.muted = true` on all remote audio elements (mic + screen)
- Client-side only — server stores state but doesn't enforce
- When deafened, user cannot hear anyone

### Per-User Volume

- Stored in `voiceStore.userVolumes` map (peerId → 0-200)
- 0-100%: `audio.volume = vol / 100`
- 101-200%: GainNode → `audioContext.destination`, element muted
- Smooth transitions via `linearRampToValueAtTime`

---

## 9. Output Device Selection

- Uses `HTMLAudioElement.setSinkId()` for output device routing
- "default" resolved to actual device ID to prevent audio cutout on window blur/focus
- Applied to all audio elements on device change
- Falls back gracefully if `setSinkId` not supported
- `deviceResolutionFailed` flag prevents repeated resolution attempts after failure

### Timing Note

`applyOutputDevice()` is fire-and-forget (not awaited). In Firefox, concurrent `setSinkId()` + `play()` can cause `play()` to resolve with `paused=true`. The ICE-connected play() retry handles this edge case.

---

## 10. Backend Voice State

### VoiceStateService (In-Memory Singleton)

| Data Structure | Purpose |
|---------------|---------|
| `_voiceChannels` | channelId → {userId → VoiceUserState} |
| `_voiceConnections` | userId → connectionId (voice session ownership) |
| `_userChannels` | userId → channelId (inverse lookup) |
| `_activeSharers` | channelId → {userId → displayName} |
| `_activeCameras` | channelId → {userId → displayName} |

### Single Voice Session Per User

Each user can only have one voice session. `_voiceConnections` maps userId to the connectionId that owns the session. Joining from another device sends `VoiceSessionReplaced` to the old connection.

### Stale Connection Cleanup

- Background job runs every 5 minutes
- Removes users not seen (no heartbeat) in 10 minutes
- Client sends `VoiceHeartbeat` every 30 seconds

### Reconciliation

Client-side 30s periodic reconciliation fetches authoritative `VoiceChannelUsers` from server. Closes peers for departed users, creates peers for missing users. Handles race conditions between join events and the participant list.

---

## 11. Troubleshooting Guide

### "Can't hear anyone" / No audio

1. **Check TURN server**: Most common cause. Open `chrome://webrtc-internals` or `about:webrtc` (Firefox).
   - Look for `relay` candidates in the candidate list. If none → TURN is broken.
   - Check for `onicecandidateerror` events with 401/403 codes.
   - Verify coturn config uses `use-auth-secret` (NOT `lt-cred-mech`).

2. **Check ICE connection state**: Should be `connected`. If `failed`, check TURN + firewall.

3. **Check DTLS/connection state**: `connectionState` must be `connected`. If ICE is connected but connection is `failed`, DTLS handshake failed (often caused by ICE restart after initial failure).

4. **Check RTP packet flow**: In `chrome://webrtc-internals`, look at `outbound-rtp` / `inbound-rtp` stats. `packetsSent` and `packetsReceived` should be non-zero and increasing.
   - If zero: Connection-level issue (DTLS, ICE, or track not enabled)
   - If non-zero: Audio playback pipeline issue (see below)

5. **Check audio element state**: `play()` can resolve with `paused=true` in Firefox when using `createMediaStreamDestination()` streams or when `setSinkId()` races with `play()`.

6. **Check track.enabled**: Voice activity detection sets `track.enabled = false` when no speech detected. In PTT mode, track is only enabled while key is held.

### Docker/VPN Users Have Slow Connections

Virtual network interfaces (Docker bridges, VPN adapters) generate extra ICE host candidates that all fail before the real LAN/internet candidate succeeds. This adds seconds to connection time. A working TURN server mitigates this — relay candidates bypass local network topology.

### One Direction Works, Other Doesn't

- Check if the sender's local track is `enabled=true` (not gated by VAD/PTT)
- Check the receiver's audio element: `paused`, `muted`, `volume`, `srcObject`
- Verify both sides have matching codec support (Opus is standard)

### Firefox-Specific Issues

- `play()` resolving with `paused=true` on MediaStreamDestination streams
- `track.enabled` toggling can permanently mute audio in cross-browser sessions
- ICE can stall at "checking" state indefinitely (30s hard timeout handles this)

### Glare / Signaling Errors

- `setLocalDescriptionOnFailure: Called in wrong state` — signaling race between offer creation and incoming offer. Usually self-recovers, but can leave audio in broken state. Rejoin voice channel to reset.
