import { useState, useEffect, useRef, useCallback } from 'react';
import { useServerStore, useMessageStore, useVoiceStore, useAuthStore, useUnreadStore, useDmStore, useFriendStore, usePresenceStore, useNotificationSettingsStore, api, getApiBase, hasPermission, Permission, canViewChannel } from '@abyss/shared';
import { useContextMenuStore } from '../stores/contextMenuStore';
import { useMobileStore, isMobile } from '../stores/mobileStore';
import { useLongPress } from '../hooks/useLongPress';
import type { Channel, DmChannel, User } from '@abyss/shared';
import { useWebRTC } from '../hooks/useWebRTC';
import CreateChannelModal from './CreateChannelModal';
import InviteModal from './InviteModal';
import VoiceChannel from './VoiceChannel';
import VoiceControls from './VoiceControls';
import UserSettingsModal from './UserSettingsModal';
import ServerSettingsModal from './ServerSettingsModal';
import AdminPanelModal from './AdminPanelModal';
import ConfirmModal from './ConfirmModal';
import EditChannelModal from './EditChannelModal';
import ChannelPermissionsModal from './ChannelPermissionsModal';
import ServerNotificationModal from './ServerNotificationModal';
import ChannelNotificationModal from './ChannelNotificationModal';
import FriendsList from './FriendsList';

export default function ChannelSidebar() {
  const { activeServer, channels, activeChannel, setActiveChannel, members, deleteChannel, renameChannel, reorderChannels, leaveServer } = useServerStore();
  const { joinChannel, leaveChannel, fetchMessages, currentChannelId } = useMessageStore();
  const voiceChannelId = useVoiceStore((s) => s.currentChannelId);
  const { joinVoice, leaveVoice } = useWebRTC();
  const user = useAuthStore((s) => s.user);
  const isSysadmin = useAuthStore((s) => s.isSysadmin);
  const channelUnreads = useUnreadStore((s) => s.channelUnreads);
  const dmUnreads = useUnreadStore((s) => s.dmUnreads);
  const { isDmMode, dmChannels, activeDmChannel, setActiveDmChannel } = useDmStore();
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [serverToLeave, setServerToLeave] = useState(false);
  const [showNewDm, setShowNewDm] = useState(false);
  const [dmSearchQuery, setDmSearchQuery] = useState('');
  const [dmSearchResults, setDmSearchResults] = useState<User[]>([]);
  const [dmSearching, setDmSearching] = useState(false);
  const [channelToDelete, setChannelToDelete] = useState<Channel | null>(null);
  const [channelToEdit, setChannelToEdit] = useState<Channel | null>(null);
  const [channelToEditPermissions, setChannelToEditPermissions] = useState<Channel | null>(null);
  const [showNotifSettings, setShowNotifSettings] = useState(false);
  const [notifChannel, setNotifChannel] = useState<Channel | null>(null);
  const [showServerDropdown, setShowServerDropdown] = useState(false);
  const serverDropdownRef = useRef<HTMLDivElement>(null);
  const [draggingChannelId, setDraggingChannelId] = useState<string | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<string | null>(null);
  const [dragType, setDragType] = useState<'Text' | 'Voice' | null>(null);
  const dmSearchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dmSearchInputRef = useRef<HTMLInputElement>(null);
  const openContextMenu = useContextMenuStore((s) => s.open);
  const [dmTab, setDmTab] = useState<'messages' | 'friends'>('messages');
  const pendingRequestCount = useFriendStore((s) => s.requests.filter((r) => !r.isOutgoing).length);

  const currentMember = members.find((m) => m.userId === user?.id);
  const canManageChannels = currentMember ? hasPermission(currentMember, Permission.ManageChannels) : false;
  const canManageServer = currentMember ? hasPermission(currentMember, Permission.ManageServer) : false;
  const canViewAuditLog = currentMember ? hasPermission(currentMember, Permission.ViewAuditLog) : false;
  const canManageRoles = currentMember ? hasPermission(currentMember, Permission.ManageRoles) : false;
  const canBanMembers = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const showServerSettingsBtn = canManageServer || canViewAuditLog || canManageRoles || canBanMembers || (currentMember?.isOwner ?? false);

  // When activeChannel changes (including restore from localStorage), join + fetch messages
  useEffect(() => {
    if (activeChannel && activeChannel.type === 'Text') {
      if (currentChannelId !== activeChannel.id) {
        const switchChannel = async () => {
          if (currentChannelId) {
            await leaveChannel(currentChannelId);
          }
          // Join SignalR group BEFORE fetching messages so any message sent
          // during/after the fetch is caught by the group subscription
          await joinChannel(activeChannel.id);
          fetchMessages(activeChannel.id);
        };
        switchChannel().catch(console.error);
      } else {
        // Returning to the same text channel (e.g., after viewing a voice channel).
        // MessageList was unmounted so messages received while away were lost — refetch.
        fetchMessages(activeChannel.id);
      }
    }
  }, [activeChannel]);


  const isServerMuted = useNotificationSettingsStore((s) => activeServer ? s.isServerMuted(activeServer.id) : false);
  const channelSettingsMap = useNotificationSettingsStore((s) => s.channelSettings);

  useEffect(() => {
    if (!showServerDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (serverDropdownRef.current && !serverDropdownRef.current.contains(e.target as Node)) {
        setShowServerDropdown(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [showServerDropdown]);

  const handleChannelContextMenu = (channel: Channel) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY,
      { channel },
      {
        onChannelNotifSettings: () => setNotifChannel(channel),
        ...(canManageChannels ? {
          onEditChannel: () => setChannelToEdit(channel),
          onChannelPermissions: () => setChannelToEditPermissions(channel),
          onDeleteChannel: () => setChannelToDelete(channel),
        } : {}),
      }
    );
  };

  const longPressChannelRef = useRef<Channel | null>(null);
  const channelLongPress = useLongPress(useCallback((x: number, y: number) => {
    const channel = longPressChannelRef.current;
    if (!channel) return;
    openContextMenu(x, y,
      { channel },
      {
        onChannelNotifSettings: () => setNotifChannel(channel),
        ...(canManageChannels ? {
          onEditChannel: () => setChannelToEdit(channel),
          onChannelPermissions: () => setChannelToEditPermissions(channel),
          onDeleteChannel: () => setChannelToDelete(channel),
        } : {}),
      }
    );
  }, [canManageChannels, openContextMenu]));

  // DM mode rendering
  if (isDmMode) {
    const handleDmClick = async (dm: DmChannel) => {
      if (isMobile()) useMobileStore.getState().closeLeftDrawer();
      // Leave previous channel if any
      if (currentChannelId) {
        await leaveChannel(currentChannelId).catch(console.error);
      }
      setActiveDmChannel(dm);
      await joinChannel(dm.id).catch(console.error);
      fetchMessages(dm.id);
    };

    const handleDmSearch = (query: string) => {
      setDmSearchQuery(query);
      if (dmSearchTimeout.current) clearTimeout(dmSearchTimeout.current);
      if (!query.trim()) {
        setDmSearchResults([]);
        setDmSearching(false);
        return;
      }
      setDmSearching(true);
      dmSearchTimeout.current = setTimeout(async () => {
        try {
          const res = await api.get('/dm/search', { params: { q: query } });
          setDmSearchResults(res.data);
        } catch {
          setDmSearchResults([]);
        } finally {
          setDmSearching(false);
        }
      }, 300);
    };

    const handleSelectUser = async (selectedUser: User) => {
      const { createOrGetDm } = useDmStore.getState();
      const dm = await createOrGetDm(selectedUser.id);
      setShowNewDm(false);
      setDmSearchQuery('');
      setDmSearchResults([]);
      await handleDmClick(dm);
    };

    return (
      <div className="channel-sidebar">
        <div className="channel-sidebar-header">
          <div className="dm-tabs">
            <button className={`dm-tab${dmTab === 'messages' ? ' active' : ''}`} onClick={() => setDmTab('messages')}>Messages</button>
            <button className={`dm-tab${dmTab === 'friends' ? ' active' : ''}`} onClick={() => setDmTab('friends')}>
              Friends
              {pendingRequestCount > 0 && <span className="friend-request-badge">{pendingRequestCount}</span>}
            </button>
          </div>
          {dmTab === 'messages' && (
            <button
              className="new-dm-btn"
              onClick={() => { setShowNewDm(!showNewDm); setTimeout(() => dmSearchInputRef.current?.focus(), 0); }}
              title="New Message"
            >+</button>
          )}
        </div>
        {dmTab === 'messages' ? (
          <>
            {showNewDm && (
              <div className="dm-search-container">
                <input
                  ref={dmSearchInputRef}
                  className="dm-search-input"
                  type="text"
                  placeholder="Find or start a conversation"
                  value={dmSearchQuery}
                  onChange={(e) => handleDmSearch(e.target.value)}
                  autoFocus
                />
                {dmSearchQuery.trim() && (
                  <div className="dm-search-results">
                    {dmSearching && <div className="dm-search-empty">Searching...</div>}
                    {!dmSearching && dmSearchResults.length === 0 && <div className="dm-search-empty">No users found</div>}
                    {dmSearchResults.map((u) => (
                      <button key={u.id} className="dm-search-result-item" onClick={() => handleSelectUser(u)}>
                        <div className="dm-avatar">
                          {u.avatarUrl ? (
                            <img src={u.avatarUrl.startsWith('http') ? u.avatarUrl : `${getApiBase()}${u.avatarUrl}`} alt={u.displayName} />
                          ) : (
                            <span>{u.displayName.charAt(0).toUpperCase()}</span>
                          )}
                        </div>
                        <div className="dm-search-result-info">
                          <span className="dm-search-result-name">{u.displayName}</span>
                          <span className="dm-search-result-username">{u.username}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="channel-list">
              {dmChannels.length === 0 && !showNewDm && (
                <div className="dm-empty">
                  <p style={{ color: 'var(--text-muted)', padding: '16px', fontSize: '13px' }}>No conversations yet. Click + to start one.</p>
                </div>
              )}
              {dmChannels.map((dm) => {
                const unread = dmUnreads.get(dm.id);
                const hasUnread = unread?.hasUnread && activeDmChannel?.id !== dm.id;
                const mentionCount = unread?.mentionCount || 0;
                const isOnline = onlineUsers.has(dm.otherUser.id);

                return (
                  <div key={dm.id} className="channel-item-wrapper">
                    {hasUnread && <div className="channel-unread-dot" />}
                    <button
                      className={`channel-item dm-channel-item ${activeDmChannel?.id === dm.id ? 'active' : ''}${hasUnread ? ' unread' : ''}`}
                      onClick={() => handleDmClick(dm)}
                    >
                      <div className="dm-avatar">
                        {dm.otherUser.avatarUrl ? (
                          <img src={dm.otherUser.avatarUrl.startsWith('http') ? dm.otherUser.avatarUrl : `${getApiBase()}${dm.otherUser.avatarUrl}`} alt={dm.otherUser.displayName} />
                        ) : (
                          <span>{dm.otherUser.displayName.charAt(0).toUpperCase()}</span>
                        )}
                        <span className={`presence-dot ${isOnline ? 'online' : 'offline'}`} />
                      </div>
                      <span className="dm-channel-name">{dm.otherUser.displayName}</span>
                      {mentionCount > 0 && activeDmChannel?.id !== dm.id && (
                        <span className="mention-badge">{mentionCount}</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <FriendsList />
        )}
        <VoiceControls />
        {user && (
          <UserBar
            user={user}
            onSettings={() => setShowSettings(true)}
            onAdmin={isSysadmin ? () => setShowAdminPanel(true) : undefined}
          />
        )}
        {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
        {showAdminPanel && <AdminPanelModal onClose={() => setShowAdminPanel(false)} />}
      </div>
    );
  }

  if (!activeServer) {
    return (
      <div className="channel-sidebar">
        <div className="channel-sidebar-header">
          <span>Select a server</span>
        </div>
      </div>
    );
  }

  const visibleChannels = channels.filter((c) => canViewChannel(c));
  const textChannels = visibleChannels.filter((c) => c.type === 'Text');
  const voiceChannels = visibleChannels.filter((c) => c.type === 'Voice');

  const handleChannelClick = (channel: Channel) => {
    if (isMobile()) useMobileStore.getState().closeLeftDrawer();
    setActiveChannel(channel);
  };

  const handleVoiceJoin = async (channelId: string) => {
    await joinVoice(channelId);
  };

  const handleVoiceLeave = async () => {
    await leaveVoice();
  };

  const handleDragStart = (channel: Channel, type: 'Text' | 'Voice') => (e: React.DragEvent) => {
    if (!canManageChannels) return;
    setDraggingChannelId(channel.id);
    setDragType(type);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', channel.id);
  };

  const handleDragOver = (channel: Channel, type: 'Text' | 'Voice') => (e: React.DragEvent) => {
    if (!canManageChannels || dragType !== type) return;
    e.preventDefault();
    setDragOverChannelId(channel.id);
  };

  const handleDrop = (channel: Channel, type: 'Text' | 'Voice') => async (e: React.DragEvent) => {
    if (!canManageChannels || dragType !== type) return;
    e.preventDefault();

    const draggedId = draggingChannelId;
    if (!draggedId || draggedId === channel.id || !activeServer) {
      setDraggingChannelId(null);
      setDragOverChannelId(null);
      setDragType(null);
      return;
    }

    const list = type === 'Text' ? textChannels : voiceChannels;
    const fromIndex = list.findIndex((c) => c.id === draggedId);
    const toIndex = list.findIndex((c) => c.id === channel.id);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      setDraggingChannelId(null);
      setDragOverChannelId(null);
      setDragType(null);
      return;
    }

    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);

    try {
      await reorderChannels(activeServer.id, type, next.map((c) => c.id));
    } catch {
      // errors handled in store
    } finally {
      setDraggingChannelId(null);
      setDragOverChannelId(null);
      setDragType(null);
    }
  };

  const handleDragEnd = () => {
    setDraggingChannelId(null);
    setDragOverChannelId(null);
    setDragType(null);
  };

  return (
    <div className="channel-sidebar">
      <div className="channel-sidebar-header" ref={serverDropdownRef}>
        <button className="server-name-btn" onClick={() => setShowServerDropdown(!showServerDropdown)}>
          <span className="server-name">{activeServer.name}</span>
          {isServerMuted && <span className="mute-icon" title="Muted">&#128277;&#xFE0E;</span>}
          <svg className="server-dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        {showServerDropdown && (
          <div className="server-dropdown-menu context-menu">
            <button
              className="context-menu-item"
              onClick={() => { setShowNotifSettings(true); setShowServerDropdown(false); }}
            >
              Notification Settings
            </button>
            <button
              className="context-menu-item"
              onClick={() => { setShowInvite(true); setShowServerDropdown(false); }}
            >
              Invite People
            </button>
            {showServerSettingsBtn && (
              <button
                className="context-menu-item"
                onClick={() => { setShowServerSettings(true); setShowServerDropdown(false); }}
              >
                Server Settings
              </button>
            )}
            {activeServer.ownerId !== user?.id && (
              <>
                <div className="context-menu-separator" />
                <button
                  className="context-menu-item danger"
                  onClick={() => { setServerToLeave(true); setShowServerDropdown(false); }}
                >
                  Leave Server
                </button>
              </>
            )}
          </div>
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
            {textChannels.map((channel) => {
              const unread = channelUnreads.get(channel.id);
              const hasUnread = unread?.hasUnread && activeChannel?.id !== channel.id;
              const mentionCount = unread?.mentionCount || 0;
              const chMuted = channelSettingsMap.get(channel.id);
              const isChMuted = chMuted?.muteUntil ? new Date(chMuted.muteUntil) > new Date() : false;
              return (
                <div
                  key={channel.id}
                  className={`channel-item-wrapper${dragOverChannelId === channel.id ? ' drag-over' : ''}${draggingChannelId === channel.id ? ' dragging' : ''}`}
                  draggable={canManageChannels && !isMobile()}
                  onDragStart={handleDragStart(channel, 'Text')}
                  onDragOver={handleDragOver(channel, 'Text')}
                  onDrop={handleDrop(channel, 'Text')}
                  onDragEnd={handleDragEnd}
                  onContextMenu={handleChannelContextMenu(channel)}
                  onTouchStart={(e) => { longPressChannelRef.current = channel; channelLongPress.onTouchStart(e); }}
                  onTouchMove={channelLongPress.onTouchMove}
                  onTouchEnd={channelLongPress.onTouchEnd}
                >
                  {hasUnread && <div className="channel-unread-dot" />}
                  <button
                    className={`channel-item ${activeChannel?.id === channel.id ? 'active' : ''}${hasUnread ? ' unread' : ''}${isChMuted ? ' muted-channel' : ''}`}
                    onClick={() => handleChannelClick(channel)}
                  >
                    <span className="channel-hash">#</span>
                    {channel.name}
                    {isChMuted && <span className="channel-mute-icon" title="Muted">&#128277;&#xFE0E;</span>}
                    {mentionCount > 0 && activeChannel?.id !== channel.id && (
                      <span className="mention-badge">{mentionCount}</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {voiceChannels.length > 0 && (
          <div className="channel-category">
            <span className="category-label">Voice Channels</span>
            {voiceChannels.map((channel) => (
              <div
                key={channel.id}
                className={`channel-item-wrapper voice${dragOverChannelId === channel.id ? ' drag-over' : ''}${draggingChannelId === channel.id ? ' dragging' : ''}`}
                draggable={canManageChannels && !isMobile()}
                onDragStart={handleDragStart(channel, 'Voice')}
                onDragOver={handleDragOver(channel, 'Voice')}
                onDrop={handleDrop(channel, 'Voice')}
                onDragEnd={handleDragEnd}
                onContextMenu={handleChannelContextMenu(channel)}
                onTouchStart={(e) => { longPressChannelRef.current = channel; channelLongPress.onTouchStart(e); }}
                onTouchMove={channelLongPress.onTouchMove}
                onTouchEnd={channelLongPress.onTouchEnd}
              >
                <VoiceChannel
                  channel={channel}
                  isActive={activeChannel?.id === channel.id}
                  isConnected={voiceChannelId === channel.id}
                  onSelect={() => handleChannelClick(channel)}
                  onJoin={() => handleVoiceJoin(channel.id)}
                  onLeave={handleVoiceLeave}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreateChannel && <CreateChannelModal serverId={activeServer.id} onClose={() => setShowCreateChannel(false)} />}
      {showInvite && <InviteModal serverId={activeServer.id} onClose={() => setShowInvite(false)} />}
      <VoiceControls />
      {user && (
        <UserBar
          user={user}
          onSettings={() => setShowSettings(true)}
          onAdmin={isSysadmin ? () => setShowAdminPanel(true) : undefined}
        />
      )}
      {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
      {showAdminPanel && <AdminPanelModal onClose={() => setShowAdminPanel(false)} />}
      {showServerSettings && activeServer && (
        <ServerSettingsModal
          serverId={activeServer.id}
          onClose={() => setShowServerSettings(false)}
        />
      )}
      {channelToEdit && activeServer && (
        <EditChannelModal
          initialName={channelToEdit.name}
          channelType={channelToEdit.type}
          initialPersistentChat={channelToEdit.persistentChat}
          initialUserLimit={channelToEdit.userLimit}
          onSave={async (name, persistentChat, userLimit) => { await renameChannel(activeServer.id, channelToEdit.id, name, persistentChat, userLimit); }}
          onClose={() => setChannelToEdit(null)}
        />
      )}
      {channelToEditPermissions && activeServer && (
        <ChannelPermissionsModal
          serverId={activeServer.id}
          channelId={channelToEditPermissions.id}
          channelName={channelToEditPermissions.name}
          onClose={() => setChannelToEditPermissions(null)}
        />
      )}
      {channelToDelete && activeServer && (
        <ConfirmModal
          title={`Delete ${channelToDelete.type} Channel`}
          message={`Delete ${channelToDelete.type === 'Text' ? '#' : ''}${channelToDelete.type === 'Voice' ? 'voice ' : ''}${channelToDelete.name}? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteChannel(activeServer.id, channelToDelete.id)}
          onClose={() => setChannelToDelete(null)}
        />
      )}
      {serverToLeave && activeServer && (
        <ConfirmModal
          title={`Leave ${activeServer.name}?`}
          message={`You will lose access to ${activeServer.name}.`}
          confirmLabel="Leave"
          danger
          onConfirm={async () => {
            await leaveServer(activeServer.id);
            setServerToLeave(false);
          }}
          onClose={() => setServerToLeave(false)}
        />
      )}
      {showNotifSettings && activeServer && (
        <ServerNotificationModal
          serverId={activeServer.id}
          onClose={() => setShowNotifSettings(false)}
        />
      )}
      {notifChannel && activeServer && (
        <ChannelNotificationModal
          serverId={activeServer.id}
          channelId={notifChannel.id}
          channelName={notifChannel.name}
          onClose={() => setNotifChannel(null)}
        />
      )}
    </div>
  );
}

function UserBar({
  user,
  onSettings,
  onAdmin,
}: {
  user: { id: string; displayName: string; username: string; avatarUrl?: string | null };
  onSettings: () => void;
  onAdmin?: () => void;
}) {
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const voiceChannelUsers = useServerStore((s) => s.voiceChannelUsers);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const voiceState = currentChannelId ? voiceChannelUsers.get(currentChannelId)?.get(user.id) : null;
  const isServerMuted = !!voiceState?.isServerMuted;
  const isServerDeafened = !!voiceState?.isServerDeafened;

  return (
    <div className="user-bar">
      <div className="user-bar-avatar">
        {user.avatarUrl ? (
          <img src={user.avatarUrl.startsWith('http') ? user.avatarUrl : `${getApiBase()}${user.avatarUrl}`} alt={user.displayName} />
        ) : (
          <span>{user.displayName.charAt(0).toUpperCase()}</span>
        )}
      </div>
      <div className="user-bar-info">
        <span className="user-bar-name">{user.displayName}</span>
        <span className="user-bar-username">{user.username}</span>
      </div>
      <button
        className={`user-bar-btn ${isMuted ? 'active' : ''}`}
        onClick={toggleMute}
        title={isServerMuted ? 'Server muted' : (isMuted ? 'Unmute' : 'Mute')}
        disabled={isServerMuted}
      >
        {isMuted ? '🔇' : '🎤'}
      </button>
      <button
        className={`user-bar-btn ${isDeafened ? 'active' : ''}`}
        onClick={toggleDeafen}
        title={isServerDeafened ? 'Server deafened' : (isDeafened ? 'Undeafen' : 'Deafen')}
        disabled={isServerDeafened}
      >
        {isDeafened ? '🔇' : '🎧'}
      </button>
      <button className="user-bar-settings" onClick={onSettings} title="User Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
        </svg>
      </button>
      {onAdmin && (
        <button className="user-bar-settings admin-shield" onClick={onAdmin} title="Admin Control Panel">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l7 3v6c0 5-3.5 9.7-7 11-3.5-1.3-7-6-7-11V5l7-3zm0 2.2L7 5.5v5.4c0 4.2 2.8 7.9 5 8.8 2.2-.9 5-4.6 5-8.8V5.5l-5-1.3z" />
          </svg>
        </button>
      )}
    </div>
  );
}
