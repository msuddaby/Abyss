# Abyss

Discord clone MVP with text channels, voice chat, and screen sharing.

## Tech Stack

- **Backend:** ASP.NET (dotnet 10), EF Core, SignalR, PostgreSQL 16
- **Frontend:** React 18, TypeScript, Vite, Zustand, Axios, @microsoft/signalr
- **Voice:** WebRTC mesh topology, STUN + TURN (coturn in Docker, host network). ICE servers configured via `VITE_STUN_URL`, `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` env vars in `.env`.
- **Database:** PostgreSQL in Docker (mapped to port 5433, since 5432 was in use)
- **Auth:** ASP.NET Identity + JWT. SignalR authenticates via `access_token` query param.

## Setup

**Development:**
```
cp .env.dev.example .env.dev              # edit with your dev values
cp turnserver.conf.example turnserver.conf  # edit with your TURN config
```

**Production:** see `DEPLOY.md`

Environment files: `.env.dev` for development (localhost, port 5433), `.env` for production (docker networking, port 5432). Backend `Program.cs` loads `.env.dev` first, then `.env`. In Docker containers, env vars come from `docker-compose.yml` `env_file` directive.

## Running (Development)

```
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d  # postgres + coturn
cd server/Abyss.Api && dotnet run                                     # backend on :5000
cd client && npm run dev                                               # frontend on :5173
```

## Running (Production)

```
docker compose up -d              # postgres + api + coturn
cd client && npm ci && npm run build  # build frontend
# Caddy serves client/dist and proxies /api, /hubs, /uploads to :5000
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
- Screen share signaling: `ScreenShareStarted`/`ScreenShareStopped` (voice group), `ScreenShareStartedInChannel`/`ScreenShareStoppedInChannel` (server group for sidebar LIVE badges)
- Opt-in stream watching: `RequestWatchStream`/`StopWatchingStream` relay viewer requests to sharer for lazy track negotiation

Services:
- `PermissionService` (scoped) — centralized permission checks using bitfield permissions (`HasPermissionAsync`, `CanActOnAsync`, `CanKickAsync`, `CanBanAsync`, `IsBannedAsync`) + `LogAsync` for audit logging. Owner bypasses all permission checks (`~0L`). Computes effective permissions by OR'ing @everyone role + all assigned roles.
- `VoiceStateService` (singleton) — in-memory voice channel state + multi-sharer screen share tracking per channel
- `NotificationService` (scoped) — mention parsing (`<@userId>`, `@everyone`, `@here`), creates `Notification` records for mentioned users, upserts `ChannelRead` cursors, queries unread state per channel/server

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
- `serverStore` — servers, channels, members, roles, bans, voice channel user lists, voice channel sharers (for sidebar LIVE badges). Remembers last active server/channel in localStorage
- `messageStore` — messages for active channel, send via SignalR
- `voiceStore` — voice connection state, mute/deafen (persisted to localStorage), PTT, screen sharing, multi-sharer tracking (`activeSharers` map + `watchingUserId`), speaking indicators
- `presenceStore` — online users set, typing indicators with auto-expire timeouts
- `unreadStore` — per-channel and per-server unread state (hasUnread boolean, mentionCount int). Updated via SignalR `NewUnreadMessage`/`MentionReceived` events, cleared on channel switch via `MarkChannelRead` hub method

**Key hooks:**
- `useWebRTC` — all WebRTC logic is module-level (shared across hook instances, not per-component). Manages peer connections, local/remote streams, audio elements, audio analysers for voice activity detection. Screen sharing uses lazy track negotiation: sharer captures display media but only adds video tracks to peer connections of viewers who opt in via `RequestWatchStream`. Per-viewer senders tracked in `screenTrackSenders` map. Exports `requestWatch()`/`stopWatching()` for UI. SignalR listeners registered once via module flag.

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

`ChannelRead` — per-user read cursor. Composite PK (ChannelId, UserId), tracks LastReadAt timestamp. Index on UserId.

`Notification` — mention notification records. PK Id (Guid). Fields: UserId, MessageId, ChannelId, ServerId, Type (enum: UserMention, EveryoneMention, HereMention), IsRead, CreatedAt. Indexed on (UserId, IsRead), (UserId, ChannelId, IsRead), (UserId, ServerId, IsRead).

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
- Mute/deafen (persisted to localStorage, always visible in user bar like Discord)
- Push-to-talk (configurable key/mouse bind)
- Voice activity speaking indicators (green ring on avatar, Web Audio API AnalyserNode)
- Screen sharing: opt-in viewing (Discord-style), multiple simultaneous sharers, lazy track negotiation (bandwidth-efficient)
- Screen share UI: sharer picker cards with "Watch Stream" buttons, full video view with "Stop Watching", switcher bar for multiple streams
- LIVE badge on voice channel participants who are screen sharing (visible to all server members)
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
- Mute state correctly applied when joining voice while already muted
- Unread indicators: white dot + bold channel name for unread channels, white pill on server icon for unread servers
- @mention system: `<@userId>` for user mentions, `@everyone` and `@here` with highlighted rendering
- Mention badges: red pill with count on channels and server icons
- Mention autocomplete: type `@` in message input for dropdown with keyboard nav (arrow keys, Enter/Tab, Escape)
- Per-user SignalR group (`user:{userId}`) for targeted mention notifications
- `ChannelRead` cursor tracks per-user read position, `Notification` table stores mention records
- Auto-mark-read on channel switch, real-time `NewUnreadMessage`/`MentionReceived` SignalR events
- `NotificationService` handles mention parsing, notification creation, and unread queries

## Not Yet Implemented

- Direct messages
- User avatars (profile pictures)
- Message search
- Server rename
- Mobile responsiveness
