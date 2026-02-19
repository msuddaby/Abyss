import { create } from 'zustand';
import api from '../services/api.js';
import { ensureConnected } from '../services/signalr.js';
import type { Message, Reaction, PinnedMessage, EquippedCosmetics } from '../types/index.js';

interface CachedChannel {
  messages: Message[];
  hasMore: boolean;
}

const MAX_CACHED_CHANNELS = 25;

interface MessageState {
  messages: Message[];
  pinnedByChannel: Record<string, PinnedMessage[]>;
  channelCache: Record<string, CachedChannel>;
  loading: boolean;
  pinnedLoading: boolean;
  hasMore: boolean;
  hasNewer: boolean;
  currentChannelId: string | null;
  replyingTo: Message | null;
  highlightedMessageId: string | null;
  setReplyingTo: (message: Message | null) => void;
  setHighlightedMessageId: (messageId: string | null) => void;
  fetchMessages: (channelId: string) => Promise<void>;
  fetchPinnedMessages: (channelId: string) => Promise<void>;
  loadMore: () => Promise<void>;
  loadNewer: () => Promise<void>;
  addMessage: (message: Message) => void;
  updateMessage: (messageId: string, content: string, editedAt: string) => void;
  markDeleted: (messageId: string) => void;
  addReaction: (reaction: Reaction) => void;
  removeReaction: (messageId: string, userId: string, emoji: string) => void;
  addPinnedMessage: (pinned: PinnedMessage) => void;
  removePinnedMessage: (channelId: string, messageId: string) => void;
  isPinned: (channelId: string, messageId: string) => boolean;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  pinMessage: (messageId: string) => Promise<void>;
  unpinMessage: (messageId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, attachmentIds?: string[], replyToMessageId?: string) => Promise<void>;
  joinChannel: (channelId: string) => Promise<void>;
  leaveChannel: (channelId: string) => Promise<void>;
  updateAuthorCosmetics: (userId: string, cosmetics: EquippedCosmetics | null) => void;
  clear: () => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: [],
  pinnedByChannel: {},
  channelCache: {},
  loading: false,
  pinnedLoading: false,
  hasMore: true,
  hasNewer: false,
  currentChannelId: null,
  replyingTo: null,
  highlightedMessageId: null,
  setReplyingTo: (message) => set({ replyingTo: message }),
  setHighlightedMessageId: (messageId) => set({ highlightedMessageId: messageId }),

  fetchMessages: async (channelId) => {
    const state = get();
    const prevChannelId = state.currentChannelId;

    // Save current channel's messages to cache before switching
    if (prevChannelId && prevChannelId !== channelId && state.messages.length > 0) {
      const cache = { ...state.channelCache };
      cache[prevChannelId] = { messages: state.messages, hasMore: state.hasMore };
      // Evict oldest entry if cache exceeds limit
      const keys = Object.keys(cache);
      if (keys.length > MAX_CACHED_CHANNELS) {
        delete cache[keys[0]];
      }
      set({ channelCache: cache });
    }

    // Check cache for target channel
    const cached = get().channelCache[channelId];
    if (cached) {
      // Cache hit: restore instantly (no loading spinner)
      set({
        messages: cached.messages,
        hasMore: cached.hasMore,
        hasNewer: false,
        currentChannelId: channelId,
        loading: false,
      });

      // Fetch newer messages in background to fill the gap
      const newest = cached.messages[cached.messages.length - 1];
      if (newest) {
        try {
          const res = await api.get(`/channels/${channelId}/messages?limit=100&after=${newest.id}`);
          if (res.data.length > 0 && get().currentChannelId === channelId) {
            set((s) => {
              const existingIds = new Set(s.messages.map((m) => m.id));
              const newMsgs = (res.data as Message[]).filter((m) => !existingIds.has(m.id));
              if (newMsgs.length === 0) return s;
              return {
                messages: [...s.messages, ...newMsgs],
                hasNewer: res.data.length >= 100,
              };
            });
          }
        } catch {
          // Gap fill failed silently — user still sees cached messages
        }
      }
      get().fetchPinnedMessages(channelId).catch(() => {});
      return;
    }

    // Cache miss: fetch from API with loading state (original behavior)
    set({ loading: true, messages: [], hasMore: true, hasNewer: false, currentChannelId: channelId });
    const res = await api.get(`/channels/${channelId}/messages?limit=100`);
    // Guard against stale response: another fetchMessages may have changed the active channel
    if (get().currentChannelId !== channelId) return;
    set({ messages: res.data, loading: false, hasMore: res.data.length >= 100, hasNewer: false });
    get().fetchPinnedMessages(channelId).catch(() => {});
  },

  fetchPinnedMessages: async (channelId) => {
    set({ pinnedLoading: true });
    const res = await api.get(`/channels/${channelId}/pins`);
    set((s) => ({
      pinnedByChannel: { ...s.pinnedByChannel, [channelId]: res.data },
      pinnedLoading: false,
    }));
  },

  loadMore: async () => {
    const { messages, currentChannelId, hasMore, loading } = get();
    if (!currentChannelId || !hasMore || loading) return;
    set({ loading: true });
    const oldest = messages[0];
    const res = await api.get(`/channels/${currentChannelId}/messages?limit=100&before=${oldest?.id || ''}`);
    set((s) => ({
      messages: [...res.data, ...s.messages],
      loading: false,
      hasMore: res.data.length >= 100,
    }));
  },

  loadNewer: async () => {
    const { messages, currentChannelId, hasNewer, loading } = get();
    if (!currentChannelId || !hasNewer || loading) return;
    const newest = messages[messages.length - 1];
    if (!newest) return;
    set({ loading: true });
    const res = await api.get(`/channels/${currentChannelId}/messages?limit=100&after=${newest.id}`);
    set((s) => ({
      messages: [...s.messages, ...res.data],
      loading: false,
      hasNewer: res.data.length >= 100,
    }));
  },

  addMessage: (message) => {
    set((s) => {
      // Active channel: append to messages
      if (message.channelId === s.currentChannelId) {
        if (s.messages.some((m) => m.id === message.id)) return s;
        return { messages: [...s.messages, message] };
      }
      // Cached channel: append to cache so it's there on switch-back
      const cached = s.channelCache[message.channelId];
      if (cached && !cached.messages.some((m) => m.id === message.id)) {
        return {
          channelCache: {
            ...s.channelCache,
            [message.channelId]: {
              ...cached,
              messages: [...cached.messages, message],
            },
          },
        };
      }
      return s;
    });
  },

  updateMessage: (messageId, content, editedAt) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, content, editedAt } : m
      ),
      pinnedByChannel: Object.fromEntries(
        Object.entries(s.pinnedByChannel).map(([channelId, pins]) => ([
          channelId,
          pins.map((p) => p.message.id === messageId ? { ...p, message: { ...p.message, content, editedAt } } : p),
        ])),
      ),
    }));
  },

  markDeleted: (messageId) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id === messageId) return { ...m, isDeleted: true, content: '', attachments: [] };
        if (m.replyTo && m.replyTo.id === messageId) return { ...m, replyTo: { ...m.replyTo, isDeleted: true, content: '' } };
        return m;
      }),
      pinnedByChannel: Object.fromEntries(
        Object.entries(s.pinnedByChannel).map(([channelId, pins]) => ([
          channelId,
          pins.filter((p) => p.message.id !== messageId),
        ])),
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
      pinnedByChannel: Object.fromEntries(
        Object.entries(s.pinnedByChannel).map(([channelId, pins]) => ([
          channelId,
          pins.map((p) => p.message.id === reaction.messageId
            ? { ...p, message: { ...p.message, reactions: [...p.message.reactions, reaction] } }
            : p),
        ])),
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
      pinnedByChannel: Object.fromEntries(
        Object.entries(s.pinnedByChannel).map(([channelId, pins]) => ([
          channelId,
          pins.map((p) => p.message.id === messageId
            ? { ...p, message: { ...p.message, reactions: p.message.reactions.filter((r) => !(r.userId === userId && r.emoji === emoji)) } }
            : p),
        ])),
      ),
    }));
  },

  addPinnedMessage: (pinned) => {
    set((s) => {
      const channelId = pinned.message.channelId;
      const existing = s.pinnedByChannel[channelId] || [];
      if (existing.some((p) => p.message.id === pinned.message.id)) return s;
      return {
        pinnedByChannel: {
          ...s.pinnedByChannel,
          [channelId]: [pinned, ...existing],
        },
      };
    });
  },

  removePinnedMessage: (channelId, messageId) => {
    set((s) => ({
      pinnedByChannel: {
        ...s.pinnedByChannel,
        [channelId]: (s.pinnedByChannel[channelId] || []).filter((p) => p.message.id !== messageId),
      },
    }));
  },

  isPinned: (channelId, messageId) => {
    const pins = get().pinnedByChannel[channelId] || [];
    return pins.some((p) => p.message.id === messageId);
  },

  toggleReaction: async (messageId, emoji) => {
    const conn = await ensureConnected();
    await conn.invoke('ToggleReaction', messageId, emoji);
  },

  editMessage: async (messageId, newContent) => {
    const conn = await ensureConnected();
    await conn.invoke('EditMessage', messageId, newContent);
  },

  deleteMessage: async (messageId) => {
    const conn = await ensureConnected();
    await conn.invoke('DeleteMessage', messageId);
  },

  pinMessage: async (messageId) => {
    const conn = await ensureConnected();
    await conn.invoke('PinMessage', messageId);
  },

  unpinMessage: async (messageId) => {
    const conn = await ensureConnected();
    await conn.invoke('UnpinMessage', messageId);
  },

  sendMessage: async (channelId, content, attachmentIds, replyToMessageId) => {
    const conn = await ensureConnected();
    await conn.invoke('SendMessage', channelId, content, attachmentIds || [], replyToMessageId || null);
  },

  joinChannel: async (channelId) => {
    const conn = await ensureConnected();
    await conn.invoke('JoinChannel', channelId);
  },

  leaveChannel: async (channelId) => {
    const conn = await ensureConnected();
    await conn.invoke('LeaveChannel', channelId);
  },

  updateAuthorCosmetics: (userId, cosmetics) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        const authorMatch = m.authorId === userId;
        const replyMatch = m.replyTo && m.replyTo.authorId === userId;
        if (!authorMatch && !replyMatch) return m;
        return {
          ...m,
          author: authorMatch ? { ...m.author, cosmetics } : m.author,
          replyTo: m.replyTo && replyMatch ? { ...m.replyTo, author: { ...m.replyTo.author, cosmetics } } : m.replyTo,
        };
      }),
    })),

  clear: () => set({
    messages: [],
    pinnedByChannel: {},
    channelCache: {},
    loading: false,
    pinnedLoading: false,
    hasMore: true,
    hasNewer: false,
    currentChannelId: null,
    replyingTo: null,
    highlightedMessageId: null,
  }),
}));
