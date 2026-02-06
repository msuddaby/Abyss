import { useEffect } from 'react';
import ServerSidebar from '../components/ServerSidebar';
import ChannelSidebar from '../components/ChannelSidebar';
import MessageList from '../components/MessageList';
import MessageInput from '../components/MessageInput';

import ScreenShareView from '../components/ScreenShareView';
import TypingIndicator from '../components/TypingIndicator';
import MemberList from '../components/MemberList';
import { useServerStore } from '../stores/serverStore';
import { useAuthStore } from '../stores/authStore';

import { usePresenceStore } from '../stores/presenceStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useDmStore } from '../stores/dmStore';
import { getConnection, startConnection } from '../services/signalr';
import type { HubConnection } from '@microsoft/signalr';
import type { ServerRole, CustomEmoji, DmChannel } from '../types';

function fetchServerState(conn: HubConnection, serverId: string) {
  conn.invoke('GetServerVoiceUsers', serverId).then((data: Record<string, Record<string, string>>) => {
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

export default function MainLayout() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const activeServer = useServerStore((s) => s.activeServer);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);

  useEffect(() => {
    startConnection().then(() => {
      const conn = getConnection();

      // Remove any previous handlers to prevent double registration (React StrictMode)
      const events = [
        'UserOnline', 'UserOffline', 'UserIsTyping',
        'VoiceUserJoinedChannel', 'VoiceUserLeftChannel',
        'ScreenShareStartedInChannel', 'ScreenShareStoppedInChannel',
        'UserProfileUpdated', 'MemberRolesUpdated', 'MemberKicked', 'MemberBanned', 'MemberUnbanned',
        'RoleCreated', 'RoleUpdated', 'RoleDeleted',
        'EmojiCreated', 'EmojiUpdated', 'EmojiDeleted',
        'ChannelCreated', 'ChannelDeleted', 'ServerDeleted',
        'NewUnreadMessage', 'MentionReceived',
        'DmChannelCreated',
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

      conn.on('VoiceUserJoinedChannel', (channelId: string, userId: string, displayName: string) => {
        useServerStore.getState().voiceUserJoined(channelId, userId, displayName);
      });

      conn.on('VoiceUserLeftChannel', (channelId: string, userId: string) => {
        useServerStore.getState().voiceUserLeft(channelId, userId);
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

      conn.on('MemberKicked', (_serverId: string, userId: string) => {
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          const serverId = useServerStore.getState().activeServer?.id;
          if (serverId) {
            useServerStore.getState().removeServer(serverId);
          }
        } else {
          useServerStore.getState().removeMember(userId);
        }
      });

      conn.on('MemberBanned', (_serverId: string, userId: string) => {
        const currentUser = useAuthStore.getState().user;
        if (currentUser?.id === userId) {
          const serverId = useServerStore.getState().activeServer?.id;
          if (serverId) {
            useServerStore.getState().removeServer(serverId);
          }
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

      conn.on('ChannelCreated', (_serverId: string, channel: { id: string; name: string; type: 'Text' | 'Voice'; serverId: string; position: number }) => {
        useServerStore.getState().addChannelLocal(channel);
      });

      conn.on('ChannelDeleted', (_serverId: string, channelId: string) => {
        useServerStore.getState().removeChannel(channelId);
      });

      conn.on('ServerDeleted', (serverId: string) => {
        useServerStore.getState().removeServer(serverId);
      });

      // DM channel created by other user
      conn.on('DmChannelCreated', (dm: DmChannel) => {
        useDmStore.getState().addDmChannelLocal(dm);
      });

      // Unread & mention listeners
      conn.on('NewUnreadMessage', (channelId: string, serverId: string | null) => {
        if (!serverId) {
          // DM unread
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
          // DM mention
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

      // Fetch initial server unreads for sidebar badges
      conn.invoke('GetAllServerUnreads').then((unreads: { serverId: string; hasUnread: boolean; mentionCount: number }[]) => {
        useUnreadStore.getState().setServerUnreads(unreads);
      }).catch(console.error);

      // Fetch DM channels and DM unreads
      conn.invoke('GetDmChannels').then((dms: DmChannel[]) => {
        useDmStore.setState({ dmChannels: dms });
      }).catch(console.error);

      conn.invoke('GetDmUnreads').then((unreads: { channelId: string; hasUnread: boolean; mentionCount: number }[]) => {
        useUnreadStore.getState().setDmUnreads(unreads);
      }).catch(console.error);

      // Fetch voice users if a server was already restored before connection was ready
      const server = useServerStore.getState().activeServer;
      if (server) {
        fetchServerState(conn, server.id);
      }
    }).catch(console.error);
  }, []);

  // Fetch voice channel users when switching servers
  useEffect(() => {
    if (!activeServer) return;
    const conn = getConnection();
    if (conn.state === 'Connected') {
      fetchServerState(conn, activeServer.id);
    }
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

  return (
    <div className="main-layout">
      <ServerSidebar />
      <ChannelSidebar />
      <div className="content-area">
        {isDmMode && activeDmChannel ? (
          <>
            <div className="channel-header">
              <span className="channel-dm-icon">@</span>
              <span className="channel-name">{activeDmChannel.otherUser.displayName}</span>
            </div>
            <MessageList />
            <TypingIndicator />
            <MessageInput />
          </>
        ) : activeChannel ? (
          activeChannel.type === 'Text' ? (
            <>
              <div className="channel-header">
                <span className="channel-hash">#</span>
                <span className="channel-name">{activeChannel.name}</span>
              </div>
              <MessageList />
              <TypingIndicator />
              <MessageInput />
            </>
          ) : (
            <div className="voice-channel-view">
              <div className="channel-header">
                <span className="channel-voice-icon">🔊</span>
                <span className="channel-name">{activeChannel.name}</span>
              </div>
              <div className="voice-channel-content">
                <ScreenShareView />
              </div>
            </div>
          )
        ) : (
          <div className="no-channel">
            <h2>Welcome to Abyss</h2>
            <p>Select a channel to start chatting</p>
          </div>
        )}
      </div>
      {activeServer && !isDmMode && <MemberList />}
    </div>
  );
}
