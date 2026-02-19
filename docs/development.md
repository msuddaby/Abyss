# Development Workflow

This project is a monorepo with a .NET backend, React web client, shared TypeScript package, and an Electron desktop app.

## Repository Layout

```
.
├── server/
│   └── Abyss.Api/          # ASP.NET Core 10 API, SignalR hub, EF Core models
├── client/                  # React 19 web app (also used by Capacitor mobile builds)
│   ├── src/
│   │   ├── components/      # React UI components
│   │   ├── hooks/           # Custom hooks (useWebRTC, useIdleDetection, etc.)
│   │   ├── pages/           # Page-level layout components
│   │   ├── stores/          # Local Zustand stores (context menu, mobile state, etc.)
│   │   ├── services/        # HTTP clients and service wrappers
│   │   ├── audio/           # Audio device management, VAD, noise suppression
│   │   └── types/           # Client-only TypeScript types
│   ├── android/             # Capacitor Android native project
│   └── ios/                 # Capacitor iOS native project
├── packages/
│   ├── shared/              # Shared TypeScript: types, Zustand stores, service clients
│   │   └── src/
│   │       ├── stores/      # 20+ Zustand stores (auth, servers, voice, messages, etc.)
│   │       ├── services/    # apiClient, signalRService, livekitService
│   │       ├── hooks/       # Shared hooks (SignalR listeners, voice listeners)
│   │       └── types/       # Shared TS types consumed by client and desktop
│   └── desktop/             # Electron main process, auto-updater, IPC handlers
├── docs/                    # VitePress documentation site
├── docker-compose.yml       # Production service stack
├── docker-compose.dev.yml   # Local dev (PostgreSQL + optional TURN and LiveKit)
└── package.json             # Root monorepo (npm workspaces)
```

## Common Commands

### Root (monorepo)

```sh
npm install          # Install all workspace dependencies
npm run docs:dev     # Start VitePress dev server
npm run docs:build   # Build documentation site
npm run docs:preview # Preview built docs locally
```

### Web Client (`client/`)

```sh
npm run dev          # Start Vite dev server (http://localhost:5173)
npm run build        # Production build → client/dist/
npm run lint         # ESLint

# Mobile (Capacitor)
npm run build:mobile # Build web assets for mobile
npm run cap:sync     # Sync to iOS/Android native projects
npm run cap:ios      # Open Xcode
npm run cap:android  # Open Android Studio
```

### Backend (`server/Abyss.Api/`)

```sh
dotnet run           # Start API (http://localhost:5000), auto-migrates DB
dotnet build         # Build without running
dotnet watch         # Hot-reload dev mode
```

### Desktop (`packages/desktop/`)

```sh
npm run dev          # Launch Electron in dev mode (connects to local Vite/API)
npm run make:full    # Package distributable (AppImage, dmg, exe)
```

## Environment Loading

- The backend reads `.env.dev` first, then `.env` (from the project root). Running `dotnet run` from `server/Abyss.Api/` automatically picks up the root env file.
- The web client reads from the repo root by default — `envDir` in `client/vite.config.ts` is set to `../../` (two levels up from `client/`). This means both `.env.dev` and `.env` in the project root are loaded by Vite.
- Mobile production builds use `.env.production` at the project root (triggered by `CAPACITOR=true`).

## Database and Migrations

- **Database:** PostgreSQL 16
- **ORM:** Entity Framework Core with `Npgsql.EntityFrameworkCore.PostgreSQL`
- **Migrations path:** `server/Abyss.Api/Migrations/`
- **Startup behavior:** `db.Database.Migrate()` runs automatically — no manual migration step is required on startup.

Create a new migration after modifying a model:

```sh
cd server/Abyss.Api
dotnet ef migrations add MigrationName
```

Review the generated migration in `Migrations/` before committing. Migrations run automatically on next startup.

## Realtime Stack

- **SignalR hub:** `/hubs/chat`
- **JWT for SignalR:** passed as `access_token` query parameter during negotiate
- **Rate limiting:** separate policies for `api`, `auth`, and `upload` routes, configured in `Program.cs`
- **Hub routing:** `SendSignal` routes only to the target user's active voice connection (`_voiceConnections` map) to prevent stale peer state across browser tabs

## Shared Package (`packages/shared`)

The shared package is an npm workspace consumed by both `client` and `packages/desktop`. It contains:

- **Zustand stores** — `authStore`, `serverStore`, `voiceStore`, `messageStore`, `dmStore`, `friendStore`, `presenceStore`, `watchPartyStore`, and more
- **Service clients** — `apiClient` (Axios-based HTTP wrapper), `signalRService` (hub connection lifecycle), `livekitService` (LiveKit client)
- **Shared hooks** — `useSignalRListeners` (registers all hub event handlers), `useVoiceListeners`
- **Types** — shared TypeScript interfaces for API responses, entities, and store shapes

When adding a new feature that touches both backend and frontend, define types and store state in `packages/shared` first.

## Build Artifacts

| Artifact | Location |
|---|---|
| Web client | `client/dist/` |
| VitePress docs | `docs/.vitepress/dist/` |
| Electron app | `packages/desktop/out/` |
| Backend Docker image | Built by `docker compose` from `server/Dockerfile` |

## Debugging Tips

- **Backend logs:** `dotnet run` streams logs to stdout. For Docker: `docker compose logs -f api`
- **SignalR connection issues:** Check that `CORS_ORIGINS` includes the client origin and that `/hubs/*` is proxied correctly
- **Voice issues:** Check the browser console for ICE state transitions and TURN credential errors. See [Troubleshooting](/troubleshooting)
- **Database issues:** `docker compose -f docker-compose.dev.yml ps` to check container health; `POSTGRES_PORT=5433` for local dev to avoid conflicts with system Postgres
