import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore, parseValidationErrors, getGeneralError } from '@abyss/shared';
import FormField from './FormField';

export default function CreateServerModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const createServer = useServerStore((s) => s.createServer);
  const setActiveServer = useServerStore((s) => s.setActiveServer);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setValidationErrors(null);
    try {
      const server = await createServer(name);
      await setActiveServer(server);
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
        setError(err.response?.data || 'Failed to create server');
      }
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create a Server</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <FormField
            label="Server Name"
            name="Name"
            value={name}
            onChange={setName}
            required
            errors={validationErrors}
          />
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
