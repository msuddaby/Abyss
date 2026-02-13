import { create } from 'zustand';
import api from '../services/api.js';
import { ensureConnected } from '../services/signalr.js';
import { getStorage } from '../storage.js';
import type { Server, Channel, ServerMember, ServerRole, ServerBan, AuditLog, CustomEmoji, VoiceUserState, EquippedCosmetics } from '../types/index.js';

// channelId -> Map<userId, VoiceUserState>
type VoiceChannelUsersMap = Map<string, Map<string, VoiceUserState>>;
// channelId -> Set<userId> of active screen sharers
type VoiceChannelSharersMap = Map<string, Set<string>>;
// channelId -> Set<userId> of active camera users
type VoiceChannelCamerasMap = Map<string, Set<string>>;
type UploadFile = { uri: string; name: string; type?: string } | { name: string; type?: string; size?: number };

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
  voiceChannelCameras: VoiceChannelCamerasMap;
  fetchServers: () => Promise<void>;
  fetchChannels: (serverId: string) => Promise<Channel[]>;
  setActiveServer: (server: Server) => Promise<void>;
  setActiveChannel: (channel: Channel | null) => void;
  createServer: (name: string) => Promise<Server>;
  updateServer: (serverId: string, data: { name?: string; icon?: UploadFile; removeIcon?: boolean; joinLeaveMessagesEnabled?: boolean; joinLeaveChannelId?: string | null }) => Promise<Server>;
  createChannel: (serverId: string, name: string, type: 'Text' | 'Voice', userLimit?: number | null) => Promise<Channel>;
  renameChannel: (serverId: string, channelId: string, name: string, persistentChat?: boolean, userLimit?: number | null) => Promise<Channel>;
  reorderChannels: (serverId: string, type: 'Text' | 'Voice', channelIds: string[]) => Promise<void>;
  joinServer: (code: string) => Promise<void>;
  fetchMembers: (serverId: string) => Promise<void>;
  fetchRoles: (serverId: string) => Promise<void>;
  createRole: (serverId: string, name: string, color: string, permissions: number, displaySeparately: boolean) => Promise<ServerRole>;
  updateRole: (serverId: string, roleId: string, data: { name?: string; color?: string; permissions?: number; displaySeparately?: boolean }) => Promise<ServerRole>;
  deleteRole: (serverId: string, roleId: string) => Promise<void>;
  reorderRoles: (serverId: string, roleIds: string[]) => Promise<void>;
  updateMemberRoles: (serverId: string, userId: string, roleIds: string[]) => Promise<void>;
  fetchBans: (serverId: string) => Promise<void>;
  banMember: (serverId: string, userId: string, reason?: string) => Promise<void>;
  unbanMember: (serverId: string, userId: string) => Promise<void>;
  kickMember: (serverId: string, userId: string) => Promise<void>;
  leaveServer: (serverId: string) => Promise<void>;
  deleteChannel: (serverId: string, channelId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  fetchAuditLogs: (serverId: string) => Promise<AuditLog[]>;
  setVoiceChannelUsers: (data: Record<string, Record<string, VoiceUserState>>) => void;
  mergeVoiceChannelUsers: (data: Record<string, Record<string, VoiceUserState>>) => void;
  voiceUserJoined: (channelId: string, userId: string, state: VoiceUserState) => void;
  voiceUserLeft: (channelId: string, userId: string) => void;
  voiceUserStateUpdated: (channelId: string, userId: string, state: VoiceUserState) => void;
  setVoiceChannelSharers: (data: Record<string, string[]>) => void;
  voiceSharerStarted: (channelId: string, userId: string) => void;
  voiceSharerStopped: (channelId: string, userId: string) => void;
  setVoiceChannelCameras: (data: Record<string, string[]>) => void;
  voiceCameraStarted: (channelId: string, userId: string) => void;
  voiceCameraStopped: (channelId: string, userId: string) => void;
  removeChannel: (channelId: string) => void;
  removeServer: (serverId: string) => void;
  removeMember: (userId: string) => void;
  addMemberLocal: (member: ServerMember) => void;
  addChannelLocal: (channel: Channel) => void;
  updateChannelLocal: (channel: Channel) => void;
  setChannelsLocal: (channels: Channel[]) => void;
  updateServerLocal: (server: Server) => void;
  addRoleLocal: (role: ServerRole) => void;
  updateRoleLocal: (role: ServerRole) => void;
  removeRoleLocal: (roleId: string) => void;
  updateMemberRolesLocal: (userId: string, roles: ServerRole[]) => void;
  updateMemberCosmetics: (userId: string, cosmetics: EquippedCosmetics | null) => void;
  removeBanLocal: (userId: string) => void;
  fetchEmojis: (serverId: string) => Promise<void>;
  uploadEmoji: (serverId: string, formData: FormData) => Promise<CustomEmoji>;
  renameEmoji: (serverId: string, emojiId: string, name: string) => Promise<void>;
  deleteEmoji: (serverId: string, emojiId: string) => Promise<void>;
  addEmojiLocal: (emoji: CustomEmoji) => void;
  updateEmojiLocal: (emoji: CustomEmoji) => void;
  removeEmojiLocal: (emojiId: string) => void;
  clearActiveServer: () => void;
  voiceChannelWatchParties: Map<string, string>;
  setVoiceChannelWatchParties: (data: Record<string, string>) => void;
  watchPartyStartedInChannel: (channelId: string, itemTitle: string) => void;
  watchPartyStoppedInChannel: (channelId: string) => void;
}

function getLastChannelMap(): Record<string, string> {
  try {
    return JSON.parse(getStorage().getItem('lastChannelByServer') || '{}');
  } catch {
    return {};
  }
}

function saveLastChannel(serverId: string, channelId: string) {
  const map = getLastChannelMap();
  map[serverId] = channelId;
  getStorage().setItem('lastChannelByServer', JSON.stringify(map));
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
  voiceChannelCameras: new Map(),
  voiceChannelWatchParties: new Map(),

  fetchServers: async () => {
    const res = await api.get('/servers');
    const servers: Server[] = res.data;
    set({ servers });

    const savedServerId = getStorage().getItem('activeServerId');
    if (savedServerId && !get().activeServer) {
      const server = servers.find((s) => s.id === savedServerId);
      if (server) {
        await get().setActiveServer(server);
      }
    }
  },

  fetchChannels: async (serverId) => {
    const res = await api.get(`/servers/${serverId}/channels`);
    const channels: Channel[] = res.data;
    set((s) => {
      const activeChannel = s.activeChannel ? channels.find((c) => c.id === s.activeChannel?.id) ?? null : null;
      return { channels, activeChannel };
    });
    return channels;
  },

  setActiveServer: async (server) => {
    set({ activeServer: server, activeChannel: null, voiceChannelUsers: new Map(), voiceChannelSharers: new Map(), voiceChannelCameras: new Map(), voiceChannelWatchParties: new Map() });
    getStorage().setItem('activeServerId', server.id);
    const channels = await get().fetchChannels(server.id);

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
    set((s) => s.servers.some((sv) => sv.id === server.id) ? s : { servers: [...s.servers, server] });
    const conn = await ensureConnected();
    await conn.invoke('JoinServerGroup', server.id);
    return server;
  },

  updateServer: async (serverId, data) => {
    const formData = new FormData();
    if (data.name !== undefined) formData.append('name', data.name);
    if (data.removeIcon) formData.append('removeIcon', 'true');
    if (data.icon) formData.append('icon', data.icon as any);
    if (data.joinLeaveMessagesEnabled !== undefined) formData.append('joinLeaveMessagesEnabled', String(data.joinLeaveMessagesEnabled));
    if (data.joinLeaveChannelId !== undefined && data.joinLeaveChannelId !== null) formData.append('joinLeaveChannelId', data.joinLeaveChannelId);

    const res = await api.patch(`/servers/${serverId}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    const server: Server = res.data;
    set((s) => ({
      servers: s.servers.map((sv) => (sv.id === server.id ? server : sv)),
      activeServer: s.activeServer?.id === server.id ? server : s.activeServer,
    }));
    return server;
  },

  createChannel: async (serverId, name, type, userLimit) => {
    const res = await api.post(`/servers/${serverId}/channels`, { name, type, userLimit: userLimit || null });
    const channel = res.data;
    set((s) => s.channels.some((c) => c.id === channel.id) ? s : { channels: [...s.channels, channel] });
    return channel;
  },

  renameChannel: async (serverId, channelId, name, persistentChat, userLimit) => {
    const res = await api.patch(`/servers/${serverId}/channels/${channelId}`, { name, persistentChat, userLimit: userLimit === undefined ? undefined : (userLimit || 0) });
    const channel = res.data;
    set((s) => ({
      channels: s.channels.map((c) => (c.id === channelId ? channel : c)),
      activeChannel: s.activeChannel?.id === channelId ? channel : s.activeChannel,
    }));
    return channel;
  },

  reorderChannels: async (serverId, type, channelIds) => {
    const prevChannels = get().channels;
    const prevActive = get().activeChannel;

    const updatedChannels = prevChannels.map((channel) => {
      if (channel.type !== type) return channel;
      const nextIndex = channelIds.indexOf(channel.id);
      return nextIndex === -1 ? channel : { ...channel, position: nextIndex };
    });

    const nextChannels = [...updatedChannels].sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.position - b.position;
    });

    const nextActive = prevActive
      ? nextChannels.find((c) => c.id === prevActive.id) || prevActive
      : prevActive;

    set({ channels: nextChannels, activeChannel: nextActive });

    try {
      await api.patch(`/servers/${serverId}/channels/reorder`, { type, channelIds });
    } catch (err) {
      console.error('Failed to reorder channels', err);
      set({ channels: prevChannels, activeChannel: prevActive });
      throw err;
    }
  },

  joinServer: async (code) => {
    const res = await api.post(`/invites/${code}/join`);
    const server = res.data;
    set((s) => s.servers.some((sv) => sv.id === server.id) ? s : { servers: [...s.servers, server] });
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

  createRole: async (serverId, name, color, permissions, displaySeparately) => {
    const res = await api.post(`/servers/${serverId}/roles`, { name, color, permissions, displaySeparately });
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

  leaveServer: async (serverId) => {
    await api.delete(`/servers/${serverId}/leave`);
    get().removeServer(serverId);
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

  // Authoritative replace: server data is the source of truth during periodic reconciliation.
  // Stale local-only users are removed. This prevents ghost users from persisting after missed leave events.
  mergeVoiceChannelUsers: (data) =>
    set(() => {
      const next: VoiceChannelUsersMap = new Map();
      for (const [channelId, users] of Object.entries(data)) {
        next.set(channelId, new Map(Object.entries(users)));
      }
      return { voiceChannelUsers: next };
    }),

  voiceUserJoined: (channelId, userId, state) =>
    set((s) => {
      const next = new Map(s.voiceChannelUsers);
      const channelUsers = new Map(next.get(channelId) || []);
      channelUsers.set(userId, state);
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

  voiceUserStateUpdated: (channelId, userId, state) =>
    set((s) => {
      const next = new Map(s.voiceChannelUsers);
      const channelUsers = new Map(next.get(channelId) || []);
      channelUsers.set(userId, state);
      next.set(channelId, channelUsers);
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

  setVoiceChannelCameras: (data) => {
    const map: VoiceChannelCamerasMap = new Map();
    for (const [channelId, userIds] of Object.entries(data)) {
      map.set(channelId, new Set(userIds));
    }
    set({ voiceChannelCameras: map });
  },

  voiceCameraStarted: (channelId, userId) =>
    set((s) => {
      const next = new Map(s.voiceChannelCameras);
      const cameras = new Set(next.get(channelId) || []);
      cameras.add(userId);
      next.set(channelId, cameras);
      return { voiceChannelCameras: next };
    }),

  voiceCameraStopped: (channelId, userId) =>
    set((s) => {
      const next = new Map(s.voiceChannelCameras);
      const cameras = next.get(channelId);
      if (cameras) {
        const updated = new Set(cameras);
        updated.delete(userId);
        if (updated.size === 0) {
          next.delete(channelId);
        } else {
          next.set(channelId, updated);
        }
      }
      return { voiceChannelCameras: next };
    }),

  setVoiceChannelWatchParties: (data) => {
    const map = new Map<string, string>();
    for (const [channelId, title] of Object.entries(data)) {
      map.set(channelId, title);
    }
    set({ voiceChannelWatchParties: map });
  },

  watchPartyStartedInChannel: (channelId, itemTitle) =>
    set((s) => {
      const next = new Map(s.voiceChannelWatchParties);
      next.set(channelId, itemTitle);
      return { voiceChannelWatchParties: next };
    }),

  watchPartyStoppedInChannel: (channelId) =>
    set((s) => {
      const next = new Map(s.voiceChannelWatchParties);
      next.delete(channelId);
      return { voiceChannelWatchParties: next };
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
        return { servers, activeServer: null, channels: [], activeChannel: null, members: [], roles: [], bans: [], emojis: [], voiceChannelUsers: new Map(), voiceChannelSharers: new Map(), voiceChannelCameras: new Map(), voiceChannelWatchParties: new Map() };
      }
      return { servers };
    }),

  removeMember: (userId) =>
    set((s) => {
      // Also remove from voice channel users and sharers
      const nextVoice = new Map(s.voiceChannelUsers);
      for (const [channelId, users] of nextVoice) {
        if (users.has(userId)) {
          const updated = new Map(users);
          updated.delete(userId);
          if (updated.size === 0) nextVoice.delete(channelId);
          else nextVoice.set(channelId, updated);
        }
      }
      const nextSharers = new Map(s.voiceChannelSharers);
      for (const [channelId, sharers] of nextSharers) {
        if (sharers.has(userId)) {
          const updated = new Set(sharers);
          updated.delete(userId);
          if (updated.size === 0) nextSharers.delete(channelId);
          else nextSharers.set(channelId, updated);
        }
      }
      const nextCameras = new Map(s.voiceChannelCameras);
      for (const [channelId, cameras] of nextCameras) {
        if (cameras.has(userId)) {
          const updated = new Set(cameras);
          updated.delete(userId);
          if (updated.size === 0) nextCameras.delete(channelId);
          else nextCameras.set(channelId, updated);
        }
      }
      return {
        members: s.members.filter((m) => m.userId !== userId),
        voiceChannelUsers: nextVoice,
        voiceChannelSharers: nextSharers,
        voiceChannelCameras: nextCameras,
      };
    }),

  addMemberLocal: (member) =>
    set((s) => s.members.some((m) => m.userId === member.userId) ? s : { members: [...s.members, member] }),

  addChannelLocal: (channel) =>
    set((s) => s.channels.some((c) => c.id === channel.id) ? s : { channels: [...s.channels, channel] }),

  updateChannelLocal: (channel) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.id === channel.id ? channel : c)),
      activeChannel: s.activeChannel?.id === channel.id ? channel : s.activeChannel,
    })),

  setChannelsLocal: (channels) =>
    set((s) => ({
      channels,
      activeChannel: s.activeChannel ? channels.find((c) => c.id === s.activeChannel!.id) || null : null,
    })),

  updateServerLocal: (server) =>
    set((s) => ({
      servers: s.servers.map((sv) => (sv.id === server.id ? server : sv)),
      activeServer: s.activeServer?.id === server.id ? server : s.activeServer,
    })),

  addRoleLocal: (role) =>
    set((s) => s.roles.some((r) => r.id === role.id) ? s : { roles: [...s.roles, role] }),

  updateRoleLocal: (role) =>
    set((s) => ({
      roles: s.roles.map((r) => (r.id === role.id ? role : r)),
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

  updateMemberCosmetics: (userId, cosmetics) =>
    set((s) => ({
      members: s.members.map((m) => (m.userId === userId ? { ...m, user: { ...m.user, cosmetics } } : m)),
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
    set({ activeServer: null, channels: [], activeChannel: null, members: [], roles: [], bans: [], emojis: [], voiceChannelUsers: new Map(), voiceChannelSharers: new Map(), voiceChannelCameras: new Map(), voiceChannelWatchParties: new Map() }),
}));
