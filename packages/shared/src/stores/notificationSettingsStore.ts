import { create } from 'zustand';
import api from '../services/api.js';
import type { ServerNotifSettings, ChannelNotifSettings } from '../types/index.js';

interface NotificationSettingsState {
  serverSettings: Map<string, ServerNotifSettings>;
  channelSettings: Map<string, ChannelNotifSettings>;
  fetchSettings: (serverId: string) => Promise<void>;
  updateServerSettings: (serverId: string, updates: Partial<ServerNotifSettings>) => Promise<void>;
  updateChannelSettings: (serverId: string, channelId: string, updates: Partial<ChannelNotifSettings>) => Promise<void>;
  setServerSetting: (serverId: string, settings: ServerNotifSettings) => void;
  setChannelSetting: (channelId: string, settings: ChannelNotifSettings) => void;
  isServerMuted: (serverId: string) => boolean;
  isChannelMuted: (channelId: string) => boolean;
  getEffectiveLevel: (serverId: string, channelId: string, serverDefault: number) => number;
}

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => ({
  serverSettings: new Map(),
  channelSettings: new Map(),

  fetchSettings: async (serverId: string) => {
    try {
      const res = await api.get(`/servers/${serverId}/notification-settings`);
      const { serverSettings: sv, channelSettings: ch } = res.data;
      set((s) => {
        const nextServer = new Map(s.serverSettings);
        nextServer.set(serverId, sv);
        const nextChannel = new Map(s.channelSettings);
        for (const [chId, chSetting] of Object.entries(ch)) {
          nextChannel.set(chId, chSetting as ChannelNotifSettings);
        }
        return { serverSettings: nextServer, channelSettings: nextChannel };
      });
    } catch {
      // ignore
    }
  },

  updateServerSettings: async (serverId: string, updates: Partial<ServerNotifSettings>) => {
    try {
      const res = await api.patch(`/servers/${serverId}/notification-settings`, updates);
      set((s) => {
        const next = new Map(s.serverSettings);
        next.set(serverId, res.data);
        return { serverSettings: next };
      });
    } catch {
      // ignore
    }
  },

  updateChannelSettings: async (serverId: string, channelId: string, updates: Partial<ChannelNotifSettings>) => {
    try {
      const res = await api.patch(`/servers/${serverId}/channels/${channelId}/notification-settings`, updates);
      set((s) => {
        const next = new Map(s.channelSettings);
        next.set(channelId, res.data);
        return { channelSettings: next };
      });
    } catch {
      // ignore
    }
  },

  setServerSetting: (serverId, settings) => {
    set((s) => {
      const next = new Map(s.serverSettings);
      next.set(serverId, settings);
      return { serverSettings: next };
    });
  },

  setChannelSetting: (channelId, settings) => {
    set((s) => {
      const next = new Map(s.channelSettings);
      next.set(channelId, settings);
      return { channelSettings: next };
    });
  },

  isServerMuted: (serverId: string) => {
    const setting = get().serverSettings.get(serverId);
    if (!setting?.muteUntil) return false;
    return new Date(setting.muteUntil) > new Date();
  },

  isChannelMuted: (channelId: string) => {
    const setting = get().channelSettings.get(channelId);
    if (!setting?.muteUntil) return false;
    return new Date(setting.muteUntil) > new Date();
  },

  getEffectiveLevel: (serverId: string, channelId: string, serverDefault: number) => {
    const chSetting = get().channelSettings.get(channelId);
    if (chSetting?.notificationLevel != null) return chSetting.notificationLevel;
    const svSetting = get().serverSettings.get(serverId);
    if (svSetting?.notificationLevel != null) return svSetting.notificationLevel;
    return serverDefault;
  },
}));
