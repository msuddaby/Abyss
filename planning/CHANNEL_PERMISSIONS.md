# Channel Permissions (Role-Based) for Text/Voice

**Summary**
Implement a Discord‑style channel permission system using role allow/deny overrides. Add new channel permission flags, persist channel overrides in the DB, compute effective channel permissions server‑side, enforce them in REST + SignalR, and expose a web UI to edit overrides. Clients (web + mobile) will **read and respect** effective permissions; only web gets the channel permissions editor UI.

## Public API / Interface Changes

**Types**
- `Permission` enum (server + shared) expanded with channel-level flags (new bits):
  - `ViewChannel`
  - `ReadMessageHistory`
  - `SendMessages`
  - `AddReactions`
  - `AttachFiles`
  - `MentionEveryone`
  - `Connect`
  - `Speak`
  - `Stream`
- `Channel` type gains `permissions?: number` (effective channel perms for current user; only set for server channels).
- New DTOs:
  - `ChannelPermissionOverrideDto` with `{ roleId, allow, deny }`.
  - `ChannelPermissionsDto` as list of overrides.

**Endpoints**
- `GET /servers/{serverId}/channels`
  - Filter to channels the requester can `ViewChannel`.
  - Each `ChannelDto` includes `permissions` (effective for requester).
- `GET /servers/{serverId}/channels/{channelId}/permissions`
  - Returns overrides; requires `ManageChannels`.
- `PUT /servers/{serverId}/channels/{channelId}/permissions`
  - Replaces overrides with the provided list; requires `ManageChannels`.

**SignalR**
- Channel create/update/delete events remain, but client will **refetch channels** to get correct filtered list + effective perms.
- New `ChannelPermissionsUpdated` event (serverId, channelId) so clients can refetch channels and re-evaluate active channel access.

## Data Model

**New table: `ChannelPermissionOverrides`**
- `ChannelId` (FK)
- `RoleId` (FK, non-null)
- `Allow` (long)
- `Deny` (long)
- Unique index `(ChannelId, RoleId)`

**EF**
- Add `DbSet<ChannelPermissionOverride>`
- Add navigation `Channel.PermissionOverrides` (optional)

## Permission Computation

Add to `PermissionService`:
- `GetServerPermissionsAsync(serverId, userId)` (existing logic renamed or reused)
- `GetChannelPermissionsAsync(channelId, userId)`
  - If DM: full access.
  - If owner: full access.
  - Base = server permissions (roles + @everyone).
  - Apply channel overrides:
    1) @everyone override (role where `IsDefault == true`)
    2) Combine all role overrides for member’s roles:
       - `combinedAllow = OR(allows)`, `combinedDeny = OR(denies)`
       - `perms = (perms & ~combinedDeny) | combinedAllow`
  - Return perms.
- `HasChannelPermissionAsync(channelId, userId, Permission perm)`

**Channel permission mask**
- Only the channel-level bits are affected by overrides; server‑level perms (e.g., `ManageRoles`) remain server‑wide.

## Backend Enforcement

**REST**
- `ChannelsController`:
  - `GET /messages`, `/messages/around`, `/pins` require `ViewChannel` + `ReadMessageHistory`.
- `UploadController`:
  - No change required for MVP (enforce at send time). If needed later, accept `channelId` to validate `AttachFiles`.

**SignalR (ChatHub)**
- `CanAccessChannel` checks `ViewChannel` (server channels) or DM participants.
- `JoinChannel` requires `ViewChannel`.
- `SendMessage` requires:
  - `SendMessages`
  - if attachments: `AttachFiles`
  - if `@everyone`/`@here`: `MentionEveryone` (reject or strip those tokens)
- `ToggleReaction` requires `AddReactions`.
- `JoinVoiceChannel` requires `Connect`.
  - If lacking `Speak`, set `isServerMuted = true` on join.
- `UpdateVoiceState` cannot unmute if `Speak` is missing or server-muted.
- `NotifyScreenShare` requires `Stream`.

**Mentions + unread**
- Before creating mention notifications for a target user, verify target has `ViewChannel`.
- `NewUnreadMessage` should only be sent to users who can `ViewChannel`.
- `GetUnreadState`, `GetServerVoiceUsers`, `GetServerVoiceSharers` should be filtered to channels user can `ViewChannel`.
- `ScreenShareStartedInChannel` / `VoiceUserJoinedChannel` server-wide events should be sent only to users with `ViewChannel` (use per-user groups).

## Client Changes (Web + Mobile Read/Enforce)

**Shared**
- Add helpers:
  - `hasChannelPermission(channelPermissions: number | undefined, perm: number): boolean`
  - `canViewChannel(channel): boolean` (for server channels)
- `serverStore`:
  - new `fetchChannels(serverId)` method used by:
    - `setActiveServer`
    - SignalR listeners for channel events and `ChannelPermissionsUpdated`

**Web UI**
- Channel list:
  - Filter channels by `ViewChannel` (defensive), but primary filter is server response.
- Message UI:
  - Disable input + send button when no `SendMessages`.
  - Disable attach button when no `AttachFiles`.
  - Remove `@everyone`/`@here` from autocomplete when no `MentionEveryone`.
  - Disable reactions UI when no `AddReactions`.
- Voice UI:
  - Disable join when no `Connect`.
  - Disable screen share when no `Stream`.

**Channel Permissions Editor (Web-only)**
- Extend `EditChannelModal` (or add `ChannelPermissionsModal`) with:
  - Role selector (including @everyone).
  - Allow/Deny checkbox grid for channel perms.
  - Save → `PUT /servers/{serverId}/channels/{channelId}/permissions`
- Visible only to users with `ManageChannels`.

**Mobile**
- No channel permissions editor.
- Enforce effective permissions via `channel.permissions` for:
  - Message send, attachments, reactions, voice connect, screen share.

## Migration / Rollout

1. Add new permissions bits to enum (server + shared).
2. Add `ChannelPermissionOverride` model + EF migration.
3. Implement PermissionService changes + channel permission evaluation.
4. Update REST + SignalR enforcement.
5. Update shared types + store + listeners.
6. Implement web editor UI.
7. Update web/mobile UI gating.
8. Verify with manual tests.

## Test Cases / Scenarios

**Text**
1. Role A denied `ViewChannel`: channel is not returned by `/channels`, cannot join, cannot read messages, no unread events.
2. Role A allowed `ViewChannel` but denied `ReadMessageHistory`: can join and receive new messages but cannot load history or pins.
3. Role A allowed `SendMessages` but denied `AttachFiles`: can send plain text, attachment send is rejected.
4. Role A denied `AddReactions`: reaction toggle is rejected.

**Voice**
5. Role A denied `Connect`: cannot join voice.
6. Role A allowed `Connect` but denied `Speak`: joins voice but server-muted; unmute attempts fail.
7. Role A denied `Stream`: screen share start is rejected.

**Mentions**
8. User without `MentionEveryone` tries `@everyone`/`@here`: server rejects or strips; no mass notifications.

**Permissions updates**
9. Admin updates channel overrides: users who lose `ViewChannel` are removed from list; active channel closes; no more events for that channel.

## Assumptions / Defaults

- Only role-based overrides; no per-user overrides.
- Expanded permission set as listed above.
- DM channels are unaffected (full access for participants).
- Server‑level admin perms (`ManageChannels`, `ManageMessages`, etc.) remain server-wide.
- Web-only UI for editing channel permissions; mobile enforces but doesn’t edit.
- Channel events trigger client-side `fetchChannels` to refresh visibility and effective perms.
