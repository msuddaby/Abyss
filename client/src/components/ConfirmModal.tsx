import { useState } from 'react';

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
  danger,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  danger?: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      console.error('Confirm action failed', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', textAlign: 'center' }}>{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className={danger ? 'btn-danger' : undefined} onClick={handleConfirm} disabled={submitting}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
