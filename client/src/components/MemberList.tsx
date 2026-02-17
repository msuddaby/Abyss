import { useState, useEffect, useRef } from 'react';
import { useServerStore, useAuthStore, usePresenceStore, getApiBase, getDisplayColor, getNameplateStyle } from '@abyss/shared';
import type { ServerMember } from '@abyss/shared';
import UserProfileCard from './UserProfileCard';
import { useContextMenuStore } from '../stores/contextMenuStore';
import { useWindowVisibility } from '../hooks/useWindowVisibility';

export default function MemberList() {
  const members = useServerStore((s) => s.members);
  const activeServer = useServerStore((s) => s.activeServer);
  const roles = useServerStore((s) => s.roles);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const userStatuses = usePresenceStore((s) => s.userStatuses);
  const currentUser = useAuthStore((s) => s.user);
  const [profileCard, setProfileCard] = useState<{ userId: string; x: number; y: number } | null>(null);
  const openContextMenu = useContextMenuStore((s) => s.open);
  const [hoveredMemberId, setHoveredMemberId] = useState<string | null>(null);
  const [isInViewport, setIsInViewport] = useState(true);
  const memberListRef = useRef<HTMLDivElement>(null);
  const isWindowVisible = useWindowVisibility();

  const currentMember = members.find((m) => m.userId === currentUser?.id);

  const getPresenceDotClass = (userId: string) => {
    const isOnline = onlineUsers.has(userId);
    const status = userStatuses.get(userId) ?? 0;

    if (!isOnline || status === 3) return 'presence-dot offline';
    if (status === 1) return 'presence-dot away';
    if (status === 2) return 'presence-dot dnd';
    return 'presence-dot online';
  };

  // Detect if member list is in viewport
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setIsInViewport(entries[0].isIntersecting);
      },
      { threshold: 0 }
    );

    if (memberListRef.current) {
      observer.observe(memberListRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  // Combine window visibility with viewport visibility
  const shouldPauseAnimations = !isWindowVisible || !isInViewport;

  if (members.length === 0) return null;

  const online = members.filter((m) => onlineUsers.has(m.userId));
  const offline = members.filter((m) => !onlineUsers.has(m.userId));

  const displayRoleGroups = (() => {
    let roleOrder = [...roles]
      .filter((r) => !r.isDefault && r.displaySeparately)
      .sort((a, b) => b.position - a.position);
    const groups = new Map<string, ServerMember[]>();
    const ungrouped: ServerMember[] = [];

    for (const member of online) {
      const displayRoles = [...member.roles]
        .filter((r) => !r.isDefault && r.displaySeparately)
        .sort((a, b) => b.position - a.position);
      const topRole = displayRoles[0];
      if (topRole) {
        const list = groups.get(topRole.id);
        if (list) {
          list.push(member);
        } else {
          groups.set(topRole.id, [member]);
        }
      } else {
        ungrouped.push(member);
      }
    }

    if (roleOrder.length === 0 && groups.size > 0) {
      const fallbackRoles = new Map<string, ServerMember['roles'][number]>();
      for (const member of online) {
        for (const role of member.roles) {
          if (!role.isDefault && role.displaySeparately) {
            fallbackRoles.set(role.id, role);
          }
        }
      }
      roleOrder = [...fallbackRoles.values()].sort((a, b) => b.position - a.position);
    }

    const orderedGroups = roleOrder
      .map((role) => ({ role, members: groups.get(role.id) ?? [] }))
      .filter((g) => g.members.length > 0);

    return { orderedGroups, ungrouped };
  })();

  const handleMemberClick = (userId: string, e: React.MouseEvent) => {
    setProfileCard({ userId, x: e.clientX, y: e.clientY });
  };

  const handleContextMenu = (member: ServerMember, e: React.MouseEvent) => {
    e.preventDefault();
    if (!currentMember) return;
    const isSelf = member.userId === currentUser?.id;
    if (isSelf) return;
    openContextMenu(e.clientX, e.clientY,
      { user: member.user, member },
      {
        onViewProfile: () => setProfileCard({ userId: member.userId, x: e.clientX, y: e.clientY }),
      }
    );
  };

  const renderMember = (m: ServerMember) => {
    const displayColor = getDisplayColor(m);
    const nameplateStyle = getNameplateStyle(m.user);
    const nameStyle = nameplateStyle ?? (displayColor ? { color: displayColor } : undefined);
    const isHovered = hoveredMemberId === m.userId;

    // Add performance hints and hover-based animation control
    // Always add animationPlayState control if there's any nameplateStyle (not just when animation property exists)
    const optimizedStyle: React.CSSProperties | undefined = nameplateStyle ? {
      ...nameStyle,
      animationPlayState: (shouldPauseAnimations || !isHovered) ? 'paused' : 'running',
      ...(nameplateStyle?.animation ? {
        willChange: 'background-position',
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden',
      } : {}),
    } : nameStyle;

    return (
      <div
        key={m.userId}
        className={`member-item${!onlineUsers.has(m.userId) ? ' offline' : ''}`}
        onClick={(e) => handleMemberClick(m.userId, e)}
        onContextMenu={(e) => handleContextMenu(m, e)}
        onMouseEnter={() => setHoveredMemberId(m.userId)}
        onMouseLeave={() => setHoveredMemberId(null)}
      >
        <div className="member-avatar">
          {m.user.avatarUrl ? (
            <img src={m.user.avatarUrl.startsWith('http') ? m.user.avatarUrl : `${getApiBase()}${m.user.avatarUrl}`} alt={m.user.displayName} />
          ) : (
            <span>{m.user.displayName.charAt(0).toUpperCase()}</span>
          )}
          <span className={getPresenceDotClass(m.userId)} />
        </div>
        <div className="member-text">
          <span className="member-name" style={optimizedStyle}>{m.user.displayName}</span>
          <span className="member-status">{m.user.status || ''}</span>
        </div>
        {m.isOwner && <span className="member-badge" style={{ background: '#faa61a', color: '#000' }}>Owner</span>}
      </div>
    );
  };

  return (
    <div className="member-list" ref={memberListRef}>
      {displayRoleGroups.orderedGroups.map((group) => (
        <div key={group.role.id}>
          <span className="category-label">{group.role.name} — {group.members.length}</span>
          {group.members.map(renderMember)}
        </div>
      ))}
      {displayRoleGroups.ungrouped.length > 0 && (
        <>
          <span className="category-label">Online — {displayRoleGroups.ungrouped.length}</span>
          {displayRoleGroups.ungrouped.map(renderMember)}
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
    </div>
  );
}
