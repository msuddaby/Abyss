import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@abyss/shared';

export default function InviteModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const generateInvite = async () => {
    const payload: { maxUses?: number; expiresAt?: string } = {};
    const parsedMax = Number(maxUses);
    if (!Number.isNaN(parsedMax) && parsedMax > 0) payload.maxUses = parsedMax;
    if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
    const res = await api.post(`/servers/${serverId}/invites`, payload);
    setCode(res.data.code);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return createPortal(
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
          <div className="invite-options">
            <div className="invite-options-row">
              <input
                type="number"
                min={1}
                placeholder="Max uses (optional)"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <button onClick={generateInvite}>Generate Invite Link</button>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
