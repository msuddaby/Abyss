import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore, parseValidationErrors, getGeneralError } from '@abyss/shared';
import FormField from './FormField';

export default function GuestUpgradeModal({ onClose }: { onClose: () => void }) {
  const upgradeAccount = useAuthStore((s) => s.upgradeAccount);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setValidationErrors(null);
    setSubmitting(true);
    try {
      await upgradeAccount(email, password);
      onClose();
    } catch (err: any) {
      const parsedErrors = parseValidationErrors(err);
      if (parsedErrors) {
        setValidationErrors(parsedErrors);
        const generalError = getGeneralError(parsedErrors);
        if (generalError) setError(generalError);
      } else {
        setError(err.response?.data || 'Upgrade failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create Your Account</h2>
        <p className="auth-subtitle">Add an email and password to keep your username and data.</p>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <FormField
            label="Email"
            name="Email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            placeholder="your@email.com"
            errors={validationErrors}
            autoComplete="email"
          />
          <FormField
            label="Password"
            name="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            placeholder="At least 8 characters"
            errors={validationErrors}
            autoComplete="new-password"
          />
          <button type="submit" disabled={submitting}>
            {submitting ? 'Upgrading...' : 'Create Account'}
          </button>
        </form>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Not now</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
