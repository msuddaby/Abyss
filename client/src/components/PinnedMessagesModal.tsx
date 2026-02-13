import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api, getApiBase, useAuthStore, useDmStore, useMessageStore, useServerStore, hasPermission, Permission } from '@abyss/shared';
import type { Message, PinnedMessage } from '@abyss/shared';

function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function PinnedMessagesModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const pinnedByChannel = useMessageStore((s) => s.pinnedByChannel);
  const pinnedLoading = useMessageStore((s) => s.pinnedLoading);
  const fetchPinnedMessages = useMessageStore((s) => s.fetchPinnedMessages);
  const unpinMessage = useMessageStore((s) => s.unpinMessage);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const members = useServerStore((s) => s.members);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const currentMember = members.find((m) => m.userId === currentUserId);
  const canManageMessages = currentMember ? hasPermission(currentMember, Permission.ManageMessages) : false;

  const canUnpin = isDmMode || canManageMessages;
  const pins = pinnedByChannel[channelId] || [];

  useEffect(() => {
    fetchPinnedMessages(channelId).catch(() => {});
  }, [channelId, fetchPinnedMessages]);

  const jumpToMessage = async (pinned: PinnedMessage) => {
    try {
      const res = await api.get(`/channels/${channelId}/messages/around/${pinned.message.id}`);
      const messages: Message[] = res.data;
      useMessageStore.setState({
        messages,
        currentChannelId: channelId,
        hasMore: true,
        hasNewer: true,
        highlightedMessageId: pinned.message.id,
        loading: false,
      });
      onClose();
    } catch (e) {
      console.error('Failed to jump to message', e);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pinned-messages-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pinned-header">
          <span className="pinned-header-title">Pinned Messages</span>
          <button className="pinned-close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="pinned-list">
          {pinnedLoading && <div className="loading">Loading pins...</div>}
          {!pinnedLoading && pins.length === 0 && (
            <div className="pinned-empty">
              <div className="pinned-empty-icon">pin</div>
              <div className="pinned-empty-text">No pinned messages yet</div>
              <div className="pinned-empty-hint">Pin important messages so they're easy to find later.</div>
            </div>
          )}
          {pins.map((p) => (
            <div key={p.message.id} className="pinned-card">
              <div className="pinned-card-body" onClick={() => jumpToMessage(p)}>
                <div className="pinned-avatar">
                  {p.message.author.avatarUrl ? (
                    <img
                      src={p.message.author.avatarUrl.startsWith('http')
                        ? p.message.author.avatarUrl
                        : `${getApiBase()}${p.message.author.avatarUrl}`}
                      alt=""
                    />
                  ) : (
                    <span>{p.message.author.displayName[0]}</span>
                  )}
                </div>
                <div className="pinned-info">
                  <div className="pinned-author">
                    <span className="pinned-author-name">{p.message.author.displayName}</span>
                    <span className="pinned-time">{formatDateTime(p.message.createdAt)}</span>
                  </div>
                  <div className="pinned-excerpt">
                    {p.message.content || (p.message.attachments.length > 0 ? '[Attachment]' : '[No content]')}
                  </div>
                </div>
              </div>
              {canUnpin && (
                <button className="pinned-unpin-btn" onClick={() => unpinMessage(p.message.id)} title="Unpin message">
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
