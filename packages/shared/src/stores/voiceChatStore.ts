import { create } from 'zustand';
import api from '../services/api.js';
import { ensureConnected } from '../services/signalr.js';
import { isElectron } from '../services/electronNotifications.js';
import { useVoiceStore } from './voiceStore.js';
import { useAuthStore } from './authStore.js';
import { useServerStore } from './serverStore.js';
import { getStorage } from '../storage.js';
import type { Message, Reaction } from '../types/index.js';

const TTS_USERS_KEY = 'ttsUsers';

function loadTtsUsers(): Set<string> {
  try {
    const raw = getStorage().getItem(TTS_USERS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set<string>();
}

function saveTtsUsers(users: Set<string>) {
  try {
    getStorage().setItem(TTS_USERS_KEY, JSON.stringify([...users]));
  } catch {}
}

interface VoiceChatState {
  messages: Message[];
  channelId: string | null;
  loading: boolean;
  hasMore: boolean;
  unreadCount: number;
  toastMessage: Message | null;
  setChannel: (channelId: string, persistent?: boolean) => Promise<void>;
  addMessage: (message: Message) => void;
  updateMessage: (messageId: string, content: string, editedAt: string) => void;
  markDeleted: (messageId: string) => void;
  addReaction: (reaction: Reaction) => void;
  removeReaction: (messageId: string, userId: string, emoji: string) => void;
  sendMessage: (content: string, attachmentIds?: string[]) => Promise<void>;
  loadMore: () => Promise<void>;
  clearUnread: () => void;
  dismissToast: () => void;
  ttsUsers: Set<string>;
  toggleTtsUser: (userId: string) => void;
  clear: () => void;
}

export const useVoiceChatStore = create<VoiceChatState>((set, get) => ({
  messages: [],
  channelId: null,
  loading: false,
  hasMore: false,
  unreadCount: 0,
  toastMessage: null,
  ttsUsers: new Set<string>(),

  setChannel: async (channelId, persistent) => {
    set({ channelId, messages: [], loading: false, hasMore: false });
    if (persistent) {
      set({ loading: true });
      try {
        const res = await api.get(`/channels/${channelId}/messages?limit=100`);
        set({ messages: res.data, loading: false, hasMore: res.data.length >= 100 });
      } catch {
        set({ loading: false });
      }
    }
  },

  addMessage: (message) => {
    const current = get();
    if (message.channelId !== current.channelId) return;
    if (current.messages.some((m) => m.id === message.id)) return;

    const isOpen = useVoiceStore.getState().isVoiceChatOpen;
    const myId = useAuthStore.getState().user?.id;
    const isOwnMessage = message.authorId === myId;
    const extra: Partial<VoiceChatState> = {};
    if (!isOpen && !isOwnMessage && !message.isSystem) {
      extra.unreadCount = current.unreadCount + 1;
      extra.toastMessage = message;
    }
    set({ messages: [...current.messages, message], ...extra });

    // Electron desktop notification
    if (!isOwnMessage && !message.isSystem && useVoiceStore.getState().voiceChatDesktopNotify && isElectron()) {
      const preview = message.content.replace(/<:(\w+):\w+>/g, ':$1:').slice(0, 100)
        || (message.attachments?.length > 0 ? 'sent an attachment' : '');
      window.electron!.isFocused().then((focused: boolean) => {
        if (!focused) {
          const serverId = useServerStore.getState().activeServer?.id ?? null;
          window.electron!.showNotification(
            `${message.author.displayName} in voice chat`,
            preview,
            { channelId: message.channelId, serverId }
          );
        }
      }).catch(() => {});
    }
  },

  updateMessage: (messageId, content, editedAt) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, content, editedAt } : m
      ),
    }));
  },

  markDeleted: (messageId) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, isDeleted: true, content: '', attachments: [] } : m
      ),
    }));
  },

  addReaction: (reaction) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === reaction.messageId
          ? { ...m, reactions: [...m.reactions, reaction] }
          : m
      ),
    }));
  },

  removeReaction: (messageId, userId, emoji) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? { ...m, reactions: m.reactions.filter((r) => !(r.userId === userId && r.emoji === emoji)) }
          : m
      ),
    }));
  },

  sendMessage: async (content, attachmentIds) => {
    const { channelId } = get();
    if (!channelId) return;
    const conn = await ensureConnected();
    await conn.invoke('SendMessage', channelId, content, attachmentIds || [], null);
  },

  loadMore: async () => {
    const { messages, channelId, hasMore, loading } = get();
    if (!channelId || !hasMore || loading) return;
    set({ loading: true });
    const oldest = messages[0];
    const res = await api.get(`/channels/${channelId}/messages?limit=100&before=${oldest?.id || ''}`);
    set((s) => ({
      messages: [...res.data, ...s.messages],
      loading: false,
      hasMore: res.data.length >= 100,
    }));
  },

  clearUnread: () => set({ unreadCount: 0 }),
  dismissToast: () => set({ toastMessage: null }),

  toggleTtsUser: (userId) => {
    const next = new Set(get().ttsUsers);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    saveTtsUsers(next);
    set({ ttsUsers: next });
  },

  clear: () => {
    set({ messages: [], channelId: null, loading: false, hasMore: false, unreadCount: 0, toastMessage: null });
  },
}));

/**
 * Hydrate TTS user preferences from persistent storage.
 * Must be called AFTER setStorage() so the adapter is available.
 */
export function hydrateTtsUsers() {
  useVoiceChatStore.setState({ ttsUsers: loadTtsUsers() });
}
