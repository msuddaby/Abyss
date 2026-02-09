import { useEffect, useState } from 'react';
import { api, getApiBase, useServerStore } from '@abyss/shared';
import type { User } from '@abyss/shared';

interface Props {
  userId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export default function UserProfileCard({ userId, position, onClose }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const members = useServerStore((s) => s.members);
  const member = members.find((m) => m.userId === userId);

  useEffect(() => {
    api.get(`/auth/profile/${userId}`).then((res) => setUser(res.data)).catch(console.error);
  }, [userId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.user-profile-card')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (!user) return null;

  const avatarUrl = user.avatarUrl
    ? (user.avatarUrl.startsWith('http') ? user.avatarUrl : `${getApiBase()}${user.avatarUrl}`)
    : null;

  // Position the card so it doesn't go off-screen
  const style: React.CSSProperties = {
    top: Math.min(position.y, window.innerHeight - 320),
    left: Math.min(position.x, window.innerWidth - 300),
  };

  const nonDefaultRoles = [...(member?.roles ?? [])].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);

  return (
    <div className="user-profile-card" style={style}>
      <div className="profile-card-banner" />
      <div className="profile-card-avatar">
        {avatarUrl ? (
          <img src={avatarUrl} alt={user.displayName} />
        ) : (
          <span>{user.displayName.charAt(0).toUpperCase()}</span>
        )}
      </div>
      <div className="profile-card-body">
        <div className="profile-card-name">{user.displayName}</div>
        <div className="profile-card-status">{user.status || ''}</div>
        <div className="profile-card-username">@{user.username}</div>
        {nonDefaultRoles.length > 0 && (
          <div className="profile-card-roles">
            {nonDefaultRoles.map((role) => (
              <span key={role.id} className="role-pill">
                <span className="role-pill-dot" style={{ background: role.color }} />
                {role.name}
              </span>
            ))}
          </div>
        )}
        {member?.isOwner && (
          <div className="profile-card-roles">
            <span className="role-pill">
              <span className="role-pill-dot" style={{ background: '#faa61a' }} />
              Owner
            </span>
          </div>
        )}
        {user.bio && <div className="profile-card-bio">{user.bio}</div>}
      </div>
    </div>
  );
}
