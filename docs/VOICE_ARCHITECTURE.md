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

- P2P mode: explicit signaling + track-info handling
- SFU mode: publish/unpublish through LiveKit APIs
- quality controls:
  - camera presets up to 1080p
  - screen-share presets from quality to high-motion

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

### P2P repeatedly fails then reconnects

Expected on restrictive networks. Abyss intentionally promotes to SFU quickly after failures to stabilize voice.
