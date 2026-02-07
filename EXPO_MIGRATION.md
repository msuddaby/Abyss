# Expo Universal Migration Plan

Migrate the Abyss React web client to an Expo universal app targeting **iOS + Android + Web** from a single codebase.

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

    app/                 # Expo universal app (replaces client/)
      app/               # Expo Router file-based routing
        (auth)/
          login.tsx
          register.tsx
        (main)/
          _layout.tsx    # Main 3-column layout
          index.tsx      # Server view
      src/
        components/      # All UI components (RN primitives)
        hooks/
          useWebRTC.ts   # react-native-webrtc version
        theme/           # Design tokens + StyleSheet factories
      app.json
      package.json

    web/                 # OPTIONAL: Keep current client as-is during transition
      ...current client/

  server/                # Unchanged backend
  package.json           # Monorepo root (npm workspaces or turborepo)
```

**Why monorepo:** Stores, types, and services are already UI-agnostic. Extract them once, import from both web (legacy) and Expo (new). This lets you migrate incrementally without breaking the existing web app.

---

## Phases

### Phase 0: Monorepo Setup & Shared Package Extraction
> Estimated: 1-2 days | Risk: Low

- [ ] Initialize monorepo (npm workspaces or Turborepo) at repo root
- [ ] Create `packages/shared/` with its own `package.json` and `tsconfig.json`
- [ ] Move `client/src/types/index.ts` -> `packages/shared/src/types/index.ts`
- [ ] Move all 8 stores -> `packages/shared/src/stores/`
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
- [ ] Move `client/src/services/api.ts` -> `packages/shared/src/services/api.ts`
  - Axios works in both web and RN, no changes needed
  - Make base URL configurable (injected at init, not from `import.meta.env`)
- [ ] Move `client/src/services/signalr.ts` -> `packages/shared/src/services/signalr.ts`
  - `@microsoft/signalr` works in RN over WebSocket transport
  - Make hub URL configurable
- [ ] Extract utility functions from components into `packages/shared/src/utils/`:
  - Mention parsing regex (from MessageItem.tsx)
  - Message grouping logic (from MessageList.tsx)
  - Permission helpers (bitfield checks)
  - Date formatting helpers
- [ ] Update `client/` imports to use `@abyss/shared` package
- [ ] Verify existing web client still works with shared imports

**Checkpoint:** Web client works identically, but logic lives in shared package.

---

### Phase 1: Expo Project Scaffolding
> Estimated: 1-2 days | Risk: Low

- [ ] Install Expo CLI: `npx create-expo-app packages/app --template tabs`
- [ ] Configure Expo Router for file-based routing
- [ ] Set up path aliases for `@abyss/shared` in `tsconfig.json` and `metro.config.js`
- [ ] Install core dependencies:
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
- [ ] Create theme system:
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
- [ ] Create base reusable primitives:
  - `Button` (text button, icon button, variants: primary/secondary/danger)
  - `Avatar` (image with fallback initials, online status dot)
  - `Modal` (React Native Modal wrapper with overlay)
  - `TextInput` (styled input with label)
- [ ] Initialize storage adapter with AsyncStorage on app start
- [ ] Initialize API + SignalR services with config from `app.json` extras or env
- [ ] Wire up Expo Router auth guard (redirect to login if no token)
- [ ] Verify: app boots, shows login screen on iOS simulator + web

**Checkpoint:** Empty Expo app with routing, theme, and shared services connected.

---

### Phase 2: Auth Screens
> Estimated: 1-2 days | Risk: Low

- [ ] `app/(auth)/login.tsx` — email + password form, calls `authStore.login()`
- [ ] `app/(auth)/register.tsx` — registration form, calls `authStore.register()`
- [ ] Token persistence: `expo-secure-store` for JWT (more secure than AsyncStorage)
- [ ] Auto-login on app start if token exists
- [ ] Handle 401 responses (clear token, redirect to login)

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

- [ ] **Layout strategy:**
  - Web/tablet: 3 columns side-by-side (same as current)
  - Mobile: drawer navigation. Server sidebar = left drawer, member list = right drawer, channel sidebar = screen, content = screen
- [ ] `app/(main)/_layout.tsx` — top-level layout with:
  - `useWindowDimensions()` for responsive breakpoints
  - Drawer navigation for mobile (`@react-navigation/drawer`)
  - Static columns for web/tablet
- [ ] **ServerSidebar component** (97 lines web):
  - Vertical icon strip with `<FlatList>`
  - Server icon = `<Pressable>` with `<Avatar>` or initial
  - Unread dot + mention badge overlays
  - Home (DM) button, create/join server buttons
- [ ] **ChannelSidebar component** (344 lines web):
  - Server name header
  - Channel list with `<FlatList>` sections (text/voice categories)
  - Channel item = `<Pressable>` with `<Text>` + unread/mention indicators
  - Voice channel participants inline (speaking ring, LIVE badge)
  - User bar at bottom (avatar, name, mute/deafen buttons)
- [ ] **Content area placeholder** — "Select a channel" empty state
- [ ] **MemberList component** (192 lines web):
  - `<SectionList>` with Online/Offline sections
  - Member item = `<Pressable>` with avatar, name, role color
- [ ] **SignalR listener registration** (from MainLayout.tsx, 337 lines):
  - Move all `.on()` handlers into a `useSignalRListeners()` hook in shared package
  - Call from `_layout.tsx` useEffect
  - Events: ReceiveMessage, MessageEdited, MessageDeleted, ToggleReaction, UserJoinedServer, UserLeftServer, UserOnline, UserOffline, UserTyping, RoleCreated, RoleUpdated, RoleDeleted, MemberRolesUpdated, UserBanned, UserUnbanned, ServerDeleted, NewUnreadMessage, MentionReceived, VoiceChannelUsers, ScreenShareStartedInChannel, ScreenShareStoppedInChannel
- [ ] Remember last active server/channel (AsyncStorage)

**Checkpoint:** Can see servers, switch channels, see members. No messages yet.

---

### Phase 4: Text Messaging
> Estimated: 5-7 days | Risk: Medium-High (MessageInput is complex)

- [ ] **MessageList component** (169 lines web):
  - `<FlatList inverted>` for auto-scroll-to-bottom behavior (RN pattern)
  - `onEndReached` for loading older messages (replaces scroll-top detection)
  - Message grouping logic (already extracted to shared utils in Phase 0)
  - Pull-to-load-more at top

- [ ] **MessageItem component** (415 lines web):
  - Author avatar + name + timestamp + role color
  - Message content with parsed mentions:
    - `<@userId>` → highlighted `<Text>` with user name
    - `@everyone` / `@here` → highlighted `<Text>`
    - Custom emojis `<:name:id>` → `<Image>` inline
  - Image attachments → `<Image>` with `<Pressable>` for fullscreen
  - Reactions bar → horizontal `<ScrollView>` of reaction chips
  - Long-press for context menu (replaces right-click):
    - React, Edit, Delete, Copy, Reply
    - Admin actions: Kick, Ban (if permissions)
  - Emoji picker for reactions (see below)

- [ ] **MessageInput component** (591 lines web — HARDEST COMPONENT):
  - **Cannot use contentEditable.** Replace with:
    - `<TextInput multiline>` for plain text
    - Mention autocomplete: detect `@` in text, show dropdown `<FlatList>` above input
    - Custom emoji autocomplete: detect `:` in text, show dropdown
    - Selection tracking via `onSelectionChange` prop
    - Insert mention as `<@userId>` text (render highlighted in MessageItem)
  - File attachments: `expo-image-picker` for photos, `expo-document-picker` for files
  - File preview strip below input
  - Send button (no Enter key on mobile — use send icon button)
  - Edit mode: populate input with existing message text

- [ ] **Emoji picker:**
  - `emoji-mart` is web-only. Replacements:
    - [`rn-emoji-keyboard`](https://github.com/TheWidlarzGroup/rn-emoji-keyboard) — popular, maintained
    - Or build a simple grid picker with emoji data from `@emoji-mart/data`
  - Custom server emojis: separate section in picker, fetched from server

- [ ] **TypingIndicator** (21 lines web):
  - Simple `<Text>` with animated dots. Direct port.

**Checkpoint:** Full text chat working — send/receive messages, mentions, reactions, attachments.

---

### Phase 5: Modals & Settings
> Estimated: 3-4 days | Risk: Low

All modals convert from CSS overlays to React Native `<Modal>` component.

- [ ] **CreateServerModal** (39 lines) — simple form, direct port
- [ ] **JoinServerModal** (37 lines) — invite code input, direct port
- [ ] **CreateChannelModal** (57 lines) — name + type picker, direct port
- [ ] **InviteModal** (40 lines) — generate code + copy button (`expo-clipboard`)
- [ ] **UserSettingsModal** (169 lines):
  - Avatar upload via `expo-image-picker`
  - Display name + bio `<TextInput>`
  - Voice mode toggle (voice activity / PTT)
  - PTT key binding — **skip on mobile** (PTT uses screen button on mobile)
- [ ] **UserProfileCard** (80 lines):
  - Bottom sheet or modal on mobile (instead of positioned popover)
  - Avatar, name, bio, role pills
- [ ] **ServerSettingsModal** (495 lines):
  - Tab navigation (roles, bans, emojis, audit log, danger zone)
  - Role editor: name, color picker, permission checkboxes
  - Ban list with unban action
  - Custom emoji upload via `expo-image-picker`
  - Audit log list
  - **Consider:** This is complex enough to be its own screen stack on mobile rather than a modal

**Checkpoint:** All settings and admin features working.

---

### Phase 6: Voice Chat (WebRTC)
> Estimated: 7-10 days | Risk: HIGH

This is the most technically challenging phase.

- [ ] Install `react-native-webrtc`:
  ```
  npx expo install react-native-webrtc
  npx expo prebuild  # Ejects to bare workflow for native modules
  ```
  - **Note:** This requires Expo bare workflow or development build (not Expo Go)
  - Needs Xcode for iOS, Android Studio for Android
  - Add microphone permission to `app.json`:
    ```json
    { "ios": { "infoPlist": { "NSMicrophoneUsageDescription": "..." } } }
    ```

- [ ] Rewrite `useWebRTC.ts` (586 lines) using `react-native-webrtc` APIs:
  - `RTCPeerConnection` — same API, different import
  - `mediaDevices.getUserMedia()` — same API, from `react-native-webrtc`
  - `MediaStream` / `RTCSessionDescription` / `RTCIceCandidate` — same API
  - Audio playback: `RTCView` component for remote streams (replaces `<audio>` elements)

- [ ] **Voice activity detection:**
  - Web Audio API (`AudioContext` + `AnalyserNode`) does NOT exist in RN
  - Options:
    a. Use `expo-av` audio level metering (less precise but simpler)
    b. Native module for audio analysis (more work, better results)
    c. Skip VAD on mobile, rely on PTT or simple threshold detection
  - Recommendation: Start with (a), upgrade later if needed

- [ ] **VoiceChannel component** (51 lines) — participant grid with speaking indicators
- [ ] **VoiceControls component** (47 lines) — mute/deafen/disconnect buttons
- [ ] **PTT on mobile:** Large on-screen button (press-and-hold to talk)
  - No keyboard events on mobile, so PTT = `<Pressable onPressIn/onPressOut>`

- [ ] Handle audio session / audio focus:
  - iOS: AVAudioSession category configuration
  - Android: Audio focus management
  - Keep audio playing when app is backgrounded

**Checkpoint:** Voice chat working on all platforms.

---

### Phase 7: Screen Sharing
> Estimated: 5-7 days | Risk: HIGH (platform-specific native code)

- [ ] **Sharing your screen (mobile):**
  - iOS: Requires a Broadcast Upload Extension (ReplayKit) — native Swift code
  - Android: Uses `MediaProjection` API — native Kotlin/Java code
  - Both require `react-native-webrtc` screen capture support
  - `expo-screen-capture` only detects screenshots, does NOT do screen sharing
  - This is significantly harder than web's `getDisplayMedia()`
  - **Consider deferring mobile screen sharing** — keep it web-only initially

- [ ] **Watching someone's screen share (mobile):**
  - Much easier — just receive the WebRTC video track
  - Display in `RTCView` component (from `react-native-webrtc`)
  - Fullscreen video with pinch-to-zoom

- [ ] **ScreenShareView component** (133 lines):
  - Sharer picker cards (when multiple sharers)
  - Video view for active stream
  - Switcher bar for swapping between sharers

**Recommendation:** Phase 7a = viewing only (easy). Phase 7b = sharing from mobile (hard, defer).

**Checkpoint:** Can watch screen shares. Sharing from mobile is stretch goal.

---

### Phase 8: Push Notifications
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

### Phase 9: Search & DMs
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

### Phase 10: Polish & Platform-Specific UX
> Estimated: 3-5 days | Risk: Low

- [ ] **Keyboard handling:**
  - `KeyboardAvoidingView` for message input
  - Dismiss keyboard on scroll / tap outside
- [ ] **Haptic feedback:** `expo-haptics` for button presses, long-press actions
- [ ] **Image viewer:** Fullscreen image viewer for attachments (pinch/zoom/pan)
- [ ] **Pull-to-refresh** on channel/server lists
- [ ] **Swipe gestures:**
  - Swipe message left for quick actions (reply, react)
  - Swipe to reveal server/channel drawers on mobile
- [ ] **App icon + splash screen** via `app.json` config
- [ ] **Deep linking:** `abyss://invite/CODE` to join servers from links
- [ ] **Offline state:** Show banner when disconnected, auto-reconnect
- [ ] **Web-specific tweaks:**
  - Ensure hover states work on web (RN doesn't have `:hover` — use `Pressable` style function)
  - Keyboard shortcuts on web (Enter to send, etc.)
- [ ] **Accessibility:** Screen reader labels, font scaling

---

## Dependency Mapping

| Web Dependency | Expo Replacement | Notes |
|---|---|---|
| `react-dom` | (removed) | Not needed in RN |
| `react-router-dom` | `expo-router` | File-based routing |
| `emoji-mart` / `@emoji-mart/react` | `rn-emoji-keyboard` or custom | Web component, no RN version |
| `localStorage` | `@react-native-async-storage/async-storage` | Async API |
| `contentEditable` | `<TextInput multiline>` + custom logic | Major rewrite |
| `navigator.mediaDevices` | `react-native-webrtc` | Same API, different import |
| `AudioContext` / `AnalyserNode` | `expo-av` metering or native module | Voice activity detection |
| `getDisplayMedia()` | ReplayKit (iOS) / MediaProjection (Android) | Screen sharing from mobile |
| `HTMLVideoElement` | `RTCView` from `react-native-webrtc` | Video display |
| `HTMLAudioElement` | `RTCView` or `expo-av` | Audio playback |
| `window.getSelection()` / Range API | `TextInput.onSelectionChange` | Text selection |
| `FileReader` / `File` | `expo-file-system` / `expo-image-picker` | File handling |
| `navigator.clipboard` | `expo-clipboard` | Copy text |
| `CSS (App.css)` | `StyleSheet.create()` | Complete rewrite |
| `Vite` | Metro bundler (Expo default) | Build tooling |

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| `react-native-webrtc` instability | Voice chat broken on mobile | Pin version, test on real devices early, have web fallback |
| Expo prebuild complexity | Build failures, native debugging | Use EAS Build for CI, test on both platforms weekly |
| MessageInput rewrite scope creep | Delays Phase 4 | Start with plain text only, add mention/emoji autocomplete incrementally |
| Screen sharing on mobile | May not be feasible short-term | Defer to Phase 7b, support viewing-only first |
| SignalR reconnection on mobile networks | Dropped connections, missed messages | Add aggressive reconnect logic + push notification fallback |
| Performance (large message lists) | Scroll jank on low-end devices | Use `FlatList` with `getItemLayout`, memo components, limit re-renders |

---

## Suggested Build Order (MVP)

For the fastest path to a usable mobile app:

**Sprint 1 (Week 1-2):** Phases 0 + 1 + 2 — Monorepo, scaffolding, auth
**Sprint 2 (Week 3-4):** Phase 3 — Layout shell with navigation
**Sprint 3 (Week 5-7):** Phase 4 — Text messaging (core feature)
**Sprint 4 (Week 8):** Phase 5 — Modals and settings
**Sprint 5 (Week 9):** Phase 8 — Push notifications
**Sprint 6 (Week 10-12):** Phase 6 — Voice chat
**Sprint 7 (Week 13+):** Phases 7, 9, 10 — Screen sharing, search, polish

**MVP = Sprints 1-5** (~9 weeks): Text chat + push notifications, no voice.
**Full feature parity = all sprints** (~13+ weeks).

---

## Notes

- Keep the existing `client/` web app running throughout migration. The monorepo structure with `packages/shared` lets both coexist.
- Test on real iOS and Android devices early (especially WebRTC). Simulators are unreliable for audio/video.
- Expo Go won't work once you add `react-native-webrtc`. Use Expo Development Builds instead.
- The web target in Expo uses `react-native-web` under the hood. Most RN components work, but test web rendering at each phase.
