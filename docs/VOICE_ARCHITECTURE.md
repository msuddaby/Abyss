# Voice Architecture

Comprehensive reference for the Abyss voice stack: WebRTC P2P, TURN traversal, and LiveKit SFU relay fallback.

For a high-level overview of the voice system in context, see [Architecture](/architecture#voice-system). This page covers protocol details, state machines, signaling flows, and backend state model.

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Mode Selection and Fallback](#2-mode-selection-and-fallback)
3. [Signaling and Realtime Control Plane](#3-signaling-and-realtime-control-plane)
4. [P2P Path (WebRTC + TURN)](#4-p2p-path-webrtc--turn)
5. [SFU Path (LiveKit Relay)](#5-sfu-path-livekit-relay)
6. [Audio, Screen Share, and Camera Pipeline](#6-audio-screen-share-and-camera-pipeline)
7. [Mute, Deafen, VAD, and Push-to-Talk](#7-mute-deafen-vad-and-push-to-talk)
8. [Reliability and Recovery](#8-reliability-and-recovery)
9. [Backend Voice State Model](#9-backend-voice-state-model)
10. [Configuration Checklist](#10-configuration-checklist)
11. [Troubleshooting](#11-troubleshooting)

## 1. Architecture Overview

Abyss voice runs in two modes:

- `p2p`: direct peer-to-peer WebRTC between participants.
- `sfu`: media relayed through LiveKit.

Mode is tracked in shared state (`connectionMode`):

- `attempting-p2p`
- `p2p`
- `attempting-sfu`
- `sfu`

Key implementation files:

- `client/src/hooks/useWebRTC.ts`
- `packages/shared/src/services/livekitService.ts`
- `server/Abyss.Api/Hubs/ChatHub.cs`
- `server/Abyss.Api/Services/VoiceStateService.cs`
- `server/Abyss.Api/Controllers/VoiceController.cs`
- `server/Abyss.Api/Services/LiveKitService.cs`

## 2. Mode Selection and Fallback

Join behavior:

1. Client joins SignalR voice group (`JoinVoiceChannel`).
2. Default flow attempts P2P.
3. Client switches to SFU when fallback criteria are met.

Fallback triggers implemented in client logic:

- User preference `forceSfuMode` (`Always use relay mode`).
- P2P failure threshold reached (`p2pFailureCount >= 1`).
- Large room (`participants.size > 8`).
- ICE stuck in `checking`.
- ICE `failed`.
- Offer unanswered / peer stuck in `new`.
- Channel already has relay users (`ChannelRelayActive`).

When switching to SFU, client:

- tears down P2P connections,
- connects to LiveKit,
- calls `NotifyRelayMode` so other users in channel can upgrade.

## 3. Signaling and Realtime Control Plane

Control plane uses SignalR hub `/hubs/chat`.

Relevant hub methods/events:

- `JoinVoiceChannel`, `LeaveVoiceChannel`
- `SendSignal` -> `ReceiveSignal` (P2P SDP/ICE)
- `VoiceHeartbeat`
- `NotifyRelayMode` -> `ChannelRelayActive`
- `VoiceChannelUsers` (authoritative participant map)

Important behavior:

- `SendSignal` routes only to target user's active voice connection (`_voiceConnections`) to avoid non-voice tabs creating stale peer state.
- New joiners receive current relay status; if channel already has relay users, server emits `ChannelRelayActive`.

## 4. P2P Path (WebRTC + TURN)

P2P mode uses browser WebRTC connections with ICE servers from:

- STUN (`VITE_STUN_URL`)
- TURN credentials from `GET /api/voice/turn`

TURN auth model:

- coturn `use-auth-secret`
- backend issues short-lived HMAC credentials

Required alignment:

- `TURN_AUTH_SECRET` equals coturn `static-auth-secret`
- `TURN_REALM` matches coturn `realm`
- `TURN_URLS` valid and reachable

P2P uses:

- per-peer signaling queues,
- ICE restarts with backoff,
- reconciliation against `VoiceChannelUsers`.

## 5. SFU Path (LiveKit Relay)

SFU token endpoint:

- `POST /api/voice/livekit-token` with `channelId`
- returns signed JWT and LiveKit URL

Server-side guardrails:

- returns `501` when LiveKit not configured
- checks channel existence and `Permission.Connect`

LiveKit room model:

- room name format: `channel-{channelId}`
- participants publish mic and optional camera/screen tracks
- remote tracks auto-subscribed by LiveKit client

Relay cascade behavior:

- when one client enables relay, it notifies server via `NotifyRelayMode`
- server marks relay user in `VoiceStateService` and broadcasts `ChannelRelayActive`
- peers in P2P mode upgrade to SFU to keep channel in one transport mode

### SFU Encryption Notes

LiveKit connection attempts to enable client-side E2EE (`ExternalE2EEKeyProvider`).

Current key strategy is deterministic per channel ID (`abyss-e2ee-{channelId}`), derived client-side.
This protects media from relay plaintext exposure, but it is not equivalent to user-managed end-to-end secrets.

## 6. Audio, Screen Share, and Camera Pipeline

P2P audio:

- remote audio attached to `HTMLAudioElement` from raw `MediaStream`
- per-user volume 0-100 via `audio.volume`
- >100 uses GainNode boost

SFU audio:

- `TrackSubscribed` attaches LiveKit remote audio tracks
- same volume/deafen model as P2P via shared voice store

Screen sharing and camera:

- publish/unpublish through LiveKit APIs (`sfuPublishScreenShare` / `sfuPublishCamera`)
- quality controls:
  - camera presets up to 1080p
  - screen-share tiers: 720p30 (3 Mbps), 1080p30 (5 Mbps, default),
    1080p60 (8 Mbps), 1440p30 (8 Mbps) — set in `SCREEN_SHARE_QUALITY_CONSTRAINTS`
    (`client/src/hooks/useWebRTC.ts`), selectable from the quality popover or
    Settings → Video
- each tier carries an explicit capture resolution. Without one, livekit-client
  pins capture to 1080p30 and the 60fps tier becomes unreachable.
- screen-share encodings must be passed as `screenShareEncoding`, never
  `videoEncoding` — `computeVideoEncodings()` discards the latter for
  `Track.Source.ScreenShare` and silently falls back to 1080p15 @ 2.5 Mbps.

Rendering (adaptiveStream):

- remote video **must** be rendered with `track.attach(el)` / `track.detach(el)`,
  not by assigning a `MediaStream` to `srcObject`. `attach()` is the only thing
  that registers the element with adaptiveStream; without it the SDK sees no
  attached elements, reports the video as hidden/0x0, and the SFU pauses the
  track or drops it to the lowest layer.
- the same mechanism is what makes unwatched screen shares free: the track stays
  subscribed but paused until someone actually tunes in.

Watching a screen share is opt-in:

- a share starting does **not** auto-tune anyone in — `ScreenShareView` shows a
  "Watch Stream" picker, and only `requestWatch()` subscribes the share's audio
- screen-share audio is gated in two places: `TrackPublished` (for shares that
  start while you are in the channel) and `TrackSubscribed` (for shares already
  running when you join, which `TrackPublished` never fires for)

### Screen-share audio: platform support and known limitation

Shared system audio works on **Windows only**. Electron's
`setDisplayMediaRequestHandler` accepts `audio: 'loopback'`, which its own docs
describe as system audio and "currently only supported on Windows". macOS gets
no shared audio, and on Linux the handler is not registered at all (it crashes
PipeWire on many setups) — the Linux capture path in `sfuPublishScreenShare`
requests `audio: false`.

**Known limitation:** `'loopback'` captures the entire default-output mix, which
includes Abyss's own voice playback. Viewers therefore hear the other call
participants echoed back through the sharer, slightly delayed. This cannot be
fixed at the capture layer: Electron exposes only `'loopback'` /
`'loopbackWithMute'` (the latter mutes local playback while capturing the same
mix, so it does not help), and neither Electron nor Chromium exposes per-process
or per-window audio capture for desktop sources. Discord avoids this by shipping
a native audio driver that hooks the shared process's audio session; matching it
would require a native module (WASAPI process-loopback on Windows 10 2004+).

Note that headphones do not help — loopback captures the digital output mix, not
the acoustic path. The only workaround today is to set Abyss's output device
(Settings → Voice) to a device that is *not* the system default, so Abyss's
playback stays out of the captured mix.

## 7. Mute, Deafen, VAD, and Push-to-Talk

Mute/deafen semantics:

- mute controls outgoing mic publication/track state
- deafen mutes local playback only
- server moderation can enforce mute/deafen state

Input modes:

- Voice Activity Detection (VAD)
- Push-to-talk (browser listeners + Electron global keybind support)

SFU mode maps mute/device changes through LiveKit participant APIs.

## 8. Reliability and Recovery

P2P reliability mechanisms:

- ICE timeout handling for `new`, `checking`, `disconnected`, `failed`
- ICE restart with capped exponential backoff
- periodic reconciliation against server participant list
- connection replacement logic for stale/zombie peers

Session resilience:

- voice session ownership is single-connection per user
- reconnect path supports same-channel recovery without full leave/rejoin churn

## 9. Backend Voice State Model

`VoiceStateService` keeps in-memory state for:

- channel participants and voice state
- active screen sharers
- active camera users
- relay users per channel
- user -> voice connection ownership

Cleanup job:

- stale voice entries removed after inactivity window
- heartbeat updates via `VoiceHeartbeat`

## 10. Configuration Checklist

Required for base voice:

- `VITE_STUN_URL`
- TURN variables (`TURN_URLS`, `TURN_AUTH_SECRET`, `TURN_TTL_SECONDS`, etc.)
- valid `turnserver.conf`

Required for relay mode:

- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_URL` (backend)
- `VITE_LIVEKIT_URL` (client)
- reverse proxy route for LiveKit signaling (example: `/lk/*`)

Recommended production network exposure:

- TURN: `3478` TCP/UDP
- LiveKit signaling/media per `livekit.yaml` and deployment docs

## 11. Troubleshooting

### Voice works on some networks only

Likely P2P NAT/firewall failure. Validate TURN config and ensure relay mode is configured.

### Relay mode unavailable

Check `POST /api/voice/livekit-token` response:

- `501`: LiveKit env vars missing on backend.
- `403`: user lacks connect permission.
- connection errors: verify `LIVEKIT_URL` / `VITE_LIVEKIT_URL` and proxy routing.

### Channel oscillates between modes

Confirm clients are on current build with `NotifyRelayMode` + `ChannelRelayActive` behavior and that reconnection logic is not dropping hub events.

### No remote audio in SFU mode

Inspect LiveKit track subscription logs and local device output selection. Verify deafen is off and per-user volume is not set to `0`.

### Viewers hear Abyss voices echoed inside a screen share

Expected on Windows. `audio: 'loopback'` captures the whole default-output mix,
which includes Abyss's own playback. Not fixable at the capture layer — see
"Screen-share audio: platform support and known limitation" in section 6. The
sharer can work around it by selecting a non-default output device in
Settings → Voice.

### Screen share looks soft or low-framerate

Check the tier in Settings → Video (default is 1080p30). If the selected tier is
not taking effect, confirm the publish path passes `screenShareEncoding` rather
than `videoEncoding`, and verify in `chrome://webrtc-internals` that the
*receiver's* inbound-rtp `frameWidth` matches the sender — a receiver stuck at
half resolution means video is not being rendered via `track.attach()`.

### P2P repeatedly fails then reconnects

Expected on restrictive networks. Abyss intentionally promotes to SFU quickly after failures to stabilize voice.
