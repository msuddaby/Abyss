# Getting Started

This guide sets up Abyss for local development. At the end you'll have a working instance with text chat and peer-to-peer voice running on your machine.

## Prerequisites

| Requirement | Notes |
|---|---|
| [.NET 10 SDK](https://dotnet.microsoft.com/download) | Backend runtime and build toolchain |
| [Node.js LTS](https://nodejs.org/) | Web client and shared package builds |
| [Docker](https://www.docker.com/) | PostgreSQL and optional voice relay services |
| [ffmpeg](https://ffmpeg.org/) | Media processing — must be on `PATH` |

**Optional:** LiveKit server (SFU relay mode) and a coturn TURN server for broader NAT compatibility.

## 1. Clone and Install Dependencies

```sh
git clone https://github.com/msuddaby/Abyss.git
cd Abyss
npm install
```

`npm install` at the repo root installs all workspaces (`client/` and `packages/shared/`) in one pass.

## 2. Configure Environment

Copy the development template:

```sh
cp .env.dev.example .env.dev
```

The defaults are safe for local development. At minimum, check these values:

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_USER` | `abyss` | Database username |
| `POSTGRES_PASSWORD` | `changeme` | Change for any shared environment |
| `POSTGRES_DB` | `abyss` | Database name |
| `POSTGRES_HOST` | `localhost` | Use `localhost` when running the DB in Docker on the same machine |
| `POSTGRES_PORT` | `5433` | Dev Docker Compose maps to 5433 to avoid conflicts |
| `JWT_KEY` | dev placeholder | Must be 64+ characters |
| `SYSADMIN_USERNAME` | `admin` | The first account with this username is promoted to sysadmin |
| `CORS_ORIGINS` | `http://localhost:5173,...` | Must include the web client URL |
| `VITE_API_URL` | `http://localhost:5000` | Backend URL seen by the browser |
| `VITE_STUN_URL` | `stun:stun.l.google.com:19302` | STUN server for WebRTC |

## 3. Start the Database

```sh
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d
```

This starts PostgreSQL on port **5433**. If you already have Postgres running locally, adjust `POSTGRES_PORT` in `.env.dev`.

To verify it's up:

```sh
docker compose -f docker-compose.dev.yml ps
```

## 4. Run the Backend

```sh
cd server/Abyss.Api
dotnet run
```

The API starts on `http://localhost:5000`. On first run (and after any migration), EF Core applies database migrations automatically — no manual step needed.

Confirm the backend is healthy:

```sh
curl http://localhost:5000/health
# Expected: 200 OK
```

## 5. Run the Web Client

Open a new terminal:

```sh
cd client
npm run dev
```

The app is available at `http://localhost:5173`.

The client reads `VITE_*` variables from the root `.env.dev` file (Vite's `envDir` is set to the repo root in `client/vite.config.ts`).

## 6. Create Your Account

Open `http://localhost:5173` in a browser. The first account with the username matching `SYSADMIN_USERNAME` is automatically promoted to system administrator.

## Optional: Enable LiveKit SFU Relay

Without LiveKit, voice works peer-to-peer for all users. Configure LiveKit if you want relay mode (for restrictive networks or large voice channels).

Add these to `.env.dev` (generate with `openssl rand -hex 16` / `openssl rand -base64 32`):

```sh
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
LIVEKIT_URL=ws://localhost:7880
VITE_LIVEKIT_URL=ws://localhost:7880
```

Then start LiveKit with Docker:

```sh
docker compose -f docker-compose.dev.yml --env-file .env.dev --profile livekit up -d livekit
```

Or natively (recommended on macOS — Docker Desktop has UDP forwarding issues):

```sh
livekit-server --config livekit.yaml --dev
```

## Optional: Enable TURN Server

TURN is needed for P2P voice when users are behind symmetric NAT or restrictive firewalls. Without TURN, users on those networks need to use relay mode.

```sh
cp turnserver.conf.example turnserver.conf
# Edit: set external-ip and static-auth-secret
```

Add to `.env.dev`:

```sh
TURN_EXTERNAL_IP=your.public.ip
TURN_PORT=3478
TURN_REALM=abyss
TURN_AUTH_SECRET=changeme
TURN_URLS=turn:your.public.ip:3478,turn:your.public.ip:3478?transport=tcp
TURN_TTL_SECONDS=3600
```

## Next Steps

- [Development Workflow](/development) — Package-level commands, migrations, and realtime stack notes
- [Configuration](/configuration) — Full environment variable reference
- [Deployment](/deployment) — Production setup with Docker, Caddy, and TLS
- [Voice Architecture](/VOICE_ARCHITECTURE) — Deep dive into P2P, TURN, SFU relay, and E2EE internals
