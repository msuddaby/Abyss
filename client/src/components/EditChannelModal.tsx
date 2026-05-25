import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore, useXenForoStore } from '@abyss/shared';

type ChannelTypeValue = 'Text' | 'Voice' | 'RssFeed' | 'XenForoMirror';

export default function EditChannelModal({
  channelId,
  initialName,
  channelType,
  initialPersistentChat,
  initialUserLimit,
  initialRssFeedUrl,
  initialRssRefreshIntervalMinutes,
  initialXenForoNodeId,
  initialXenForoNodeTitle,
  onSave,
  onClose,
}: {
  channelId: string;
  initialName: string;
  channelType: ChannelTypeValue;
  initialPersistentChat?: boolean;
  initialUserLimit?: number | null;
  initialRssFeedUrl?: string | null;
  initialRssRefreshIntervalMinutes?: number | null;
  initialXenForoNodeId?: number | null;
  initialXenForoNodeTitle?: string | null;
  onSave: (
    name: string,
    persistentChat?: boolean,
    userLimit?: number | null,
    rssFeedUrl?: string | null,
    rssRefreshIntervalMinutes?: number | null,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [persistentChat, setPersistentChat] = useState(initialPersistentChat ?? false);
  const [userLimit, setUserLimit] = useState(initialUserLimit ? String(initialUserLimit) : '');
  const [rssFeedUrl, setRssFeedUrl] = useState(initialRssFeedUrl ?? '');
  const [rssInterval, setRssInterval] = useState(initialRssRefreshIntervalMinutes ? String(initialRssRefreshIntervalMinutes) : '30');
  const [xfNodeId, setXfNodeId] = useState<number | ''>(initialXenForoNodeId ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const xfNodes = useXenForoStore((s) => s.nodes);
  const fetchXfNodes = useXenForoStore((s) => s.fetchNodes);
  const subscribeMirror = useXenForoStore((s) => s.subscribeMirror);
  const unsubscribeMirror = useXenForoStore((s) => s.unsubscribeMirror);
  const updateChannelLocal = useServerStore((s) => s.updateChannelLocal);

  useEffect(() => { setName(initialName); }, [initialName]);
  useEffect(() => { setPersistentChat(initialPersistentChat ?? false); }, [initialPersistentChat]);
  useEffect(() => { setUserLimit(initialUserLimit ? String(initialUserLimit) : ''); }, [initialUserLimit]);
  useEffect(() => { setRssFeedUrl(initialRssFeedUrl ?? ''); }, [initialRssFeedUrl]);
  useEffect(() => { setRssInterval(initialRssRefreshIntervalMinutes ? String(initialRssRefreshIntervalMinutes) : '30'); }, [initialRssRefreshIntervalMinutes]);
  useEffect(() => { setXfNodeId(initialXenForoNodeId ?? ''); }, [initialXenForoNodeId]);

  useEffect(() => {
    if (channelType === 'XenForoMirror') {
      void fetchXfNodes().catch(() => undefined);
    }
  }, [channelType, fetchXfNodes]);

  const selectedNode = useMemo(
    () => xfNodes.find((n) => n.nodeId === xfNodeId) ?? null,
    [xfNodes, xfNodeId],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Channel name is required.');
      return;
    }
    if (channelType === 'RssFeed' && !rssFeedUrl.trim()) {
      setError('Feed URL is required.');
      return;
    }
    if (channelType === 'XenForoMirror' && (xfNodeId === '' || xfNodeId <= 0)) {
      setError('Pick a forum to mirror.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const limit = channelType === 'Voice' ? (userLimit ? parseInt(userLimit, 10) : 0) : undefined;
      const feedUrl = channelType === 'RssFeed' ? rssFeedUrl.trim() : undefined;
      const interval = channelType === 'RssFeed' && rssInterval ? parseInt(rssInterval, 10) : undefined;
      await onSave(
        name.trim(),
        channelType === 'Voice' ? persistentChat : undefined,
        limit,
        feedUrl,
        interval,
      );
      if (channelType === 'XenForoMirror' && xfNodeId !== initialXenForoNodeId) {
        const updated = await subscribeMirror(channelId, xfNodeId as number, selectedNode?.title ?? undefined);
        updateChannelLocal(updated);
      }
      onClose();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to update channel');
    } finally {
      setSaving(false);
    }
  };

  const handleStopMirroring = async () => {
    if (!confirm('Stop mirroring this forum? The channel will revert to a normal text channel.')) return;
    setSaving(true);
    try {
      await unsubscribeMirror(channelId);
      updateChannelLocal({
        id: channelId,
        name: name.trim() || initialName,
        type: 'Text',
        serverId: '',
        position: 0,
        xenForoNodeId: null,
        xenForoNodeTitle: null,
      } as any);
      onClose();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to stop mirroring');
      setSaving(false);
    }
  };

  const typeLabel = channelType === 'RssFeed'
    ? 'RSS Feed'
    : channelType === 'XenForoMirror'
      ? 'Forum Mirror'
      : channelType;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit {typeLabel} Channel</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <label>
            Channel Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>
          {channelType === 'Voice' && (
            <>
              <div className="edit-channel-toggle" onClick={() => setPersistentChat(!persistentChat)}>
                <div className={`toggle-switch${persistentChat ? ' on' : ''}`}>
                  <div className="toggle-knob" />
                </div>
                <div className="edit-channel-toggle-text">
                  <span>Persistent Chat</span>
                  <div className="server-setting-hint">Keep chat messages after everyone leaves</div>
                </div>
              </div>
              <label>
                User Limit
                <input
                  type="number"
                  min="0"
                  max="99"
                  placeholder="No limit"
                  value={userLimit}
                  onChange={(e) => setUserLimit(e.target.value)}
                />
                <div className="server-setting-hint">0 or empty for unlimited</div>
              </label>
            </>
          )}
          {channelType === 'RssFeed' && (
            <>
              <label>
                Feed URL
                <input
                  type="url"
                  value={rssFeedUrl}
                  onChange={(e) => setRssFeedUrl(e.target.value)}
                  placeholder="https://example.com/feed.rss"
                  required
                />
              </label>
              <label>
                Refresh Interval (minutes)
                <input
                  type="number"
                  min="5"
                  max="1440"
                  value={rssInterval}
                  onChange={(e) => setRssInterval(e.target.value)}
                />
                <div className="server-setting-hint">5–1440 minutes</div>
              </label>
            </>
          )}
          {channelType === 'XenForoMirror' && (
            <>
              <label>
                Forum to mirror
                <select
                  value={xfNodeId}
                  onChange={(e) => setXfNodeId(e.target.value ? parseInt(e.target.value, 10) : '')}
                  required
                >
                  <option value="">Choose a forum…</option>
                  {xfNodes.map((node) => (
                    <option key={node.nodeId} value={node.nodeId}>
                      {node.title}
                    </option>
                  ))}
                </select>
                <div className="server-setting-hint">
                  {initialXenForoNodeTitle
                    ? `Currently mirroring "${initialXenForoNodeTitle}".`
                    : 'Pick a forum to mirror.'}
                </div>
              </label>
              <button type="button" className="btn-secondary" onClick={handleStopMirroring} disabled={saving}>
                Stop mirroring
              </button>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" disabled={saving}>Save</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
