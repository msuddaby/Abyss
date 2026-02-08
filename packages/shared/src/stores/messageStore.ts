import { create } from 'zustand';
import api from '../services/api.js';
import { ensureConnected } from '../services/signalr.js';
import type { Message, Reaction, PinnedMessage } from '../types/index.js';

interface MessageState {
  messages: Message[];
  pinnedByChannel: Record<string, PinnedMessage[]>;
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
  clear: () => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: [],
  pinnedByChannel: {},
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
    set({ loading: true, messages: [], hasMore: true, hasNewer: false, currentChannelId: channelId });
    const res = await api.get(`/channels/${channelId}/messages?limit=100`);
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
      if (message.channelId !== s.currentChannelId) return s;
      if (s.messages.some((m) => m.id === message.id)) return s;
      return { messages: [...s.messages, message] };
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

  clear: () => set({
    messages: [],
    pinnedByChannel: {},
    loading: false,
    pinnedLoading: false,
    hasMore: true,
    hasNewer: false,
    currentChannelId: null,
    replyingTo: null,
    highlightedMessageId: null,
  }),
}));
