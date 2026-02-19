# Deployment

Production deployment guide for Abyss using Docker Compose, Caddy, coturn, and LiveKit.

## Server Requirements

- **OS:** Linux (Ubuntu 22.04+ recommended)
- **Docker** and **Docker Compose** v2
- **Caddy** (for reverse proxy and TLS)
- **Node.js LTS** (to build the web client)
- Open firewall ports:

| Port | Protocol | Service |
|---|---|---|
| 80, 443 | TCP | Caddy (HTTP + HTTPS) |
| 3478 | TCP + UDP | coturn TURN server |
| 7881 | TCP | LiveKit WebRTC TCP fallback |
| 50000–50100 | UDP | LiveKit WebRTC media |

## 1. Prepare Environment

Clone the repository and copy the production env template:

```sh
git clone https://github.com/msuddaby/Abyss.git
cd Abyss
cp .env.example .env
```

Edit `.env` and set all values before starting any services. Key secrets to generate:

```sh
openssl rand -base64 48    # JWT_KEY
openssl rand -hex 32       # TURN_AUTH_SECRET
openssl rand -hex 16       # LIVEKIT_API_KEY
openssl rand -base64 32    # LIVEKIT_API_SECRET
```

**Required variables:**

| Variable | Description |
|---|---|
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password (strong random) |
| `POSTGRES_DB` | Database name |
| `POSTGRES_HOST` | `db` (Docker service name) |
| `POSTGRES_PORT` | `5432` (internal Docker network port) |
| `JWT_KEY` | JWT signing key (64+ characters) |
| `JWT_ISSUER` | JWT issuer claim (e.g. `Abyss`) |
| `JWT_AUDIENCE` | JWT audience claim (e.g. `Abyss`) |
| `SYSADMIN_USERNAME` | Username granted sysadmin on startup |
| `CORS_ORIGINS` | See below |
| `VITE_API_URL` | Your public domain (e.g. `https://chat.example.com`) |
| `VITE_STUN_URL` | STUN server (e.g. `stun:stun.l.google.com:19302`) |

**`CORS_ORIGINS`** must include all client origins that will connect to the backend:

```
CORS_ORIGINS=https://chat.example.com,app://abyss,capacitor://localhost,https://localhost
```

- `https://chat.example.com` — web browser
- `app://abyss` — Electron desktop app
- `capacitor://localhost` — iOS (Capacitor)
- `https://localhost` — Android (Capacitor)

## 2. Configure TURN Server

```sh
cp turnserver.conf.example turnserver.conf
```

Edit `turnserver.conf`:

- Set `external-ip` to your server's public IP address
- Set `static-auth-secret` to the same value as `TURN_AUTH_SECRET` in `.env`
- Set `realm` to match `TURN_REALM`

Add to `.env`:

```sh
TURN_EXTERNAL_IP=203.0.113.1       # Your server's public IP
TURN_PORT=3478
TURN_REALM=chat.example.com
TURN_AUTH_SECRET=your_strong_secret
TURN_URLS=turn:203.0.113.1:3478,turn:203.0.113.1:3478?transport=tcp
TURN_TTL_SECONDS=3600
```

## 3. Configure LiveKit

LiveKit provides the SFU relay for large voice channels and restrictive networks.

Add to `.env`:

```sh
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
LIVEKIT_URL=ws://livekit:7880           # Backend-to-LiveKit (internal Docker network)
VITE_LIVEKIT_URL=wss://chat.example.com/lk  # Browser-to-LiveKit (proxied through Caddy)
```

Edit `livekit.yaml` for production — set `use_external_ip: true` so LiveKit advertises your public IP in ICE candidates:

```yaml
rtc:
  use_external_ip: true
```

LiveKit WebSocket signaling is proxied through Caddy (configured in step 6). WebRTC media ports (50000–50100 UDP and 7881 TCP) bypass the proxy and must be opened in your firewall.

## 4. Start Backend Services

```sh
docker compose --env-file .env up -d --build
```

This starts four services:

| Service | Container | Description |
|---|---|---|
| `db` | `abyss-db` | PostgreSQL 16 with persistent volume |
| `api` | `abyss-api` | ASP.NET Core backend on port 5000 |
| `coturn` | `abyss-turn` | TURN server (host networking mode) |
| `livekit` | `abyss-livekit` | LiveKit SFU (host networking mode) |

The API container auto-migrates the database on startup and creates upload directories. Check that it's healthy:

```sh
docker compose ps
docker compose logs -f api
```

## 5. Build the Web Client

Install Node.js dependencies and build:

```sh
npm install
cd client
npm run build
```

The production build is written to `client/dist/`. This directory is served as static files by Caddy.

## 6. Configure Reverse Proxy (Caddy)

Install Caddy from [caddyserver.com/docs/install](https://caddyserver.com/docs/install).

```sh
cp Caddyfile.example Caddyfile
```

Edit `Caddyfile`:

- Replace the hostname with your domain
- Update the `root` directive to point to the absolute path of `client/dist/`

The included template handles all required routing:

| Path | Proxied To | Notes |
|---|---|---|
| `/api/*` | `localhost:5000` | REST API |
| `/hubs/*` | `localhost:5000` | SignalR WebSocket |
| `/uploads/*` | `localhost:5000` | User-uploaded files |
| `/lk/*` | `localhost:7880` | LiveKit signaling (WebSocket) |
| Everything else | `client/dist/` | SPA static files with fallback |

Start Caddy:

```sh
sudo caddy start --config /path/to/Caddyfile
```

Caddy automatically obtains and renews TLS certificates via Let's Encrypt. Ensure ports 80 and 443 are open and your domain's A record points to the server.

## 7. Push Notifications (Optional)

See the [Push Notifications section in the README](https://github.com/msuddaby/Abyss#push-notifications-mobile) for Firebase setup instructions.

Place the Firebase service account JSON at the project root:

```
firebase-service-account.json
```

The Docker Compose file mounts it into the container at `/app/firebase-service-account.json`. Set in `.env`:

```sh
FIREBASE_SERVICE_ACCOUNT_PATH=/app/firebase-service-account.json
```

If the file is absent, push notifications are silently disabled — all other functionality works normally.

## Validation Checklist

After deployment, verify these work end-to-end:

- [ ] `curl https://chat.example.com/health` returns HTTP 200
- [ ] Web client loads and you can register/log in
- [ ] SignalR connects (messages send and receive in real-time)
- [ ] P2P voice call works between two clients on different networks
- [ ] TURN works: test with a client behind a strict NAT (disable direct UDP if needed)
- [ ] Relay mode works: enable "Always use relay" in Settings > Voice & Audio and verify the call stays connected

## Upgrading

```sh
git pull
docker compose --env-file .env up -d --build api
cd client && npm install && npm run build
```

The API container automatically applies any new database migrations on startup. Always review migration files before upgrading on production.

## Backups

The persistent data is stored in two Docker volumes and the uploads directory:

```sh
# Backup PostgreSQL
docker exec abyss-db pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql

# Backup uploads
tar -czf uploads-backup.tar.gz data/
```

Data Protection keys (for ASP.NET Core) are stored in the `dpkeys` Docker volume and should also be backed up — losing them invalidates all active sessions.
