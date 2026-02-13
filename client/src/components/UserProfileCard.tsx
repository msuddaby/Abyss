import { useEffect, useState } from 'react';
import { api, getApiBase, useServerStore, useAuthStore, useFriendStore, useDmStore, useMessageStore, useToastStore, getNameplateStyle } from '@abyss/shared';
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
  const currentUser = useAuthStore((s) => s.user);
  const [friendStatus, setFriendStatus] = useState<{ id?: string; status: string; isOutgoing?: boolean } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    api.get(`/auth/profile/${userId}`).then((res) => setUser(res.data)).catch(console.error);
  }, [userId]);

  useEffect(() => {
    if (userId !== currentUser?.id) {
      useFriendStore.getState().getFriendStatus(userId).then(setFriendStatus).catch(console.error);
    }
  }, [userId, currentUser?.id]);

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
    top: Math.min(position.y, window.innerHeight - 380),
    left: Math.min(position.x, window.innerWidth - 300),
  };

  const nonDefaultRoles = [...(member?.roles ?? [])].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);

  const handleMessage = async () => {
    const { createOrGetDm, enterDmMode, setActiveDmChannel } = useDmStore.getState();
    const { leaveChannel, joinChannel, fetchMessages, currentChannelId } = useMessageStore.getState();
    if (currentChannelId) {
      await leaveChannel(currentChannelId).catch(console.error);
    }
    const dm = await createOrGetDm(userId);
    enterDmMode();
    useServerStore.getState().clearActiveServer();
    setActiveDmChannel(dm);
    await joinChannel(dm.id).catch(console.error);
    fetchMessages(dm.id);
    onClose();
  };

  const handleFriendAction = async () => {
    if (!friendStatus) return;
    setActionLoading(true);
    try {
      if (friendStatus.status === 'none') {
        await useFriendStore.getState().sendRequest(userId);
        setFriendStatus({ status: 'pending', isOutgoing: true });
        useToastStore.getState().addToast('Friend request sent!', 'success');
      } else if (friendStatus.status === 'pending' && !friendStatus.isOutgoing && friendStatus.id) {
        await useFriendStore.getState().acceptRequest(friendStatus.id);
        setFriendStatus({ id: friendStatus.id, status: 'accepted' });
      } else if (friendStatus.status === 'accepted' && friendStatus.id) {
        await useFriendStore.getState().removeFriend(friendStatus.id);
        setFriendStatus({ status: 'none' });
      }
    } catch (err: any) {
      useToastStore.getState().addToast(err?.response?.data || 'Action failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const isSelf = userId === currentUser?.id;

  const friendBtnLabel = (() => {
    if (!friendStatus) return '';
    switch (friendStatus.status) {
      case 'none': return 'Add Friend';
      case 'pending': return friendStatus.isOutgoing ? 'Request Sent' : 'Accept Request';
      case 'accepted': return 'Remove Friend';
      default: return 'Add Friend';
    }
  })();

  const friendBtnDisabled = actionLoading || (friendStatus?.status === 'pending' && friendStatus.isOutgoing);

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
        <div className="profile-card-name" style={getNameplateStyle(user)}>{user.displayName}</div>
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
        {!isSelf && (
          <div className="profile-card-actions">
            <button className="profile-card-btn primary" onClick={handleMessage}>Message</button>
            {friendStatus && (
              <button
                className={`profile-card-btn${friendStatus.status === 'accepted' ? ' danger' : ' secondary'}`}
                onClick={handleFriendAction}
                disabled={!!friendBtnDisabled}
              >
                {friendBtnLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
