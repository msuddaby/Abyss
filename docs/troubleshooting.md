# Troubleshooting

Common issues and how to diagnose and fix them.

## Backend Won't Start

**Symptoms:** `dotnet run` exits immediately or throws on startup.

**Check environment variables first:**

```sh
# Verify .env.dev exists and has required values
cat .env.dev | grep -E 'POSTGRES_|JWT_KEY'
```

Required: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `JWT_KEY`.

**Read the exception:**

```sh
cd server/Abyss.Api
dotnet run 2>&1 | head -50
```

Common errors:

| Error message | Cause | Fix |
|---|---|---|
| `Connection refused` | PostgreSQL not running | `docker compose -f docker-compose.dev.yml up -d db` |
| `password authentication failed` | Wrong `POSTGRES_PASSWORD` | Check `.env.dev` matches Docker Compose env |
| `JWT key too short` | `JWT_KEY` < 64 chars | Generate a longer key: `openssl rand -base64 48` |
| `address already in use` | Port 5000 is taken | Kill the other process or change the API port |

**In Docker production:**

```sh
docker compose logs -f api
```

---

## Database Connection Errors

**Port mismatch:**

- Local development: `POSTGRES_HOST=localhost`, `POSTGRES_PORT=5433` (Docker Compose maps `5433:5432`)
- Docker production: `POSTGRES_HOST=db`, `POSTGRES_PORT=5432` (internal Docker network)

**Check container health:**

```sh
docker compose ps
# Look for "healthy" status on the db container
```

If the `db` container is unhealthy:

```sh
docker compose logs db
```

**Check the database is reachable:**

```sh
docker exec -it abyss-db psql -U $POSTGRES_USER -d $POSTGRES_DB -c '\l'
```

---

## Migrations Fail on Startup

**Symptom:** API starts but immediately crashes with an EF Core migration error.

This usually means the database is empty or at an incompatible migration state.

**Reset the database (development only):**

```sh
docker compose -f docker-compose.dev.yml down -v  # Destroys volumes!
docker compose -f docker-compose.dev.yml up -d
dotnet run
```

**Apply migrations manually:**

```sh
cd server/Abyss.Api
dotnet ef database update
```

---

## SignalR Not Connecting

**Symptom:** Chat loads but messages don't appear in real time; voice doesn't work; browser console shows WebSocket connection errors.

**Check in order:**

1. **Proxy routing:** In production, verify Caddy forwards `/hubs/*` to the backend. The WebSocket upgrade must be passed through — Caddy handles this automatically with `reverse_proxy`.

2. **CORS:** The client origin must be in `CORS_ORIGINS`. Check the browser console for CORS errors. In development, `http://localhost:5173` must be included.

3. **JWT:** The token may be expired. Try logging out and back in.

4. **Backend is running:** `curl http://localhost:5000/health` should return 200.

5. **In Docker:** Check that the `api` container is healthy:
   ```sh
   docker compose ps
   docker compose logs -f api
   ```

---

## Voice Doesn't Work

### Only works on some networks

**Cause:** P2P WebRTC cannot traverse NAT on some networks (symmetric NAT, enterprise firewalls, VPNs).

**Fixes:**

1. **Configure TURN:** TURN relay handles the most restrictive NAT scenarios. Verify:
   - `TURN_AUTH_SECRET` in `.env` matches `static-auth-secret` in `turnserver.conf`
   - `TURN_REALM` matches `realm` in `turnserver.conf`
   - Port `3478` TCP and UDP are open in your firewall
   - `TURN_EXTERNAL_IP` is your actual public IP (not a private/LAN IP)

2. **Enable LiveKit relay:** Configure the SFU relay so users on restrictive networks can fall back automatically. See [Deployment → Configure LiveKit](/deployment#3-configure-livekit).

3. **Force relay mode for testing:** In Settings > Voice & Audio, enable "Always use relay mode" to bypass P2P entirely.

**Verify TURN is working:**

```sh
# Check coturn is running
docker compose ps coturn

# Check coturn logs for auth errors
docker compose logs coturn | tail -50
```

### One user hears others but others can't hear them

**Likely cause:** The user's microphone is muted at the OS or browser level, or VAD threshold is too high.

- Check the mute button in Abyss (both local mute and server-enforced mute)
- Check browser microphone permissions
- Verify the correct input device is selected in Settings > Voice & Audio
- If using VAD, try switching to push-to-talk to rule out the VAD threshold

### No audio at all in a call

- Check that the user is not deafened (deafen mutes all output)
- Verify per-user volume is not set to 0 in the voice participant list
- Check the selected audio output device in Settings > Voice & Audio

---

## LiveKit Relay Issues

**Symptom:** "Always use relay mode" is enabled but voice doesn't connect, or users see "SFU unavailable".

**Check backend response:**

```sh
curl -X POST http://localhost:5000/api/voice/livekit-token \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"channelId": "123"}'
```

| Response | Cause |
|---|---|
| `501 Not Implemented` | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, or `LIVEKIT_URL` not set in `.env` |
| `403 Forbidden` | User lacks `Connect` permission in the channel |
| Connection refused | `LIVEKIT_URL` is wrong or LiveKit isn't running |

**In production:** Verify the `/lk/*` proxy route in Caddy reaches LiveKit and that ports 50000–50100 UDP and 7881 TCP are open in your firewall.

```sh
docker compose logs livekit | tail -50
```

---

## Push Notifications Not Delivered

**Check in order:**

1. `firebase-service-account.json` exists at the project root and is mounted into the container
2. `FIREBASE_SERVICE_ACCOUNT_PATH=/app/firebase-service-account.json` is set in `.env`
3. The mobile app registered its FCM token (logs: `Device registered for push notifications`)
4. The Firebase project has the correct Android package name / iOS bundle ID configured
5. For iOS: Push Notifications capability is enabled in Xcode and a valid APNs key is configured in Firebase

```sh
docker compose logs api | grep -i "push\|firebase\|notification"
```

---

## Web Client Build Fails

**Vite rollup native module error (Node.js v25+):**

Node.js v25 may have compatibility issues with some rollup native modules. Use Node.js LTS (v20 or v22) instead.

```sh
node --version  # Should be LTS
npm run build
```

**Environment variable not set:**

If the build succeeds but the app shows a blank screen or can't connect to the backend, check that `VITE_API_URL` is set before running the build. It's embedded at build time and cannot be changed after.

---

## Docs Site Build Fails

```sh
npm run docs:build
```

If links fail, check that all paths in `docs/.vitepress/config.mts` sidebar match existing markdown filenames (VitePress enforces dead link checking at build time).

---

## Electron Desktop App

### App loads but can't connect to the server

The desktop app uses a custom `app://abyss` protocol. The backend's `CORS_ORIGINS` must include `app://abyss`:

```
CORS_ORIGINS=https://chat.example.com,app://abyss,...
```

### Auto-update not applying (Linux)

After an update downloads, Abyss calls `quitAndInstall()` followed by `app.exit(0)` to kill the old process. If the update installs but the old version is still running, check that the AppImage symlink at `~/.local/bin/Abyss.AppImage` points to the new version:

```sh
ls -la ~/.local/bin/Abyss.AppImage
```

### Push-to-talk keybind not working

Global keybinds require Accessibility permissions on macOS. Grant the permission in System Settings > Privacy & Security > Accessibility.
