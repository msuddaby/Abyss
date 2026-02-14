# Mobile App Feature Parity Plan

## Context

The Abyss mobile app (`packages/app` - React Native + Expo) has been neglected while new features were added to the web client. The mobile app already has solid foundations (auth, messaging, voice/WebRTC, server management, search, reactions, pinning, DMs, push notifications), but is missing several features that the web client has gained. Critically, most of the backend integration is already done — the shared `@abyss/shared` package exports all needed Zustand stores (`useFriendStore`, `useWatchPartyStore`, `useSoundboardStore`, `useNotificationSettingsStore`, `useVoiceChatStore`, `useSignalRStore`, etc.) and the shared `useSignalRListeners` already wires up all SignalR events. **The gap is entirely at the UI component layer.**

---

## Phase 1: Quick Wins (Small, High Impact)

### 1.1 Connection Status Banner
- New `ConnectionStatusBanner.tsx` component using `useSignalRStore.status`
- Render at top of `(main)/index.tsx` when status !== `'connected'`
- Yellow for reconnecting, red for disconnected

### 1.2 Image Preview Modal
- New `ImagePreviewModal.tsx` — full-screen dark overlay with pinch-to-zoom/pan
- Triggered from `MessageItem.tsx` on image attachment tap
- Add `'imagePreview'` to `ModalType` in `uiStore.ts`

### 1.3 Notification Settings
- New `ServerNotificationModal.tsx` and `ChannelNotificationModal.tsx`
- Radio buttons for notification level (All / Mentions Only / Nothing), mute toggle, suppress @everyone
- Uses `useNotificationSettingsStore` (already has `fetchSettings`, `updateServerSettings`, `updateChannelSettings`)
- Triggered via long-press on server icon and channel items

### 1.4 Per-user Volume Control
- Long-press on a voice participant in `VoiceView.tsx` opens a bottom sheet with a volume slider (0-200%)
- Uses `useVoiceStore.userVolumes` / `setUserVolume()`
- Note: React Native WebRTC has limited per-peer volume control — may need to fall back to mute/unmute per user if `GainNode` equivalent isn't available

---

## Phase 2: Social Features (Medium, High Impact)

### 2.1 Friends System
- New `FriendsList.tsx` component with sections: search bar, incoming requests, outgoing requests, friends list
- Each friend shows avatar, name, online status, with Message/Remove actions
- Integrate into `ChannelSidebar.tsx` when in DM mode (add "Friends" tab/button)
- Add send/accept/remove friend buttons to `UserProfileCard.tsx`
- Uses `useFriendStore` (all methods ready), `usePresenceStore` for online status
- Call `fetchFriends()` and `fetchRequests()` on app init

### 2.2 Voice Persistent Chat
- New `VoiceChatPanel.tsx` — bottom sheet or half-screen overlay
- "Chat" toggle button added to `VoiceView.tsx` action bar
- Reuse `MessageList.tsx` and `MessageInput.tsx` with voice chat channel context
- Unread badge on the toggle button via `useVoiceChatStore.unreadCount`
- Ensure `voiceChatStore.setChannel()` is called on voice join in mobile `useWebRTC.ts`

### 2.3 Soundboard
- New `SoundboardPanel.tsx` — bottom sheet with grid of clip buttons
- Tap plays clip via `conn.invoke('PlaySoundboardClip', channelId, clipId)`
- Upload via `expo-document-picker` for audio files
- Long-press clips for rename/delete (permission-gated)
- Triggered from soundboard icon in `VoiceView.tsx` action bar
- **Mobile audio adapter needed**: shared `playVoiceSound()` uses web `Audio` API — need `expo-av` replacement for clip playback on receiving end

---

## Phase 3: Visual Polish & Media (Medium-Large, Medium Impact)

### 3.1 Cosmetics Display
- Modify `MessageItem.tsx` to apply message styles from `getMessageStyle()`
- Modify `Avatar.tsx` / name display to apply nameplate styles from `getNameplateStyle()`
- Show avatar decorations as overlay images in `Avatar.tsx`
- Need a `cssToRNStyle()` adapter — some CSS properties (border, background color, borderRadius) map directly; others (boxShadow, backgroundImage, animations) need graceful fallbacks
- Show equipped cosmetics in `UserProfileCard.tsx`

### 3.2 Join/Leave Sounds
- Create mobile `playVoiceSound()` using `expo-av` (`Audio.Sound.createAsync`)
- The shared `useSignalRListeners` already triggers sound playback on `VoiceUserJoinedChannel`/`VoiceUserLeftChannel` — needs mobile-compatible audio function injected
- Bundle default join/leave sounds as app assets

### 3.3 Watch Party (Viewer Mode)
- New `WatchPartyViewer.tsx` — renders when `useWatchPartyStore.activeParty` exists and user is in voice
- HLS playback via `expo-av` Video component (for Plex), `react-native-youtube-iframe` for YouTube
- Sync to `activeParty.currentTimeMs` / `isPlaying` from shared store
- Show title, progress bar, queue list
- Host controls deferred to later phase

---

## Phase 4: Advanced Voice & Video (Large, Medium-High Impact)

### 4.1 Camera/Video Support
- Add `startCamera()` / `stopCamera()` to mobile `useWebRTC.ts`
- New `VideoTile.tsx` using `RTCView` from `react-native-webrtc`
- Modify `VoiceView.tsx` to show video tiles for users with active cameras
- Camera toggle button in action bar, front/back camera switch
- Uses `useVoiceStore.activeCameras`, `setCameraOn()`

### 4.2 Advanced Voice Settings
- Add "Voice & Audio" section to `UserSettingsModal.tsx`
- Noise suppression, echo cancellation, auto gain toggles
- Input sensitivity slider
- Audio level meter using `localInputLevel` from voice store
- Settings already persist via shared store

### 4.3 Channel Reordering
- Use `react-native-draggable-flatlist` in `ChannelSidebar.tsx`
- "Edit mode" toggle for users with `ManageChannels` permission
- Calls reorder API on drop

---

## Phase 5: Lower Priority / Deferred

### 5.1 Media Provider Management
- Add "Media Providers" section to `ServerSettingsModal.tsx`
- Link/unlink provider forms, connection list
- Uses `useMediaProviderStore`

### 5.2 Watch Party Host Controls
- Media library browser, queue management, play/pause/seek controls
- Builds on Phase 3.3 viewer

### 5.3 Admin Panel (Simplified)
- Read-only overview: stats, server list, user search
- Skip cosmetics CRUD and invite management on mobile — defer to web

### 5.4 Screen Sharing from Mobile — **Defer indefinitely**
- Technically possible but complex, battery-intensive, rarely needed
- Viewing screen shares already works

---

## Key Technical Considerations

1. **Mobile audio adapter** — `playVoiceSound()` in shared code uses web `Audio()`. Need to provide an `expo-av` based adapter for soundboard, join/leave sounds, and notification sounds. Inject it before SignalR listeners initialize.

2. **CSS-to-RN style conversion** — Cosmetics use CSS properties. Direct mappings: `border`, `backgroundColor`, `borderRadius`, `color`, `fontWeight`. No RN equivalent: `backgroundImage`, `boxShadow` (use `elevation`/`shadow*`), `animation`, `textShadow`. Build a small converter with graceful fallbacks.

3. **Long-press → bottom sheet pattern** — Replace web right-click context menus with long-press triggering bottom sheets for per-user volume, channel actions, message actions.

4. **Watch party video** — Plex transcodes to HLS (`expo-av` handles this). YouTube needs `react-native-youtube-iframe`. Different player APIs need an adapter.

---

## Critical Files

| File | Role |
|------|------|
| `packages/app/app/(main)/_layout.tsx` | Main layout, modal registration, SignalR init |
| `packages/app/app/(main)/index.tsx` | Home screen — render connection banner here |
| `packages/app/src/stores/uiStore.ts` | ModalType union — add new modal types here |
| `packages/app/src/components/VoiceView.tsx` | Voice UI — entry point for chat, soundboard, camera, volume |
| `packages/app/src/components/MessageItem.tsx` | Message rendering — cosmetics, image tap |
| `packages/app/src/components/ChannelSidebar.tsx` | Channel list — friends tab, notification settings, reordering |
| `packages/app/src/components/ServerSidebar.tsx` | Server list — notification settings long-press |
| `packages/app/src/components/UserProfileCard.tsx` | User profile — friend actions, cosmetics display |
| `packages/app/src/hooks/useWebRTC.ts` | WebRTC — camera, volume, voice chat integration |
| `packages/shared/src/hooks/useSignalRListeners.ts` | All SignalR handlers — reference for what's already wired |
