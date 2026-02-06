import { useState, useEffect } from 'react';
import { useServerStore } from '../stores/serverStore';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { API_BASE } from '../services/api';
import UserProfileCard from './UserProfileCard';
import type { ServerMember } from '../types';
import { hasPermission, Permission, getDisplayColor, getHighestRole, canActOn } from '../types';

export default function MemberList() {
  const members = useServerStore((s) => s.members);
  const activeServer = useServerStore((s) => s.activeServer);
  const { kickMember, banMember } = useServerStore();
  const roles = useServerStore((s) => s.roles);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const currentUser = useAuthStore((s) => s.user);
  const [profileCard, setProfileCard] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ member: ServerMember; x: number; y: number } | null>(null);
  const [showRoleAssign, setShowRoleAssign] = useState(false);
  const [roleAssignTarget, setRoleAssignTarget] = useState<ServerMember | null>(null);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canKick = currentMember ? hasPermission(currentMember, Permission.KickMembers) : false;
  const canBan = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const canManageRoles = currentMember ? hasPermission(currentMember, Permission.ManageRoles) : false;

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  if (members.length === 0) return null;

  const online = members.filter((m) => onlineUsers.has(m.userId));
  const offline = members.filter((m) => !onlineUsers.has(m.userId));

  const handleMemberClick = (userId: string, e: React.MouseEvent) => {
    setProfileCard({ userId, x: e.clientX, y: e.clientY });
  };

  const handleContextMenu = (member: ServerMember, e: React.MouseEvent) => {
    e.preventDefault();
    if (!currentMember) return;
    if (member.userId === currentUser?.id) return;
    if (!canActOn(currentMember, member)) return;
    if (!canKick && !canBan && !canManageRoles) return;
    setContextMenu({ member, x: e.clientX, y: e.clientY });
  };

  const handleKick = async () => {
    if (!contextMenu || !activeServer) return;
    await kickMember(activeServer.id, contextMenu.member.userId);
    setContextMenu(null);
  };

  const handleBan = async () => {
    if (!contextMenu || !activeServer) return;
    await banMember(activeServer.id, contextMenu.member.userId);
    setContextMenu(null);
  };

  const handleManageRoles = () => {
    if (!contextMenu) return;
    setRoleAssignTarget(contextMenu.member);
    setSelectedRoleIds(contextMenu.member.roles.filter((r) => !r.isDefault).map((r) => r.id));
    setShowRoleAssign(true);
    setContextMenu(null);
  };

  const handleSaveRoles = async () => {
    if (!roleAssignTarget || !activeServer) return;
    const { updateMemberRoles } = useServerStore.getState();
    await updateMemberRoles(activeServer.id, roleAssignTarget.userId, selectedRoleIds);
    setShowRoleAssign(false);
    setRoleAssignTarget(null);
  };

  const assignableRoles = roles.filter((r) => !r.isDefault);

  const renderMember = (m: ServerMember) => {
    const displayColor = getDisplayColor(m);
    const highestRole = getHighestRole(m);

    return (
      <div key={m.userId} className={`member-item${!onlineUsers.has(m.userId) ? ' offline' : ''}`} onClick={(e) => handleMemberClick(m.userId, e)} onContextMenu={(e) => handleContextMenu(m, e)}>
        <div className="member-avatar">
          {m.user.avatarUrl ? (
            <img src={m.user.avatarUrl.startsWith('http') ? m.user.avatarUrl : `${API_BASE}${m.user.avatarUrl}`} alt={m.user.displayName} />
          ) : (
            <span>{m.user.displayName.charAt(0).toUpperCase()}</span>
          )}
          <span className={`presence-dot ${onlineUsers.has(m.userId) ? 'online' : 'offline'}`} />
        </div>
        <span className="member-name" style={displayColor ? { color: displayColor } : undefined}>{m.user.displayName}</span>
        {m.isOwner && <span className="member-badge" style={{ background: '#faa61a', color: '#000' }}>Owner</span>}
        {!m.isOwner && highestRole && (
          <span className="member-badge" style={{ background: highestRole.color, color: '#fff' }}>{highestRole.name}</span>
        )}
      </div>
    );
  };

  return (
    <div className="member-list">
      {online.length > 0 && (
        <>
          <span className="category-label">Online — {online.length}</span>
          {online.map(renderMember)}
        </>
      )}
      {offline.length > 0 && (
        <>
          <span className="category-label">Offline — {offline.length}</span>
          {offline.map(renderMember)}
        </>
      )}
      {profileCard && (
        <UserProfileCard
          userId={profileCard.userId}
          position={{ x: profileCard.x, y: profileCard.y }}
          onClose={() => setProfileCard(null)}
        />
      )}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {canManageRoles && (
            <button className="context-menu-item" onClick={handleManageRoles}>Manage Roles</button>
          )}
          {canKick && currentMember && canActOn(currentMember, contextMenu.member) && (
            <button className="context-menu-item danger" onClick={handleKick}>Kick</button>
          )}
          {canBan && currentMember && canActOn(currentMember, contextMenu.member) && (
            <button className="context-menu-item danger" onClick={handleBan}>Ban</button>
          )}
        </div>
      )}
      {showRoleAssign && roleAssignTarget && (
        <div className="modal-overlay" onClick={() => setShowRoleAssign(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Manage Roles — {roleAssignTarget.user.displayName}</h2>
            <div className="role-assign-list">
              {assignableRoles.map((role) => (
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
              {assignableRoles.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No roles created yet.</p>}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowRoleAssign(false)}>Cancel</button>
              <button onClick={handleSaveRoles}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
