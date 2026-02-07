# Expo Universal Migration Plan

Migrate the Abyss mobile experience to an Expo app targeting **iOS + Android**. The existing React/Vite web client remains the canonical web app — Expo targets native mobile only.

**Current client:** ~5,665 lines TypeScript/TSX, 2,763 lines CSS, 18 components, 8 stores, 1 hook, 2 services.

---

## Architecture: Monorepo with Shared Core

```
abyss/
  packages/
    shared/              # Stores, types, services (portable logic)
      src/
        types/index.ts
        stores/          # All 8 Zustand stores (adapted)
        services/
          api.ts         # Axios HTTP client
          signalr.ts     # SignalR connection
        utils/           # Mention parsing, message grouping, etc.
      package.json

    app/                 # Expo mobile app (iOS + Android only)
      app/               # Expo Router file-based routing
        (auth)/
          login.tsx
          register.tsx
        (main)/
          _layout.tsx    # Responsive layout shell
          index.tsx      # Server view
      src/
        components/      # All UI components (RN primitives)
        hooks/
          useWebRTC.ts   # react-native-webrtc version
        theme/           # Design tokens + StyleSheet factories
      app.json
      package.json

  client/                # React/Vite web client (uses @abyss/shared, canonical web app)
  server/                # Unchanged backend
  package.json           # Monorepo root (npm workspaces)
```

**Why monorepo:** Stores, types, and services are UI-agnostic. Both the React web client and Expo mobile app import from `@abyss/shared`. New business logic goes in shared, UI is implemented separately per platform.

---

## Phases

### Phase 0: Monorepo Setup & Shared Package Extraction
> Estimated: 1-2 days | Risk: Low

- [x] Initialize monorepo (npm workspaces or Turborepo) at repo root
- [x] Create `packages/shared/` with its own `package.json` and `tsconfig.json`
- [x] Move `client/src/types/index.ts` -> `packages/shared/src/types/index.ts`
- [x] Move all 8 stores -> `packages/shared/src/stores/`
  - Replace `localStorage` with a storage adapter interface:
    ```ts
    // packages/shared/src/storage.ts
    export interface StorageAdapter {
      getItem(key: string): Promise<string | null>;
      setItem(key: string, value: string): Promise<void>;
      removeItem(key: string): Promise<void>;
    }

    let storage: StorageAdapter;
    export const setStorage = (s: StorageAdapter) => { storage = s; };
    export const getStorage = () => storage;
    ```
  - Web impl: wraps `localStorage` (sync->async shim)
  - Expo impl: wraps `@react-native-async-storage/async-storage`
- [x] Move `client/src/services/api.ts` -> `packages/shared/src/services/api.ts`
  - Axios works in both web and RN, no changes needed
  - Make base URL configurable (injected at init, not from `import.meta.env`)
- [x] Move `client/src/services/signalr.ts` -> `packages/shared/src/services/signalr.ts`
  - `@microsoft/signalr` works in RN over WebSocket transport
  - Make hub URL configurable
- [x] Extract utility functions from components into `packages/shared/src/utils/`:
  - Mention parsing regex (from MessageItem.tsx)
  - Message grouping logic (from MessageList.tsx)
  - Permission helpers (bitfield checks)
  - Date formatting helpers
- [x] Update `client/` imports to use `@abyss/shared` package
- [x] Verify existing web client still works with shared imports

**Checkpoint:** Web client works identically, but logic lives in shared package.

---

### Phase 1: Expo Project Scaffolding
> Estimated: 1-2 days | Risk: Low

- [x] Install Expo CLI: `npx create-expo-app packages/app --template tabs`
- [x] Configure Expo Router for file-based routing
- [x] Set up path aliases for `@abyss/shared` in `tsconfig.json` and `metro.config.js`
- [x] Install core dependencies:
  ```
  npx expo install expo-router expo-linking expo-constants
  npx expo install @react-native-async-storage/async-storage
  npx expo install expo-secure-store        # JWT token storage
  npx expo install expo-clipboard            # Copy invite codes
  npx expo install expo-image-picker         # Avatar/emoji uploads
  npx expo install expo-file-system          # File handling
  npx expo install expo-notifications        # Push notifications
  npx expo install expo-av                   # Audio playback
  ```
- [x] Create theme system:
  ```ts
  // packages/app/src/theme/tokens.ts
  export const colors = {
    bgPrimary: '#36393f',
    bgSecondary: '#2f3136',
    bgTertiary: '#202225',
    textPrimary: '#dcddde',
    textSecondary: '#b9bbbe',
    textMuted: '#72767d',
    accent: '#5865f2',
    danger: '#ed4245',
    success: '#3ba55c',
    border: '#42454a',
  };

  export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
  export const fontSize = { sm: 12, md: 14, lg: 16, xl: 20, xxl: 24 };
  ```
- [x] Create base reusable primitives:
  - `Button` (text button, icon button, variants: primary/secondary/danger)
  - `Avatar` (image with fallback initials, online status dot)
  - `Modal` (React Native Modal wrapper with overlay)
  - `TextInput` (styled input with label)
- [x] Initialize storage adapter with AsyncStorage on app start
- [x] Initialize API + SignalR services with config from `app.json` extras or env
- [x] Wire up Expo Router auth guard (redirect to login if no token)
- [x] Verify: app boots, shows login screen on iOS simulator + web

**Checkpoint:** Empty Expo app with routing, theme, and shared services connected.

---

### Phase 2: Auth Screens
> Estimated: 1-2 days | Risk: Low

- [x] `app/(auth)/login.tsx` — email + password form, calls `authStore.login()`
- [x] `app/(auth)/register.tsx` — registration form, calls `authStore.register()`
- [x] Token persistence: `expo-secure-store` for JWT (more secure than AsyncStorage)
- [x] Auto-login on app start if token exists
- [x] Handle 401 responses (clear token, redirect to login)

**Component mapping:**
| Web (LoginPage.tsx, 44 lines) | Expo |
|---|---|
| `<form>` | `<View>` with `onSubmit` handler |
| `<input type="email">` | `<TextInput keyboardType="email-address">` |
| `<input type="password">` | `<TextInput secureTextEntry>` |
| `<button type="submit">` | `<Pressable>` / custom `<Button>` |
| CSS `.auth-container` | `StyleSheet` with flexbox centering |

**Checkpoint:** Can log in and register on all 3 platforms.

---

### Phase 3: Main Layout Shell
> Estimated: 3-5 days | Risk: Medium

Build the 3-column Discord layout that adapts to mobile.

- [x] **Layout strategy:**
  - Desktop (>=768px): All 4 columns side-by-side (server sidebar 72px | channel sidebar 240px | content flex:1 | member list 240px)
  - Mobile (<768px): State-based panel switching with bottom nav bar (Channels / Chat / Members)
  - Pure responsive via `useWindowDimensions()` — no drawer library needed
- [x] `app/(main)/_layout.tsx` — responsive layout shell with:
  - `useLayout()` breakpoint hook (768px threshold)
  - `useSignalRListeners()` from shared package
  - Desktop: `flexDirection: 'row'` with `<Slot />` for content
  - Mobile: `uiStore.activePanel` state switching + bottom nav bar
  - `SafeAreaView` wrapping
- [x] **`useSignalRListeners` hook** extracted to `packages/shared/src/hooks/`:
  - `fetchServerState()` — voice users, sharers, online users, unreads
  - All `.on()` handlers (presence, voice, roles, emojis, channels, DMs, unreads, mentions)
  - Server-switch effect, typing channel tracking, auto-mark-read effects
  - Web client `MainLayout.tsx` refactored to use shared hook
- [x] **ServerSidebar component:**
  - Vertical icon strip with DM button, separator, server icons (`Avatar`), create/join buttons
  - Unread dots + mention badges via `Badge` component
  - On mobile, auto-switches to channels panel on tap
- [x] **ChannelSidebar component** (server mode + DM mode):
  - Server header (name + settings gear), action buttons (Invite, + Channel)
  - Text channel list with `ChannelItem` (# icon, unread dot, mention badge)
  - Voice channel list with `VoiceChannelItem` (participants, speaking indicators, LIVE badges)
  - DM mode: DM list with avatars, online dots, unreads
  - `VoiceControls` + `UserBar` at bottom
  - Channel switching joins SignalR channel group + fetches messages
  - On mobile, auto-switches to content panel on channel tap
  - Modals deferred to Phase 5 (show `Alert.alert('Coming Soon')`)
- [x] **Content area placeholder** (`ContentPlaceholder`):
  - No channel: "Welcome to Abyss" / "Select a channel"
  - Channel selected: header bar (# or speaker icon or @ DM name) + "Messages coming in Phase 4"
- [x] **MemberList component:**
  - `SectionList` with Online/Offline sections + counts
  - `MemberItem`: avatar (with online dot), display name (role color), owner/role badge
  - Context menus deferred to Phase 5
- [x] **Supporting components:**
  - `Badge` — unread dot + mention count pill
  - `useLayout` — responsive breakpoint hook
  - `uiStore` — mobile panel switching state
- [x] Remember last active server/channel (via shared `serverStore` using `StorageAdapter`)

**Checkpoint:** Can see servers, switch channels, see members. No messages yet.

---

### Phase 4: Text Messaging ✓
> Estimated: 5-7 days | Risk: Medium-High (MessageInput is complex)

- [x] **MessageList component** (`packages/app/src/components/MessageList.tsx`):
  - Normal `FlatList` (not inverted — inverted has performance issues) with `scrollToEnd()`
  - SignalR listeners: ReceiveMessage, MessageEdited, MessageDeleted, ReactionAdded, ReactionRemoved
  - Auto-scroll to bottom on channel switch and new messages (only when near bottom, <150px threshold)
  - Scroll-up pagination: loads more when `contentOffset.y < 100` with scroll position preservation
  - Message grouping via shared `shouldGroupMessage()` util
  - Scroll-to-message for reply navigation with highlight animation (1.5s)
  - Loading spinner (ActivityIndicator) and empty state

- [x] **MessageItem component** (`packages/app/src/components/MessageItem.tsx`):
  - Column layout: reply reference on top, avatar+body row below
  - Author avatar + name (role color via `getDisplayColor`) + timestamp + (edited) label in header
  - Grouped messages: empty spacer column (no gutter time), timestamps only in header
  - Content rendering via shared `parseMentions()` → `<Text>` segments for mentions, `<Image>` for custom emojis
  - Mention highlight background (yellow tint + left border) when message contains current user mention
  - Image attachments with `resizeMode="contain"`, file name text for non-images
  - Reactions bar: horizontal `ScrollView` of chips, custom emoji support, active state, toggle on press
  - Long-press action sheet (`Alert.alert`): Reply, Add Reaction, Copy Text, Edit (own), Delete (own or ManageMessages), Kick/Ban (with `canActOn` hierarchy check)
  - Inline edit mode with `TextInput` + Save/Cancel buttons
  - Reply reference: mini avatar + author name + truncated content (pressable to scroll)
  - Deleted state: avatar + author + "This message has been deleted" italic text

- [x] **MessageInput component** (`packages/app/src/components/MessageInput.tsx`):
  - Plain `TextInput multiline` (replaces web `contentEditable` — major simplification)
  - Mention autocomplete: `@` trigger detection via `onSelectionChange` cursor tracking, overlay list of members + @everyone/@here, tap to insert raw `<@userId>` format
  - Custom emoji autocomplete: `:` trigger, tap to insert `<:name:id>` format
  - `rn-emoji-keyboard` modal picker with dark theme (replaces web `emoji-mart`)
  - `expo-image-picker` for image attachments with horizontal preview strip + remove buttons
  - Reply bar: "Replying to {name}" with close button
  - Typing indicator: `UserTyping` SignalR call on text change
  - Send button (disabled when empty and no files)

- [x] **TypingIndicator** (`packages/app/src/components/TypingIndicator.tsx`):
  - Reads `typingUsers` from presenceStore, formats "X is typing..." / "X and Y are typing..." / "X and N others are typing..."
  - Fixed 24px height to prevent layout shift

- [x] **index.tsx** (`packages/app/app/(main)/index.tsx`):
  - `KeyboardAvoidingView` wrapping on iOS (offset 90px)
  - Channel header: # (text) / speaker emoji (voice) / @ (DM) + name
  - Text channels / DMs: header + MessageList + TypingIndicator + MessageInput
  - Voice channels: header + "Voice view coming in Phase 6" placeholder
  - No channel: "Welcome to Abyss" / "Select a channel"

- [x] **Dependencies:** `rn-emoji-keyboard@^1.7.0`, `expo-image-picker@~17.0.10`

**Checkpoint:** Full text chat working — send/receive messages, mentions, reactions, attachments.

---

### Phase 5: Modals & Settings ✅
> Completed

All modals ported from CSS overlays to React Native `<Modal>` component.

- [x] **Modal base component** — reusable wrapper with dark overlay, centered card, title, scroll
- [x] **CreateServerModal** — server name form, creates + switches to new server
- [x] **JoinServerModal** — invite code input
- [x] **CreateChannelModal** — channel type picker (Text/Voice) + name
- [x] **InviteModal** — generate code + copy button (`expo-clipboard`)
- [x] **UserSettingsModal** — avatar upload (expo-image-picker), display name, bio, status, voice mode toggle, PTT key section web-only
- [x] **UserProfileCard** — modal with avatar, name, bio, role pills, owner badge
- [x] **ServerSettingsModal** — tabbed modal (Members, Roles, Emojis, Bans, Audit Log, Danger Zone), all permission-gated, role editor with permissions checkboxes, role assignment sub-modal, emoji upload, ban/unban, audit log list, delete server confirmation
- [x] **uiStore** — `activeModal`/`modalProps`/`openModal`/`closeModal` state
- [x] **Wiring** — all `Alert.alert('Coming Soon')` replaced with `openModal()` in ServerSidebar, ChannelSidebar, UserBar, MemberList/MemberItem

**Checkpoint:** All settings and admin features working.

---

### Phase 6: Voice Chat (WebRTC) ✅
> Completed

- [x] Installed `react-native-webrtc` + `@config-plugins/react-native-webrtc`
- [x] Updated `app.json`: iOS microphone permission + background audio, Android RECORD_AUDIO + MODIFY_AUDIO_SETTINGS, ICE server extras
- [x] Created `packages/app/src/hooks/useWebRTC.ts` (~250 lines): ported from web client using `react-native-webrtc` APIs
  - Module-level singleton pattern (same as web)
  - `mediaDevices.getUserMedia()` from `react-native-webrtc`
  - RN-webrtc auto-plays remote audio (no HTMLAudioElement needed)
  - Deafen via `receiver.track.enabled` on peer receivers
  - PTT keyboard/mouse listeners wrapped in `Platform.OS === 'web'` guard
  - Screen share SignalR events update store only (Phase 7)
  - Omitted: VAD (no Web Audio API in RN), screen sharing (Phase 7)
- [x] Created `packages/app/src/components/VoiceView.tsx` (~160 lines): participant grid, PTT button, mute/deafen/disconnect action bar
- [x] Wired into ChannelSidebar (joinVoice/leaveVoice), VoiceControls (disconnect), index.tsx (VoiceView replaces placeholder)

**Known limitations:**
- No voice activity detection / speaking indicators on mobile (Web Audio API not available in RN)
- No screen sharing (Phase 7)
- Expo Go no longer works (must use dev builds with `npx expo run:ios` / `npx expo run:android`)
- Audio may route to earpiece on iOS — may need `react-native-incall-manager` (follow-up)

---

### Phase 7: Mobile-Only Cleanup ✅
> Completed

The Expo app now targets **iOS + Android only**. All web-specific code stripped.

- [x] **Removed Expo web target:**
  - Removed `"web"` from `app.json` → `expo.platforms` (now `["ios", "android"]`)
  - Removed `react-dom`, `react-native-web` from `packages/app/package.json`
  - Removed `"web"` config block from `app.json` (bundler/favicon)
  - Removed `"web"` script from package.json
- [x] **Stripped all `Platform.OS === 'web'` branches:**
  - `MessageInput.tsx` — removed web blob conversion, kept native `{uri, name, type}` only
  - `UserSettingsModal.tsx` — removed web file upload path + PTT web-only note
  - `ServerSettingsModal.tsx` — removed web file upload path
  - `useWebRTC.ts` — removed entire PTT keyboard/mouse web listener useEffect, removed all `Platform.OS !== 'web'` guards around InCallManager calls
  - `VoiceView.tsx` — speaker toggle always rendered (removed `Platform.OS !== 'web'` guard)
  - Removed unused `Platform` imports from all cleaned components
- [x] **Removed desktop layout path:**
  - Deleted `useLayout.ts` hook entirely (breakpoint logic no longer needed)
  - `(main)/_layout.tsx` — removed desktop 4-column layout branch, kept only mobile panel-switching
  - `ServerSidebar.tsx` — removed `isMobile` conditional, always calls `setPanel()`
  - `ChannelSidebar.tsx` — removed `isMobile` conditional, always calls `setPanel()`
- [x] **Simplified storage adapter:**
  - `packages/app/src/storage.ts` — removed `Platform.OS !== 'web'` check, always uses SecureStore for secure keys

**Checkpoint:** Expo project is clean mobile-only code. Zero `Platform.OS === 'web'` checks, no desktop layout branches, no web dependencies. Simpler, smaller, more maintainable.

---

### Phase 8a: Screen Share Viewing ✅
> Completed

Mobile users can watch screen shares from web (or other) clients. Sharing from mobile deferred to Phase 8b.

- [x] **useWebRTC hook updates** (`packages/app/src/hooks/useWebRTC.ts`):
  - Added `screenVideoStreams: Map<string, MediaStream>` module-level state
  - Video track handling in `ontrack`: caches remote screen video streams, bumps store version
  - Exported `requestWatch(sharerUserId)` — sets watching in store + sends `RequestWatchStream` to backend
  - Exported `stopWatching()` — cleans up stream cache + sends `StopWatchingStream` to backend
  - Exported `getScreenVideoStream(userId)` — returns cached `MediaStream` for RTCView
  - `ScreenShareStopped` handler cleans up `screenVideoStreams` if watching that sharer
  - `closePeer` and `cleanupAll` clean up `screenVideoStreams`
  - `WatchStreamRequested`/`StopWatchingRequested` remain no-ops (mobile can't share yet)

- [x] **ScreenShareView component** (`packages/app/src/components/ScreenShareView.tsx`):
  - Three states: no sharers (returns null), sharer picker cards, watching (fullscreen RTCView)
  - Sharer picker: card per sharer with name + "Watch Stream" button
  - Watching: `RTCView` with `streamURL` from `stream.toURL()`, `objectFit="contain"`, black background
  - Header with sharer name + "Stop Watching" button
  - Switcher bar (horizontal ScrollView chips) when multiple sharers, tap to switch
  - Self-viewing supported (for when mobile sharing is added in Phase 8b)

- [x] **VoiceView integration** (`packages/app/src/components/VoiceView.tsx`):
  - When watching: `ScreenShareView` takes over the content area (above action bar)
  - When not watching but sharers exist: picker cards shown above participant grid in ScrollView

**Checkpoint:** Can watch screen shares from mobile. Backend unchanged. No new dependencies.

---

### Phase 9: Push Notifications
> Estimated: 3-4 days | Risk: Medium

- [ ] Install and configure `expo-notifications`
- [ ] Backend changes:
  - New endpoint: `POST /api/notifications/register-device` (saves push token per user)
  - New model: `DevicePushToken` (UserId, Token, Platform, CreatedAt)
  - Modify `NotificationService` to send push via APNs/FCM when user is offline
  - Options for push delivery:
    a. Direct APNs/FCM from backend (add `FirebaseAdmin` or `dotnet-apns` NuGet)
    b. Use Expo Push Service (simplest — send to `https://exp.host/--/api/v2/push/send`)
  - Recommendation: Expo Push Service — it abstracts APNs/FCM, works with expo-notifications tokens
- [ ] Client:
  - Request notification permission on first launch
  - Register push token with backend on login
  - Handle notification tap → navigate to relevant channel
  - Badge count on app icon (unread mentions)
- [ ] Notification types:
  - Direct message received
  - @mention in a channel
  - @everyone / @here (respect future mute settings)

**Checkpoint:** Receive push notifications when app is backgrounded/closed.

---

### Phase 10: Search & DMs
> Estimated: 2-3 days | Risk: Low

- [ ] **SearchPanel** (198 lines):
  - `<TextInput>` with search icon
  - Filter chips (channel, author, date, has attachment)
  - Results in `<FlatList>` with highlighted matches
  - Tap result → navigate to channel + scroll to message
- [ ] **DM conversations:**
  - DM list in home/sidebar view
  - Reuse MessageList + MessageInput components
  - DM search (find users to message)

**Checkpoint:** Feature parity with web client.

---

### Phase 11: Polish & Mobile UX
> Estimated: 5-7 days | Risk: Medium

#### Custom Context Menus
Replace native `Alert.alert` action sheets with themed context menus:
- [ ] **ContextMenu component** — animated bottom sheet:
  - Slides up from bottom with backdrop overlay
  - Dark themed (bgSecondary background, textPrimary items, danger-colored destructive actions)
  - Separator lines between action groups
  - Smooth open/close animations
- [ ] **MessageItem integration** — replace `Alert.alert` long-press with custom ContextMenu
- [ ] **MemberList context menu** — role management, kick/ban actions via themed bottom sheet

#### Custom Emoji Picker
`rn-emoji-keyboard` doesn't support custom server emojis. Build a custom picker:
- [ ] **EmojiPicker component** — full replacement:
  - Grid of native emojis organized by category
  - Custom server emoji section at the top (fetched from serverStore.emojis)
  - Search bar with filtering
  - Category tabs (custom, smileys, people, nature, food, etc.)
  - Dark themed to match app
  - Bottom sheet presentation
  - Frequently used / recent emojis section
- [ ] **MessageInput integration** — replace `rn-emoji-keyboard` with custom picker
- [ ] **MessageItem reactions** — use custom picker for "Add Reaction" action

#### Other Polish
- [ ] **Keyboard handling:** Dismiss keyboard on scroll / tap outside
- [ ] **Haptic feedback:** `expo-haptics` for button presses, long-press actions
- [ ] **Image viewer:** Fullscreen image viewer for attachments (pinch/zoom/pan)
- [ ] **Pull-to-refresh** on channel/server lists
- [ ] **Swipe gestures:**
  - Swipe message left for quick actions (reply, react)
  - Swipe to reveal server/channel panels
- [ ] **App icon + splash screen** via `app.json` config
- [ ] **Deep linking:** `abyss://invite/CODE` to join servers from links
- [ ] **Offline state:** Show banner when disconnected, auto-reconnect
- [ ] **Accessibility:** Screen reader labels, font scaling

---

## Dependency Mapping (Web → Mobile)

| Web (React client) | Mobile (Expo app) | Notes |
|---|---|---|
| `react-router-dom` | `expo-router` | File-based routing |
| `emoji-mart` / `@emoji-mart/react` | Custom emoji picker (Phase 11) | `rn-emoji-keyboard` used as interim |
| `localStorage` | `AsyncStorage` + `expo-secure-store` | Async API, SecureStore for JWT |
| `contentEditable` | `<TextInput multiline>` | Simpler on mobile |
| `navigator.mediaDevices` | `react-native-webrtc` | Same API, different import |
| `getDisplayMedia()` | N/A (viewing only via RTCView) | Mobile can watch but not broadcast |
| `HTMLVideoElement` | `RTCView` from `react-native-webrtc` | Video display |
| `navigator.clipboard` | `expo-clipboard` | Copy text |
| `CSS (App.css)` | `StyleSheet.create()` | Separate UI per platform |
| `Vite` | Metro bundler | Build tooling |

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| `react-native-webrtc` instability | Voice chat broken on mobile | Pin version, test on real devices early, have web fallback |
| Expo prebuild complexity | Build failures, native debugging | Use EAS Build for CI, test on both platforms weekly |
| MessageInput rewrite scope creep | Delays Phase 4 | Start with plain text only, add mention/emoji autocomplete incrementally |
| Screen sharing on mobile | May not be feasible short-term | Viewing implemented (Phase 8a), broadcasting from mobile not planned |
| SignalR reconnection on mobile networks | Dropped connections, missed messages | Add aggressive reconnect logic + push notification fallback |
| Performance (large message lists) | Scroll jank on low-end devices | Use `FlatList` with `getItemLayout`, memo components, limit re-renders |

---

## Suggested Build Order (MVP)

For the fastest path to a usable mobile app:

**Sprint 1 (Week 1-2):** Phases 0 + 1 + 2 — Monorepo, scaffolding, auth ✓
**Sprint 2 (Week 3-4):** Phase 3 — Layout shell with navigation ✓
**Sprint 3 (Week 5-7):** Phase 4 — Text messaging (core feature) ✓
**Sprint 4 (Week 8):** Phase 5 — Modals and settings ✓
**Sprint 5 (Week 9):** Phase 6 — Voice chat ✓
**Sprint 6 (Done):** Phase 7 — Mobile-only cleanup (strip web code/layout) ✓
**Sprint 7 (Done):** Phase 8a — Screen share viewing ✓
**Sprint 8:** Phase 9 — Push notifications
**Sprint 9:** Phase 10 — Search & DMs
**Sprint 10:** Phase 11 — Polish (context menus, emoji picker, haptics)

**MVP = Sprints 1-8** : Text chat + voice + screen share viewing + push notifications.
**Full feature parity = all sprints**.

---

## Notes

- The React/Vite web client (`client/`) is the canonical web app. It stays as-is and continues to evolve independently.
- The Expo app (`packages/app/`) targets iOS + Android only. No Expo web.
- Both share business logic via `@abyss/shared`. New features: implement shared logic once, build UI separately per platform.
- Test on real iOS and Android devices early (especially WebRTC). Simulators are unreliable for audio/video.
- Expo Go won't work once you add `react-native-webrtc`. Use Expo Development Builds instead.
