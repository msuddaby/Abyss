import { useState, useEffect } from 'react';
import { useServerStore } from '../stores/serverStore';
import { useAuthStore } from '../stores/authStore';
import type { AuditLog, ServerRole } from '../types';
import { hasPermission, Permission } from '../types';

const ACTION_LABELS: Record<string, string> = {
  MessageDeleted: 'Deleted a message',
  ChannelCreated: 'Created channel',
  ChannelDeleted: 'Deleted channel',
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
};

const ACTION_ICONS: Record<string, string> = {
  MessageDeleted: '\u{1F5D1}',
  ChannelCreated: '\u{2795}',
  ChannelDeleted: '\u{2796}',
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
};

const PERMISSION_LABELS: { perm: number; label: string }[] = [
  { perm: Permission.ManageChannels, label: 'Manage Channels' },
  { perm: Permission.ManageMessages, label: 'Manage Messages' },
  { perm: Permission.KickMembers, label: 'Kick Members' },
  { perm: Permission.BanMembers, label: 'Ban Members' },
  { perm: Permission.ManageRoles, label: 'Manage Roles' },
  { perm: Permission.ViewAuditLog, label: 'View Audit Log' },
  { perm: Permission.ManageServer, label: 'Manage Server' },
  { perm: Permission.ManageInvites, label: 'Manage Invites' },
];

function formatTimestamp(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString();
}

type Tab = 'roles' | 'bans' | 'audit' | 'danger';

export default function ServerSettingsModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('roles');
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const { fetchAuditLogs, deleteServer, activeServer, fetchBans, unbanMember } = useServerStore();
  const members = useServerStore((s) => s.members);
  const roles = useServerStore((s) => s.roles);
  const bans = useServerStore((s) => s.bans);
  const currentUser = useAuthStore((s) => s.user);
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const isOwner = currentMember?.isOwner ?? false;
  const canManageRoles = currentMember ? hasPermission(currentMember, Permission.ManageRoles) : false;
  const canBan = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const canViewAuditLog = currentMember ? hasPermission(currentMember, Permission.ViewAuditLog) : false;

  // Role editor state
  const [editingRole, setEditingRole] = useState<ServerRole | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#99aab5');
  const [rolePerms, setRolePerms] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (tab === 'audit' && canViewAuditLog) {
      fetchAuditLogs(serverId).then(setLogs).catch(console.error);
    }
    if (tab === 'bans' && canBan) {
      fetchBans(serverId);
    }
  }, [tab, serverId]);

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

  const togglePerm = (perm: number) => {
    setRolePerms((p) => (p & perm) ? (p & ~perm) : (p | perm));
  };

  const showEditor = creating || editingRole != null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal server-settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Server Settings</h2>
        <div className="settings-tabs">
          {canManageRoles && (
            <button className={`settings-tab ${tab === 'roles' ? 'active' : ''}`} onClick={() => setTab('roles')}>Roles</button>
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

        {tab === 'roles' && canManageRoles && (
          <div className="roles-tab">
            {!showEditor ? (
              <>
                <button className="sidebar-action-btn" onClick={startCreateRole} style={{ marginBottom: 12, width: '100%' }}>+ Create Role</button>
                <div className="role-list">
                  {nonDefaultRoles.map((role) => (
                    <div key={role.id} className="role-item" onClick={() => startEditRole(role)}>
                      <span className="role-color-dot" style={{ background: role.color }} />
                      <span className="role-item-name">{role.name}</span>
                      <button className="role-delete-btn" onClick={(e) => { e.stopPropagation(); handleDeleteRole(role.id); }} title="Delete Role">&times;</button>
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
