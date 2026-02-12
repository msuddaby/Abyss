import { useState, useEffect, useRef } from 'react';
import { useServerStore, useAuthStore, useMediaProviderStore, useSoundboardStore, getApiBase, hasPermission, Permission, getDisplayColor, getHighestRole, canActOn, NotificationLevel, api } from '@abyss/shared';
import type { AuditLog, ServerRole, ServerMember } from '@abyss/shared';
import AudioTrimmer from './AudioTrimmer';

const ACTION_LABELS: Record<string, string> = {
  MessageDeleted: 'Deleted a message',
  ChannelCreated: 'Created channel',
  ChannelDeleted: 'Deleted channel',
  ChannelUpdated: 'Updated channel',
  MemberKicked: 'Kicked',
  MemberPromoted: 'Promoted',
  MemberDemoted: 'Demoted',
  ServerDeleted: 'Deleted server',
  MemberBanned: 'Banned',
  MemberUnbanned: 'Unbanned',
  RoleCreated: 'Created role',
  RoleUpdated: 'Updated role',
  RoleDeleted: 'Deleted role',
  MemberRolesUpdated: 'Updated roles of',
  MemberLeft: 'Left the server',
  EmojiCreated: 'Created emoji',
  EmojiDeleted: 'Deleted emoji',
  ServerUpdated: 'Updated server',
  MessagePinned: 'Pinned a message',
  MessageUnpinned: 'Unpinned a message',
  MediaProviderLinked: 'Linked media provider',
  MediaProviderUnlinked: 'Unlinked media provider',
  WatchPartyStarted: 'Started watch party',
  WatchPartyStopped: 'Stopped watch party',
  SoundboardClipUploaded: 'Uploaded soundboard clip',
  SoundboardClipDeleted: 'Deleted soundboard clip',
};

const ACTION_ICONS: Record<string, string> = {
  MessageDeleted: '\u{1F5D1}',
  ChannelCreated: '\u{2795}',
  ChannelDeleted: '\u{2796}',
  ChannelUpdated: '\u{270F}',
  MemberKicked: '\u{1F6AB}',
  MemberPromoted: '\u{2B06}',
  MemberDemoted: '\u{2B07}',
  ServerDeleted: '\u{1F4A5}',
  MemberBanned: '\u{1F6D1}',
  MemberUnbanned: '\u{2705}',
  RoleCreated: '\u{1F3F7}',
  RoleUpdated: '\u{270F}',
  RoleDeleted: '\u{274C}',
  MemberRolesUpdated: '\u{1F465}',
  MemberLeft: '\u{1F6AA}',
  EmojiCreated: '\u{1F600}',
  EmojiDeleted: '\u{274C}',
  ServerUpdated: '\u{270F}',
  MessagePinned: '\u{1F4CC}',
  MessageUnpinned: '\u{1F4CC}',
  MediaProviderLinked: '\u{1F3AC}',
  MediaProviderUnlinked: '\u{274C}',
  WatchPartyStarted: '\u{1F389}',
  WatchPartyStopped: '\u{23F9}',
  SoundboardClipUploaded: '\u{1F50A}',
  SoundboardClipDeleted: '\u{274C}',
};

const PERMISSION_SECTIONS: { section: string; perms: { perm: number; label: string; description: string }[] }[] = [
  {
    section: 'General',
    perms: [
      { perm: Permission.ViewChannel, label: 'View Channels', description: 'Allows members to view channels' },
      { perm: Permission.ManageChannels, label: 'Manage Channels', description: 'Create, edit, and delete channels' },
      { perm: Permission.ManageServer, label: 'Manage Server', description: 'Edit server name, icon, and settings' },
      { perm: Permission.ManageRoles, label: 'Manage Roles', description: 'Create, edit, and assign roles' },
      { perm: Permission.ManageEmojis, label: 'Manage Emojis', description: 'Upload and delete custom emojis' },
      { perm: Permission.ManageInvites, label: 'Manage Invites', description: 'Create and manage invite links' },
      { perm: Permission.ViewAuditLog, label: 'View Audit Log', description: 'View the server audit log' },
    ],
  },
  {
    section: 'Membership',
    perms: [
      { perm: Permission.KickMembers, label: 'Kick Members', description: 'Remove members from the server' },
      { perm: Permission.BanMembers, label: 'Ban Members', description: 'Permanently ban members' },
      { perm: Permission.MuteMembers, label: 'Mute Members', description: 'Server-mute members in voice' },
    ],
  },
  {
    section: 'Text Channels',
    perms: [
      { perm: Permission.SendMessages, label: 'Send Messages', description: 'Send messages in text channels' },
      { perm: Permission.ManageMessages, label: 'Manage Messages', description: 'Delete and pin messages by others' },
      { perm: Permission.ReadMessageHistory, label: 'Read Message History', description: 'Read previous messages in channels' },
      { perm: Permission.AddReactions, label: 'Add Reactions', description: 'Add reactions to messages' },
      { perm: Permission.AttachFiles, label: 'Attach Files', description: 'Upload files and images' },
      { perm: Permission.MentionEveryone, label: 'Mention @everyone', description: 'Use @everyone and @here mentions' },
    ],
  },
  {
    section: 'Voice Channels',
    perms: [
      { perm: Permission.Connect, label: 'Connect', description: 'Join voice channels' },
      { perm: Permission.Speak, label: 'Speak', description: 'Talk in voice channels' },
      { perm: Permission.Stream, label: 'Stream', description: 'Share screen in voice channels' },
      { perm: Permission.ManageSoundboard, label: 'Manage Soundboard', description: 'Upload and delete soundboard clips' },
      { perm: Permission.UseSoundboard, label: 'Use Soundboard', description: 'Play soundboard clips in voice channels' },
    ],
  },
];

const ROLE_COLOR_PRESETS = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245',
  '#f47b67', '#f8a532', '#2ecc71', '#1abc9c', '#3498db',
  '#9b59b6', '#e91e63', '#e74c3c', '#11806a', '#1f8b4c',
  '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300',
];

function formatTimestamp(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString();
}

type Tab = 'server' | 'members' | 'roles' | 'emojis' | 'soundboard' | 'media' | 'bans' | 'audit' | 'danger';

export default function ServerSettingsModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const { fetchAuditLogs, deleteServer, activeServer, fetchBans, unbanMember, kickMember, banMember } = useServerStore();
  const channels = useServerStore((s) => s.channels);
  const members = useServerStore((s) => s.members);
  const roles = useServerStore((s) => s.roles);
  const bans = useServerStore((s) => s.bans);
  const currentUser = useAuthStore((s) => s.user);
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const isOwner = currentMember?.isOwner ?? false;
  const canManageRoles = currentMember ? hasPermission(currentMember, Permission.ManageRoles) : false;
  const canKick = currentMember ? hasPermission(currentMember, Permission.KickMembers) : false;
  const canBan = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const canViewAuditLog = currentMember ? hasPermission(currentMember, Permission.ViewAuditLog) : false;
  const canManageEmojis = currentMember ? hasPermission(currentMember, Permission.ManageEmojis) : false;
  const canManageSoundboard = currentMember ? hasPermission(currentMember, Permission.ManageSoundboard) : false;
  const canManageServer = currentMember ? hasPermission(currentMember, Permission.ManageServer) : false;
  const canManageAnyMembers = canManageRoles || canKick || canBan;

  const [tab, setTab] = useState<Tab>(
    canManageServer ? 'server'
      : canManageAnyMembers ? 'members'
      : canManageRoles ? 'roles'
      : canViewAuditLog ? 'audit'
      : 'danger',
  );

  // Members tab state
  const [memberSearch, setMemberSearch] = useState('');
  const [roleAssignTarget, setRoleAssignTarget] = useState<ServerMember | null>(null);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  // Role editor state
  const [editingRole, setEditingRole] = useState<ServerRole | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#99aab5');
  const [rolePerms, setRolePerms] = useState(0);
  const [roleDisplaySeparately, setRoleDisplaySeparately] = useState(false);
  const [creating, setCreating] = useState(false);

  // Emoji tab state
  const emojis = useServerStore((s) => s.emojis);
  const [emojiName, setEmojiName] = useState('');
  const [emojiFile, setEmojiFile] = useState<File | null>(null);
  const [emojiPreview, setEmojiPreview] = useState<string | null>(null);
  const [emojiUploading, setEmojiUploading] = useState(false);
  const [emojiError, setEmojiError] = useState('');

  // Soundboard tab state
  const soundboardClips = useSoundboardStore((s) => s.clips);
  const [sbName, setSbName] = useState('');
  const [sbFile, setSbFile] = useState<File | null>(null);
  const [sbTrimming, setSbTrimming] = useState(false);
  const [sbUploading, setSbUploading] = useState(false);
  const [sbError, setSbError] = useState('');
  const sbFileRef = useRef<HTMLInputElement>(null);
  const [sbPreviewAudio, setSbPreviewAudio] = useState<HTMLAudioElement | null>(null);
  const [sbPreviewClipId, setSbPreviewClipId] = useState<string | null>(null);

  // Media provider state
  const mediaConnections = useMediaProviderStore((s) => s.connections);
  const [mpProviderType, setMpProviderType] = useState('Plex');
  const [mpDisplayName, setMpDisplayName] = useState('');
  const [mpServerUrl, setMpServerUrl] = useState('');
  const [mpAuthToken, setMpAuthToken] = useState('');
  const [mpError, setMpError] = useState('');
  const [mpLinking, setMpLinking] = useState(false);

  // Server settings
  const [serverName, setServerName] = useState(activeServer?.name ?? '');
  const [serverIconFile, setServerIconFile] = useState<File | null>(null);
  const [serverIconPreview, setServerIconPreview] = useState<string | null>(null);
  const [serverSaving, setServerSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const [joinLeaveEnabled, setJoinLeaveEnabled] = useState(activeServer?.joinLeaveMessagesEnabled ?? true);
  const [joinLeaveChannelId, setJoinLeaveChannelId] = useState<string>('');
  const [defaultNotifLevel, setDefaultNotifLevel] = useState(activeServer?.defaultNotificationLevel ?? 0);

  useEffect(() => {
    if (tab === 'audit' && canViewAuditLog) {
      fetchAuditLogs(serverId).then(setLogs).catch(console.error);
    }
    if (tab === 'bans' && canBan) {
      fetchBans(serverId);
    }
    if (tab === 'media' && canManageServer) {
      useMediaProviderStore.getState().fetchConnections(serverId);
    }
  }, [tab, serverId]);

  useEffect(() => {
    if (activeServer) {
      setServerName(activeServer.name);
      setServerIconFile(null);
      setServerIconPreview(null);
      setServerError('');
      const textChannels = channels.filter((c) => c.type === 'Text');
      setJoinLeaveEnabled(activeServer.joinLeaveMessagesEnabled);
      setJoinLeaveChannelId(activeServer.joinLeaveChannelId ?? textChannels[0]?.id ?? '');
    }
  }, [activeServer?.id, channels]);

  useEffect(() => {
    if (!serverIconFile) return;
    const url = URL.createObjectURL(serverIconFile);
    setServerIconPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [serverIconFile]);

  const handleDelete = async () => {
    if (!activeServer || confirmName !== activeServer.name) return;
    setDeleting(true);
    try {
      await deleteServer(serverId);
      onClose();
    } catch {
      setDeleting(false);
    }
  };

  const nonDefaultRoles = [...roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
  const everyoneRole = roles.find((r) => r.isDefault) ?? null;

  const startCreateRole = () => {
    setEditingRole(null);
    setRoleName('');
    setRoleColor('#99aab5');
    setRolePerms(0);
    setRoleDisplaySeparately(false);
    setCreating(true);
  };

  const startEditRole = (role: ServerRole) => {
    setEditingRole(role);
    setRoleName(role.name);
    setRoleColor(role.color);
    setRolePerms(role.permissions);
    setRoleDisplaySeparately(role.displaySeparately);
    setCreating(false);
  };

  const handleSaveRole = async () => {
    const { createRole, updateRole } = useServerStore.getState();
    if (creating) {
      await createRole(serverId, roleName, roleColor, rolePerms, roleDisplaySeparately);
    } else if (editingRole) {
      await updateRole(serverId, editingRole.id, { name: roleName, color: roleColor, permissions: rolePerms, displaySeparately: roleDisplaySeparately });
    }
    setEditingRole(null);
    setCreating(false);
  };

  const handleDeleteRole = async (roleId: string) => {
    const { deleteRole } = useServerStore.getState();
    await deleteRole(serverId, roleId);
    if (editingRole?.id === roleId) {
      setEditingRole(null);
      setCreating(false);
    }
  };

  const handleMoveRole = async (roleId: string, direction: 'up' | 'down') => {
    const idx = nonDefaultRoles.findIndex((r) => r.id === roleId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= nonDefaultRoles.length) return;
    const reordered = [...nonDefaultRoles];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    const { reorderRoles } = useServerStore.getState();
    await reorderRoles(serverId, [...reordered].reverse().map((r) => r.id));
  };

  const togglePerm = (perm: number) => {
    setRolePerms((p) => (p & perm) ? (p & ~perm) : (p | perm));
  };

  const handleServerIconChange = (file: File | null) => {
    setServerIconFile(file);
    setServerError('');
    if (!file) setServerIconPreview(null);
  };

  const handleSaveServer = async () => {
    if (!activeServer) return;
    const name = serverName.trim();
    if (!name) {
      setServerError('Server name is required.');
      return;
    }
    setServerSaving(true);
    setServerError('');
    try {
      await useServerStore.getState().updateServer(serverId, {
        name,
        icon: serverIconFile ?? undefined,
        joinLeaveMessagesEnabled: joinLeaveEnabled,
        joinLeaveChannelId: joinLeaveEnabled ? (joinLeaveChannelId || undefined) : undefined,
      });
      if (defaultNotifLevel !== (activeServer.defaultNotificationLevel ?? 0)) {
        await api.patch(`/servers/${serverId}/default-notification-level`, defaultNotifLevel, {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      setServerIconFile(null);
      setServerIconPreview(null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setServerError(typeof msg === 'string' ? msg : 'Update failed');
    } finally {
      setServerSaving(false);
    }
  };

  const showEditor = creating || editingRole != null;

  const TAB_LABELS: Record<Tab, string> = {
    server: 'Server',
    members: 'Members',
    roles: 'Roles',
    emojis: 'Emojis',
    soundboard: 'Soundboard',
    media: 'Media',
    bans: 'Bans',
    audit: 'Audit Log',
    danger: 'Danger Zone',
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal user-settings-modal server-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="us-sidebar">
          <div className="us-sidebar-header">{activeServer?.name ?? 'Server'}</div>
          {canManageServer && (
            <button className={`us-nav-item ${tab === 'server' ? 'active' : ''}`} onClick={() => setTab('server')}>Server</button>
          )}
          {canManageAnyMembers && (
            <button className={`us-nav-item ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>Members</button>
          )}
          {canManageRoles && (
            <button className={`us-nav-item ${tab === 'roles' ? 'active' : ''}`} onClick={() => setTab('roles')}>Roles</button>
          )}
          {canManageEmojis && (
            <button className={`us-nav-item ${tab === 'emojis' ? 'active' : ''}`} onClick={() => setTab('emojis')}>Emojis</button>
          )}
          {canManageSoundboard && (
            <button className={`us-nav-item ${tab === 'soundboard' ? 'active' : ''}`} onClick={() => setTab('soundboard')}>Soundboard</button>
          )}
          {canManageServer && (
            <button className={`us-nav-item ${tab === 'media' ? 'active' : ''}`} onClick={() => setTab('media')}>Media</button>
          )}
          {canBan && (
            <>
              <div className="us-nav-separator" />
              <button className={`us-nav-item ${tab === 'bans' ? 'active' : ''}`} onClick={() => setTab('bans')}>Bans</button>
            </>
          )}
          {canViewAuditLog && (
            <button className={`us-nav-item ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit Log</button>
          )}
          {isOwner && (
            <>
              <div className="us-nav-separator" />
              <button className={`us-nav-item ${tab === 'danger' ? 'active' : ''}`} onClick={() => setTab('danger')}>Danger Zone</button>
            </>
          )}
        </div>

        <div className="us-content">
          <div className="us-content-header">
            <h2>{TAB_LABELS[tab]}</h2>
            <button className="us-close" onClick={onClose}>&times;</button>
          </div>

          <div className="us-content-body">
            {tab === 'server' && canManageServer && (
              <>
                <div className="us-card">
                  <div className="us-card-title">Server Icon</div>
                  <div className="server-icon-row">
                    <button className="server-icon-preview" onClick={() => document.getElementById('server-icon-input')?.click()}>
                      {(() => {
                        const iconUrl = serverIconPreview
                          ?? (activeServer?.iconUrl
                            ? (activeServer.iconUrl.startsWith('http') ? activeServer.iconUrl : `${getApiBase()}${activeServer.iconUrl}`)
                            : null);
                        if (iconUrl) return <img src={iconUrl} alt={activeServer?.name ?? 'Server icon'} />;
                        return <span>{(activeServer?.name ?? '?').charAt(0).toUpperCase()}</span>;
                      })()}
                    </button>
                    <div className="server-icon-actions">
                      <label className="server-icon-upload-btn">
                        Change Icon
                        <input
                          id="server-icon-input"
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={(e) => handleServerIconChange(e.target.files?.[0] ?? null)}
                        />
                      </label>
                      <span className="server-icon-hint">PNG, JPG, WEBP, or GIF (max 5MB)</span>
                    </div>
                  </div>
                </div>

                <div className="us-card">
                  <div className="us-card-title">Server Name</div>
                  <input
                    className="server-name-input"
                    value={serverName}
                    onChange={(e) => { setServerName(e.target.value); setServerError(''); }}
                    placeholder="Server name"
                  />
                </div>

                <div className="us-card">
                  <div className="us-card-title">Join / Leave Messages</div>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={joinLeaveEnabled}
                      onChange={(e) => setJoinLeaveEnabled(e.target.checked)}
                    />
                    Post a message when members join or leave
                  </label>
                  <div className="server-setting-row" style={{ marginTop: 8 }}>
                    <span className="server-setting-label">Channel</span>
                    <select
                      className="settings-select"
                      value={joinLeaveChannelId}
                      disabled={!joinLeaveEnabled || channels.filter((c) => c.type === 'Text').length === 0}
                      onChange={(e) => setJoinLeaveChannelId(e.target.value)}
                    >
                      {channels.filter((c) => c.type === 'Text').map((c) => (
                        <option key={c.id} value={c.id}>#{c.name}</option>
                      ))}
                    </select>
                  </div>
                  {channels.filter((c) => c.type === 'Text').length === 0 && (
                    <div className="settings-help">No text channels available.</div>
                  )}
                </div>

                <div className="us-card">
                  <div className="us-card-title">Default Notification Level</div>
                  <div className="settings-help" style={{ marginTop: 0 }}>
                    This sets the default for all members who haven't customized their settings.
                  </div>
                  <select
                    className="settings-select"
                    value={defaultNotifLevel}
                    onChange={(e) => setDefaultNotifLevel(Number(e.target.value))}
                  >
                    <option value={NotificationLevel.AllMessages}>All Messages</option>
                    <option value={NotificationLevel.OnlyMentions}>Only Mentions</option>
                    <option value={NotificationLevel.Nothing}>Nothing</option>
                  </select>
                </div>

                {serverError && <div className="server-error">{serverError}</div>}

                <div className="us-card-actions">
                  <button className="btn-secondary" onClick={onClose}>Cancel</button>
                  <button onClick={handleSaveServer} disabled={!serverName.trim() || serverSaving}>
                    {serverSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </>
            )}

            {tab === 'members' && canManageAnyMembers && (
              <>
                <div className="us-card">
                  <input
                    className="members-search"
                    placeholder="Search members..."
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                  />
                </div>
                <div className="members-manage-list">
                  {members
                    .filter((m) => m.user.displayName.toLowerCase().includes(memberSearch.toLowerCase()) || m.user.username.toLowerCase().includes(memberSearch.toLowerCase()))
                    .map((m) => {
                      const displayColor = getDisplayColor(m);
                      const highestRole = getHighestRole(m);
                      const isSelf = m.userId === currentUser?.id;
                      const canActOnMember = !isSelf && currentMember && canActOn(currentMember, m);
                      const showManageRoles = canManageRoles && (canActOnMember || (isSelf && isOwner));
                      const showKick = canKick && canActOnMember;
                      const showBan = canBan && canActOnMember;

                      return (
                        <div key={m.userId} className="member-manage-row">
                          <div className="member-manage-info">
                            <div className="member-manage-avatar">
                              {m.user.avatarUrl ? (
                                <img src={m.user.avatarUrl.startsWith('http') ? m.user.avatarUrl : `${getApiBase()}${m.user.avatarUrl}`} alt={m.user.displayName} />
                              ) : (
                                <span>{m.user.displayName.charAt(0).toUpperCase()}</span>
                              )}
                            </div>
                            <div className="member-manage-details">
                              <span className="member-manage-name" style={displayColor ? { color: displayColor } : undefined}>{m.user.displayName}</span>
                              <span className="member-manage-username">@{m.user.username}</span>
                            </div>
                            {m.isOwner && <span className="member-badge" style={{ background: '#faa61a', color: '#000' }}>Owner</span>}
                            {!m.isOwner && highestRole && (
                              <span className="member-badge" style={{ background: highestRole.color, color: '#fff' }}>{highestRole.name}</span>
                            )}
                          </div>
                          <div className="member-manage-actions">
                            {showManageRoles && (
                              <button className="btn-secondary" onClick={() => {
                                setRoleAssignTarget(m);
                                setSelectedRoleIds(m.roles.filter((r) => !r.isDefault).map((r) => r.id));
                              }}>Roles</button>
                            )}
                            {showKick && (
                              <button className="btn-danger-sm" onClick={() => kickMember(serverId, m.userId)}>Kick</button>
                            )}
                            {showBan && (
                              <button className="btn-danger-sm" onClick={() => {
                                const reason = prompt('Ban reason (optional):');
                                banMember(serverId, m.userId, reason || undefined);
                              }}>Ban</button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
                {roleAssignTarget && (
                  <div className="modal-overlay" onClick={() => setRoleAssignTarget(null)}>
                    <div className="modal role-assign-modal" onClick={(e) => e.stopPropagation()}>
                      <h2>Manage Roles</h2>
                      <div className="role-assign-target">
                        <div className="member-manage-avatar">
                          {roleAssignTarget.user.avatarUrl ? (
                            <img src={roleAssignTarget.user.avatarUrl.startsWith('http') ? roleAssignTarget.user.avatarUrl : `${getApiBase()}${roleAssignTarget.user.avatarUrl}`} alt={roleAssignTarget.user.displayName} />
                          ) : (
                            <span>{roleAssignTarget.user.displayName.charAt(0).toUpperCase()}</span>
                          )}
                        </div>
                        <span className="role-assign-target-name">{roleAssignTarget.user.displayName}</span>
                      </div>
                      <div className="role-assign-list">
                        {[...roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position).map((role) => {
                          const checked = selectedRoleIds.includes(role.id);
                          return (
                            <div
                              key={role.id}
                              className={`role-assign-item${checked ? ' active' : ''}`}
                              onClick={() => {
                                if (checked) {
                                  setSelectedRoleIds(selectedRoleIds.filter((id) => id !== role.id));
                                } else {
                                  setSelectedRoleIds([...selectedRoleIds, role.id]);
                                }
                              }}
                            >
                              <span className="role-assign-color" style={{ background: role.color }} />
                              <span className="role-assign-name">{role.name}</span>
                              <div className={`toggle-switch small${checked ? ' on' : ''}`}>
                                <div className="toggle-knob" />
                              </div>
                            </div>
                          );
                        })}
                        {roles.filter((r) => !r.isDefault).length === 0 && (
                          <p className="role-assign-empty">No roles created yet. Create roles in the Roles tab.</p>
                        )}
                      </div>
                      <div className="modal-actions">
                        <button className="btn-secondary" onClick={() => setRoleAssignTarget(null)}>Cancel</button>
                        <button onClick={async () => {
                          const { updateMemberRoles } = useServerStore.getState();
                          await updateMemberRoles(serverId, roleAssignTarget.userId, selectedRoleIds);
                          setRoleAssignTarget(null);
                        }}>Save</button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === 'roles' && canManageRoles && (
              <div className="roles-tab">
                {!showEditor ? (
                  <>
                    <button className="role-create-btn" onClick={startCreateRole}>
                      <span className="role-create-icon">+</span>
                      Create Role
                    </button>
                    <div className="role-list">
                      {nonDefaultRoles.map((role, i) => {
                        const memberCount = members.filter((m) => m.roles.some((r) => r.id === role.id)).length;
                        return (
                          <div key={role.id} className="role-item" onClick={() => startEditRole(role)}>
                            <div className="role-item-color-bar" style={{ background: role.color }} />
                            <div className="role-item-content">
                              <div className="role-item-header">
                                <span className="role-item-name" style={{ color: role.color }}>{role.name}</span>
                                <span className="role-item-meta">{memberCount} {memberCount === 1 ? 'member' : 'members'}</span>
                              </div>
                            </div>
                            <div className="role-item-actions">
                              <button className="role-move-btn" disabled={i === 0} onClick={(e) => { e.stopPropagation(); handleMoveRole(role.id, 'up'); }} title="Move Up">&uarr;</button>
                              <button className="role-move-btn" disabled={i === nonDefaultRoles.length - 1} onClick={(e) => { e.stopPropagation(); handleMoveRole(role.id, 'down'); }} title="Move Down">&darr;</button>
                              <button className="role-delete-btn" onClick={(e) => { e.stopPropagation(); handleDeleteRole(role.id); }} title="Delete Role">&times;</button>
                            </div>
                          </div>
                        );
                      })}
                      {nonDefaultRoles.length === 0 && (
                        <div className="role-list-empty">
                          <span className="role-list-empty-icon">&#x1F3F7;&#xFE0F;</span>
                          <p>No custom roles yet</p>
                          <span>Create a role to organize your members and manage permissions.</span>
                        </div>
                      )}
                      {everyoneRole && (
                        <>
                          <div className="role-list-separator">
                            <span>Default Permissions</span>
                          </div>
                          <div className="role-item" onClick={() => startEditRole(everyoneRole)}>
                            <div className="role-item-color-bar" style={{ background: '#99aab5' }} />
                            <div className="role-item-content">
                              <div className="role-item-header">
                                <span className="role-item-name" style={{ color: '#99aab5' }}>@everyone</span>
                                <span className="role-item-meta">All members</span>
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="role-editor">
                    <div className="role-editor-header">
                      <button className="role-editor-back" onClick={() => { setEditingRole(null); setCreating(false); }} title="Back to roles">&larr;</button>
                      <h3>{creating ? 'Create Role' : editingRole?.isDefault ? '@everyone Permissions' : 'Edit Role'}</h3>
                    </div>

                    {!editingRole?.isDefault && (
                      <>
                        <div className="role-editor-preview">
                          <span className="role-pill" style={{ borderColor: roleColor, color: roleColor }}>
                            <span className="role-pill-dot" style={{ background: roleColor }} />
                            {roleName || 'Role Name'}
                          </span>
                        </div>

                        <div className="role-editor-section">
                          <label className="role-editor-label">Role Name</label>
                          <input className="role-editor-input" value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="e.g. Moderator" />
                        </div>

                        <div className="role-editor-section">
                          <label className="role-editor-label">Color</label>
                          <div className="role-color-presets">
                            {ROLE_COLOR_PRESETS.map((c) => (
                              <button
                                key={c}
                                className={`role-color-swatch${roleColor === c ? ' active' : ''}`}
                                style={{ background: c }}
                                onClick={() => setRoleColor(c)}
                                title={c}
                              />
                            ))}
                            <label className="role-color-custom" title="Custom color">
                              <input type="color" value={roleColor} onChange={(e) => setRoleColor(e.target.value)} />
                              <span className="role-color-custom-icon">&#9998;</span>
                            </label>
                          </div>
                        </div>

                        <div className="role-editor-section">
                          <label className="role-editor-toggle">
                            <div className={`toggle-switch${roleDisplaySeparately ? ' on' : ''}`} onClick={() => setRoleDisplaySeparately(!roleDisplaySeparately)}>
                              <div className="toggle-knob" />
                            </div>
                            <span>Display role members separately</span>
                          </label>
                        </div>
                      </>
                    )}

                    <div className="role-editor-section">
                      <label className="role-editor-label">Permissions</label>
                      {PERMISSION_SECTIONS.map(({ section, perms }) => (
                        <div key={section} className="permission-section">
                          <div className="permission-section-header">{section}</div>
                          {perms.map(({ perm, label, description }) => (
                            <div key={perm} className="permission-row" onClick={() => togglePerm(perm)}>
                              <div className="permission-info">
                                <span className="permission-name">{label}</span>
                                <span className="permission-desc">{description}</span>
                              </div>
                              <div className={`toggle-switch${(rolePerms & perm) !== 0 ? ' on' : ''}`}>
                                <div className="toggle-knob" />
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>

                    <div className="us-card-actions">
                      <button className="btn-secondary" onClick={() => { setEditingRole(null); setCreating(false); }}>Cancel</button>
                      <button onClick={handleSaveRole} disabled={!roleName.trim()}>
                        {creating ? 'Create' : 'Save Changes'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'emojis' && canManageEmojis && (
              <div className="emojis-tab">
                <div className="us-card">
                  <div className="us-card-title">Upload Emoji ({emojis.length} / 50)</div>
                  <div className="emoji-upload-row">
                    <input
                      type="file"
                      accept="image/png,image/gif,image/webp"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setEmojiFile(f);
                        setEmojiError('');
                        if (f) {
                          const reader = new FileReader();
                          reader.onload = (ev) => setEmojiPreview(ev.target?.result as string);
                          reader.readAsDataURL(f);
                          if (!emojiName) {
                            const base = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
                            if (base.length >= 2) setEmojiName(base);
                          }
                        } else {
                          setEmojiPreview(null);
                        }
                      }}
                    />
                    {emojiPreview && <img src={emojiPreview} alt="preview" className="emoji-upload-preview" />}
                  </div>
                  <div className="emoji-upload-row">
                    <input
                      type="text"
                      placeholder="emoji_name"
                      value={emojiName}
                      onChange={(e) => { setEmojiName(e.target.value); setEmojiError(''); }}
                      maxLength={32}
                    />
                    <button
                      disabled={!emojiFile || !emojiName || emojiUploading}
                      onClick={async () => {
                        if (!emojiFile || !emojiName) return;
                        setEmojiUploading(true);
                        setEmojiError('');
                        try {
                          const fd = new FormData();
                          fd.append('file', emojiFile);
                          fd.append('name', emojiName);
                          await useServerStore.getState().uploadEmoji(serverId, fd);
                          setEmojiName('');
                          setEmojiFile(null);
                          setEmojiPreview(null);
                        } catch (err: unknown) {
                          const msg = (err as { response?: { data?: string } })?.response?.data;
                          setEmojiError(typeof msg === 'string' ? msg : 'Upload failed');
                        } finally {
                          setEmojiUploading(false);
                        }
                      }}
                    >
                      {emojiUploading ? 'Uploading...' : 'Upload'}
                    </button>
                  </div>
                  {emojiError && <p className="emoji-error">{emojiError}</p>}
                </div>
                <div className="emoji-list">
                  {emojis.length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>No custom emojis yet.</p>}
                  {emojis.map((emoji) => (
                    <div key={emoji.id} className="emoji-item">
                      <img src={`${getApiBase()}${emoji.imageUrl}`} alt={emoji.name} className="emoji-item-img" />
                      <span className="emoji-item-name">:{emoji.name}:</span>
                      <button className="role-delete-btn" onClick={() => useServerStore.getState().deleteEmoji(serverId, emoji.id)} title="Delete Emoji">&times;</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'soundboard' && canManageSoundboard && (
              <div className="soundboard-tab">
                <div className="us-card">
                  <div className="us-card-title">Upload Clip ({soundboardClips.length} / 50)</div>
                  {!sbFile && (
                    <div className="sb-upload-row">
                      <input
                        type="file"
                        ref={sbFileRef}
                        accept="audio/*"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          setSbFile(f);
                          setSbError('');
                          if (f) {
                            setSbTrimming(true);
                            const base = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 32);
                            if (base.length >= 2) setSbName(base);
                          }
                        }}
                      />
                    </div>
                  )}
                  {sbTrimming && sbFile && (
                    <AudioTrimmer
                      file={sbFile}
                      maxDuration={5}
                      onConfirm={async (trimmedFile) => {
                        setSbTrimming(false);
                        if (!sbName.trim()) {
                          setSbError('Please enter a clip name');
                          return;
                        }
                        setSbUploading(true);
                        setSbError('');
                        try {
                          const fd = new FormData();
                          fd.append('file', trimmedFile);
                          fd.append('name', sbName);
                          await useSoundboardStore.getState().uploadClip(serverId, fd);
                          setSbName('');
                          setSbFile(null);
                          if (sbFileRef.current) sbFileRef.current.value = '';
                        } catch (err: unknown) {
                          const msg = (err as { response?: { data?: string } })?.response?.data;
                          setSbError(typeof msg === 'string' ? msg : 'Upload failed');
                        } finally {
                          setSbUploading(false);
                        }
                      }}
                      onCancel={() => {
                        setSbTrimming(false);
                        setSbFile(null);
                        setSbName('');
                        if (sbFileRef.current) sbFileRef.current.value = '';
                      }}
                    />
                  )}
                  {sbFile && (
                    <div className="sb-upload-row" style={{ marginTop: sbTrimming ? 8 : 0 }}>
                      <input
                        type="text"
                        placeholder="Clip name"
                        value={sbName}
                        onChange={(e) => { setSbName(e.target.value); setSbError(''); }}
                        maxLength={32}
                        autoFocus
                      />
                    </div>
                  )}
                  {sbUploading && <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>Uploading...</p>}
                  {sbError && <p className="emoji-error">{sbError}</p>}
                </div>
                <div className="sb-clip-list">
                  {soundboardClips.length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>No soundboard clips yet.</p>}
                  {soundboardClips.map((clip) => (
                    <div key={clip.id} className="sb-clip-item">
                      <span className="sb-clip-name">{clip.name}</span>
                      <span className="sb-clip-duration">{clip.duration.toFixed(1)}s</span>
                      <button
                        className="sb-clip-preview"
                        onClick={() => {
                          if (sbPreviewClipId === clip.id && sbPreviewAudio) {
                            sbPreviewAudio.pause();
                            sbPreviewAudio.currentTime = 0;
                            setSbPreviewClipId(null);
                            setSbPreviewAudio(null);
                          } else {
                            if (sbPreviewAudio) { sbPreviewAudio.pause(); sbPreviewAudio.currentTime = 0; }
                            const url = clip.url.startsWith('http') ? clip.url : `${getApiBase()}${clip.url}`;
                            const audio = new Audio(url);
                            audio.volume = 0.5;
                            audio.onended = () => { setSbPreviewClipId(null); setSbPreviewAudio(null); };
                            audio.play().catch(() => {});
                            setSbPreviewAudio(audio);
                            setSbPreviewClipId(clip.id);
                          }
                        }}
                        title={sbPreviewClipId === clip.id ? 'Stop' : 'Preview'}
                      >
                        {sbPreviewClipId === clip.id ? '⏹' : '▶'}
                      </button>
                      <button
                        className="role-delete-btn"
                        onClick={() => useSoundboardStore.getState().deleteClip(serverId, clip.id)}
                        title="Delete Clip"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'media' && canManageServer && (
              <div className="media-tab">
                <div className="us-card">
                  <div className="us-card-title">Linked Providers</div>
                  {mediaConnections.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', padding: '12px 0' }}>No media providers linked yet.</p>
                  ) : (
                    <div className="mps-provider-list">
                      {mediaConnections.map((conn) => (
                        <div key={conn.id} className="mps-provider-card">
                          <div className="mps-provider-info">
                            <span className="mps-provider-name">{conn.displayName}</span>
                            <span className="mps-provider-type">{conn.providerType}</span>
                          </div>
                          {conn.providerType !== 'YouTube' && (
                            <button
                              className="btn-danger-sm"
                              onClick={async () => {
                                try {
                                  await useMediaProviderStore.getState().unlinkProvider(serverId, conn.id);
                                } catch (e) {
                                  console.error('Failed to unlink:', e);
                                }
                              }}
                            >
                              Unlink
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="us-card">
                  <div className="us-card-title">Link Provider</div>
                  <div className="mps-form">
                    <div className="mps-form-row">
                      <label className="mps-form-label">Provider</label>
                      <select
                        className="settings-select"
                        value={mpProviderType}
                        onChange={(e) => setMpProviderType(e.target.value)}
                      >
                        <option value="Plex">Plex</option>
                      </select>
                    </div>
                    <div className="mps-form-row">
                      <label className="mps-form-label">Display Name</label>
                      <input
                        className="mps-form-input"
                        value={mpDisplayName}
                        onChange={(e) => { setMpDisplayName(e.target.value); setMpError(''); }}
                        placeholder="e.g. My Plex Server"
                      />
                    </div>
                    <div className="mps-form-row">
                      <label className="mps-form-label">Server URL</label>
                      <input
                        className="mps-form-input"
                        value={mpServerUrl}
                        onChange={(e) => { setMpServerUrl(e.target.value); setMpError(''); }}
                        placeholder="http://192.168.1.100:32400"
                      />
                    </div>
                    <div className="mps-form-row">
                      <label className="mps-form-label">Auth Token</label>
                      <input
                        className="mps-form-input"
                        type="password"
                        value={mpAuthToken}
                        onChange={(e) => { setMpAuthToken(e.target.value); setMpError(''); }}
                        placeholder="Your Plex auth token"
                      />
                    </div>
                    {mpError && <div className="server-error">{mpError}</div>}
                    <button
                      className="mps-link-btn"
                      disabled={!mpDisplayName.trim() || !mpServerUrl.trim() || !mpAuthToken.trim() || mpLinking}
                      onClick={async () => {
                        setMpLinking(true);
                        setMpError('');
                        try {
                          await useMediaProviderStore.getState().linkProvider(serverId, {
                            providerType: mpProviderType,
                            displayName: mpDisplayName.trim(),
                            serverUrl: mpServerUrl.trim(),
                            authToken: mpAuthToken.trim(),
                          });
                          setMpDisplayName('');
                          setMpServerUrl('');
                          setMpAuthToken('');
                        } catch (err: unknown) {
                          const msg = (err as { response?: { data?: string } })?.response?.data;
                          setMpError(typeof msg === 'string' ? msg : 'Failed to link provider');
                        } finally {
                          setMpLinking(false);
                        }
                      }}
                    >
                      {mpLinking ? 'Linking...' : 'Link Provider'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tab === 'bans' && canBan && (
              <div className="ban-list">
                {bans.length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>No banned users.</p>}
                {bans.map((ban) => (
                  <div key={ban.id} className="ban-item">
                    <div className="ban-info">
                      <span className="ban-user">{ban.user.displayName}</span>
                      <span className="ban-username">@{ban.user.username}</span>
                      {ban.reason && <span className="ban-reason">Reason: {ban.reason}</span>}
                      <span className="ban-meta">Banned by {ban.bannedBy.displayName} on {formatTimestamp(ban.createdAt)}</span>
                    </div>
                    <button className="sidebar-action-btn" onClick={() => unbanMember(serverId, ban.userId)}>Unban</button>
                  </div>
                ))}
              </div>
            )}

            {tab === 'audit' && canViewAuditLog && (
              <div className="audit-log-list">
                {logs.length === 0 && <p className="audit-empty">No audit log entries yet.</p>}
                {logs.map((log) => (
                  <div key={log.id} className="audit-log-item">
                    <span className="audit-icon">{ACTION_ICONS[log.action] || '?'}</span>
                    <div className="audit-details">
                      <span className="audit-actor">{log.actor.displayName}</span>
                      {' '}
                      <span className="audit-action">{ACTION_LABELS[log.action] || log.action}</span>
                      {log.targetName && <span className="audit-target"> {log.targetName}</span>}
                      {log.details && <span className="audit-extra"> ({log.details})</span>}
                      <span className="audit-time">{formatTimestamp(log.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'danger' && isOwner && (
              <div className="us-card danger-zone">
                <div className="us-card-title">Delete Server</div>
                <p className="settings-help" style={{ marginTop: 0, marginBottom: 12 }}>
                  Deleting a server is permanent and cannot be undone. All channels, messages, and members will be lost.
                </p>
                <label>
                  Type <strong>{activeServer?.name}</strong> to confirm
                  <input
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    placeholder="Server name"
                  />
                </label>
                <button
                  className="btn-danger"
                  disabled={confirmName !== activeServer?.name || deleting}
                  onClick={handleDelete}
                  style={{ marginTop: 8 }}
                >
                  {deleting ? 'Deleting...' : 'Delete Server'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
