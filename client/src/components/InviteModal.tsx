import { useState } from 'react';
import api from '../services/api';

export default function InviteModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  const generateInvite = async () => {
    const res = await api.post(`/servers/${serverId}/invites`);
    setCode(res.data.code);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Invite People</h2>
        {code ? (
          <div className="invite-code-display">
            <p>Share this invite code:</p>
            <div className="invite-code-row">
              <code className="invite-code">{code}</code>
              <button onClick={copyCode}>{copied ? 'Copied!' : 'Copy'}</button>
            </div>
          </div>
        ) : (
          <button onClick={generateInvite}>Generate Invite Link</button>
        )}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
