import { create } from 'zustand';
import api from '../services/api';
import { ensureConnected } from '../services/signalr';
import type { Server, Channel, ServerMember, ServerRole, ServerBan, AuditLog, CustomEmoji } from '../types';

// channelId -> Map<userId, displayName>
type VoiceChannelUsersMap = Map<string, Map<string, string>>;
// channelId -> Set<userId> of active screen sharers
type VoiceChannelSharersMap = Map<string, Set<string>>;

interface ServerState {
  servers: Server[];
  activeServer: Server | null;
  channels: Channel[];
  activeChannel: Channel | null;
  members: ServerMember[];
  roles: ServerRole[];
  bans: ServerBan[];
  emojis: CustomEmoji[];
  voiceChannelUsers: VoiceChannelUsersMap;
  voiceChannelSharers: VoiceChannelSharersMap;
  fetchServers: () => Promise<void>;
  setActiveServer: (server: Server) => Promise<void>;
  setActiveChannel: (channel: Channel | null) => void;
  createServer: (name: string) => Promise<Server>;
  createChannel: (serverId: string, name: string, type: 'Text' | 'Voice') => Promise<Channel>;
  joinServer: (code: string) => Promise<void>;
  fetchMembers: (serverId: string) => Promise<void>;
  fetchRoles: (serverId: string) => Promise<void>;
  createRole: (serverId: string, name: string, color: string, permissions: number) => Promise<ServerRole>;
  updateRole: (serverId: string, roleId: string, data: { name?: string; color?: string; permissions?: number }) => Promise<ServerRole>;
  deleteRole: (serverId: string, roleId: string) => Promise<void>;
  reorderRoles: (serverId: string, roleIds: string[]) => Promise<void>;
  updateMemberRoles: (serverId: string, userId: string, roleIds: string[]) => Promise<void>;
  fetchBans: (serverId: string) => Promise<void>;
  banMember: (serverId: string, userId: string, reason?: string) => Promise<void>;
  unbanMember: (serverId: string, userId: string) => Promise<void>;
  kickMember: (serverId: string, userId: string) => Promise<void>;
  deleteChannel: (serverId: string, channelId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  fetchAuditLogs: (serverId: string) => Promise<AuditLog[]>;
  setVoiceChannelUsers: (data: Record<string, Record<string, string>>) => void;
  voiceUserJoined: (channelId: string, userId: string, displayName: string) => void;
  voiceUserLeft: (channelId: string, userId: string) => void;
  setVoiceChannelSharers: (data: Record<string, string[]>) => void;
  voiceSharerStarted: (channelId: string, userId: string) => void;
  voiceSharerStopped: (channelId: string, userId: string) => void;
  removeChannel: (channelId: string) => void;
  removeServer: (serverId: string) => void;
  removeMember: (userId: string) => void;
  // Local update actions for SignalR
  addChannelLocal: (channel: Channel) => void;
  addRoleLocal: (role: ServerRole) => void;
  updateRoleLocal: (role: ServerRole) => void;
  removeRoleLocal: (roleId: string) => void;
  updateMemberRolesLocal: (userId: string, roles: ServerRole[]) => void;
  removeBanLocal: (userId: string) => void;
  fetchEmojis: (serverId: string) => Promise<void>;
  uploadEmoji: (serverId: string, formData: FormData) => Promise<CustomEmoji>;
  renameEmoji: (serverId: string, emojiId: string, name: string) => Promise<void>;
  deleteEmoji: (serverId: string, emojiId: string) => Promise<void>;
  addEmojiLocal: (emoji: CustomEmoji) => void;
  updateEmojiLocal: (emoji: CustomEmoji) => void;
  removeEmojiLocal: (emojiId: string) => void;
  clearActiveServer: () => void;
}

function getLastChannelMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('lastChannelByServer') || '{}');
  } catch {
    return {};
  }
}

function saveLastChannel(serverId: string, channelId: string) {
  const map = getLastChannelMap();
  map[serverId] = channelId;
  localStorage.setItem('lastChannelByServer', JSON.stringify(map));
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServer: null,
  channels: [],
  activeChannel: null,
  members: [],
  roles: [],
  bans: [],
  emojis: [],
  voiceChannelUsers: new Map(),
  voiceChannelSharers: new Map(),

  fetchServers: async () => {
    const res = await api.get('/servers');
    const servers: Server[] = res.data;
    set({ servers });

    // Restore last active server from localStorage
    const savedServerId = localStorage.getItem('activeServerId');
    if (savedServerId && !get().activeServer) {
      const server = servers.find((s) => s.id === savedServerId);
      if (server) {
        await get().setActiveServer(server);
      }
    }
  },

  setActiveServer: async (server) => {
    set({ activeServer: server, activeChannel: null, voiceChannelUsers: new Map(), voiceChannelSharers: new Map() });
    localStorage.setItem('activeServerId', server.id);
    const res = await api.get(`/servers/${server.id}/channels`);
    const channels: Channel[] = res.data;
    set({ channels });

    // Restore last channel for this server
    const lastChannelId = getLastChannelMap()[server.id];
    if (lastChannelId) {
      const channel = channels.find((c) => c.id === lastChannelId);
      if (channel) {
        set({ activeChannel: channel });
      }
    }

    get().fetchMembers(server.id);
    get().fetchRoles(server.id);
    get().fetchEmojis(server.id);
  },

  setActiveChannel: (channel) => {
    set({ activeChannel: channel });
    const server = get().activeServer;
    if (channel && server) {
      saveLastChannel(server.id, channel.id);
    }
  },

  createServer: async (name) => {
    const res = await api.post('/servers', { name });
    const server = res.data;
    set((s) => ({ servers: [...s.servers, server] }));
    const conn = await ensureConnected();
    await conn.invoke('JoinServerGroup', server.id);
    return server;
  },

  createChannel: async (serverId, name, type) => {
    const res = await api.post(`/servers/${serverId}/channels`, { name, type });
    const channel = res.data;
    set((s) => s.channels.some((c) => c.id === channel.id) ? s : { channels: [...s.channels, channel] });
    return channel;
  },

  joinServer: async (code) => {
    const res = await api.post(`/invites/${code}/join`);
    const server = res.data;
    set((s) => ({ servers: [...s.servers, server] }));
    const conn = await ensureConnected();
    await conn.invoke('JoinServerGroup', server.id);
  },

  fetchMembers: async (serverId) => {
    try {
      const res = await api.get(`/servers/${serverId}/members`);
      set({ members: res.data });
    } catch {
      set({ members: [] });
    }
  },

  fetchRoles: async (serverId) => {
    try {
      const res = await api.get(`/servers/${serverId}/roles`);
      set({ roles: res.data });
    } catch {
      set({ roles: [] });
    }
  },

  createRole: async (serverId, name, color, permissions) => {
    const res = await api.post(`/servers/${serverId}/roles`, { name, color, permissions });
    const role: ServerRole = res.data;
    set((s) => s.roles.some((r) => r.id === role.id) ? s : { roles: [...s.roles, role] });
    return role;
  },

  updateRole: async (serverId, roleId, data) => {
    const res = await api.patch(`/servers/${serverId}/roles/${roleId}`, data);
    const role: ServerRole = res.data;
    set((s) => ({ roles: s.roles.map((r) => (r.id === roleId ? role : r)) }));
    return role;
  },

  deleteRole: async (serverId, roleId) => {
    await api.delete(`/servers/${serverId}/roles/${roleId}`);
    set((s) => ({ roles: s.roles.filter((r) => r.id !== roleId) }));
  },

  reorderRoles: async (serverId, roleIds) => {
    await api.patch(`/servers/${serverId}/roles/reorder`, { roleIds });
  },

  updateMemberRoles: async (serverId, userId, roleIds) => {
    await api.patch(`/servers/${serverId}/members/${userId}/roles`, { roleIds });
  },

  fetchBans: async (serverId) => {
    try {
      const res = await api.get(`/servers/${serverId}/bans`);
      set({ bans: res.data });
    } catch {
      set({ bans: [] });
    }
  },

  banMember: async (serverId, userId, reason) => {
    await api.post(`/servers/${serverId}/bans/${userId}`, { reason });
  },

  unbanMember: async (serverId, userId) => {
    await api.delete(`/servers/${serverId}/bans/${userId}`);
    set((s) => ({ bans: s.bans.filter((b) => b.userId !== userId) }));
  },

  kickMember: async (serverId, userId) => {
    await api.delete(`/servers/${serverId}/members/${userId}`);
  },

  deleteChannel: async (serverId, channelId) => {
    await api.delete(`/servers/${serverId}/channels/${channelId}`);
  },

  deleteServer: async (serverId) => {
    await api.delete(`/servers/${serverId}`);
  },

  fetchAuditLogs: async (serverId) => {
    const res = await api.get(`/servers/${serverId}/audit-logs`);
    return res.data;
  },

  setVoiceChannelUsers: (data) => {
    const map: VoiceChannelUsersMap = new Map();
    for (const [channelId, users] of Object.entries(data)) {
      map.set(channelId, new Map(Object.entries(users)));
    }
    set({ voiceChannelUsers: map });
  },

  voiceUserJoined: (channelId, userId, displayName) =>
    set((s) => {
      const next = new Map(s.voiceChannelUsers);
      const channelUsers = new Map(next.get(channelId) || []);
      channelUsers.set(userId, displayName);
      next.set(channelId, channelUsers);
      return { voiceChannelUsers: next };
    }),

  voiceUserLeft: (channelId, userId) =>
    set((s) => {
      const next = new Map(s.voiceChannelUsers);
      const channelUsers = next.get(channelId);
      if (channelUsers) {
        const updated = new Map(channelUsers);
        updated.delete(userId);
        if (updated.size === 0) {
          next.delete(channelId);
        } else {
          next.set(channelId, updated);
        }
      }
      return { voiceChannelUsers: next };
    }),

  setVoiceChannelSharers: (data) => {
    const map: VoiceChannelSharersMap = new Map();
    for (const [channelId, userIds] of Object.entries(data)) {
      map.set(channelId, new Set(userIds));
    }
    set({ voiceChannelSharers: map });
  },

  voiceSharerStarted: (channelId, userId) =>
    set((s) => {
      const next = new Map(s.voiceChannelSharers);
      const sharers = new Set(next.get(channelId) || []);
      sharers.add(userId);
      next.set(channelId, sharers);
      return { voiceChannelSharers: next };
    }),

  voiceSharerStopped: (channelId, userId) =>
    set((s) => {
      const next = new Map(s.voiceChannelSharers);
      const sharers = next.get(channelId);
      if (sharers) {
        const updated = new Set(sharers);
        updated.delete(userId);
        if (updated.size === 0) {
          next.delete(channelId);
        } else {
          next.set(channelId, updated);
        }
      }
      return { voiceChannelSharers: next };
    }),

  removeChannel: (channelId) =>
    set((s) => {
      const channels = s.channels.filter((c) => c.id !== channelId);
      const activeChannel = s.activeChannel?.id === channelId ? (channels.find((c) => c.type === 'Text') || null) : s.activeChannel;
      return { channels, activeChannel };
    }),

  removeServer: (serverId) =>
    set((s) => {
      const servers = s.servers.filter((sv) => sv.id !== serverId);
      if (s.activeServer?.id === serverId) {
        return { servers, activeServer: null, channels: [], activeChannel: null, members: [], roles: [], bans: [], emojis: [], voiceChannelUsers: new Map(), voiceChannelSharers: new Map() };
      }
      return { servers };
    }),

  removeMember: (userId) =>
    set((s) => ({ members: s.members.filter((m) => m.userId !== userId) })),

  addChannelLocal: (channel) =>
    set((s) => s.channels.some((c) => c.id === channel.id) ? s : { channels: [...s.channels, channel] }),

  addRoleLocal: (role) =>
    set((s) => s.roles.some((r) => r.id === role.id) ? s : { roles: [...s.roles, role] }),

  updateRoleLocal: (role) =>
    set((s) => ({
      roles: s.roles.map((r) => (r.id === role.id ? role : r)),
      // Also update roles in members
      members: s.members.map((m) => ({
        ...m,
        roles: m.roles.map((r) => (r.id === role.id ? role : r)),
      })),
    })),

  removeRoleLocal: (roleId) =>
    set((s) => ({
      roles: s.roles.filter((r) => r.id !== roleId),
      members: s.members.map((m) => ({
        ...m,
        roles: m.roles.filter((r) => r.id !== roleId),
      })),
    })),

  updateMemberRolesLocal: (userId, roles) =>
    set((s) => ({
      members: s.members.map((m) => (m.userId === userId ? { ...m, roles } : m)),
    })),

  removeBanLocal: (userId) =>
    set((s) => ({ bans: s.bans.filter((b) => b.userId !== userId) })),

  fetchEmojis: async (serverId) => {
    try {
      const res = await api.get(`/servers/${serverId}/emojis`);
      set({ emojis: res.data });
    } catch {
      set({ emojis: [] });
    }
  },

  uploadEmoji: async (serverId, formData) => {
    const res = await api.post(`/servers/${serverId}/emojis`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    const emoji: CustomEmoji = res.data;
    set((s) => s.emojis.some((e) => e.id === emoji.id) ? s : { emojis: [...s.emojis, emoji] });
    return emoji;
  },

  renameEmoji: async (serverId, emojiId, name) => {
    await api.patch(`/servers/${serverId}/emojis/${emojiId}`, { name });
  },

  deleteEmoji: async (serverId, emojiId) => {
    await api.delete(`/servers/${serverId}/emojis/${emojiId}`);
    set((s) => ({ emojis: s.emojis.filter((e) => e.id !== emojiId) }));
  },

  addEmojiLocal: (emoji) =>
    set((s) => s.emojis.some((e) => e.id === emoji.id) ? s : { emojis: [...s.emojis, emoji] }),

  updateEmojiLocal: (emoji) =>
    set((s) => ({ emojis: s.emojis.map((e) => (e.id === emoji.id ? emoji : e)) })),

  removeEmojiLocal: (emojiId) =>
    set((s) => ({ emojis: s.emojis.filter((e) => e.id !== emojiId) })),

  clearActiveServer: () =>
    set({ activeServer: null, channels: [], activeChannel: null, members: [], roles: [], bans: [], emojis: [], voiceChannelUsers: new Map(), voiceChannelSharers: new Map() }),
}));
