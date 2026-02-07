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
- Mobile: stop SignalR on background, reconnect + rejoin channel + refresh state on foreground (Expo)

### Data Model

`AppUser` (Identity) → `ServerMember` (composite key) → `Server` → `Channel` (Text|Voice) → `Message` → `Attachment`

`Invite` — unique code, optional expiry and max uses.

`ServerRole` — per-server custom roles with Name, Color (hex), Permissions (long bitfield), Position (int, higher=more power), IsDefault (bool for @everyone). Linked to members via `ServerMemberRole` junction table (many-to-many).

`ServerMember.IsOwner` — immutable boolean flag. Owner is not a role; it's a special status that bypasses all permission checks and has effective position of `int.MaxValue`.

`Permission` flags enum: ManageChannels (1), ManageMessages (2), KickMembers (4), BanMembers (8), ManageRoles (16), ViewAuditLog (32), ManageServer (64), ManageInvites (128), ManageEmojis (256), MuteMembers (512).

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

## Expo Mobile App (Branch: `expo-refactor`)

See `EXPO_MIGRATION.md` for full plan. The React/Vite web client (`client/`) is the canonical web app. The Expo app (`packages/app/`) targets **iOS + Android only** — no Expo web.

### Monorepo Structure
```
abyss/
  package.json              # Root — npm workspaces
  .npmrc                    # legacy-peer-deps=true
  packages/
    shared/                 # @abyss/shared — types, stores, services, utils
      src/
        types/index.ts
        stores/             # All 8 Zustand stores (platform-agnostic)
        services/api.ts     # Axios + setOnUnauthorized() callback
        services/signalr.ts # SignalR connection
        utils/              # Mention parsing, message grouping, formatting
        storage.ts          # StorageAdapter interface
        index.ts            # Barrel export
    app/                    # @abyss/app — Expo mobile app (iOS + Android)
      app/
        _layout.tsx         # Root layout: init storage/api/auth, auth routing guard
        (auth)/login.tsx    # Login screen
        (auth)/register.tsx # Register screen
        (main)/_layout.tsx  # Mobile layout shell (panel switching + bottom nav)
        (main)/index.tsx    # Content area (messages / voice)
      src/
        components/         # All RN UI components
        hooks/useWebRTC.ts  # react-native-webrtc version
        stores/uiStore.ts   # Mobile panel switching + modal state
        theme/tokens.ts     # Design tokens (colors, spacing, fontSize, borderRadius)
        storage.ts          # AsyncStorage + SecureStore adapter (preloadStorage())
  client/                   # React/Vite web client (canonical web app, uses @abyss/shared)
  server/                   # ASP.NET backend (unchanged)
```

### Completed Phases
- **Phase 0:** Monorepo setup, shared package extraction, client re-imports
- **Phase 1:** Expo project scaffolding, routing, theme, base components, storage adapter
- **Phase 2:** Auth screens (login/register), SecureStore for JWT on native, 401 auto-logout interceptor
- **Phase 3:** Main layout shell — responsive 4-column desktop / mobile panel switching with bottom nav
- **Phase 4:** Text messaging — MessageList, MessageItem, MessageInput, TypingIndicator, emoji picker, mention autocomplete, reactions, file attachments
- **Phase 5:** Modals & Settings — All 7 modal components ported (CreateServer, JoinServer, CreateChannel, Invite, UserSettings, UserProfileCard, ServerSettings with tabbed UI), uiStore modal state, wired into existing sidebar/bar components
- **Phase 6:** Voice Chat (WebRTC) — useWebRTC hook + VoiceView component
- **Phase 7:** Mobile-Only Cleanup — stripped all web code (Platform.OS === 'web' branches, react-dom, react-native-web, desktop layout, useLayout hook)
- **Phase 8a:** Screen Share Viewing — receive + display remote screen via RTCView, sharer picker, switcher bar (no new deps)
- **Phase 9:** Push Notifications — expo-notifications, backend DevicePushToken model + /api/notifications/register-device endpoint, NotificationService sends push via Expo Push Service to offline users, client auto-registers token on login, handles notification taps for navigation, badge count shows total unread mentions

### Phase 11 Progress (Polish & Mobile UX)
- **Drawer-based layout** — removed bottom nav, added slide-in left drawer (servers + channels) and right drawer (members), tap outside to close, header buttons (`☰` / `👥`) to open. Server/DM selection keeps drawer open; channel selection closes it. Animated slide + fade scrim.

### Voice Status (Muted/Deafened)
- **Server state:** `VoiceStateService` now stores per-user voice state (displayName, isMuted, isDeafened). Join requires state, and updates are broadcast to the server group.
- **SignalR events:**
  - `GetServerVoiceUsers` returns `{ [channelId]: { [userId]: { displayName, isMuted, isDeafened, isServerMuted, isServerDeafened }}}`
  - `VoiceUserJoinedChannel(channelId, userId, state)` where `state` includes mute/deafen + server mute/deafen flags
  - `VoiceUserStateUpdated(channelId, userId, state)` fired on mute/deafen changes (including server mute/deafen)
  - `ModerateVoiceState(targetUserId, isMuted, isDeafened)` admin-only, applies server mute/deafen lock
- **Client responsibilities (mobile + web):**
  - On join: call `JoinVoiceChannel(channelId, isMuted, isDeafened)`
  - On toggle: call `UpdateVoiceState(isMuted, isDeafened)` while connected
  - Sidebar + voice UI read `voiceChannelUsers` state to show 🔇 / 🎧 indicators (server-locked states indicated separately)
  - If server-muted/deafened, client should disable local unmute/undeafen controls
- **Mobile files to check:** `packages/app/src/hooks/useWebRTC.ts`, `packages/app/src/components/VoiceChannelItem.tsx`, `packages/app/src/components/VoiceView.tsx`

### Key Implementation Details
- `StorageAdapter` — sync interface backed by in-memory `Map` cache. Web: `localStorage`. Expo: `AsyncStorage` + `expo-secure-store` for token key on native.
- `setOnUnauthorized()` in `api.ts` — callback pattern avoids circular deps between api.ts ↔ authStore. Called in `client/src/init.ts` and `packages/app/app/_layout.tsx`.
- Metro config in `packages/app/metro.config.js` strips `.js` extensions from `@abyss/shared` imports (shared uses ESM `.js` convention, Metro needs `.ts`).
- Expo API URL: `app.json` → `expo.extra.apiUrl` → `expo-constants`
- `useSignalRListeners()` hook in `packages/shared/src/hooks/` — extracted from web MainLayout, used by both web client and Expo app
- Expo layout: mobile-only panel switching (`uiStore.activePanel`: channels/content/members) with bottom nav bar. No desktop layout in Expo — desktop is the React web client.

### Phase 4 Implementation Details
- `MessageList.tsx` — `FlatList` with SignalR listeners (ReceiveMessage, MessageEdited, MessageDeleted, ReactionAdded, ReactionRemoved), auto-scroll to bottom on channel switch and new messages (only if near bottom), scroll-up pagination, message grouping via `shouldGroupMessage()`, scroll-to-message for reply navigation with highlight
- `MessageItem.tsx` — Full message rendering: parsed mentions (`parseMentions()`), custom emoji images, reply references above message row, message grouping (avatar vs empty spacer), mention highlight, image attachments, reaction chips (horizontal ScrollView, custom emoji support), long-press action sheet (Reply, Add Reaction, Edit, Delete, Kick, Ban with hierarchy checks), inline edit mode with TextInput
- `MessageInput.tsx` — Plain `TextInput multiline` (no contentEditable). Mention autocomplete (`@` trigger → member list + @everyone/@here, tap to insert `<@userId>`). Custom emoji autocomplete (`:` trigger → insert `<:name:id>`). Custom EmojiPicker bottom sheet for native + server emojis. `expo-image-picker` for image attachments with preview strip. Reply bar. Typing indicator via SignalR `UserTyping`. Send button.
- `TypingIndicator.tsx` — Reads `typingUsers` from presenceStore, fixed 24px height
- `index.tsx` — `KeyboardAvoidingView` wrapping on iOS, channel header (# / speaker / @ DM), voice channels show Phase 6 placeholder
- Dependencies: `expo-image-picker@~17.0.10`

### Known Limitations (Phase 11 Polish)
- **Context menus:** Currently uses native `Alert.alert` — doesn't match app theme. Phase 11 replaces with custom themed bottom sheets.
- **Emoji picker:** Custom picker supports native + server emojis with search, categories, and recents.

### Phase 5 Implementation Details
- `Modal.tsx` — base component wrapping RN `<Modal transparent animationType="fade">` with dark overlay, centered card, title, ScrollView
- `uiStore.ts` — `activeModal` (union type), `modalProps` (Record), `openModal(type, props?)`, `closeModal()`
- All modals rendered in `(main)/_layout.tsx` outside the column layout (overlays everything)
- `ServerSettingsModal.tsx` — tabbed modal with horizontal ScrollView tab bar. Tabs: Members (search + role/kick/ban actions), Roles (list + editor with name/color/permissions), Emojis (upload via expo-image-picker + list with delete), Bans (list + unban), Audit Log (list with icons/labels), Danger Zone (delete with name confirmation). Role assignment via nested `RoleAssignModal` sub-component.
- `UserSettingsModal.tsx` — avatar upload (expo-image-picker), voice mode toggle.
- `InviteModal.tsx` — copy via `expo-clipboard` (`Clipboard.setStringAsync`)
- `UserProfileCard.tsx` — fetches profile from API, shows banner, avatar, roles, bio
- Dependencies added: `expo-clipboard`

### Phase 8a Implementation Details
- `useWebRTC.ts` — added `screenVideoStreams` map, video track handling in `ontrack`, exported `requestWatch()`/`stopWatching()`/`getScreenVideoStream()`
- `ScreenShareView.tsx` — three-state component (null / picker cards / fullscreen RTCView), sharer switcher bar, `stream.toURL()` for RTCView `streamURL`
- `VoiceView.tsx` — when watching: ScreenShareView takes over content; when not watching but sharers exist: picker cards above participant grid
- No new dependencies — uses existing `react-native-webrtc` `RTCView` component
- Backend unchanged — same `RequestWatchStream`/`StopWatchingStream` SignalR flow as web

### Phase 9 Implementation Details
- **Backend:**
  - Created `Models/DevicePushToken.cs` — Id, UserId, Token, Platform, CreatedAt
  - Added `DbSet<DevicePushToken>` to `AppDbContext` with unique index on (UserId, Token)
  - Created `Controllers/NotificationsController.cs` — POST /register-device (upserts token), DELETE /unregister-device
  - Modified `Services/NotificationService.cs` — added `SendPushNotifications()` method, uses `IHttpClientFactory` to POST to Expo Push Service (https://exp.host/--/api/v2/push/send)
  - Push only sent to offline users (checked against `onlineUserIds` set from SignalR hub)
  - Push payload includes title (author + channel), body (message preview), data (channelId, serverId, messageId, type), badge (unread mention count)
  - Registered `AddHttpClient()` in `Program.cs`
- **Mobile Client:**
  - Installed `expo-notifications`, added plugin to `app.json` with icon and color
  - Created `packages/app/src/utils/notifications.ts` — `registerForPushNotifications()` (requests permission, gets Expo push token, registers with backend), `setBadgeCount()`, `addNotificationResponseListener()`
  - Modified `packages/app/app/_layout.tsx` — auto-registers push token on login, listens for notification taps (navigates to channel via router + serverStore), updates badge count based on `serverUnreads` + `dmUnreads` from unreadStore
  - Created `eas.json` template for EAS builds (required for production push notifications)
- **Production setup required:** Run `eas init` to create EAS project, add project ID to `app.json` → `expo.extra.eas.projectId`, build with `eas build`

### Phase 10 Implementation Details (Partial)
- **Message Search:**
  - Created `packages/app/src/components/SearchPanel.tsx` (~500 lines) — full-screen modal with search input, filter chips, and paginated results FlatList
  - Search button (🔍) added to ChannelSidebar header, opens search modal
  - Filter chips: channel (horizontal scroll), author (horizontal scroll), has attachment (checkbox)
  - Debounced search (300ms) calls existing backend endpoint `GET /api/servers/{serverId}/search`
  - Tap result → closes modal, switches to channel, fetches messages around target, scrolls to message with highlight animation (1.5s yellow background tint)
  - Extended `messageStore` with `highlightedMessageId` field + setter
  - Updated `MessageList` to watch `highlightedMessageId` and auto-scroll to highlighted message on change
  - Backend endpoint supports pagination (offset/limit), filters (channelId, authorId, hasAttachment, before/after dates), and full-text search via `EF.Functions.ILike`
- **DM Search (find users to start DMs):** Not yet implemented

### Next: Phase 11 — Polish & Mobile UX

## Not Yet Implemented

- Server rename
- Mobile responsiveness
- Message pinning
- Server icons
- Channel reordering
- Custom user status
- Link embeds/previews
- Notification settings (per-channel/server mute, suppress @everyone)
- Friend system
- Markdown rendering (bold, italic, code blocks, syntax highlighting)
- Role name effects (wavy, rainbow, gradient, glow, bounce, etc. — predefined CSS animations on per-letter spans)
- System admin panel (instance-wide settings, manage predefined role effects/themes, user management for self-hosters)
- **WebRTC quality controls** (voice bitrate, screen share resolution/framerate, adaptive quality) — see `WEBRTC_QUALITY.md` for detailed proposal
