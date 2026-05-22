import { useEffect, useMemo } from 'react';
import { useServerStore, useRssFeedStore, useAuthStore, useMessageStore, hasPermission, Permission } from '@abyss/shared';
import type { ServerMember } from '@abyss/shared';

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export default function RssFeedChannelView() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const members = useServerStore((s) => s.members);
  const user = useAuthStore((s) => s.user);
  const channelState = useRssFeedStore((s) => (activeChannel ? s.feeds[activeChannel.id] : undefined));
  const fetchItems = useRssFeedStore((s) => s.fetchItems);
  const forceRefresh = useRssFeedStore((s) => s.forceRefresh);
  const joinChannel = useMessageStore((s) => s.joinChannel);
  const leaveChannel = useMessageStore((s) => s.leaveChannel);

  const currentMember = useMemo(
    () => members.find((m: ServerMember) => m.userId === user?.id),
    [members, user?.id]
  );
  const canManage = currentMember ? hasPermission(currentMember, Permission.ManageChannels) : false;

  // Join the channel:{id} SignalR group so we receive RssFeedUpdated broadcasts.
  useEffect(() => {
    if (!activeChannel || activeChannel.type !== 'RssFeed') return;
    const channelId = activeChannel.id;
    joinChannel(channelId).catch(() => {});
    fetchItems(channelId);
    return () => {
      leaveChannel(channelId).catch(() => {});
    };
  }, [activeChannel?.id, activeChannel?.type, joinChannel, leaveChannel, fetchItems]);

  if (!activeChannel || activeChannel.type !== 'RssFeed') return null;

  const items = channelState?.items ?? [];
  const lastFetched = channelState?.lastFetched ?? null;
  const lastError = channelState?.lastError ?? null;
  const loading = channelState?.loading ?? false;

  return (
    <div className="rss-feed-view">
      <div className="rss-feed-bar">
        <div className="rss-feed-bar-info">
          {activeChannel.rssFeedUrl && (
            <a className="rss-feed-source" href={activeChannel.rssFeedUrl} target="_blank" rel="noopener noreferrer" title={activeChannel.rssFeedUrl}>
              {activeChannel.rssFeedUrl}
            </a>
          )}
          <span className="rss-feed-meta">
            {lastFetched ? `Updated ${formatRelative(lastFetched)}` : 'Never fetched'}
            {activeChannel.rssRefreshIntervalMinutes ? ` · every ${activeChannel.rssRefreshIntervalMinutes}m` : ''}
          </span>
        </div>
        {canManage && (
          <button
            type="button"
            className="rss-feed-refresh-btn"
            onClick={() => forceRefresh(activeChannel.id)}
            disabled={loading}
            title="Refresh now"
          >
            {loading ? '...' : 'Refresh'}
          </button>
        )}
      </div>

      {lastError && (
        <div className="rss-feed-error">Failed to load feed: {lastError}</div>
      )}

      {loading && items.length === 0 ? (
        <div className="rss-feed-empty">Loading feed...</div>
      ) : items.length === 0 ? (
        <div className="rss-feed-empty">No items in this feed yet.</div>
      ) : (
        <ul className="rss-feed-list">
          {items.map((item) => (
            <li key={item.guid} className="rss-feed-item">
              <a
                className="rss-feed-item-title"
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.title}
              </a>
              <div className="rss-feed-item-meta">
                {item.author && <span className="rss-feed-item-author">{item.author}</span>}
                {item.pubDate && <span className="rss-feed-item-date">{formatRelative(item.pubDate)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
