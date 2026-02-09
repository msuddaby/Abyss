import { useEffect } from 'react';
import { getConnection, startConnection } from '../services/signalr.js';
import { useServerStore } from '../stores/serverStore.js';
import { useAuthStore } from '../stores/authStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUnreadStore } from '../stores/unreadStore.js';
import { useDmStore } from '../stores/dmStore.js';
import { useMessageStore } from '../stores/messageStore.js';
import { useSearchStore } from '../stores/searchStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useToastStore } from '../stores/toastStore.js';
import { useAppConfigStore } from '../stores/appConfigStore.js';
import type { HubConnection } from '@microsoft/signalr';
import type { Server, ServerRole, CustomEmoji, DmChannel } from '../types/index.js';

export function fetchServerState(conn: HubConnection, serverId: string) {
  conn.invoke('GetServerVoiceUsers', serverId).then((data: Record<string, Record<string, { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }>>) => {
    useServerStore.getState().setVoiceChannelUsers(data);
  }).catch(console.error);

  conn.invoke('GetServerVoiceSharers', serverId).then((data: Record<string, string[]>) => {
    useServerStore.getState().setVoiceChannelSharers(data);
  }).catch(console.error);

  conn.invoke('GetOnlineUsers', serverId).then((userIds: string[]) => {
    usePresenceStore.getState().setOnlineUsers(userIds);
  }).catch(console.error);

  conn.invoke('GetUnreadState', serverId).then((unreads: { channelId: string; hasUnread: boolean; mentionCount: number }[]) => {
    useUnreadStore.getState().setChannelUnreads(serverId, unreads);
  }).catch(console.error);
}

export function refreshSignalRState(conn: HubConnection) {
  conn.invoke('GetAllServerUnreads').then((unreads: { serverId: string; hasUnread: boolean; mentionCount: number }[]) => {
    useUnreadStore.getState().setServerUnreads(unreads);
  }).catch(console.error);

  conn.invoke('GetDmChannels').then((dms: DmChannel[]) => {
    useDmStore.setState({ dmChannels: dms });
  }).catch(console.error);

  conn.invoke('GetDmUnreads').then((unreads: { channelId: string; hasUnread: boolean; mentionCount: number }[]) => {
    useUnreadStore.getState().setDmUnreads(unreads);
  }).catch(console.error);

  const server = useServerStore.getState().activeServer;
  if (server) {
    fetchServerState(conn, server.id);
  }
}

export async function rejoinActiveChannel(conn: HubConnection) {
  const { isDmMode, activeDmChannel } = useDmStore.getState();
  const { activeChannel } = useServerStore.getState();
  const channelId = isDmMode ? activeDmChannel?.id : (activeChannel?.type === 'Text' ? activeChannel.id : null);
  if (!channelId) return;
  try {
    await conn.invoke('JoinChannel', channelId);
    // Refetch messages to pick up any sent while disconnected
    useMessageStore.getState().fetchMessages(channelId);
  } catch (err) {
    console.error('Failed to rejoin channel:', err);
  }
}

export function useSignalRListeners() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const activeServer = useServerStore((s) => s.activeServer);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);

  // Connect + register all handlers
  useEffect(() => {
    startConnection().then(() => {
      const conn = getConnection();

      conn.onreconnected(() => {
        rejoinActiveChannel(conn);
        refreshSignalRState(conn);
      });

      const events = [
        'UserOnline', 'UserOffline', 'UserIsTyping',
        'VoiceUserJoinedChannel', 'VoiceUserLeftChannel', 'VoiceUserStateUpdated',
        'ScreenShareStartedInChannel', 'ScreenShareStoppedInChannel',
        'UserProfileUpdated', 'MemberRolesUpdated', 'MemberKicked', 'MemberBanned', 'MemberUnbanned',
        'RoleCreated', 'RoleUpdated', 'RoleDeleted',
        'EmojiCreated', 'EmojiUpdated', 'EmojiDeleted',
        'ChannelCreated', 'ChannelUpdated', 'ChannelDeleted', 'ChannelsReordered', 'ChannelPermissionsUpdated',
        'ServerDeleted', 'ServerUpdated',
        'NewUnreadMessage', 'MentionReceived',
        'DmChannelCreated',
        'Error', 'ConfigUpdated',
      ];
      for (const e of events) conn.off(e);

      conn.on('UserOnline', (userId: string) => {
        usePresenceStore.getState().setUserOnline(userId);
      });

      conn.on('UserOffline', (userId: string) => {
        usePresenceStore.getState().setUserOffline(userId);
      });

      conn.on('UserIsTyping', (userId: string, displayName: string) => {
        const channelId = usePresenceStore.getState().typingChannelId;
        if (channelId) {
          usePresenceStore.getState().addTypingUser(channelId, userId, displayName);
        }
      });

      conn.on('VoiceUserJoinedChannel', (channelId: string, userId: string, state: { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }) => {
        useServerStore.getState().voiceUserJoined(channelId, userId, state);
      });

      conn.on('VoiceUserLeftChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceUserLeft(channelId, userId);
      });

      conn.on('VoiceUserStateUpdated', (channelId: string, userId: string, state: { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }) => {
        useServerStore.getState().voiceUserStateUpdated(channelId, userId, state);
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          useVoiceStore.getState().setMuteDeafen(state.isMuted, state.isDeafened);
        }
      });

      conn.on('ScreenShareStartedInChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceSharerStarted(channelId, userId);
      });

      conn.on('ScreenShareStoppedInChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceSharerStopped(channelId, userId);
      });

      conn.on('UserProfileUpdated', () => {
        const server = useServerStore.getState().activeServer;
        if (server) {
          useServerStore.getState().fetchMembers(server.id);
        }
      });

      conn.on('MemberRolesUpdated', (_serverId: string, userId: string, roles: ServerRole[]) => {
        useServerStore.getState().updateMemberRolesLocal(userId, roles);
      });

      conn.on('MemberKicked', (serverId: string, userId: string) => {
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          useServerStore.getState().removeServer(serverId);
        } else {
          useServerStore.getState().removeMember(userId);
        }
      });

      conn.on('MemberBanned', (serverId: string, userId: string) => {
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          useServerStore.getState().removeServer(serverId);
        } else {
          useServerStore.getState().removeMember(userId);
        }
      });

      conn.on('MemberUnbanned', (_serverId: string, userId: string) => {
        useServerStore.getState().removeBanLocal(userId);
      });

      conn.on('RoleCreated', (_serverId: string, role: ServerRole) => {
        useServerStore.getState().addRoleLocal(role);
      });

      conn.on('RoleUpdated', (_serverId: string, role: ServerRole) => {
        useServerStore.getState().updateRoleLocal(role);
      });

      conn.on('RoleDeleted', (_serverId: string, roleId: string) => {
        useServerStore.getState().removeRoleLocal(roleId);
      });

      conn.on('EmojiCreated', (_serverId: string, emoji: CustomEmoji) => {
        useServerStore.getState().addEmojiLocal(emoji);
      });

      conn.on('EmojiUpdated', (_serverId: string, emoji: CustomEmoji) => {
        useServerStore.getState().updateEmojiLocal(emoji);
      });

      conn.on('EmojiDeleted', (_serverId: string, emojiId: string) => {
        useServerStore.getState().removeEmojiLocal(emojiId);
      });

      const refreshChannels = async (serverId: string) => {
        const activeServer = useServerStore.getState().activeServer;
        if (activeServer?.id !== serverId) return;
        await useServerStore.getState().fetchChannels(serverId);
      };

      conn.on('ChannelCreated', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelUpdated', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelDeleted', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelsReordered', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ChannelPermissionsUpdated', (serverId: string) => {
        refreshChannels(serverId).catch(console.error);
      });

      conn.on('ServerDeleted', (serverId: string) => {
        useServerStore.getState().removeServer(serverId);
      });

      conn.on('ServerUpdated', (_serverId: string, server: Server) => {
        useServerStore.getState().updateServerLocal(server);
      });

      conn.on('DmChannelCreated', (dm: DmChannel) => {
        useDmStore.getState().addDmChannelLocal(dm);
      });

      conn.on('NewUnreadMessage', (channelId: string, serverId: string | null) => {
        if (!serverId) {
          const activeDm = useDmStore.getState().activeDmChannel;
          if (activeDm?.id === channelId) {
            conn.invoke('MarkChannelRead', channelId).catch(console.error);
          } else {
            useUnreadStore.getState().handleNewDmUnread(channelId);
          }
          useDmStore.getState().moveDmToTop(channelId);
        } else {
          const activeChannel = useServerStore.getState().activeChannel;
          if (activeChannel?.id === channelId && activeChannel.type === 'Text') {
            conn.invoke('MarkChannelRead', channelId).catch(console.error);
          } else {
            useUnreadStore.getState().handleNewUnreadMessage(channelId, serverId);
          }
        }
      });

      conn.on('MentionReceived', (notification: { id: string; messageId: string; channelId: string; serverId: string | null; type: string; createdAt: string }) => {
        if (!notification.serverId) {
          const activeDm = useDmStore.getState().activeDmChannel;
          if (activeDm?.id === notification.channelId) {
            conn.invoke('MarkChannelRead', notification.channelId).catch(console.error);
          } else {
            useUnreadStore.getState().incrementDmMention(notification.channelId);
          }
        } else {
          const activeChannel = useServerStore.getState().activeChannel;
          if (activeChannel?.id === notification.channelId && activeChannel.type === 'Text') {
            conn.invoke('MarkChannelRead', notification.channelId).catch(console.error);
          } else {
            useUnreadStore.getState().incrementMention(notification.channelId, notification.serverId);
          }
        }
      });

      conn.on('Error', (message: string) => {
        if (message) {
          useToastStore.getState().addToast(message, 'error');
        }
      });

      conn.on('ConfigUpdated', (payload: { maxMessageLength: number } | number) => {
        const value = typeof payload === 'number' ? payload : payload?.maxMessageLength;
        if (typeof value === 'number' && value > 0) {
          useAppConfigStore.getState().setMaxMessageLength(value);
        }
      });

      refreshSignalRState(conn);
    }).catch(console.error);
  }, []);

  // Fetch voice channel users when switching servers + periodic reconciliation
  useEffect(() => {
    if (!activeServer) return;
    useSearchStore.getState().closeSearch();
    const conn = getConnection();
    if (conn.state === 'Connected') {
      fetchServerState(conn, activeServer.id);
    }

    // Periodic reconciliation: re-fetch voice state every 30s to self-heal
    // any stale state from missed signals or race conditions
    const interval = setInterval(() => {
      const c = getConnection();
      if (c.state === 'Connected') {
        c.invoke('GetServerVoiceUsers', activeServer.id).then((data: Record<string, Record<string, { displayName: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean }>>) => {
          useServerStore.getState().setVoiceChannelUsers(data);
        }).catch(console.error);
        c.invoke('GetServerVoiceSharers', activeServer.id).then((data: Record<string, string[]>) => {
          useServerStore.getState().setVoiceChannelSharers(data);
        }).catch(console.error);
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, [activeServer]);

  // Track which channel is active for typing indicators
  useEffect(() => {
    if (isDmMode && activeDmChannel) {
      usePresenceStore.getState().setTypingChannel(activeDmChannel.id);
    } else if (activeChannel?.type === 'Text') {
      usePresenceStore.getState().setTypingChannel(activeChannel.id);
    } else {
      usePresenceStore.getState().setTypingChannel(null);
    }
  }, [activeChannel, isDmMode, activeDmChannel]);

  // Auto-mark channel as read when switching to a text channel
  useEffect(() => {
    if (activeChannel?.type === 'Text' && activeServer) {
      const conn = getConnection();
      if (conn.state === 'Connected') {
        conn.invoke('MarkChannelRead', activeChannel.id).catch(console.error);
      }
      useUnreadStore.getState().markChannelRead(activeChannel.id, activeServer.id);
    }
  }, [activeChannel, activeServer]);

  // Auto-mark DM channel as read when switching
  useEffect(() => {
    if (isDmMode && activeDmChannel) {
      const conn = getConnection();
      if (conn.state === 'Connected') {
        conn.invoke('MarkChannelRead', activeDmChannel.id).catch(console.error);
      }
      useUnreadStore.getState().markDmChannelRead(activeDmChannel.id);
    }
  }, [isDmMode, activeDmChannel]);
}
