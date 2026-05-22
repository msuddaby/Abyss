import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore, parseValidationErrors, getGeneralError } from '@abyss/shared';
import FormField from './FormField';

type ChannelTypeOption = 'Text' | 'Voice' | 'RssFeed';

export default function CreateChannelModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ChannelTypeOption>('Text');
  const [userLimit, setUserLimit] = useState('');
  const [rssFeedUrl, setRssFeedUrl] = useState('');
  const [rssInterval, setRssInterval] = useState('30');
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const createChannel = useServerStore((s) => s.createChannel);

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
      await createChannel(serverId, name, type, limit, feedUrl, interval);
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
