import { useState } from 'react';
import { useServerStore } from '@abyss/shared';

export default function CreateChannelModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'Text' | 'Voice'>('Text');
  const [error, setError] = useState('');
  const createChannel = useServerStore((s) => s.createChannel);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createChannel(serverId, name, type);
      onClose();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to create channel');
    }
  };

  return (
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
            </div>
          </label>
          <label>
            Channel Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
