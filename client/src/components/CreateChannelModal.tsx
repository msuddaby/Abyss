import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore, useXenForoStore, parseValidationErrors, getGeneralError } from '@abyss/shared';
import FormField from './FormField';

type ChannelTypeOption = 'Text' | 'Voice' | 'RssFeed' | 'XenForoMirror';

export default function CreateChannelModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ChannelTypeOption>('Text');
  const [userLimit, setUserLimit] = useState('');
  const [rssFeedUrl, setRssFeedUrl] = useState('');
  const [rssInterval, setRssInterval] = useState('30');
  const [xfNodeId, setXfNodeId] = useState<number | ''>('');
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const createChannel = useServerStore((s) => s.createChannel);
  const updateChannelLocal = useServerStore((s) => s.updateChannelLocal);
  const xfNodes = useXenForoStore((s) => s.nodes);
  const fetchXfNodes = useXenForoStore((s) => s.fetchNodes);
  const subscribeMirror = useXenForoStore((s) => s.subscribeMirror);

  useEffect(() => {
    if (type === 'XenForoMirror') {
      void fetchXfNodes().catch(() => undefined);
    }
  }, [type, fetchXfNodes]);

  const selectedNode = useMemo(
    () => xfNodes.find((n) => n.nodeId === xfNodeId) ?? null,
    [xfNodes, xfNodeId],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setValidationErrors(null);
    try {
      const limit = type === 'Voice' && userLimit ? parseInt(userLimit, 10) : null;
      const feedUrl = type === 'RssFeed' ? rssFeedUrl.trim() : null;
      const interval = type === 'RssFeed' && rssInterval ? parseInt(rssInterval, 10) : null;
      if (type === 'RssFeed' && !feedUrl) {
        setError('Feed URL is required for RSS channels.');
        return;
      }
      if (type === 'XenForoMirror' && (xfNodeId === '' || xfNodeId <= 0)) {
        setError('Pick a forum to mirror.');
        return;
      }

      // Mirror channels are created as Text first, then converted via the
      // subscribe endpoint — the create endpoint doesn't know about XF.
      const createType = type === 'XenForoMirror' ? 'Text' : type;
      const channel = await createChannel(serverId, name, createType, limit, feedUrl, interval);
      if (type === 'XenForoMirror' && channel) {
        const updated = await subscribeMirror(channel.id, xfNodeId as number, selectedNode?.title ?? undefined);
        updateChannelLocal(updated);
      }
      onClose();
    } catch (err: any) {
      const parsedErrors = parseValidationErrors(err);
      if (parsedErrors) {
        setValidationErrors(parsedErrors);
        const generalError = getGeneralError(parsedErrors);
        if (generalError) {
          setError(generalError);
        }
      } else {
        setError(err.response?.data || 'Failed to create channel');
      }
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create Channel</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <label>
            Channel Type
            <div className="channel-type-select">
              <button
                type="button"
                className={`type-option ${type === 'Text' ? 'active' : ''}`}
                onClick={() => setType('Text')}
              >
                # Text
              </button>
              <button
                type="button"
                className={`type-option ${type === 'Voice' ? 'active' : ''}`}
                onClick={() => setType('Voice')}
              >
                🔊 Voice
              </button>
              <button
                type="button"
                className={`type-option ${type === 'RssFeed' ? 'active' : ''}`}
                onClick={() => setType('RssFeed')}
              >
                📰 RSS Feed
              </button>
              <button
                type="button"
                className={`type-option ${type === 'XenForoMirror' ? 'active' : ''}`}
                onClick={() => setType('XenForoMirror')}
              >
                💬 Forum Mirror
              </button>
            </div>
          </label>

          <FormField
            label="Channel Name"
            name="Name"
            value={name}
            onChange={setName}
            required
            errors={validationErrors}
          />

          {type === 'Voice' && (
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
          )}

          {type === 'RssFeed' && (
            <>
              <FormField
                label="Feed URL"
                name="RssFeedUrl"
                value={rssFeedUrl}
                onChange={setRssFeedUrl}
                required
                placeholder="https://example.com/feed.rss"
                errors={validationErrors}
              />
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

          {type === 'XenForoMirror' && (
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
                New threads and replies on this forum will appear in the channel.
              </div>
            </label>
          )}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit">Create</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
