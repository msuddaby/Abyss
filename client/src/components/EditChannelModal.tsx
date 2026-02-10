import { useEffect, useState } from 'react';

export default function EditChannelModal({
  initialName,
  channelType,
  initialPersistentChat,
  onSave,
  onClose,
}: {
  initialName: string;
  channelType: 'Text' | 'Voice';
  initialPersistentChat?: boolean;
  onSave: (name: string, persistentChat?: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [persistentChat, setPersistentChat] = useState(initialPersistentChat ?? false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  useEffect(() => {
    setPersistentChat(initialPersistentChat ?? false);
  }, [initialPersistentChat]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Channel name is required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave(name.trim(), channelType === 'Voice' ? persistentChat : undefined);
      onClose();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to update channel');
    } finally {
      setSaving(false);
    }
  };

  return (
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
            <label className="edit-channel-checkbox">
              <input type="checkbox" checked={persistentChat} onChange={(e) => setPersistentChat(e.target.checked)} />
              <span>Persistent Chat</span>
              <div className="server-setting-hint">Keep chat messages after everyone leaves</div>
            </label>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" disabled={saving}>Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}
