# Features

Complete inventory of user-facing features currently implemented in Abyss.

## Feature Summary

| Area | Capabilities |
|---|---|
| **Servers & Channels** | Multi-server instances, text and voice channels, channel ordering, invite-based joining |
| **Permissions & Roles** | Custom roles, bitfield permission system, per-channel overrides, moderation controls |
| **Messaging** | Real-time chat, mentions, reactions, replies, edits, deletes, pinned messages, attachments |
| **Discovery** | Message search, DM search, unread tracking, typing indicators |
| **Voice & Video** | WebRTC P2P, TURN traversal, LiveKit SFU fallback, mute/deafen/PTT/VAD, screen share, camera |
| **Watch Party** | Synchronized playback, queue management, host controls, YouTube and Plex sources |
| **Social** | Friend requests and list, direct messages, user presence and status |
| **Personalization** | Avatars, custom emoji, soundboard clips, cosmetics |
| **Notifications** | In-app notifications, per-server/channel settings, mobile push via Firebase |
| **Administration** | System admin panel, user and server management, instance settings |
| **Platform Support** | Web, iOS/Android (Capacitor), Electron desktop |

---

## Servers and Channels

Abyss is organized around servers — isolated communities that each have their own channels, members, roles, and invite links.

- Create, edit, and delete servers
- Text channels for persistent chat history
- Voice channels for live communication
- Drag-to-reorder channels within a server
- Invite-based member joining with optional invite code expiry and use limits
- Server-level moderation: kick, ban, view bans, unban

## Roles and Permissions

Every server has a fully customizable role system:

- Create, rename, reorder, and delete roles
- Assign roles to members
- Permissions are stored as a **bitfield** — roles combine additively, and higher-priority roles override lower ones
- Per-channel permission overrides let specific roles gain or lose access to individual channels
- Built-in permissions include: `ManageChannels`, `ManageRoles`, `ManageMembers`, `KickMembers`, `BanMembers`, `MuteMembers`, `DeafenMembers`, `Connect`, `Speak`, `SendMessages`, `ManageMessages`, `ViewChannel`, `ManageServer`, `Administrator`

The `Administrator` permission grants all other permissions and bypasses per-channel restrictions.

## Messaging and Collaboration

Real-time chat is backed by a SignalR hub with persistent PostgreSQL storage.

- Send, edit, and delete messages
- **Replies** — thread a message to a specific prior message
- **Reactions** — emoji reactions visible to all channel members
- **Mentions** — `@username` mentions trigger notifications; supports `@here` for online members
- **Pinned messages** — pin important messages for easy reference
- **Attachments** — upload images, video, and files; images display inline
- **Typing indicators** — see who's currently composing a message
- **Unread tracking** — per-channel last-read position, visible in the sidebar
- **Search** — full-text message search within a server; DM search for direct messages

## Voice and Video

Voice chat uses a hybrid P2P/SFU architecture. See [Voice Architecture](/VOICE_ARCHITECTURE) for protocol details.

### Connection Modes

| Mode | Description |
|---|---|
| **Peer-to-peer (default)** | Direct WebRTC between participants. Lowest latency, no server involvement in media. |
| **TURN-assisted P2P** | TURN relay for NAT traversal when direct P2P connections cannot be established. |
| **SFU relay (automatic fallback)** | LiveKit SFU relay, triggered automatically after P2P failures, when the room exceeds 8 participants, or when a user enables "Always use relay mode". |

### Voice Controls

- Mute/deafen with server moderation enforcement
- **Voice Activity Detection (VAD)** — automatic mic activation based on audio level
- **Push-to-Talk (PTT)** — browser keybind or Electron global keybind
- Per-user volume control (0–300%, with gain boost above 100%)
- Input and output device selection
- Noise suppression (via `@sapphi-red/web-noise-suppressor`)

### Video and Screen Share

- Screen sharing with audio (where supported by the browser/OS)
- Camera streaming
- Quality presets:
  - Camera: up to 1080p
  - Screen share: quality / balanced / motion / high-motion

### End-to-End Encryption

When using SFU relay, all media is encrypted client-side with AES-GCM-256 keys derived via PBKDF2. The LiveKit relay server handles routing but never sees plaintext audio or video.

## Watch Parties

Watch parties let server members watch content together in sync, within a voice channel.

- **Synchronized playback** — play, pause, seek, and skip are broadcast to all participants
- **Queue management** — add, remove, and reorder items in the queue
- **Host controls** — designated host manages playback state
- **Sources:**
  - **YouTube** — search and add videos by URL or search term
  - **Plex** — connect a Plex server to a server; browse and queue library content

## Social Features

- **Friends** — send, accept, and decline friend requests; remove friends
- **Direct messages** — one-on-one conversations with persistent history and search
- **Presence and status** — Online, Away, and Do Not Disturb; propagated in real-time via SignalR

## Personalization

- **Avatars** — upload a custom avatar (images are resized and optimized server-side)
- **Custom emoji** — upload and manage per-server custom emoji; usable in messages and reactions
- **Soundboard** — per-server soundboard clips that can be played into a voice channel
- **Cosmetics** — cosmetic catalog with per-user assignment and equip flows

## Notifications

- **In-app notifications** — delivered in real-time via SignalR to active sessions
- **Per-server defaults** — configure notification behavior for an entire server (All Messages, Mentions Only, Muted)
- **Per-channel overrides** — override the server default for individual channels
- **Mobile push (optional)** — Firebase Cloud Messaging push notifications for iOS and Android; delivered when the user has no active SignalR connection

## Administration

System administrators have access to an admin panel with:

- **Instance overview** — user count, server count, active sessions
- **Server management** — browse all servers, transfer ownership, delete servers
- **User management** — view all users, manage roles, delete accounts
- **Invite code controls** — view and revoke instance-wide invite codes
- **Global settings** — configure instance-level settings such as public registration

Admin access is granted to accounts matching `SYSADMIN_USERNAME` on backend startup.

## Platform Support

| Platform | Notes |
|---|---|
| **Web** | Primary target; works in any modern browser |
| **iOS** | Capacitor wrapper around the shared React codebase; supports push notifications |
| **Android** | Capacitor wrapper; supports push notifications |
| **Desktop (Electron)** | Native desktop wrapper with global PTT keybinds, system idle detection, and auto-updates (Linux, macOS, Windows) |

## Optional Infrastructure Dependencies

Some features require additional services that are not required for core functionality:

| Service | Required For |
|---|---|
| **coturn** | TURN-assisted P2P voice on restrictive networks |
| **LiveKit** | SFU relay mode for large/difficult voice scenarios |
| **Firebase** | Mobile push notifications |
| **Plex server** | Plex watch party source |

Abyss runs without any of these configured — voice is peer-to-peer only, and push notifications are disabled if Firebase is absent.
