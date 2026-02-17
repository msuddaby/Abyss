import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore, parseValidationErrors, getGeneralError } from '@abyss/shared';
import FormField from './FormField';

export default function CreateChannelModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'Text' | 'Voice'>('Text');
  const [userLimit, setUserLimit] = useState('');
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const createChannel = useServerStore((s) => s.createChannel);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setValidationErrors(null);
    try {
      const limit = type === 'Voice' && userLimit ? parseInt(userLimit, 10) : null;
      await createChannel(serverId, name, type, limit);
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
