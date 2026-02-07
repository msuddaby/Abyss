import { create } from 'zustand';
import api from '../services/api.js';
import { ensureConnected } from '../services/signalr.js';
import type { Message, Reaction } from '../types/index.js';

interface MessageState {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  currentChannelId: string | null;
  replyingTo: Message | null;
  setReplyingTo: (message: Message | null) => void;
  fetchMessages: (channelId: string) => Promise<void>;
  loadMore: () => Promise<void>;
  addMessage: (message: Message) => void;
  updateMessage: (messageId: string, content: string, editedAt: string) => void;
  markDeleted: (messageId: string) => void;
  addReaction: (reaction: Reaction) => void;
  removeReaction: (messageId: string, userId: string, emoji: string) => void;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, attachmentIds?: string[], replyToMessageId?: string) => Promise<void>;
  joinChannel: (channelId: string) => Promise<void>;
  leaveChannel: (channelId: string) => Promise<void>;
  clear: () => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: [],
  loading: false,
  hasMore: true,
  currentChannelId: null,
  replyingTo: null,
  setReplyingTo: (message) => set({ replyingTo: message }),

  fetchMessages: async (channelId) => {
    set({ loading: true, messages: [], hasMore: true, currentChannelId: channelId });
    const res = await api.get(`/channels/${channelId}/messages?limit=100`);
    set({ messages: res.data, loading: false, hasMore: res.data.length >= 100 });
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
    }));
  },

  markDeleted: (messageId) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id === messageId) return { ...m, isDeleted: true, content: '', attachments: [] };
        if (m.replyTo && m.replyTo.id === messageId) return { ...m, replyTo: { ...m.replyTo, isDeleted: true, content: '' } };
        return m;
      }),
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

  clear: () => set({ messages: [], currentChannelId: null, replyingTo: null }),
}));
