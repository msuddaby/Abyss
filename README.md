# Abyss

A self-hosted chat platform with text channels, voice chat (WebRTC), screen sharing, custom emoji, and role-based permissions.

## Why?

tl;dr Discord sucks and there's no sane alternative that offers all of the features I want out of a chat app. Thus, Abyss was created.

## Tech Stack

- **Backend**: ASP.NET Core (.NET 10), Entity Framework Core, SignalR, PostgreSQL 16
- **Web Client**: React 19, TypeScript, Vite, Zustand
- **Mobile App**: Expo (React Native), iOS & Android only
- **Shared**: TypeScript package (`@abyss/shared`) for types, stores, and services
- **Voice/Video**: WebRTC with coturn TURN server for NAT traversal

## Project Structure

```
.
├── server/                 # ASP.NET backend
│   └── Abyss.Api/
├── client/                 # React web client
├── packages/
│   ├── shared/             # Shared TypeScript (types, stores, services)
│   └── app/                # Expo mobile app
├── docker-compose.yml      # Production deployment
├── docker-compose.dev.yml  # Development (DB + TURN only)
├── .env                    # All configuration (not committed)
└── turnserver.conf         # coturn config (not committed)
```

## Configuration

All configuration is done through environment variables in a `.env` file at the project root. Both the backend and frontend read from this file.

### Development Setup

Copy the example and edit:

```sh
cp .env.dev.example .env.dev
```

| Variable            | Description                          | Example                                  |
| ------------------- | ------------------------------------ | ---------------------------------------- |
| `POSTGRES_USER`     | Database user                        | `abyss`                                  |
| `POSTGRES_PASSWORD` | Database password                    | `changeme`                               |
| `POSTGRES_DB`       | Database name                        | `abyss`                                  |
| `POSTGRES_HOST`     | Database host                        | `localhost`                              |
| `POSTGRES_PORT`     | Database port                        | `5433` (dev docker maps to 5433)         |
| `JWT_KEY`           | JWT signing key (min 64 chars)       | `dev-only-key-replace-in-production-...` |
| `JWT_ISSUER`        | JWT issuer                           | `Abyss`                                  |
| `JWT_AUDIENCE`      | JWT audience                         | `Abyss`                                  |
| `SYSADMIN_USERNAME` | Username granted sysadmin on startup | `admin`                                  |
| `CORS_ORIGINS`      | Allowed origins (comma-separated)    | `http://localhost:5173`                  |
| `VITE_API_URL`      | Backend URL (used by web client)     | `http://localhost:5000`                  |
| `VITE_STUN_URL`     | STUN server for WebRTC               | `stun:stun.l.google.com:19302`           |

#### TURN Server (optional, needed for voice across NATs)

| Variable           | Description                 | Example                                   |
| ------------------ | --------------------------- | ----------------------------------------- |
| `TURN_EXTERNAL_IP` | Your public IP              | `203.0.113.1`                             |
| `TURN_PORT`        | TURN listening port         | `3478`                                    |
| `TURN_REALM`       | TURN realm                  | `abyss`                                   |
| `TURN_AUTH_SECRET` | Shared secret for TURN auth | `changeme`                                |
| `TURN_URLS`        | TURN URLs (comma-separated) | `turn:IP:3478,turn:IP:3478?transport=tcp` |
| `TURN_TTL_SECONDS` | TURN credential TTL         | `3600`                                    |

Also copy and edit the TURN server config:

```sh
cp turnserver.conf.example turnserver.conf
```

### Production Setup

Copy the production example instead:

```sh
cp .env.example .env
```

Key differences from dev: `POSTGRES_HOST=db` (Docker service name), `POSTGRES_PORT=5432`, strong passwords, HTTPS origins.

## Development

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Node.js](https://nodejs.org/) (LTS)
- [Docker](https://www.docker.com/) (for PostgreSQL and coturn)
- [ffmpeg](https://ffmpeg.org/) (for media processing, must be on PATH)

### 1. Start the Database

```sh
docker compose -f docker-compose.dev.yml up -d
```

This starts PostgreSQL on port **5433** and optionally coturn for TURN.

### 2. Install Dependencies

From the project root:

```sh
npm install
```

This installs all workspaces (`client`, `packages/shared`, `packages/app`).

### 3. Run the Backend

```sh
cd server/Abyss.Api
dotnet run
```

The backend starts on `http://localhost:5000`. It automatically applies EF Core migrations on startup.

### 4. Run the Web Client

```sh
cd client
npm run dev
```

The web client starts on `http://localhost:5173`. It reads `VITE_*` variables from the root `.env.dev` file (via Vite's `envDir` config).

### 5. Run the Mobile App (optional)

The Expo app is iOS/Android only (no web target). It requires a dev build (Expo Go is not supported due to native dependencies like `react-native-webrtc`).

```sh
cd packages/app
```

Edit `app.json` to set `expo.extra.apiUrl` to your backend's local IP (e.g., `http://192.168.1.x:5000`). Then:

```sh
# Build and run on iOS
npx expo run:ios

# Build and run on Android
npx expo run:android
```

ICE server configuration for the mobile app is also in `app.json` under `expo.extra` (`stunUrl`, `turnUrls`, `turnUsername`, `turnCredential`).

## Production Deployment

### Docker Compose

```sh
docker compose up -d --build
```

This starts three services:

- **db**: PostgreSQL 16
- **api**: ASP.NET backend (port 5000)
- **coturn**: TURN server (host networking)

The API container creates upload directories automatically on startup.

### Building the Web Client

```sh
cd client
npm run build
```

Output goes to `client/dist/`. Serve with any static file server, or put behind a reverse proxy.

## Backend Development

### EF Core Migrations

The backend auto-migrates on startup. This behavior will change (at some point) as it is [not recommended by Microsoft](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying?tabs=dotnet-core-cli#apply-migrations-at-runtime)

To create a new migration:

```sh
cd server/Abyss.Api
dotnet ef migrations add MigrationName
```

### Key Services

| Service               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `TokenService`        | JWT generation and TURN credential generation      |
| `PermissionService`   | Bitfield permission checks against server roles    |
| `VoiceStateService`   | Tracks voice channel membership and screen sharers |
| `NotificationService` | Push notification dispatch                         |
| `ChatHub`             | Single SignalR hub for all real-time communication |

### Upload Directories

The backend serves uploaded files from `uploads/` with subdirectories for `servers/`, `dms/`, `misc/`, and `wwwroot/uploads/emojis/`.
