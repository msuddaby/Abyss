# API Overview

Abyss exposes REST endpoints under `/api/*` and real-time events over SignalR at `/hubs/chat`.

All API endpoints require a valid JWT bearer token unless noted otherwise. The JWT is obtained from the auth endpoints and passed as `Authorization: Bearer <token>` on subsequent requests.

## Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | None | Create a new account |
| `POST` | `/api/auth/login` | None | Log in; returns JWT + refresh token |
| `POST` | `/api/auth/refresh` | None | Exchange a refresh token for a new JWT |
| `POST` | `/api/auth/logout` | Yes | Revoke refresh token |
| `GET` | `/api/auth/me` | Yes | Get current user profile |
| `PUT` | `/api/auth/profile` | Yes | Update username, display name, bio |
| `POST` | `/api/auth/avatar` | Yes | Upload a new avatar image |
| `PUT` | `/api/auth/presence` | Yes | Update presence status (Online, Away, DnD) |

## Servers

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/servers` | List servers the current user belongs to |
| `POST` | `/api/servers` | Create a new server |
| `GET` | `/api/servers/{id}` | Get server details |
| `PUT` | `/api/servers/{id}` | Edit server name/icon |
| `DELETE` | `/api/servers/{id}` | Delete a server (owner only) |
| `POST` | `/api/servers/{id}/leave` | Leave a server |
| `GET` | `/api/servers/{id}/members` | List server members |

## Channels

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/channels/{id}` | Get channel details |
| `POST` | `/api/servers/{serverId}/channels` | Create a channel |
| `PUT` | `/api/channels/{id}` | Edit channel |
| `DELETE` | `/api/channels/{id}` | Delete a channel |
| `PUT` | `/api/servers/{serverId}/channels/order` | Reorder channels |
| `GET` | `/api/channels/{id}/messages` | Fetch message history (paginated) |
| `GET` | `/api/channels/{id}/pins` | Get pinned messages |
| `GET` | `/api/channels/{id}/search` | Search messages in channel |

## Roles and Permissions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/servers/{serverId}/roles` | List server roles |
| `POST` | `/api/servers/{serverId}/roles` | Create a role |
| `PUT` | `/api/servers/{serverId}/roles/{roleId}` | Edit role (name, permissions, color) |
| `DELETE` | `/api/servers/{serverId}/roles/{roleId}` | Delete a role |
| `PUT` | `/api/servers/{serverId}/roles/order` | Reorder roles |
| `POST` | `/api/servers/{serverId}/members/{userId}/roles/{roleId}` | Assign role to member |
| `DELETE` | `/api/servers/{serverId}/members/{userId}/roles/{roleId}` | Remove role from member |
| `GET` | `/api/channels/{channelId}/permissions` | Get channel permission overrides |
| `PUT` | `/api/channels/{channelId}/permissions/{roleId}` | Set channel permission override for role |
| `DELETE` | `/api/channels/{channelId}/permissions/{roleId}` | Remove channel permission override |

## Invites and Bans

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/invites` | Create an invite link |
| `GET` | `/api/invites/{code}` | Get invite info (public) |
| `POST` | `/api/invites/{code}/join` | Join a server using an invite code |
| `GET` | `/api/servers/{serverId}/bans` | List bans |
| `POST` | `/api/servers/{serverId}/bans` | Ban a member |
| `DELETE` | `/api/servers/{serverId}/bans/{userId}` | Unban a user |

## Friends and Direct Messages

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/friends` | List friends and pending requests |
| `POST` | `/api/friends/{userId}` | Send a friend request |
| `PUT` | `/api/friends/{userId}` | Accept or decline a friend request |
| `DELETE` | `/api/friends/{userId}` | Remove a friend |
| `GET` | `/api/dm` | List DM conversations |
| `GET` | `/api/dm/{userId}` | Get DM conversation with a user |
| `GET` | `/api/dm/{userId}/messages` | Fetch DM message history |
| `GET` | `/api/dm/{userId}/search` | Search DM messages |

## Voice

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/voice/turn` | Fetch short-lived TURN credentials (HMAC) |
| `POST` | `/api/voice/livekit-token` | Fetch a LiveKit token for SFU relay mode |

## Media and Uploads

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload a file attachment |
| `GET` | `/api/servers/{serverId}/emojis` | List custom emoji |
| `POST` | `/api/servers/{serverId}/emojis` | Upload a custom emoji |
| `DELETE` | `/api/servers/{serverId}/emojis/{emojiId}` | Delete a custom emoji |
| `GET` | `/api/servers/{serverId}/soundboard` | List soundboard clips |
| `POST` | `/api/servers/{serverId}/soundboard` | Upload a soundboard clip |
| `DELETE` | `/api/servers/{serverId}/soundboard/{clipId}` | Delete a clip |

## Watch Party

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/channels/{channelId}/watch-party` | Get current watch party state |
| `POST` | `/api/channels/{channelId}/watch-party` | Create or update watch party |
| `POST` | `/api/channels/{channelId}/watch-party/queue` | Add item to queue |
| `DELETE` | `/api/channels/{channelId}/watch-party/queue/{itemId}` | Remove item from queue |
| `PUT` | `/api/channels/{channelId}/watch-party/queue/order` | Reorder queue |
| `GET` | `/api/servers/{serverId}/media-providers` | List connected media providers (Plex) |

## Notifications and Preferences

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users/preferences` | Get user preferences |
| `PUT` | `/api/users/preferences` | Update user preferences |
| `GET` | `/api/servers/{serverId}/notification-settings` | Get notification settings for a server |
| `PUT` | `/api/servers/{serverId}/notification-settings` | Update server notification settings |
| `GET` | `/api/channels/{channelId}/notification-settings` | Get notification settings for a channel |
| `PUT` | `/api/channels/{channelId}/notification-settings` | Update channel notification settings |
| `POST` | `/api/notifications/register-device` | Register a device for push notifications |
| `DELETE` | `/api/notifications/unregister-device` | Unregister a device |

## Administration

All admin endpoints require the `Administrator` system permission. Access is restricted to accounts matching `SYSADMIN_USERNAME`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/overview` | Instance stats (users, servers, sessions) |
| `GET` | `/api/admin/users` | List all users |
| `DELETE` | `/api/admin/users/{userId}` | Delete a user account |
| `GET` | `/api/admin/servers` | List all servers |
| `DELETE` | `/api/admin/servers/{serverId}` | Delete a server |
| `POST` | `/api/admin/servers/{serverId}/transfer` | Transfer server ownership |
| `GET` | `/api/admin/invites` | List all invite codes |
| `DELETE` | `/api/admin/invites/{code}` | Revoke an invite code |
| `GET` | `/api/admin/settings` | Get instance settings |
| `PUT` | `/api/admin/settings/{key}` | Update an instance setting |

## Public Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Health check — returns `OK` when the API is running |
| `GET` | `/api/config` | None | Public app configuration (registration enabled, etc.) |

---

## SignalR Hub (`/hubs/chat`)

Connect with the JWT passed as a query parameter:

```
ws://localhost:5000/hubs/chat?access_token=<jwt>
```

### Client → Server Methods

| Method | Payload | Description |
|---|---|---|
| `JoinVoiceChannel` | `channelId` | Join a voice channel |
| `LeaveVoiceChannel` | — | Leave the current voice channel |
| `SendSignal` | `{ targetUserId, signal }` | Send a WebRTC SDP/ICE signal to a specific peer |
| `VoiceHeartbeat` | — | Keep the voice session alive |
| `NotifyRelayMode` | `channelId` | Notify the server this client has switched to SFU relay |
| `SendMessage` | `{ channelId, content, ... }` | Send a message to a channel |
| `SendDm` | `{ recipientId, content, ... }` | Send a direct message |
| `StartTyping` | `channelId` | Broadcast typing indicator |
| `StopTyping` | `channelId` | Stop typing indicator |
| `UpdateMuteState` | `{ muted, deafened }` | Broadcast local mute/deafen state |
| `UpdateScreenShare` | `{ sharing }` | Broadcast screen share state |

### Server → Client Events

| Event | Payload | Description |
|---|---|---|
| `ReceiveMessage` | `MessageDto` | A new message was sent to a channel |
| `MessageEdited` | `MessageDto` | A message was edited |
| `MessageDeleted` | `{ messageId }` | A message was deleted |
| `ReceiveDm` | `MessageDto` | A new direct message was received |
| `ReceiveSignal` | `{ senderId, signal }` | WebRTC SDP/ICE signal from a peer |
| `VoiceChannelUsers` | `{ channelId, users[] }` | Full voice participant list (on join or reconciliation) |
| `VoiceUserJoinedChannel` | `{ channelId, user }` | A user joined a voice channel (sidebar update) |
| `VoiceUserLeftChannel` | `{ channelId, userId }` | A user left a voice channel (sidebar update) |
| `UserJoinedVoice` | `{ user }` | A participant joined the active call |
| `UserLeftVoice` | `{ userId }` | A participant left the active call |
| `ChannelRelayActive` | `{ channelId }` | Channel has switched to SFU relay mode |
| `PresenceUpdated` | `{ userId, status }` | A user's presence/status changed |
| `UserMuteStateChanged` | `{ userId, muted, deafened }` | A participant's mute state changed |
| `UserScreenShareChanged` | `{ userId, sharing }` | A participant started or stopped screen sharing |
| `TypingStarted` | `{ channelId, userId }` | A user started typing |
| `TypingStopped` | `{ channelId, userId }` | A user stopped typing |
| `ReactionAdded` | `{ messageId, reaction }` | A reaction was added to a message |
| `ReactionRemoved` | `{ messageId, emoji, userId }` | A reaction was removed |
| `NotificationReceived` | `NotificationDto` | An in-app notification |
| `ServerUpdated` | `ServerDto` | Server details changed |
| `MemberJoined` | `{ serverId, member }` | A new member joined a server |
| `MemberLeft` | `{ serverId, userId }` | A member left or was removed |
