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
import { getConnection, startConnection } from '../services/signalr';
import type { HubConnection } from '@microsoft/signalr';
import type { ServerRole } from '../types';

function fetchServerState(conn: HubConnection, serverId: string) {
  conn.invoke('GetServerVoiceUsers', serverId).then((data: Record<string, Record<string, string>>) => {
    useServerStore.getState().setVoiceChannelUsers(data);
  }).catch(console.error);

  conn.invoke('GetOnlineUsers', serverId).then((userIds: string[]) => {
    usePresenceStore.getState().setOnlineUsers(userIds);
  }).catch(console.error);
}

export default function MainLayout() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const activeServer = useServerStore((s) => s.activeServer);
  useEffect(() => {
    startConnection().then(() => {
      const conn = getConnection();

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

      conn.on('ChannelDeleted', (_serverId: string, channelId: string) => {
        useServerStore.getState().removeChannel(channelId);
      });

      conn.on('ServerDeleted', (serverId: string) => {
        useServerStore.getState().removeServer(serverId);
      });

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
    if (activeChannel?.type === 'Text') {
      usePresenceStore.getState().setTypingChannel(activeChannel.id);
    } else {
      usePresenceStore.getState().setTypingChannel(null);
    }
  }, [activeChannel]);

  return (
    <div className="main-layout">
      <ServerSidebar />
      <ChannelSidebar />
      <div className="content-area">
        {activeChannel ? (
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
      {activeServer && <MemberList />}
    </div>
  );
}
