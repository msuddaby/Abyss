# Abyss

> Self-hosted chat platform — text, voice, video, and watch parties on infrastructure you control.

![.NET 10](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)

Abyss is an open-source, self-hosted alternative to managed chat platforms. No telemetry, no vendor lock-in, and no reliance on a managed SaaS backend — your data lives on your server.

## Features

- Host many servers in an instance
- Create text channels
- Custom roles with permissions
- Per-channel permissions
- @ mentions with notifications
- Reactions
- Custom emojis
- Pin messages
- Chat search
- Voice chat (peer-to-peer with automatic SFU relay fallback)
- End-to-end encrypted voice relay (AES-GCM-256 via PBKDF2)
- Webcam and screen sharing with audio, quality presets (up to 1080p)
- Watch parties (connect your Plex server to a server or YouTube) — keeps everyone in sync
- Soundboard
- Cosmetics
- Online, away, DnD status
- Friend system
- Direct messages
- Push notifications (mobile, via Firebase)
- System administrator control panel

## Tech Stack

- **Backend**: ASP.NET Core (.NET 10), Entity Framework Core, SignalR, PostgreSQL 16
- **Web Client**: React 19, TypeScript, Vite, Zustand
- **Mobile App**: Capacitor (iOS & Android) — shares the same React codebase as the web client
- **Desktop App**: Electron (Linux, macOS, Windows) with auto-updates
- **Shared**: TypeScript package (`@abyss/shared`) for types, stores, and services
- **Voice/Video**: WebRTC peer-to-peer with automatic LiveKit SFU relay fallback
- **NAT Traversal**: coturn TURN server for P2P, LiveKit SFU for relay mode

## Project Structure

```
.
├── server/                 # ASP.NET backend
│   └── Abyss.Api/
├── client/                 # React web + Capacitor mobile (iOS/Android)
├── packages/
│   ├── shared/             # Shared TypeScript (types, stores, services)
│   └── desktop/            # Electron desktop app
├── docker-compose.yml      # Production deployment
├── docker-compose.dev.yml  # Development (DB + TURN only)
├── Caddyfile.example       # Reverse proxy config (copy to Caddyfile)
├── livekit.yaml            # LiveKit SFU server config
├── turnserver.conf         # coturn config (not committed)
├── .env                    # All configuration (not committed)
└── .env.dev                # Dev configuration (not committed)
```

---

## Development Setup

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Node.js](https://nodejs.org/) (LTS)
- [Docker](https://www.docker.com/) (for PostgreSQL and coturn)
- [ffmpeg](https://ffmpeg.org/) (for media processing, must be on PATH)
- [LiveKit server](https://docs.livekit.io/home/self-hosting/local/) (for voice relay — optional, see step 5)

### 1. Configure Environment

Copy the dev example and edit with your values:

```sh
cp .env.dev.example .env.dev
```

At minimum you need to set the database credentials and JWT key. The defaults work out of the box for local development.

| Variable | Description | Default |
|---|---|---|
| `POSTGRES_USER` | Database user | `abyss` |
| `POSTGRES_PASSWORD` | Database password | `changeme` |
| `POSTGRES_DB` | Database name | `abyss` |
| `POSTGRES_HOST` | Database host | `localhost` |
| `POSTGRES_PORT` | Database port (dev docker maps to 5433) | `5433` |
| `JWT_KEY` | JWT signing key (min 64 chars) | dev placeholder |
| `JWT_ISSUER` | JWT issuer | `Abyss` |
| `JWT_AUDIENCE` | JWT audience | `Abyss` |
| `SYSADMIN_USERNAME` | Username granted sysadmin on startup | `admin` |
| `CORS_ORIGINS` | Allowed origins (comma-separated) | `http://localhost:5173,...` |
| `VITE_API_URL` | Backend URL (used by web client) | `http://localhost:5000` |
| `VITE_STUN_URL` | STUN server for WebRTC | `stun:stun.l.google.com:19302` |
| `VITE_GIPHY_API_KEY` | Giphy API key (optional) | — |

### 2. Start the Database

```sh
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d
```

This starts PostgreSQL on port **5433** and optionally coturn for TURN.

### 3. Install Dependencies

From the project root (installs all workspaces — `client`, `packages/shared`):

```sh
npm install
```

### 4. Run the Backend

```sh
cd server/Abyss.Api
dotnet run
```

The backend starts on `http://localhost:5000`. It automatically applies EF Core migrations on startup — no manual migration step needed.

### 5. Run the Web Client

```sh
cd client
npm run dev
```

The web client starts on `http://localhost:5173`. It reads `VITE_*` variables from the root `.env.dev` file (via Vite's `envDir` config).

At this point you have a working instance with text chat, voice (P2P), and all core features. The following steps are optional.

### 6. LiveKit SFU Relay (Optional)

LiveKit provides a relay server for voice when peer-to-peer fails (restrictive firewalls, VPNs, symmetric NAT). Voice calls automatically fall back to relay mode after two P2P failures. Users can also force relay mode in Settings > Voice & Audio.

All relay traffic is end-to-end encrypted — the server never sees plaintext audio.

**Generate credentials and uncomment the LiveKit section in `.env.dev`:**

```sh
openssl rand -hex 16       # → LIVEKIT_API_KEY
openssl rand -base64 32    # → LIVEKIT_API_SECRET
```

```
LIVEKIT_API_KEY=your_generated_key
LIVEKIT_API_SECRET=your_generated_secret
LIVEKIT_URL=ws://localhost:7880
VITE_LIVEKIT_URL=ws://localhost:7880
```

**Run LiveKit — choose one method:**

**Option A: Native (recommended for macOS)**

```sh
brew install livekit
source <(grep '^LIVEKIT_' .env.dev) && LIVEKIT_KEYS="$LIVEKIT_API_KEY: $LIVEKIT_API_SECRET" livekit-server --config livekit.yaml --dev
```

This reads `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from your `.env.dev` file automatically.

> Docker Desktop on macOS has UDP port forwarding issues that break WebRTC. Run natively instead.

**Option B: Docker (Linux)**

```sh
docker compose -f docker-compose.dev.yml --env-file .env.dev --profile livekit up -d livekit
```

**Verify it's running:**

```sh
curl http://localhost:7880/
```

Without LiveKit configured, the app works normally — voice uses peer-to-peer only, and the backend logs "SFU relay disabled" on startup.

### 7. TURN Server (Optional)

TURN is needed for P2P voice calls when both users are behind NAT/firewalls that block direct connections.

Copy and edit the coturn config:

```sh
cp turnserver.conf.example turnserver.conf
```

Update `external-ip` and `static-auth-secret` to match your `.env.dev` values, then add these to `.env.dev`:

| Variable | Description | Example |
|---|---|---|
| `TURN_EXTERNAL_IP` | Your public IP | `203.0.113.1` |
| `TURN_PORT` | TURN listening port | `3478` |
| `TURN_REALM` | TURN realm (must match coturn) | `abyss` |
| `TURN_AUTH_SECRET` | Shared secret (must match coturn) | `changeme` |
| `TURN_URLS` | TURN URLs (comma-separated) | `turn:IP:3478,turn:IP:3478?transport=tcp` |
| `TURN_TTL_SECONDS` | TURN credential TTL | `3600` |

The dev Docker Compose includes a coturn service that reads `turnserver.conf`.

### 8. Mobile App (Optional)

The mobile app uses Capacitor to wrap the same React web client for iOS and Android.

**Environment:** Mobile builds use `.env.production` (at the project root) so the app connects to your production server. Create it with production values:

```sh
# .env.production
VITE_API_URL=https://your-domain.com
VITE_STUN_URL=stun:stun.l.google.com:19302
VITE_TURN_URLS=turn:IP:3478,turn:IP:3478?transport=tcp
VITE_TURN_USERNAME=username
VITE_TURN_CREDENTIAL=password
```

**Build and run:**

```sh
cd client

# Build the web client for mobile (uses .env.production)
npm run build:mobile

# Sync web assets to native projects
npx cap sync

# Open in Xcode (iOS)
npx cap open ios

# Open in Android Studio (Android)
npx cap open android
```

For local development, you can point Capacitor's dev server to your local Vite instance by uncommenting `server.url` in `client/capacitor.config.ts`.

### 9. Desktop App (Optional)

The Electron desktop app lives in `packages/desktop/`.

```sh
cd packages/desktop
npm run dev
```

To build a distributable package:

```sh
npm run make:full
```

---

## Production Deployment

### 1. Configure Environment

Copy the production example:

```sh
cp .env.example .env
```

**Required changes from the defaults:**

- `POSTGRES_PASSWORD` — use a strong random password
- `JWT_KEY` — generate with `openssl rand -base64 48`
- `SYSADMIN_USERNAME` — your admin account username
- `CORS_ORIGINS` — your domain + app origins (see below)
- `VITE_API_URL` — your public domain (`https://your-domain.com`)
- TURN server variables — your public IP and a strong auth secret
- LiveKit variables — generated API key/secret and `wss://` URL

**Full variable reference:**

| Variable | Description | Example |
|---|---|---|
| `POSTGRES_USER` | Database user | `abyss` |
| `POSTGRES_PASSWORD` | Database password | **strong random** |
| `POSTGRES_DB` | Database name | `abyss` |
| `POSTGRES_HOST` | Database host (Docker service name) | `db` |
| `POSTGRES_PORT` | Database port (internal) | `5432` |
| `JWT_KEY` | JWT signing key (min 64 chars) | `openssl rand -base64 48` |
| `JWT_ISSUER` | JWT issuer | `Abyss` |
| `JWT_AUDIENCE` | JWT audience | `Abyss` |
| `SYSADMIN_USERNAME` | Username granted sysadmin on startup | `admin` |
| `CORS_ORIGINS` | Allowed origins (comma-separated) | see below |
| `VITE_API_URL` | Public backend URL | `https://your-domain.com` |
| `VITE_STUN_URL` | STUN server | `stun:stun.l.google.com:19302` |
| `VITE_GIPHY_API_KEY` | Giphy API key (optional) | — |
| `TURN_EXTERNAL_IP` | Your server's public IP | `203.0.113.1` |
| `TURN_PORT` | TURN listening port | `3478` |
| `TURN_REALM` | TURN realm | `abyss` |
| `TURN_AUTH_SECRET` | TURN shared secret | **strong random** |
| `TURN_URLS` | TURN URLs for clients | `turn:IP:3478,turn:IP:3478?transport=tcp` |
| `TURN_TTL_SECONDS` | TURN credential TTL | `3600` |
| `LIVEKIT_API_KEY` | LiveKit API key | `openssl rand -hex 16` |
| `LIVEKIT_API_SECRET` | LiveKit API secret | `openssl rand -base64 32` |
| `LIVEKIT_URL` | LiveKit server URL (backend) | `ws://livekit:7880` |
| `VITE_LIVEKIT_URL` | LiveKit server URL (client, via Caddy) | `wss://your-domain.com/lk` |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Firebase service account JSON path | `/app/firebase-service-account.json` |

**CORS origins** must include all clients that will connect:

```
CORS_ORIGINS=https://your-domain.com,app://abyss,capacitor://localhost,https://localhost
```

- `https://your-domain.com` — web client
- `app://abyss` — Electron desktop app
- `capacitor://localhost` — iOS (Capacitor)
- `https://localhost` — Android (Capacitor)

### 2. Configure TURN Server

```sh
cp turnserver.conf.example turnserver.conf
```

Edit `turnserver.conf` and set `external-ip` to your server's public IP and `static-auth-secret` to match your `.env` `TURN_AUTH_SECRET`.

### 3. Configure LiveKit

The `LIVEKIT_KEYS` environment variable is set automatically from your `.env` by Docker Compose.

For production, edit `livekit.yaml` and set `use_external_ip: true` so LiveKit advertises your server's public IP in ICE candidates:

```yaml
rtc:
  use_external_ip: true
```

LiveKit WebSocket signaling is proxied through Caddy (see step 6) for TLS. The WebRTC media ports must be opened directly in your firewall:

| Port | Protocol | Service |
|---|---|---|
| 80, 443 | TCP | Caddy (HTTP + HTTPS) |
| 3478 | TCP + UDP | coturn TURN |
| 7881 | TCP | LiveKit WebRTC TCP fallback |
| 50000–50100 | UDP | LiveKit WebRTC media |

### 4. Deploy

```sh
docker compose up -d --build
```

This starts four services:

| Service | Description |
|---|---|
| `db` | PostgreSQL 16 |
| `api` | ASP.NET backend (port 5000) |
| `coturn` | TURN server (host networking) |
| `livekit` | LiveKit SFU relay server |

The API container creates upload directories automatically on startup and applies database migrations.

### 5. Build the Web Client

```sh
cd client
npm install
npm run build
```

Output goes to `client/dist/`.

### 6. Reverse Proxy (Caddy)

You need a reverse proxy to handle TLS and route traffic. [Caddy](https://caddyserver.com/docs/install) is recommended — it auto-provisions HTTPS via Let's Encrypt with zero config.

Copy and edit the example:

```sh
cp Caddyfile.example Caddyfile
```

Replace `your.domain.com` with your actual domain and update the `root` path to point to your built `client/dist/` directory. The Caddyfile handles:

- `/api/*` and `/hubs/*` — proxied to the backend on port 5000
- `/uploads/*` — proxied to the backend for uploaded files
- `/lk/*` — proxied to LiveKit on port 7880 (TLS termination for WebSocket signaling)
- Everything else — served as static files from the web client build, with SPA fallback

Start Caddy:

```sh
sudo caddy start --config /path/to/Caddyfile
```

Caddy automatically obtains and renews TLS certificates. Make sure ports 80 and 443 are open and your domain's DNS points to the server.

---

## Push Notifications (Mobile)

Push notifications are delivered via Firebase Cloud Messaging (FCM). Each server operator who publishes their own iOS/Android app needs their own Firebase project.

### 1. Create a Firebase Project

Go to the [Firebase Console](https://console.firebase.google.com/), create a project, and add both an Android app (`com.abyss.app` or your custom ID) and an iOS app.

### 2. Add Platform Config Files

**Android:** Download `google-services.json` and place it at:
```
client/android/app/google-services.json
```

**iOS:** Download `GoogleService-Info.plist` and add it to the Xcode project at:
```
client/ios/App/App/GoogleService-Info.plist
```
Also enable these capabilities in Xcode under your app target:
- **Push Notifications**
- **Background Modes** > **Remote notifications**

### 3. Configure the Server

Generate a Firebase Admin SDK service account key (Firebase Console > Project Settings > Service Accounts > Generate New Private Key). Place the JSON file in the project root as `firebase-service-account.json`.

Set the path in `.env`:

```
FIREBASE_SERVICE_ACCOUNT_PATH=/app/firebase-service-account.json
```

The Docker Compose file mounts this file into the container. If the file is not present, push notifications are silently disabled — everything else works normally.

### 4. How Push Notifications Work

1. On login, the mobile app requests push permission and registers the FCM token with the server (`POST /api/notifications/register-device`)
2. When a user is offline (no active SignalR connection), the server sends push notifications for mentions, DMs, and replies
3. Tapping a notification navigates to the relevant channel/DM
4. On logout, the token is unregistered (`DELETE /api/notifications/unregister-device`)
5. Stale tokens are automatically cleaned up when FCM reports them as unregistered

---

## Voice Architecture

Voice chat uses a hybrid approach:

1. **Peer-to-peer (default):** Direct WebRTC connections between users. Lowest latency, no server involvement in media.
2. **SFU relay (automatic fallback):** If P2P ICE negotiation fails twice (or a user enables "Always use relay mode" in settings), voice transparently switches to a LiveKit SFU server. This handles restrictive firewalls, VPNs, and symmetric NAT.
3. **End-to-end encryption:** All relay traffic is encrypted with AES-GCM-256 keys derived via PBKDF2 from a channel-specific passphrase. The relay server never sees plaintext audio or video.
4. **Capacity:** P2P voice supports small groups (up to ~8 users). Beyond 8 participants, the call automatically upgrades to SFU relay mode. LiveKit rooms support up to 50 participants.

Screen sharing and camera feeds work in both P2P and SFU modes with configurable quality presets (360p to 1080p for camera, quality/balanced/motion/high-motion for screen share).

---

## Backend Development

### EF Core Migrations

The backend auto-migrates on startup. To create a new migration:

```sh
cd server/Abyss.Api
dotnet ef migrations add MigrationName
```

### Key Services

| Service | Purpose |
|---|---|
| `TokenService` | JWT generation and TURN credential generation |
| `PermissionService` | Bitfield permission checks against server roles |
| `VoiceStateService` | Tracks voice channel membership and screen sharers |
| `LiveKitService` | LiveKit token generation for SFU relay |
| `NotificationService` | Push notification dispatch via Firebase |
| `ChatHub` | Single SignalR hub for all real-time communication |

### Upload Directories

The backend serves uploaded files from `uploads/` with subdirectories for `servers/`, `dms/`, `misc/`, and `wwwroot/uploads/emojis/`.
