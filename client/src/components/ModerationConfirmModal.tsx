import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore } from '@abyss/shared';
import { useModerationStore } from '../stores/moderationStore';

export default function ModerationConfirmModal() {
  const pending = useModerationStore((s) => s.pending);
  const close = useModerationStore((s) => s.close);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!pending) return null;

  const isBan = pending.type === 'ban';

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (isBan) {
        await useServerStore.getState().banMember(pending.serverId, pending.userId, reason.trim() || undefined);
      } else {
        await useServerStore.getState().kickMember(pending.serverId, pending.userId);
      }
      setReason('');
      close();
    } catch (err) {
      console.error(`${pending.type} failed`, err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setReason('');
    close();
  };

  return createPortal(
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{isBan ? 'Ban' : 'Kick'} {pending.displayName}</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', textAlign: 'center' }}>
          Are you sure you want to {isBan ? 'ban' : 'kick'} <strong>{pending.displayName}</strong>?
          {isBan && ' They will not be able to rejoin until unbanned.'}
        </p>
        {isBan && (
          <div style={{ width: '100%', marginBottom: '16px' }}>
            <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '6px', textTransform: 'uppercase', fontWeight: 600 }}>
              Reason (optional)
            </label>
            <textarea
              className="moderation-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Enter a reason for the ban..."
              maxLength={256}
              rows={3}
            />
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={handleClose} disabled={submitting}>Cancel</button>
          <button type="button" className="btn-danger" onClick={handleConfirm} disabled={submitting}>
            {isBan ? 'Ban' : 'Kick'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
