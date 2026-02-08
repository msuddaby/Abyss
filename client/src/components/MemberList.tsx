import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useServerStore, useAuthStore, usePresenceStore, useDmStore, useMessageStore, getApiBase, hasPermission, Permission, getDisplayColor, getHighestRole, canActOn } from '@abyss/shared';
import type { ServerMember } from '@abyss/shared';
import UserProfileCard from './UserProfileCard';

export default function MemberList() {
  const members = useServerStore((s) => s.members);
  const activeServer = useServerStore((s) => s.activeServer);
  const { kickMember, banMember } = useServerStore();
  const roles = useServerStore((s) => s.roles);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const currentUser = useAuthStore((s) => s.user);
  const [profileCard, setProfileCard] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ member: ServerMember; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const margin = 8;
    let left = contextMenu.x;
    let top = contextMenu.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - rect.height - margin;
    }
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    if (left !== contextMenu.x || top !== contextMenu.y) {
      setContextMenu({ ...contextMenu, x: left, y: top });
    }
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
    const isSelf = member.userId === currentUser?.id;
    if (isSelf) return;
    setContextMenu({ member, x: e.clientX, y: e.clientY });
  };

  const handleMessage = async () => {
    if (!contextMenu) return;
    const { createOrGetDm, enterDmMode, setActiveDmChannel } = useDmStore.getState();
    const { leaveChannel, joinChannel, fetchMessages } = useMessageStore.getState();
    const currentChannelId = useMessageStore.getState().currentChannelId;
    if (currentChannelId) {
      await leaveChannel(currentChannelId).catch(console.error);
    }
    const dm = await createOrGetDm(contextMenu.member.userId);
    enterDmMode();
    useServerStore.getState().clearActiveServer();
    setActiveDmChannel(dm);
    await joinChannel(dm.id).catch(console.error);
    fetchMessages(dm.id);
    setContextMenu(null);
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

  const assignableRoles = [...roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);

  const renderMember = (m: ServerMember) => {
    const displayColor = getDisplayColor(m);
    const highestRole = getHighestRole(m);

    return (
      <div key={m.userId} className={`member-item${!onlineUsers.has(m.userId) ? ' offline' : ''}`} onClick={(e) => handleMemberClick(m.userId, e)} onContextMenu={(e) => handleContextMenu(m, e)}>
        <div className="member-avatar">
          {m.user.avatarUrl ? (
            <img src={m.user.avatarUrl.startsWith('http') ? m.user.avatarUrl : `${getApiBase()}${m.user.avatarUrl}`} alt={m.user.displayName} />
          ) : (
            <span>{m.user.displayName.charAt(0).toUpperCase()}</span>
          )}
          <span className={`presence-dot ${onlineUsers.has(m.userId) ? 'online' : 'offline'}`} />
        </div>
        <div className="member-text">
          <span className="member-name" style={displayColor ? { color: displayColor } : undefined}>{m.user.displayName}</span>
          <span className="member-status">{m.user.status || ''}</span>
        </div>
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
        <div ref={contextMenuRef} className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button className="context-menu-item" onClick={handleMessage}>Message</button>
          {canManageRoles && currentMember && canActOn(currentMember, contextMenu.member) && (
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
