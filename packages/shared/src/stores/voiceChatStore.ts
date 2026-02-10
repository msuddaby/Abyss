import { create } from 'zustand';
import api from '../services/api.js';
import { ensureConnected } from '../services/signalr.js';
import type { Message, Reaction } from '../types/index.js';

interface VoiceChatState {
  messages: Message[];
  channelId: string | null;
  loading: boolean;
  hasMore: boolean;
  setChannel: (channelId: string, persistent?: boolean) => Promise<void>;
  addMessage: (message: Message) => void;
  updateMessage: (messageId: string, content: string, editedAt: string) => void;
  markDeleted: (messageId: string) => void;
  addReaction: (reaction: Reaction) => void;
  removeReaction: (messageId: string, userId: string, emoji: string) => void;
  sendMessage: (content: string, attachmentIds?: string[]) => Promise<void>;
  loadMore: () => Promise<void>;
  clear: () => void;
}

export const useVoiceChatStore = create<VoiceChatState>((set, get) => ({
  messages: [],
  channelId: null,
  loading: false,
  hasMore: false,

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
    set((s) => {
      if (message.channelId !== s.channelId) return s;
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

  clear: () => {
    set({ messages: [], channelId: null, loading: false, hasMore: false });
  },
}));
