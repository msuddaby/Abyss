# Message Pins Plan (Discord-Style)

## Summary
Add a pin system for messages in server text channels and DMs. Server channels require `Manage Messages` to pin/unpin; DMs allow both participants. Pin/unpin creates a system message. Pinned lists are synced via SignalR and exposed via a channel pins endpoint.

Defaults/assumptions:
- Max 50 pinned messages per channel.

## Progress
- Step 1 (Model + migration): completed (2026-02-08)
- Step 2 (DTOs): completed (2026-02-08)
- Step 3 (Pins API): completed (2026-02-08)
- Step 4 (SignalR hub methods): completed (2026-02-08)
- Step 5 (Delete behavior): completed (2026-02-08)
- Step 6 (Audit log labels/icons): completed (2026-02-08)
- Step 7 (Shared types + store updates): completed (2026-02-08)
- Step 8 (Web UI): completed (2026-02-08)

## Public API / Interface Changes
- REST
  - `GET /channels/{channelId}/pins` → `PinnedMessageDto[]` (ordered by `PinnedAt` desc)
- SignalR hub methods
  - `PinMessage(messageId)`
  - `UnpinMessage(messageId)`
- SignalR events
  - `MessagePinned(pinned: PinnedMessageDto)`
  - `MessageUnpinned(channelId: string, messageId: string)`
- DTO / shared types
  - `PinnedMessageDto(MessageDto Message, DateTime PinnedAt, UserDto PinnedBy)`
  - Shared `PinnedMessage` type with same shape
- Audit log
  - `AuditAction.MessagePinned`
  - `AuditAction.MessageUnpinned`

## Backend Plan (ASP.NET / EF Core)
1. Model + migration
   - Add `PinnedMessage` model:
     - `ChannelId`, `MessageId` (composite PK)
     - `PinnedById`, `PinnedAt`
     - Navigation to `Channel`, `Message`, `PinnedBy`
   - `DbSet<PinnedMessage>` in `AppDbContext`
   - Model config:
     - `HasKey(pm => new { pm.ChannelId, pm.MessageId })`
     - FK `PinnedById` → `AppUser`
     - Index `(ChannelId, PinnedAt)`
   - Migration to create `PinnedMessages` table

2. DTOs
   - Add `PinnedMessageDto` in `server/Abyss.Api/DTOs/ServerDtos.cs`

3. Pins API
   - `ChannelsController.GetPins(channelId)`:
     - Validate access same as `GetMessages`
     - Query pinned messages + full message includes (author, attachments, reactions, reply)
     - Order by `PinnedAt` desc

4. SignalR hub methods
   - `PinMessage(messageId)`:
     - Validate message exists, not system, not deleted
     - Check access to channel (DM participant or server member)
     - Server channel requires `ManageMessages`
     - Enforce max pins (50)
     - Idempotent if already pinned
     - Create pin row
     - Audit log (server only)
     - Emit `MessagePinned` to `channel:{channelId}` with full `PinnedMessageDto`
     - Emit system message “pinned a message to this channel”
   - `UnpinMessage(messageId)`:
     - Validate message exists and is pinned
     - Same access checks
     - Remove pin row
     - Audit log (server only)
     - Emit `MessageUnpinned(channelId, messageId)`
     - Emit system message “unpinned a message from this channel”

5. Delete behavior
   - On `DeleteMessage`, if message is pinned:
     - Remove pin and emit `MessageUnpinned` (no system message)

6. Audit log labels/icons
   - Add labels and icons for `MessagePinned` / `MessageUnpinned`

## Shared Package Plan (`packages/shared`)
1. Types
   - Add `PinnedMessage` interface in `types/index.ts`

2. Message store
   - Add state:
     - `pinnedByChannel: Record<string, PinnedMessage[]>`
     - `pinnedLoading: boolean`
   - Add actions:
     - `fetchPinnedMessages(channelId)`
     - `pinMessage(messageId)`
     - `unpinMessage(messageId)`
     - `addPinnedMessage(pinned)`
     - `removePinnedMessage(channelId, messageId)`
     - `isPinned(channelId, messageId)`
   - Keep pinned copies updated in:
     - `updateMessage`
     - `markDeleted`
     - `addReaction` / `removeReaction`

3. SignalR handlers
   - In `MessageList` (web + mobile):
     - `MessagePinned` → `addPinnedMessage`
     - `MessageUnpinned` → `removePinnedMessage`

4. Channel switch
   - In `fetchMessages(channelId)`, also `fetchPinnedMessages(channelId)`

## Web UI Plan (`client/`)
1. Header button
   - Add pushpin button in `.channel-header` for DMs and text channels

2. Pinned messages modal
   - New `PinnedMessagesModal` component
   - Lists pinned messages with author/avatar/time/excerpt
   - “Jump” button uses `/channels/{id}/messages/around/{messageId}` to load/scroll/highlight
   - “Unpin” button shown when user can unpin

3. Message context menu
   - Add “Pin/Unpin” option
   - DM: always available
   - Server: requires `ManageMessages`

4. Styles
   - Add CSS for pin button + modal list cards

## Mobile UI Plan (`packages/app`)
1. Header button
   - Add pushpin button in channel header (DMs + text channels)

2. Pinned messages modal
   - New modal via `useUiStore` (`ModalType` add `pins`)
   - List pinned messages, tap to jump (close modal, set channel, fetch messages around, highlight)

3. Long-press menu
   - Add “Pin/Unpin” to `Alert` options using same permission logic

## Edge Cases / Behavior
- Idempotent pin/unpin
- Pinned list excludes deleted/system messages
- Pinned list auto-updates on edits/deletes/reactions
- DM pins visible to both participants

## Tests / Verification
- Server
  - Pin/unpin with valid permissions
  - Reject non-member or no-permission
  - DM participants can pin/unpin
  - Enforce max pins
  - Delete pinned message removes pin and emits unpin
- Web
  - Pin/unpin from context menu
  - Pins modal list and jump behavior
  - System message on pin/unpin
- Mobile
  - Long-press pin/unpin
  - Pins modal list and jump
- Audit log
  - `MessagePinned` / `MessageUnpinned` entries appear
