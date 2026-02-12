import { useState, useRef, useEffect } from 'react';
import { useFriendStore, useDmStore, useMessageStore, useServerStore, usePresenceStore, useToastStore, api, getApiBase } from '@abyss/shared';
import type { User } from '@abyss/shared';
import ConfirmModal from './ConfirmModal';

export default function FriendsList() {
  const { friends, requests, sendRequest, acceptRequest, declineRequest, removeFriend } = useFriendStore();
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<(User & { friendStatus?: string })[]>([]);
  const [searching, setSearching] = useState(false);
  const [friendToRemove, setFriendToRemove] = useState<{ id: string; name: string } | null>(null);
  const [sendingRequest, setSendingRequest] = useState<string | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const incomingRequests = requests.filter((r) => !r.isOutgoing);
  const outgoingRequests = requests.filter((r) => r.isOutgoing);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimeout.current = setTimeout(async () => {
      try {
        const res = await api.get('/dm/search', { params: { q: query } });
        // Annotate each result with friend status
        const results: (User & { friendStatus?: string })[] = res.data;
        for (const u of results) {
          const isFriend = friends.some((f) => f.user.id === u.id);
          const isPending = requests.some((r) => r.user.id === u.id);
          if (isFriend) (u as any).friendStatus = 'accepted';
          else if (isPending) (u as any).friendStatus = 'pending';
          else (u as any).friendStatus = 'none';
        }
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const handleSendRequest = async (userId: string) => {
    setSendingRequest(userId);
    try {
      await sendRequest(userId);
      useToastStore.getState().addToast('Friend request sent!', 'success');
      // Update the search result status
      setSearchResults((prev) =>
        prev.map((u) => u.id === userId ? { ...u, friendStatus: 'pending' } : u)
      );
    } catch (err: any) {
      const msg = err?.response?.data || 'Failed to send friend request';
      useToastStore.getState().addToast(msg, 'error');
    } finally {
      setSendingRequest(null);
    }
  };

  const handleMessage = async (userId: string) => {
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
  };

  return (
    <div className="friends-list">
      <div className="add-friend-section">
        <input
          ref={searchInputRef}
          className="add-friend-input"
          type="text"
          placeholder="Add friend by username..."
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
        />
        {searchQuery.trim() && (
          <div className="dm-search-results">
            {searching && <div className="dm-search-empty">Searching...</div>}
            {!searching && searchResults.length === 0 && <div className="dm-search-empty">No users found</div>}
            {searchResults.map((u) => (
              <div key={u.id} className="dm-search-result-item" style={{ cursor: 'default' }}>
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
                <div className="friend-item-actions">
                  {(u as any).friendStatus === 'accepted' && (
                    <button className="friend-action-btn" disabled>Friends</button>
                  )}
                  {(u as any).friendStatus === 'pending' && (
                    <button className="friend-action-btn" disabled>Pending</button>
                  )}
                  {(u as any).friendStatus === 'none' && (
                    <button
                      className="friend-action-btn accept"
                      onClick={() => handleSendRequest(u.id)}
                      disabled={sendingRequest === u.id}
                    >
                      {sendingRequest === u.id ? '...' : 'Add Friend'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="channel-list">
        {incomingRequests.length > 0 && (
          <div className="friends-section">
            <span className="friends-section-label">Incoming Requests — {incomingRequests.length}</span>
            {incomingRequests.map((req) => (
              <div key={req.id} className="friend-item">
                <div className="dm-avatar">
                  {req.user.avatarUrl ? (
                    <img src={req.user.avatarUrl.startsWith('http') ? req.user.avatarUrl : `${getApiBase()}${req.user.avatarUrl}`} alt={req.user.displayName} />
                  ) : (
                    <span>{req.user.displayName.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <div className="friend-item-info">
                  <span className="friend-item-name">{req.user.displayName}</span>
                </div>
                <div className="friend-item-actions">
                  <button className="friend-action-btn accept" onClick={() => acceptRequest(req.id)}>Accept</button>
                  <button className="friend-action-btn decline" onClick={() => declineRequest(req.id)}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {outgoingRequests.length > 0 && (
          <div className="friends-section">
            <span className="friends-section-label">Outgoing Requests — {outgoingRequests.length}</span>
            {outgoingRequests.map((req) => (
              <div key={req.id} className="friend-item">
                <div className="dm-avatar">
                  {req.user.avatarUrl ? (
                    <img src={req.user.avatarUrl.startsWith('http') ? req.user.avatarUrl : `${getApiBase()}${req.user.avatarUrl}`} alt={req.user.displayName} />
                  ) : (
                    <span>{req.user.displayName.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <div className="friend-item-info">
                  <span className="friend-item-name">{req.user.displayName}</span>
                </div>
                <div className="friend-item-actions">
                  <button className="friend-action-btn" disabled>Pending</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {friends.length > 0 && (
          <div className="friends-section">
            <span className="friends-section-label">Friends — {friends.length}</span>
            {friends.map((friend) => {
              const isOnline = onlineUsers.has(friend.user.id);
              return (
                <div key={friend.id} className="friend-item">
                  <div className="dm-avatar">
                    {friend.user.avatarUrl ? (
                      <img src={friend.user.avatarUrl.startsWith('http') ? friend.user.avatarUrl : `${getApiBase()}${friend.user.avatarUrl}`} alt={friend.user.displayName} />
                    ) : (
                      <span>{friend.user.displayName.charAt(0).toUpperCase()}</span>
                    )}
                    <span className={`presence-dot ${isOnline ? 'online' : 'offline'}`} />
                  </div>
                  <div className="friend-item-info">
                    <span className="friend-item-name">{friend.user.displayName}</span>
                  </div>
                  <div className="friend-item-actions">
                    <button className="friend-action-btn" onClick={() => handleMessage(friend.user.id)} title="Message">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                    </button>
                    <button className="friend-action-btn decline" onClick={() => setFriendToRemove({ id: friend.id, name: friend.user.displayName })} title="Remove Friend">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {friends.length === 0 && requests.length === 0 && !searchQuery && (
          <div className="dm-empty">
            <p style={{ color: 'var(--text-muted)', padding: '16px', fontSize: '13px' }}>No friends yet. Search for users above to add them!</p>
          </div>
        )}
      </div>

      {friendToRemove && (
        <ConfirmModal
          title="Remove Friend"
          message={`Remove ${friendToRemove.name} from your friends list?`}
          confirmLabel="Remove"
          danger
          onConfirm={async () => {
            await removeFriend(friendToRemove.id);
            setFriendToRemove(null);
          }}
          onClose={() => setFriendToRemove(null)}
        />
      )}
    </div>
  );
}
