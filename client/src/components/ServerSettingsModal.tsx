import { useState, useEffect } from 'react';
import { useServerStore, useAuthStore, getApiBase, hasPermission, Permission, getDisplayColor, getHighestRole, canActOn } from '@abyss/shared';
import type { AuditLog, ServerRole, ServerMember } from '@abyss/shared';

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
};

const PERMISSION_LABELS: { perm: number; label: string }[] = [
  { perm: Permission.ManageChannels, label: 'Manage Channels' },
  { perm: Permission.ManageMessages, label: 'Manage Messages' },
  { perm: Permission.KickMembers, label: 'Kick Members' },
  { perm: Permission.BanMembers, label: 'Ban Members' },
  { perm: Permission.MuteMembers, label: 'Mute Members (Voice)' },
  { perm: Permission.ManageRoles, label: 'Manage Roles' },
  { perm: Permission.ViewAuditLog, label: 'View Audit Log' },
  { perm: Permission.ManageServer, label: 'Manage Server' },
  { perm: Permission.ManageInvites, label: 'Manage Invites' },
  { perm: Permission.ManageEmojis, label: 'Manage Emojis' },
];

function formatTimestamp(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString();
}

type Tab = 'server' | 'members' | 'roles' | 'emojis' | 'bans' | 'audit' | 'danger';

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
  const [creating, setCreating] = useState(false);

  // Emoji tab state
  const emojis = useServerStore((s) => s.emojis);
  const [emojiName, setEmojiName] = useState('');
  const [emojiFile, setEmojiFile] = useState<File | null>(null);
  const [emojiPreview, setEmojiPreview] = useState<string | null>(null);
  const [emojiUploading, setEmojiUploading] = useState(false);
  const [emojiError, setEmojiError] = useState('');

  // Server settings
  const [serverName, setServerName] = useState(activeServer?.name ?? '');
  const [serverIconFile, setServerIconFile] = useState<File | null>(null);
  const [serverIconPreview, setServerIconPreview] = useState<string | null>(null);
  const [serverSaving, setServerSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const [joinLeaveEnabled, setJoinLeaveEnabled] = useState(activeServer?.joinLeaveMessagesEnabled ?? true);
  const [joinLeaveChannelId, setJoinLeaveChannelId] = useState<string>('');

  useEffect(() => {
    if (tab === 'audit' && canViewAuditLog) {
      fetchAuditLogs(serverId).then(setLogs).catch(console.error);
    }
    if (tab === 'bans' && canBan) {
      fetchBans(serverId);
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

  const startCreateRole = () => {
    setEditingRole(null);
    setRoleName('');
    setRoleColor('#99aab5');
    setRolePerms(0);
    setCreating(true);
  };

  const startEditRole = (role: ServerRole) => {
    setEditingRole(role);
    setRoleName(role.name);
    setRoleColor(role.color);
    setRolePerms(role.permissions);
    setCreating(false);
  };

  const handleSaveRole = async () => {
    const { createRole, updateRole } = useServerStore.getState();
    if (creating) {
      await createRole(serverId, roleName, roleColor, rolePerms);
    } else if (editingRole) {
      await updateRole(serverId, editingRole.id, { name: roleName, color: roleColor, permissions: rolePerms });
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
    // Backend expects IDs in low-to-high position order (position 1 first)
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal server-settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Server Settings</h2>
        <div className="settings-tabs">
          <div className="settings-tabs-scroll" role="tablist" aria-label="Server settings sections">
            {canManageServer && (
              <button className={`settings-tab ${tab === 'server' ? 'active' : ''}`} onClick={() => setTab('server')}>Server</button>
            )}
            {canManageAnyMembers && (
              <button className={`settings-tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>Members</button>
            )}
            {canManageRoles && (
              <button className={`settings-tab ${tab === 'roles' ? 'active' : ''}`} onClick={() => setTab('roles')}>Roles</button>
            )}
            {canManageEmojis && (
              <button className={`settings-tab ${tab === 'emojis' ? 'active' : ''}`} onClick={() => setTab('emojis')}>Emojis</button>
            )}
            {canBan && (
              <button className={`settings-tab ${tab === 'bans' ? 'active' : ''}`} onClick={() => setTab('bans')}>Bans</button>
            )}
            {canViewAuditLog && (
              <button className={`settings-tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit Log</button>
            )}
            {isOwner && (
              <button className={`settings-tab ${tab === 'danger' ? 'active' : ''}`} onClick={() => setTab('danger')}>Danger Zone</button>
            )}
          </div>
        </div>

        {tab === 'server' && canManageServer && (
          <div className="server-tab">
            <div className="server-settings-card">
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
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => handleServerIconChange(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <span className="server-icon-hint">PNG, JPG, or WEBP (max 5MB)</span>
                </div>
              </div>

              <label className="server-name-label">Server Name</label>
              <input
                className="server-name-input"
                value={serverName}
                onChange={(e) => { setServerName(e.target.value); setServerError(''); }}
                placeholder="Server name"
              />

              <div className="server-settings-section">
                <label className="server-setting-row">
                  <input
                    type="checkbox"
                    checked={joinLeaveEnabled}
                    onChange={(e) => setJoinLeaveEnabled(e.target.checked)}
                  />
                  <span>Post a message when members join or leave</span>
                </label>
                <div className="server-setting-row">
                  <span className="server-setting-label">Channel</span>
                  <select
                    className="server-setting-select"
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
                  <div className="server-setting-hint">No text channels available. Create one to enable join/leave messages.</div>
                )}
              </div>

              {serverError && <div className="server-error">{serverError}</div>}

              <div className="modal-actions">
                <button onClick={handleSaveServer} disabled={!serverName.trim() || serverSaving}>
                  {serverSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'members' && canManageAnyMembers && (
          <div className="members-tab">
            <input
              className="members-search"
              placeholder="Search members..."
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
            />
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
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <h2>Manage Roles — {roleAssignTarget.user.displayName}</h2>
                  <div className="role-assign-list">
                    {[...roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position).map((role) => (
                      <label key={role.id} className="role-assign-item">
                        <input
                          type="checkbox"
                          checked={selectedRoleIds.includes(role.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedRoleIds([...selectedRoleIds, role.id]);
                            } else {
                              setSelectedRoleIds(selectedRoleIds.filter((id) => id !== role.id));
                            }
                          }}
                        />
                        <span className="role-color-dot" style={{ background: role.color }} />
                        {role.name}
                      </label>
                    ))}
                    {roles.filter((r) => !r.isDefault).length === 0 && <p style={{ color: 'var(--text-muted)' }}>No roles created yet.</p>}
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
          </div>
        )}

        {tab === 'roles' && canManageRoles && (
          <div className="roles-tab">
            {!showEditor ? (
              <>
                <button className="sidebar-action-btn" onClick={startCreateRole} style={{ marginBottom: 12, width: '100%' }}>+ Create Role</button>
                <div className="role-list">
                  {nonDefaultRoles.map((role, i) => (
                    <div key={role.id} className="role-item" onClick={() => startEditRole(role)}>
                      <span className="role-color-dot" style={{ background: role.color }} />
                      <span className="role-item-name">{role.name}</span>
                      <div className="role-item-actions">
                        <button className="role-move-btn" disabled={i === 0} onClick={(e) => { e.stopPropagation(); handleMoveRole(role.id, 'up'); }} title="Move Up">&uarr;</button>
                        <button className="role-move-btn" disabled={i === nonDefaultRoles.length - 1} onClick={(e) => { e.stopPropagation(); handleMoveRole(role.id, 'down'); }} title="Move Down">&darr;</button>
                        <button className="role-delete-btn" onClick={(e) => { e.stopPropagation(); handleDeleteRole(role.id); }} title="Delete Role">&times;</button>
                      </div>
                    </div>
                  ))}
                  {nonDefaultRoles.length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>No custom roles yet.</p>}
                </div>
              </>
            ) : (
              <div className="role-editor">
                <h3>{creating ? 'Create Role' : `Edit: ${editingRole?.name}`}</h3>
                <label>
                  Name
                  <input value={roleName} onChange={(e) => setRoleName(e.target.value)} />
                </label>
                <label>
                  Color
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <input type="color" value={roleColor} onChange={(e) => setRoleColor(e.target.value)} style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
                    <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{roleColor}</span>
                  </div>
                </label>
                <label style={{ marginBottom: 8 }}>Permissions</label>
                <div className="permission-grid">
                  {PERMISSION_LABELS.map(({ perm, label }) => (
                    <label key={perm} className="permission-item">
                      <input
                        type="checkbox"
                        checked={(rolePerms & perm) !== 0}
                        onChange={() => togglePerm(perm)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="modal-actions">
                  <button className="btn-secondary" onClick={() => { setEditingRole(null); setCreating(false); }}>Back</button>
                  <button onClick={handleSaveRole} disabled={!roleName.trim()}>Save</button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'emojis' && canManageEmojis && (
          <div className="emojis-tab">
            <div className="emoji-upload-form">
              <h3>Upload Emoji ({emojis.length} / 50)</h3>
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
          <div className="danger-zone">
            <p>Deleting a server is permanent and cannot be undone. All channels, messages, and members will be lost.</p>
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
            >
              {deleting ? 'Deleting...' : 'Delete Server'}
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
