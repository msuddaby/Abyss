# Architecture

Abyss is a self-hosted real-time communication platform built around three planes: a REST + SignalR control plane, a WebRTC media plane, and a PostgreSQL persistence layer.

## Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Clients                              │
│  ┌──────────┐  ┌──────────────────┐  ┌───────────────────┐ │
│  │   Web    │  │  Mobile (Capacitor│  │ Desktop (Electron)│ │
│  │ React 19 │  │    iOS/Android)   │  │                   │ │
│  └────┬─────┘  └────────┬─────────┘  └────────┬──────────┘ │
│       └────────────────┬┘                      │            │
│                        │  @abyss/shared         │            │
│               (Zustand stores, services, types) │            │
└────────────────────────┼───────────────────────┘
                         │
                  ┌──────▼──────┐
                  │    Caddy    │  TLS termination, routing
                  └──────┬──────┘
          ┌──────────────┼──────────────┐
          │              │              │
   /api/* + /hubs/*  /uploads/*     /lk/*
          │              │              │
   ┌──────▼──────┐       │      ┌──────▼──────┐
   │  Abyss API  │       │      │   LiveKit   │  SFU relay
   │ ASP.NET 10  │       │      │   Server    │
   │  + SignalR  │       │      └─────────────┘
   └──────┬──────┘       │
          │         Static files
   ┌──────▼──────┐
   │ PostgreSQL  │  Persistent data
   └─────────────┘

                 P2P WebRTC (direct, via STUN/TURN)
           ┌──────────────────────────────────────┐
           │  Client A ←──────────────────→ Client B │
           └──────────────────────────────────────┘

                     ┌──────────┐
                     │  coturn  │  TURN relay for NAT traversal
                     └──────────┘
```

## High-Level Components

### Backend (`server/Abyss.Api`)

ASP.NET Core 10 application serving:

- **REST API** (`/api/*`) — CRUD operations for servers, channels, messages, roles, friends, etc.
- **SignalR hub** (`/hubs/chat`) — single hub for all real-time events: messages, typing indicators, presence, voice state, and WebRTC signaling
- **Static file serving** for uploaded content (`/uploads/*`)
- **Health endpoint** (`/health`)

Organized in three layers:

| Layer | Responsibility |
|---|---|
| **Controllers** | Route-level orchestration, permission policy enforcement, request validation |
| **Services** | Business logic, token generation, media handling, notification dispatch, provider integrations |
| **Data** | EF Core models, database context, repository-style access patterns |

Notable background services:

| Service | Description |
|---|---|
| `PresenceMonitorService` | Tracks user online/away/DnD status and notifies connections on change |
| `NotificationDispatchService` | Delivers queued push notifications to Firebase |
| `NotificationCleanupService` | Removes stale/unregistered device tokens |
| `AuditLogCleanupService` | Enforces audit log retention policy |

### Web Client (`client/`)

React 19 + TypeScript application built with Vite. The same codebase serves as the UI shell for:

- **Web browser** (primary target)
- **iOS/Android** via Capacitor (native wrapper, shares all React components)
- **Electron desktop** (uses the built web client via a custom `app://abyss` protocol for secure context)

Key client subsystems:

| Subsystem | Files |
|---|---|
| WebRTC voice/video | `client/src/hooks/useWebRTC.ts` |
| SignalR event handlers | `packages/shared/src/hooks/useSignalRListeners.ts` |
| Audio pipeline | `client/src/audio/` |
| Idle detection | `client/src/hooks/useIdleDetection.ts` |

### Shared Package (`packages/shared`)

TypeScript workspace package consumed by both `client/` and `packages/desktop/`. Contains:

- **20+ Zustand stores** — all shared application state (auth, servers, voice, messages, DMs, friends, presence, watch party, etc.)
- **Service clients** — `apiClient` (Axios-based), `signalRService`, `livekitService`
- **Shared hooks** — SignalR listener registration, voice event handlers
- **Shared types** — TypeScript interfaces for all API responses and entity shapes

### Desktop (`packages/desktop`)

Electron wrapper with desktop-specific integrations:

- Custom `app://abyss` protocol for secure context and CORS compatibility
- Global push-to-talk keybind support
- System idle detection (with workaround for Windows false positives when games are running)
- Auto-update pipeline with staged rollout (Electron Forge + electron-builder)
- Platform builds: AppImage (Linux), dmg (macOS), exe installer (Windows)

## Runtime Data Flow

### Authentication

1. Client posts credentials to `POST /api/auth/login`
2. Backend validates and issues a short-lived JWT + a long-lived refresh token
3. Client stores tokens and attaches JWT as `Authorization: Bearer` header on all API requests
4. SignalR connection passes the JWT as `?access_token=` query parameter during negotiate

### Real-Time Messaging

1. Client opens WebSocket to `/hubs/chat` (upgraded by SignalR from HTTP negotiate)
2. Backend adds the connection to server/channel/DM groups
3. When a message is sent (via SignalR `SendMessage`), the backend persists it to PostgreSQL and fans it out to all group members via `ReceiveMessage`
4. Typing indicators and reactions follow the same fan-out pattern without persistence

### Voice

1. Client calls `JoinVoiceChannel` on the hub
2. Backend records the voice session in `VoiceStateService` (in-memory) and notifies channel members
3. For P2P: clients exchange SDP offers/answers and ICE candidates via `SendSignal` → `ReceiveSignal`
4. For relay: client fetches a LiveKit token from `POST /api/voice/livekit-token` and connects to LiveKit directly

See [Voice Architecture](/VOICE_ARCHITECTURE) for the full signaling and fallback model.

## Storage

| Data | Storage |
|---|---|
| Relational data (users, servers, messages, etc.) | PostgreSQL |
| Uploaded attachments and media | Filesystem — `data/uploads/` (bind-mounted into container at `/app/uploads`) |
| Emoji and soundboard files | Filesystem — `data/uploads/` |
| ASP.NET Core Data Protection keys | Docker volume `dpkeys` |

Uploaded files are served by the API via the `/uploads/*` path (proxied through Caddy in production).

## Security Model

| Control | Implementation |
|---|---|
| **Authentication** | JWT (HS256) with configurable key, issuer, and audience |
| **Authorization** | Role-based permissions with a bitfield system; checked in `PermissionService` |
| **Per-channel access** | Channel-level permission overrides that can restrict or grant specific roles |
| **Rate limiting** | Separate policies for `api`, `auth`, and `upload` routes |
| **CORS** | Allowlist from `CORS_ORIGINS` environment variable |
| **Security headers** | Set in ASP.NET Core middleware |
| **SignalR routing** | `SendSignal` routes only to the target user's active voice connection to prevent cross-tab signal leakage |
| **Voice E2EE** | Client-side AES-GCM-256 encryption for SFU relay — relay server handles routing but never decrypts media |

## Voice System

Voice operates in layered modes with automatic fallback:

```
Join channel
     │
     ▼
Attempt P2P WebRTC
     │
     ├─ Success → P2P mode (direct, lowest latency)
     │
     └─ Failure (ICE fail, 2+ failures, >8 participants, restrictive NAT)
          │
          ▼
     Fetch LiveKit token from /api/voice/livekit-token
          │
          ▼
     Connect to LiveKit SFU (E2EE encrypted)
          │
          └─ Notify other channel members to upgrade (ChannelRelayActive)
```

TURN server sits between clients in P2P mode for NAT traversal. LiveKit SFU handles media routing in relay mode with client-side E2EE so the server cannot inspect the audio/video streams.
