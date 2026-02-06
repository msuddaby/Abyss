import { useState } from 'react';
import { useServerStore } from '../stores/serverStore';

export default function JoinServerModal({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const joinServer = useServerStore((s) => s.joinServer);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await joinServer(code);
      onClose();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to join server');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Join a Server</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <label>
            Invite Code
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enter invite code" required autoFocus />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit">Join</button>
          </div>
        </form>
      </div>
    </div>
  );
}
