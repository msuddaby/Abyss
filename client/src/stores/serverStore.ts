import { create } from 'zustand';
import api from '../services/api';
import type { Server, Channel, ServerMember, ServerRole, ServerBan, AuditLog } from '../types';

// channelId -> Map<userId, displayName>
type VoiceChannelUsersMap = Map<string, Map<string, string>>;

interface ServerState {
  servers: Server[];
  activeServer: Server | null;
  channels: Channel[];
  activeChannel: Channel | null;
  members: ServerMember[];
  roles: ServerRole[];
  bans: ServerBan[];
  voiceChannelUsers: VoiceChannelUsersMap;
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
  removeChannel: (channelId: string) => void;
  removeServer: (serverId: string) => void;
  removeMember: (userId: string) => void;
  // Local update actions for SignalR
  addRoleLocal: (role: ServerRole) => void;
  updateRoleLocal: (role: ServerRole) => void;
  removeRoleLocal: (roleId: string) => void;
  updateMemberRolesLocal: (userId: string, roles: ServerRole[]) => void;
  removeBanLocal: (userId: string) => void;
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
  voiceChannelUsers: new Map(),

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
    set({ activeServer: server, activeChannel: null, voiceChannelUsers: new Map() });
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
    return server;
  },

  createChannel: async (serverId, name, type) => {
    const res = await api.post(`/servers/${serverId}/channels`, { name, type });
    const channel = res.data;
    set((s) => ({ channels: [...s.channels, channel] }));
    return channel;
  },

  joinServer: async (code) => {
    const res = await api.post(`/invites/${code}/join`);
    const server = res.data;
    set((s) => ({ servers: [...s.servers, server] }));
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
    set((s) => ({ roles: [...s.roles, role] }));
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
        return { servers, activeServer: null, channels: [], activeChannel: null, members: [], roles: [], bans: [], voiceChannelUsers: new Map() };
      }
      return { servers };
    }),

  removeMember: (userId) =>
    set((s) => ({ members: s.members.filter((m) => m.userId !== userId) })),

  addRoleLocal: (role) =>
    set((s) => ({ roles: [...s.roles, role] })),

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
}));
