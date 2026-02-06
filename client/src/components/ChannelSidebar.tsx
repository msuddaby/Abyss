import { useState, useEffect } from 'react';
import { useServerStore } from '../stores/serverStore';
import { useMessageStore } from '../stores/messageStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useWebRTC } from '../hooks/useWebRTC';
import CreateChannelModal from './CreateChannelModal';
import InviteModal from './InviteModal';
import VoiceChannel from './VoiceChannel';
import VoiceControls from './VoiceControls';
import UserSettingsModal from './UserSettingsModal';
import ServerSettingsModal from './ServerSettingsModal';
import { API_BASE } from '../services/api';
import { hasPermission, Permission } from '../types';

export default function ChannelSidebar() {
  const { activeServer, channels, activeChannel, setActiveChannel, members, deleteChannel } = useServerStore();
  const { joinChannel, leaveChannel, fetchMessages, currentChannelId } = useMessageStore();
  const voiceChannelId = useVoiceStore((s) => s.currentChannelId);
  const { joinVoice, leaveVoice } = useWebRTC();
  const user = useAuthStore((s) => s.user);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);

  const currentMember = members.find((m) => m.userId === user?.id);
  const canManageChannels = currentMember ? hasPermission(currentMember, Permission.ManageChannels) : false;
  const canManageServer = currentMember ? hasPermission(currentMember, Permission.ManageServer) : false;
  const canViewAuditLog = currentMember ? hasPermission(currentMember, Permission.ViewAuditLog) : false;
  const canManageRoles = currentMember ? hasPermission(currentMember, Permission.ManageRoles) : false;
  const canBanMembers = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const showServerSettingsBtn = canManageServer || canViewAuditLog || canManageRoles || canBanMembers || (currentMember?.isOwner ?? false);

  // When activeChannel changes (including restore from localStorage), join + fetch messages
  useEffect(() => {
    if (activeChannel && activeChannel.type === 'Text' && currentChannelId !== activeChannel.id) {
      const join = async () => {
        if (currentChannelId) {
          await leaveChannel(currentChannelId);
        }
        await joinChannel(activeChannel.id);
      };
      join().catch(console.error);
      fetchMessages(activeChannel.id);
    }
  }, [activeChannel]);

  if (!activeServer) {
    return (
      <div className="channel-sidebar">
        <div className="channel-sidebar-header">
          <span>Select a server</span>
        </div>
      </div>
    );
  }

  const textChannels = channels.filter((c) => c.type === 'Text');
  const voiceChannels = channels.filter((c) => c.type === 'Voice');

  const handleChannelClick = (channel: typeof channels[0]) => {
    setActiveChannel(channel);
  };

  const handleVoiceJoin = async (channelId: string) => {
    await joinVoice(channelId);
  };

  const handleVoiceLeave = async () => {
    await leaveVoice();
  };

  return (
    <div className="channel-sidebar">
      <div className="channel-sidebar-header">
        <span className="server-name">{activeServer.name}</span>
        {showServerSettingsBtn && (
          <button className="server-settings-btn" onClick={() => setShowServerSettings(true)} title="Server Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
            </svg>
          </button>
        )}
      </div>
      <div className="channel-sidebar-actions">
        <button className="sidebar-action-btn" onClick={() => setShowInvite(true)}>Invite</button>
        {canManageChannels && (
          <button className="sidebar-action-btn" onClick={() => setShowCreateChannel(true)}>+ Channel</button>
        )}
      </div>
      <div className="channel-list">
        {textChannels.length > 0 && (
          <div className="channel-category">
            <span className="category-label">Text Channels</span>
            {textChannels.map((channel) => (
              <div key={channel.id} className="channel-item-wrapper">
                <button
                  className={`channel-item ${activeChannel?.id === channel.id ? 'active' : ''}`}
                  onClick={() => handleChannelClick(channel)}
                >
                  <span className="channel-hash">#</span>
                  {channel.name}
                </button>
                {canManageChannels && (
                  <button
                    className="channel-delete-btn"
                    onClick={(e) => { e.stopPropagation(); deleteChannel(activeServer.id, channel.id); }}
                    title="Delete Channel"
                  >&times;</button>
                )}
              </div>
            ))}
          </div>
        )}
        {voiceChannels.length > 0 && (
          <div className="channel-category">
            <span className="category-label">Voice Channels</span>
            {voiceChannels.map((channel) => (
              <VoiceChannel
                key={channel.id}
                channel={channel}
                isActive={activeChannel?.id === channel.id}
                isConnected={voiceChannelId === channel.id}
                onSelect={() => handleChannelClick(channel)}
                onJoin={() => handleVoiceJoin(channel.id)}
                onLeave={handleVoiceLeave}
              />
            ))}
          </div>
        )}
      </div>
      {showCreateChannel && <CreateChannelModal serverId={activeServer.id} onClose={() => setShowCreateChannel(false)} />}
      {showInvite && <InviteModal serverId={activeServer.id} onClose={() => setShowInvite(false)} />}
      <VoiceControls />
      {user && (
        <div className="user-bar">
          <div className="user-bar-avatar">
            {user.avatarUrl ? (
              <img src={user.avatarUrl.startsWith('http') ? user.avatarUrl : `${API_BASE}${user.avatarUrl}`} alt={user.displayName} />
            ) : (
              <span>{user.displayName.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div className="user-bar-info">
            <span className="user-bar-name">{user.displayName}</span>
            <span className="user-bar-username">{user.username}</span>
          </div>
          <button className="user-bar-settings" onClick={() => setShowSettings(true)} title="User Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
            </svg>
          </button>
        </div>
      )}
      {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
      {showServerSettings && activeServer && (
        <ServerSettingsModal
          serverId={activeServer.id}
          onClose={() => setShowServerSettings(false)}
        />
      )}
    </div>
  );
}
