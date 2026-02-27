# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Abyss is a Discord-like real-time chat platform with voice/video, screen sharing, watch parties, and cosmetics. Monorepo with ASP.NET backend, React frontend, shared TypeScript package, Electron desktop app, and Capacitor mobile apps.

## Tech Stack

- **Backend**: ASP.NET Core (dotnet 10), EF Core, SignalR, PostgreSQL 16
- **Frontend**: React 19, TypeScript 5.x, Vite 7, Zustand 5
- **Shared**: `@abyss/shared` (npm workspace) — types, stores, services, utils (raw .ts, no build step)
- **Desktop**: Electron (`packages/desktop/`)
- **Mobile**: Capacitor 8 (iOS/Android) wrapping the same React client
- **Voice**: P2P WebRTC with automatic LiveKit SFU relay fallback (E2EE via AES-GCM-256)

## Commands

### Backend
```bash
cd server/Abyss.Api
dotnet run                    # Starts API on localhost:5000 (auto-migrates DB)
dotnet watch                  # Hot reload
dotnet ef migrations add Name # New EF migration (run from server/Abyss.Api)
```

### Frontend
```bash
npm install          # From repo root (workspaces: packages/shared + client)
cd client
npm run dev          # Vite dev server on localhost:5173
npm run build        # Production build
npm run lint         # ESLint
```

### Docker (dev database)
```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d  # PostgreSQL on port 5433
```

### Desktop
```bash
cd packages/desktop
npm run dev          # Electron dev mode
npm run make:full    # Build distributable
```

### Mobile
```bash
cd client
npm run build:mobile && npx cap sync
npx cap open ios     # or android
```

## Architecture

### Monorepo Layout
```
server/Abyss.Api/     → ASP.NET API + SignalR hub + EF Core models/migrations
packages/shared/      → @abyss/shared: types, Zustand stores, services (consumed by all clients)
client/               → React web app + Capacitor mobile shell
packages/desktop/     → Electron desktop app
docs/                 → VitePress documentation
```

### Configuration
All secrets live in root `.env` (or `.env.dev` for development). Backend loads manually in `Program.cs`. Frontend uses Vite's `envDir: '..'` to read `VITE_*` vars from root.

Key env vars: `POSTGRES_*`, `JWT_KEY/ISSUER/AUDIENCE`, `CORS_ORIGINS`, `VITE_API_URL`, `VITE_STUN_URL`, `TURN_*`, `LIVEKIT_*`.

### SignalR
Single hub (`ChatHub` at `/hubs/chat`) handles all real-time communication. Group naming:
- `server:{id}` — all server members (sidebar updates, member events)
- `channel:{id}` — channel-specific (messages, typing)
- `voice:{id}` — voice channel participants (WebRTC signaling, camera/screen events)
- `user:{id}` — direct messages, friend requests, notifications

### Permissions
`[Flags] enum Permission : long` bitfield on `ServerRole.Permissions`. Server owner always has `~0L` (all bits set). Channel-specific overrides via `ChannelPermissionOverride`. Check with `PermissionService`.

### State Management
20+ Zustand stores in `packages/shared/src/stores/` (authStore, serverStore, messageStore, voiceStore, etc.). Stores call the API via axios (`packages/shared/src/services/api.ts`) and receive real-time updates via SignalR listeners registered in `MainLayout.tsx`.

### Layout Structure
Desktop: `ServerSidebar (72px)` | `ChannelSidebar (240px)` | `Content (flex:1)` | `MemberList (240px)`. Sidebars are fixed-width — never use `flex:1` on them.

## Patterns

### New Feature Checklist
Model → DbContext → Migration → DTO → Controller → TypeScript types → Store → SignalR listeners (MainLayout) → UI component → CSS in App.css

### Backend Controller Pattern
Controllers inject `AppDbContext`, `PermissionService`, and `IHubContext<ChatHub>`. Extract user ID via `User.FindFirstValue(ClaimTypes.NameIdentifier)`. Check permissions with `_perms.HasPermissionAsync()`. Broadcast changes to appropriate SignalR group. Follow `RolesController` as a template.

### Frontend Store Pattern
Zustand stores with `create<State>((set, get) => ({...}))`. Actions call API, update local state, and optionally invoke SignalR hub methods. Components select individual fields: `useServerStore(s => s.servers)`.

### CSS
All styles in `client/src/App.css` (single global file, no CSS modules). Use `.kebab-case` class names. Dark theme variables defined in `client/src/index.css` (`--bg-primary`, `--text-primary`, `--brand-color`, etc.).

### Custom Emoji
Message format: `<:name:id>`. Reaction format: `custom:id`. Autocomplete trigger: `:query`.

### Voice/Video
- Camera tracks are eager (added to all peers immediately). Screen share tracks are lazy (viewers opt-in via `RequestWatchStream`).
- Track-type disambiguation: `track-info` signal sent before renegotiation; receiver uses `pendingTrackTypes` FIFO queue.
- Voice group broadcasts for WebRTC participants; server group broadcasts for sidebar UI (LIVE badges, camera indicators).

## Important Notes

- No test suite — development relies on manual testing and TypeScript strict mode
- `npm install` from repo root handles all workspaces; `client/node_modules` may need reinstall after pulling
- Root `.npmrc` has `legacy-peer-deps=true` (needed for @emoji-mart/react + React 19)
- DB auto-migrates on backend startup — no manual migration step needed for existing migrations
- `TokenService` reads env vars directly (not via IConfiguration)
- ffmpeg must be on PATH for media processing (video thumbnails, audio metadata)
