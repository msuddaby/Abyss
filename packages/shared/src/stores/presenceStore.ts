import { create } from 'zustand';

interface PresenceState {
  onlineUsers: Set<string>; // userId set
  typingUsers: Map<string, { displayName: string; timeout: ReturnType<typeof setTimeout> }>; // per channel: userId -> info
  typingChannelId: string | null;
  setUserOnline: (userId: string) => void;
  setUserOffline: (userId: string) => void;
  setOnlineUsers: (userIds: string[]) => void;
  addTypingUser: (channelId: string, userId: string, displayName: string) => void;
  removeTypingUser: (userId: string) => void;
  clearTyping: () => void;
  setTypingChannel: (channelId: string | null) => void;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  onlineUsers: new Set(),
  typingUsers: new Map(),
  typingChannelId: null,

  setUserOnline: (userId) =>
    set((s) => {
      const next = new Set(s.onlineUsers);
      next.add(userId);
      return { onlineUsers: next };
    }),

  setUserOffline: (userId) =>
    set((s) => {
      const next = new Set(s.onlineUsers);
      next.delete(userId);
      return { onlineUsers: next };
    }),

  setOnlineUsers: (userIds) =>
    set({ onlineUsers: new Set(userIds) }),

  addTypingUser: (channelId, userId, displayName) => {
    const state = get();
    if (channelId !== state.typingChannelId) return;

    const existing = state.typingUsers.get(userId);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      get().removeTypingUser(userId);
    }, 3000);

    set((s) => {
      const next = new Map(s.typingUsers);
      next.set(userId, { displayName, timeout });
      return { typingUsers: next };
    });
  },

  removeTypingUser: (userId) =>
    set((s) => {
      const next = new Map(s.typingUsers);
      const entry = next.get(userId);
      if (entry) clearTimeout(entry.timeout);
      next.delete(userId);
      return { typingUsers: next };
    }),

  clearTyping: () =>
    set((s) => {
      s.typingUsers.forEach((entry) => clearTimeout(entry.timeout));
      return { typingUsers: new Map() };
    }),

  setTypingChannel: (channelId) => {
    get().clearTyping();
    set({ typingChannelId: channelId });
  },
}));
