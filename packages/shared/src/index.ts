// Storage adapter
export { setStorage, getStorage } from './storage.js';
export type { StorageAdapter } from './storage.js';

// Types
export * from './types/index.js';

// Services
export { default as api, getApiBase, setApiBase, setOnUnauthorized, uploadFile } from './services/api.js';
export { getConnection, startConnection, ensureConnected, stopConnection, resetConnection, onReconnected } from './services/signalr.js';
export { getTurnCredentials, refreshTurnCredentials, subscribeTurnCredentials, clearTurnCredentials } from './services/turn.js';
export type { TurnCredentials } from './services/turn.js';

// Stores
export { useAuthStore } from './stores/authStore.js';
export { useServerStore } from './stores/serverStore.js';
export { useMessageStore } from './stores/messageStore.js';
export { useVoiceStore, hydrateVoiceStore } from './stores/voiceStore.js';
export { usePresenceStore } from './stores/presenceStore.js';
export { useUnreadStore } from './stores/unreadStore.js';
export { useDmStore } from './stores/dmStore.js';
export { useSearchStore } from './stores/searchStore.js';
export { useSignalRStore } from './stores/signalrStore.js';
export { useAppConfigStore } from './stores/appConfigStore.js';
export { useToastStore } from './stores/toastStore.js';

// Hooks
export { useSignalRListeners, fetchServerState, refreshSignalRState, rejoinActiveChannel } from './hooks/useSignalRListeners.js';

// Utils
export { formatTime, formatDate } from './utils/formatting.js';
export { parseMentions, resolveMentionName, resolveCustomEmoji, MENTION_EMOJI_REGEX } from './utils/mentions.js';
export type { MentionSegment } from './utils/mentions.js';
export { shouldGroupMessage, groupReactions } from './utils/messages.js';
