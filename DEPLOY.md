# Deploying Abyss

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ (to build the frontend)
- Caddy (or any reverse proxy with HTTPS support)
- A domain name pointing to your server

## 1. Clone & Configure

```bash
git clone <your-repo-url> Abyss
cd Abyss
cp .env.example .env
```

Edit `.env` with your production values:

- **`POSTGRES_PASSWORD`** — use a strong random password
- **`JWT_KEY`** — generate a random 64+ character string (e.g. `openssl rand -base64 48`)
- **`TURN_EXTERNAL_IP`** — your server's public IP
- **`TURN_CREDENTIAL`** — strong random password for TURN auth
- **`CORS_ORIGINS`** — your domain (e.g. `https://your.domain.com`)
- **`VITE_API_URL`** — your domain (e.g. `https://your.domain.com`)
- **`VITE_TURN_URLS`** — update with your public IP

Copy and edit the TURN config:

```bash
cp turnserver.conf.example turnserver.conf
```

## 2. Build the Frontend

```bash
cd client
npm ci
npm run build
cd ..
```

This produces `client/dist/` which Caddy will serve as static files.

## 3. Configure Caddy

```bash
cp Caddyfile.example /etc/caddy/Caddyfile
```

Edit the Caddyfile:
- Replace `your.domain.com` with your actual domain
- Replace `/path/to/Abyss/client/dist` with the absolute path to your built frontend

Reload Caddy:

```bash
sudo caddy reload --config /etc/caddy/Caddyfile
```

Caddy automatically provisions HTTPS via Let's Encrypt.

## 4. Start Services

```bash
docker compose up -d
```

This starts:
- **PostgreSQL** — database (internal only, no host port exposed)
- **API server** — ASP.NET backend on port 5000
- **Coturn** — TURN relay server (host network)

The database auto-migrates on first API startup.

Verify the API is healthy:

```bash
curl http://localhost:5000/health
```

## 5. TURN Server Setup

Generate a hashed credential for turnserver.conf:

```bash
docker run --rm coturn/coturn turnadmin -k -u abyss -r abyss -p your-turn-password
```

Use the output hash in `turnserver.conf` for the `lt-cred-mech` user entry.

## 6. Uploaded Files

User uploads are stored in `./data/uploads/` on the host (bind-mounted into the container). Include this directory in your backup strategy.

## 7. Backups

Example cron job for daily PostgreSQL backups:

```bash
# Add to crontab -e
0 3 * * * docker exec abyss-db pg_dump -U abyss abyss | gzip > /backups/abyss-$(date +\%Y\%m\%d).sql.gz
```

Also back up:
- `.env` (secrets)
- `turnserver.conf`
- `./data/uploads/` (user-uploaded files)

## 8. Updating

```bash
git pull
cd client && npm ci && npm run build && cd ..
docker compose up -d --build
```

The `--build` flag rebuilds the API image with your latest code. Database migrations run automatically on startup.

## Development Setup

For local development, use the dev compose file (runs only Postgres + Coturn):

```bash
cp .env.dev.example .env.dev
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d
cd server/Abyss.Api && dotnet run    # backend on :5000
cd client && npm run dev              # frontend on :5173
```
