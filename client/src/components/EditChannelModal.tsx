import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function EditChannelModal({
  initialName,
  channelType,
  initialPersistentChat,
  initialUserLimit,
  onSave,
  onClose,
}: {
  initialName: string;
  channelType: 'Text' | 'Voice';
  initialPersistentChat?: boolean;
  initialUserLimit?: number | null;
  onSave: (name: string, persistentChat?: boolean, userLimit?: number | null) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [persistentChat, setPersistentChat] = useState(initialPersistentChat ?? false);
  const [userLimit, setUserLimit] = useState(initialUserLimit ? String(initialUserLimit) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  useEffect(() => {
    setPersistentChat(initialPersistentChat ?? false);
  }, [initialPersistentChat]);

  useEffect(() => {
    setUserLimit(initialUserLimit ? String(initialUserLimit) : '');
  }, [initialUserLimit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Channel name is required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const limit = channelType === 'Voice' ? (userLimit ? parseInt(userLimit, 10) : 0) : undefined;
      await onSave(
        name.trim(),
        channelType === 'Voice' ? persistentChat : undefined,
        limit,
      );
      onClose();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to update channel');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit {channelType} Channel</h2>
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
