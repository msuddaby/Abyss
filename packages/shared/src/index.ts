// Storage adapter
export { setStorage, getStorage } from './storage.js';
export type { StorageAdapter } from './storage.js';

// Types
export * from './types/index.js';

// Services
export { default as api, getApiBase, setApiBase, setOnUnauthorized, uploadFile, refreshAccessToken, ensureFreshToken } from './services/api.js';
export { getConnection, startConnection, ensureConnected, stopConnection, suspendConnection, resetConnection, onReconnected } from './services/signalr.js';
export { getTurnCredentials, refreshTurnCredentials, subscribeTurnCredentials, clearTurnCredentials } from './services/turn.js';
export type { TurnCredentials } from './services/turn.js';
export { showDesktopNotification, isElectron, navigateToNotification, setupNotificationClickListener } from './services/electronNotifications.js';

// Stores
export { useAuthStore } from './stores/authStore.js';
export { useServerStore } from './stores/serverStore.js';
export { useMessageStore } from './stores/messageStore.js';
export { useVoiceStore, hydrateVoiceStore } from './stores/voiceStore.js';
export { usePresenceStore } from './stores/presenceStore.js';
export { useUnreadStore } from './stores/unreadStore.js';
export { useDmStore } from './stores/dmStore.js';
export { useFriendStore } from './stores/friendStore.js';
export { useSearchStore } from './stores/searchStore.js';
export { useSignalRStore } from './stores/signalrStore.js';
export { useAppConfigStore } from './stores/appConfigStore.js';
export { useToastStore } from './stores/toastStore.js';
export { useVoiceChatStore } from './stores/voiceChatStore.js';
export { useNotificationSettingsStore } from './stores/notificationSettingsStore.js';
export { useUserPreferencesStore } from './stores/userPreferencesStore.js';
export { useMediaProviderStore } from './stores/mediaProviderStore.js';
export { useWatchPartyStore } from './stores/watchPartyStore.js';
export { useSoundboardStore } from './stores/soundboardStore.js';

// Hooks
export { useSignalRListeners, fetchServerState, refreshSignalRState, rejoinActiveChannel } from './hooks/useSignalRListeners.js';

// Utils
export { formatTime, formatDate } from './utils/formatting.js';
export { parseMentions, resolveMentionName, resolveCustomEmoji, MENTION_EMOJI_REGEX } from './utils/mentions.js';
export type { MentionSegment } from './utils/mentions.js';
export { shouldGroupMessage, groupReactions } from './utils/messages.js';
export { getNameplateStyle, getMessageStyle, parseCosmeticCss } from './utils/cosmetics.js';
