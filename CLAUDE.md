# Abyss

Discord clone MVP with text channels, voice chat, and screen sharing.

## Tech Stack

- **Backend:** ASP.NET (dotnet 10), EF Core, SignalR, PostgreSQL 16
- **Frontend:** React 18, TypeScript, Vite, Zustand, Axios, @microsoft/signalr
- **Voice:** WebRTC mesh topology, STUN + TURN (coturn in Docker, host network). ICE servers configured via `VITE_STUN_URL`, `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` env vars in `.env`.
- **Database:** PostgreSQL in Docker (mapped to port 5433, since 5432 was in use)
- **Auth:** ASP.NET Identity + JWT. SignalR authenticates via `access_token` query param.

## Setup

```
cp .env.example .env              # edit with your secrets
cp turnserver.conf.example turnserver.conf  # edit with your TURN config
```

All secrets live in the root `.env` file (gitignored). Docker Compose, the backend (`Program.cs` loads it on startup), and the frontend (Vite reads it via `envDir`) all read from this single file.

## Running

```
docker compose up -d              # postgres + coturn
cd server/Abyss.Api && dotnet run   # backend on :5000
cd client && npm run dev              # frontend on :5173
```

EF Core auto-migrates on backend startup (no manual migration step needed).

## Architecture

### Backend (`server/Abyss.Api/`)

Single SignalR hub (`ChatHub`) handles all real-time communication:
- Text messaging (send, join/leave channel groups)
- Typing indicators
- Presence (online/offline tracking via static `_connections` dictionary)
- Voice signaling (WebRTC offer/answer/ICE candidate relay via `SendSignal`)
- Voice channel join/leave with server-side state (`VoiceStateService` singleton, in-memory `ConcurrentDictionary`)
- Screen share notifications

Services:
- `PermissionService` (scoped) — centralized permission checks using bitfield permissions (`HasPermissionAsync`, `CanActOnAsync`, `CanKickAsync`, `CanBanAsync`, `IsBannedAsync`) + `LogAsync` for audit logging. Owner bypasses all permission checks (`~0L`). Computes effective permissions by OR'ing @everyone role + all assigned roles.
- `VoiceStateService` (singleton) — in-memory voice channel state

REST controllers for CRUD:
- `AuthController` — register/login, returns JWT
- `ServersController` — create server, list servers, channels, members. Management endpoints: update member roles (ManageRoles), kick member (KickMembers + hierarchy), delete channel (ManageChannels), delete server (Owner), get audit logs (ViewAuditLog)
- `RolesController` — CRUD for custom server roles (ManageRoles perm), reorder positions. SignalR broadcasts on mutations.
- `BansController` — ban/unban members (BanMembers perm + hierarchy), list bans. Banned users cannot rejoin via invite.
- `ChannelsController` — create channels, get messages (paginated)
- `InvitesController` — create/join invite codes (checks ban status on join)
- `UploadController` — image upload to `wwwroot/uploads/`, served as static files

### Frontend (`client/src/`)

**Stores (Zustand):**
- `authStore` — user + token, persisted to localStorage
- `serverStore` — servers, channels, members, roles, bans, voice channel user lists. Remembers last active server/channel in localStorage
- `messageStore` — messages for active channel, send via SignalR
- `voiceStore` — voice connection state, mute/deafen, PTT, screen sharing, speaking indicators
- `presenceStore` — online users set, typing indicators with auto-expire timeouts

**Key hooks:**
- `useWebRTC` — all WebRTC logic is module-level (shared across hook instances, not per-component). Manages peer connections, local/remote streams, audio elements, audio analysers for voice activity detection, screen share tracks. SignalR listeners registered once via module flag.

**Layout:** Three-column Discord layout — server sidebar (icons) | channel sidebar (channel list + voice controls) | content area (messages or voice view) + member list on right.

**Services:**
- `api.ts` — Axios instance with JWT interceptor, base URL from `VITE_API_URL` env var
- `signalr.ts` — singleton SignalR connection with auto-reconnect

### Data Model

`AppUser` (Identity) → `ServerMember` (composite key) → `Server` → `Channel` (Text|Voice) → `Message` → `Attachment`

`Invite` — unique code, optional expiry and max uses.

`ServerRole` — per-server custom roles with Name, Color (hex), Permissions (long bitfield), Position (int, higher=more power), IsDefault (bool for @everyone). Linked to members via `ServerMemberRole` junction table (many-to-many).

`ServerMember.IsOwner` — immutable boolean flag. Owner is not a role; it's a special status that bypasses all permission checks and has effective position of `int.MaxValue`.

`Permission` flags enum: ManageChannels (1), ManageMessages (2), KickMembers (4), BanMembers (8), ManageRoles (16), ViewAuditLog (32), ManageServer (64), ManageInvites (128).

`ServerBan` — tracks banned users per server (UserId, BannedById, Reason, CreatedAt). Unique index on (ServerId, UserId). Banned users are blocked from rejoining via invite.

`AuditLog` — tracks admin actions (message deletions, channel create/delete, member kick/ban/unban, role create/update/delete, member roles updated, server delete). Indexed on `(ServerId, CreatedAt)`.

## Style

- Dark theme with Discord-like CSS variables (defined in `index.css`)
- All styles in `App.css` — no CSS modules or styled-components
- Class naming: `.kebab-case` (e.g. `.channel-sidebar`, `.message-input-form`)
- Components are function components, no class components
- No test suite currently

## Features Implemented

- User registration and login
- Create/join servers via invite codes
- Text channels with real-time messaging via SignalR
- Image attachments (upload + inline preview)
- Typing indicators (auto-expire after 3s)
- Online/offline presence
- Voice channels (WebRTC mesh, STUN+TURN)
- Mute/deafen
- Push-to-talk (configurable key/mouse bind)
- Voice activity speaking indicators (green ring on avatar, Web Audio API AnalyserNode)
- Screen sharing with live video view
- User profile cards with bio
- User settings modal (display name, bio)
- Channel creation (text + voice)
- Member list with online status dots
- Last active server/channel restored on reload
- Message editing/deletion
- Message reactions (emoji-mart picker, toggle on/off, real-time sync via SignalR)
- Custom roles with colors, bitfield permissions, and hierarchy (position-based)
- @everyone default role seeded on server creation, Owner as immutable flag
- Role management UI in server settings (create, edit name/color/permissions, delete)
- Role assignment via member context menu (checkbox list of available roles)
- Role colors displayed on member names in chat and member list
- Role pills shown on user profile cards
- Granular permissions: ManageChannels, ManageMessages, KickMembers, BanMembers, ManageRoles, ViewAuditLog, ManageServer, ManageInvites
- Hierarchy enforcement: can only act on members with lower role position
- Ban system: ban/unban members, banned users blocked from rejoining, ban list in server settings
- Server management: kick members, ban members, delete channels, delete server (Owner only)
- Audit log with expanded action types (bans, role CRUD, role assignments) visible in server settings
- Right-click context menu on members for admin actions (kick, ban, manage roles)
- Right-click context menu on messages (react, edit, delete + kick/ban on author)
- Permission-gated UI (all admin features only visible to users with appropriate permissions)
- Real-time SignalR broadcasts for role CRUD, role assignments, ban/unban events
- Message grouping (consecutive messages from same author within 5 min collapse into compact form, timestamp on hover)
- Pagination: 100 messages per page, scroll-up triggers loading older messages with scroll position preserved
- Auto-scroll to bottom on channel switch and new messages (only if near bottom)
- User profile refreshed from server on app init (fixes stale avatar/displayName in sidebar)
- SignalR `ensureConnected()` guard on all hub invocations (fixes race condition on page refresh)

## Not Yet Implemented

- Unread indicators / notifications
- Direct messages
- User avatars (profile pictures)
- Message search
- Server rename
- Mobile responsiveness
