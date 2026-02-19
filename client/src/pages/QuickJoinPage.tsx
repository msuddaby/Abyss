import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, useAuthStore, parseValidationErrors, getGeneralError } from '@abyss/shared';
import type { InviteInfo } from '@abyss/shared';
import FormField from '../components/FormField';

export default function QuickJoinPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const guestJoin = useAuthStore((s) => s.guestJoin);

  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteError, setInviteError] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!code) return;

    // If already authenticated, join via the normal flow
    if (isAuthenticated) {
      api.post(`/invites/${code}/join`)
        .then(() => navigate('/'))
        .catch((err: any) => {
          // Already a member — just redirect
          if (err.response?.status === 200) {
            navigate('/');
          } else {
            setInviteError(err.response?.data || 'Failed to join server');
            setLoading(false);
          }
        });
      return;
    }

    api.get(`/invites/${code}/info`)
      .then((res) => {
        setInviteInfo(res.data);
        setLoading(false);
      })
      .catch((err: any) => {
        setInviteError(err.response?.data || 'Invalid or expired invite');
        setLoading(false);
      });
  }, [code, isAuthenticated, navigate]);

  const handleGuestJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code) return;
    setError('');
    setValidationErrors(null);
    setJoining(true);
    try {
      await guestJoin(code, username, displayName || username);
      navigate('/');
    } catch (err: any) {
      const parsedErrors = parseValidationErrors(err);
      if (parsedErrors) {
        setValidationErrors(parsedErrors);
        const generalError = getGeneralError(parsedErrors);
        if (generalError) setError(generalError);
      } else {
        setError(err.response?.data || 'Failed to join');
      }
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <div className="app-loading-spinner" />
          <p style={{ textAlign: 'center', marginTop: '1rem' }}>Loading invite...</p>
        </div>
      </div>
    );
  }

  if (inviteError) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <h1>Invalid Invite</h1>
          <p className="auth-subtitle">{inviteError}</p>
          <p className="auth-link">
            <Link to="/login">Log in</Link> or <Link to="/register">Register</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-form">
        {inviteInfo && (
          <div className="invite-server-info">
            {inviteInfo.serverIconUrl ? (
              <img className="invite-server-icon" src={inviteInfo.serverIconUrl} alt="" />
            ) : (
              <div className="invite-server-icon invite-server-icon-placeholder">
                {inviteInfo.serverName.charAt(0).toUpperCase()}
              </div>
            )}
            <h1>{inviteInfo.serverName}</h1>
            <p className="auth-subtitle">{inviteInfo.memberCount} {inviteInfo.memberCount === 1 ? 'member' : 'members'}</p>
          </div>
        )}

        {inviteInfo?.allowGuests ? (
          <>
            <p className="auth-subtitle">Pick a username to join as a guest</p>
            {error && <div className="auth-error">{error}</div>}
            <form onSubmit={handleGuestJoin}>
              <FormField
                label="Username"
                name="Username"
                value={username}
                onChange={setUsername}
                required
                placeholder="Choose a username"
                errors={validationErrors}
                autoComplete="username"
              />
              <FormField
                label="Display Name"
                name="DisplayName"
                value={displayName}
                onChange={setDisplayName}
                placeholder={username || 'Display name (optional)'}
                errors={validationErrors}
              />
              <button type="submit" disabled={joining || !username.trim()}>
                {joining ? 'Joining...' : 'Join as Guest'}
              </button>
            </form>
          </>
        ) : (
          <p className="auth-subtitle">Log in or register to join this server.</p>
        )}

        <p className="auth-link">
          <Link to="/login">Log in</Link> or <Link to="/register">Register</Link>
        </p>
      </div>
    </div>
  );
}
