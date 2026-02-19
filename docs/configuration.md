# Configuration

Abyss is configured through environment variables. In local development these live in `.env.dev` at the project root; in production they go in `.env`. The backend reads both files on startup (`.env.dev` takes precedence).

## Minimal Development Configuration

A working local setup needs only these variables. The `.env.dev.example` file ships with safe defaults for all of them:

```sh
# Database
POSTGRES_USER=abyss
POSTGRES_PASSWORD=changeme
POSTGRES_DB=abyss
POSTGRES_HOST=localhost
POSTGRES_PORT=5433

# Auth
JWT_KEY=change-this-to-a-long-random-string-at-least-64-chars-long-please
JWT_ISSUER=Abyss
JWT_AUDIENCE=Abyss

# Admin
SYSADMIN_USERNAME=admin

# CORS (include all client origins)
CORS_ORIGINS=http://localhost:5173,http://localhost:5174

# Frontend
VITE_API_URL=http://localhost:5000
VITE_STUN_URL=stun:stun.l.google.com:19302
```

---

## Core Variables

| Variable | Required | Description | Example |
|---|---|---|---|
| `POSTGRES_HOST` | Yes | PostgreSQL hostname | `localhost` (dev) / `db` (Docker prod) |
| `POSTGRES_PORT` | Yes | PostgreSQL port | `5433` (dev Docker) / `5432` (prod) |
| `POSTGRES_DB` | Yes | Database name | `abyss` |
| `POSTGRES_USER` | Yes | Database user | `abyss` |
| `POSTGRES_PASSWORD` | Yes | Database password | Strong random in production |
| `JWT_KEY` | Yes | JWT signing key — minimum 64 characters | Generate: `openssl rand -base64 48` |
| `JWT_ISSUER` | Yes | JWT issuer claim | `Abyss` |
| `JWT_AUDIENCE` | Yes | JWT audience claim | `Abyss` |
| `CORS_ORIGINS` | Yes | Comma-separated allowed origins | See [CORS Origins](#cors-origins) |
| `SYSADMIN_USERNAME` | Yes | Username promoted to sysadmin on startup | `admin` |

### CORS Origins

`CORS_ORIGINS` must include every client origin that connects to the backend. In production, include all platform origins:

```
CORS_ORIGINS=https://chat.example.com,app://abyss,capacitor://localhost,https://localhost
```

| Origin | Platform |
|---|---|
| `https://chat.example.com` | Web browser |
| `app://abyss` | Electron desktop app |
| `capacitor://localhost` | iOS (Capacitor) |
| `https://localhost` | Android (Capacitor) |

---

## Frontend Variables (`VITE_*`)

These are embedded into the web client at build time by Vite. Changing them requires rebuilding the client.

| Variable | Required | Description | Example |
|---|---|---|---|
| `VITE_API_URL` | Yes | Public backend base URL | `https://chat.example.com` |
| `VITE_STUN_URL` | Yes | STUN server URL for WebRTC | `stun:stun.l.google.com:19302` |
| `VITE_LIVEKIT_URL` | Optional | LiveKit WebSocket URL (client-side) | `wss://chat.example.com/lk` |
| `VITE_GIPHY_API_KEY` | Optional | Giphy API key for GIF search | — |

---

## TURN Configuration

coturn provides TURN relay for P2P WebRTC when direct connections fail. The backend issues short-lived HMAC credentials to clients; coturn validates them using the shared secret.

| Variable | Required | Description | Example |
|---|---|---|---|
| `TURN_EXTERNAL_IP` | Recommended | Server's public IP address | `203.0.113.1` |
| `TURN_PORT` | Recommended | TURN listening port | `3478` |
| `TURN_REALM` | Recommended | TURN realm (must match `turnserver.conf`) | `chat.example.com` |
| `TURN_AUTH_SECRET` | Recommended | HMAC shared secret (must match `static-auth-secret` in `turnserver.conf`) | Generate: `openssl rand -hex 32` |
| `TURN_URLS` | Recommended | Comma-separated TURN URLs sent to clients | `turn:IP:3478,turn:IP:3478?transport=tcp` |
| `TURN_TTL_SECONDS` | Optional | TURN credential lifetime in seconds | `3600` |

The values in `.env` must match the corresponding directives in `turnserver.conf`:

```
# turnserver.conf
external-ip=203.0.113.1     # ← matches TURN_EXTERNAL_IP
realm=chat.example.com       # ← matches TURN_REALM
static-auth-secret=secret    # ← matches TURN_AUTH_SECRET
```

---

## LiveKit Configuration

LiveKit is the SFU server used for relay mode. Without these variables, Abyss runs with peer-to-peer voice only and the backend logs "SFU relay disabled" on startup.

| Variable | Required for relay | Description | Example |
|---|---|---|---|
| `LIVEKIT_API_KEY` | Yes | LiveKit API key | Generate: `openssl rand -hex 16` |
| `LIVEKIT_API_SECRET` | Yes | LiveKit API secret | Generate: `openssl rand -base64 32` |
| `LIVEKIT_URL` | Yes | LiveKit URL used by the **backend** | `ws://livekit:7880` (Docker internal) |
| `VITE_LIVEKIT_URL` | Yes | LiveKit URL used by the **client** | `wss://chat.example.com/lk` (proxied) |

`LIVEKIT_URL` is the backend-to-LiveKit connection (can use the internal Docker network name). `VITE_LIVEKIT_URL` is what the browser connects to — in production this should go through Caddy for TLS.

---

## Push Notifications

| Variable | Required for push | Description | Example |
|---|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Yes | Path to the Firebase Admin SDK JSON file | `/app/firebase-service-account.json` |

The file is mounted into the Docker container via `docker-compose.yml`. If the file is absent or the path is wrong, push notifications are disabled while everything else continues to work.

---

## Security Notes

- **Rotate all secrets** before deploying to production: `JWT_KEY`, `TURN_AUTH_SECRET`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.
- **Restrict `CORS_ORIGINS`** to only the origins that need access. Never use `*` in production.
- **Keep `.env` and `firebase-service-account.json` out of source control.** Both are in `.gitignore` by default.
- **`JWT_KEY` rotation** invalidates all existing sessions — all users will be logged out.
- **Data Protection keys** (ASP.NET Core) are stored in the `dpkeys` Docker volume. Losing them also invalidates sessions; back them up.
