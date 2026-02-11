import { create } from 'zustand';

interface ChannelUnread {
  hasUnread: boolean;
  mentionCount: number;
  serverId?: string;
}

interface ServerUnread {
  hasUnread: boolean;
  mentionCount: number;
}

interface UnreadState {
  channelUnreads: Map<string, ChannelUnread>;
  serverUnreads: Map<string, ServerUnread>;
  dmUnreads: Map<string, ChannelUnread>;

  setChannelUnreads: (serverId: string, unreads: { channelId: string; hasUnread: boolean; mentionCount: number }[]) => void;
  setServerUnreads: (unreads: { serverId: string; hasUnread: boolean; mentionCount: number }[]) => void;
  markChannelRead: (channelId: string, serverId: string) => void;
  handleNewUnreadMessage: (channelId: string, serverId: string) => void;
  incrementMention: (channelId: string, serverId: string) => void;

  setDmUnreads: (unreads: { channelId: string; hasUnread: boolean; mentionCount: number }[]) => void;
  handleNewDmUnread: (channelId: string) => void;
  incrementDmMention: (channelId: string) => void;
  markDmChannelRead: (channelId: string) => void;
  getTotalDmUnreadCount: () => { hasUnread: boolean; mentionCount: number };
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  channelUnreads: new Map(),
  serverUnreads: new Map(),
  dmUnreads: new Map(),

  setChannelUnreads: (serverId, unreads) =>
    set((s) => {
      const next = new Map(s.channelUnreads);
      for (const u of unreads) {
        next.set(u.channelId, { hasUnread: u.hasUnread, mentionCount: u.mentionCount, serverId });
      }
      return { channelUnreads: next };
    }),

  setServerUnreads: (unreads) =>
    set(() => {
      const next = new Map<string, ServerUnread>();
      for (const u of unreads) {
        next.set(u.serverId, { hasUnread: u.hasUnread, mentionCount: u.mentionCount });
      }
      return { serverUnreads: next };
    }),

  markChannelRead: (channelId, serverId) =>
    set((s) => {
      const nextChannels = new Map(s.channelUnreads);
      nextChannels.set(channelId, { hasUnread: false, mentionCount: 0, serverId });

      const nextServers = new Map(s.serverUnreads);
      let serverHasUnread = false;
      let serverMentions = 0;
      for (const [, val] of nextChannels) {
        if (val.serverId !== serverId) continue;
        if (val.hasUnread) serverHasUnread = true;
        serverMentions += val.mentionCount;
      }
      const current = nextServers.get(serverId);
      if (current) {
        nextServers.set(serverId, { hasUnread: serverHasUnread, mentionCount: serverMentions });
      }

      return { channelUnreads: nextChannels, serverUnreads: nextServers };
    }),

  handleNewUnreadMessage: (channelId, serverId) =>
    set((s) => {
      const nextChannels = new Map(s.channelUnreads);
      const existing = nextChannels.get(channelId) || { hasUnread: false, mentionCount: 0 };
      nextChannels.set(channelId, { ...existing, hasUnread: true, serverId });

      const nextServers = new Map(s.serverUnreads);
      const serverExisting = nextServers.get(serverId) || { hasUnread: false, mentionCount: 0 };
      nextServers.set(serverId, { ...serverExisting, hasUnread: true });

      return { channelUnreads: nextChannels, serverUnreads: nextServers };
    }),

  incrementMention: (channelId, serverId) =>
    set((s) => {
      const nextChannels = new Map(s.channelUnreads);
      const existing = nextChannels.get(channelId) || { hasUnread: false, mentionCount: 0 };
      nextChannels.set(channelId, { hasUnread: true, mentionCount: existing.mentionCount + 1, serverId });

      const nextServers = new Map(s.serverUnreads);
      const serverExisting = nextServers.get(serverId) || { hasUnread: false, mentionCount: 0 };
      nextServers.set(serverId, { hasUnread: true, mentionCount: serverExisting.mentionCount + 1 });

      return { channelUnreads: nextChannels, serverUnreads: nextServers };
    }),

  setDmUnreads: (unreads) =>
    set(() => {
      const next = new Map<string, ChannelUnread>();
      for (const u of unreads) {
        next.set(u.channelId, { hasUnread: u.hasUnread, mentionCount: u.mentionCount });
      }
      return { dmUnreads: next };
    }),

  handleNewDmUnread: (channelId) =>
    set((s) => {
      const next = new Map(s.dmUnreads);
      const existing = next.get(channelId) || { hasUnread: false, mentionCount: 0 };
      next.set(channelId, { ...existing, hasUnread: true });
      return { dmUnreads: next };
    }),

  incrementDmMention: (channelId) =>
    set((s) => {
      const next = new Map(s.dmUnreads);
      const existing = next.get(channelId) || { hasUnread: false, mentionCount: 0 };
      next.set(channelId, { hasUnread: true, mentionCount: existing.mentionCount + 1 });
      return { dmUnreads: next };
    }),

  markDmChannelRead: (channelId) =>
    set((s) => {
      const next = new Map(s.dmUnreads);
      next.set(channelId, { hasUnread: false, mentionCount: 0 });
      return { dmUnreads: next };
    }),

  getTotalDmUnreadCount: () => {
    const s = get();
    let hasUnread = false;
    let mentionCount = 0;
    for (const [, val] of s.dmUnreads) {
      if (val.hasUnread) hasUnread = true;
      mentionCount += val.mentionCount;
    }
    return { hasUnread, mentionCount };
  },
}));
