import { useEffect, useMemo, useState } from 'react';
import { api, useAuthStore } from '@abyss/shared';
import type { AdminOverview, AdminServer, AdminUser, AdminSettings, InviteCode } from '@abyss/shared';

type TabKey = 'overview' | 'servers' | 'users' | 'settings';

export default function AdminPanelModal({ onClose }: { onClose: () => void }) {
  const isSysadmin = useAuthStore((s) => s.isSysadmin);
  const [tab, setTab] = useState<TabKey>('overview');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverQuery, setServerQuery] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [savingInviteOnly, setSavingInviteOnly] = useState(false);
  const [creatingCode, setCreatingCode] = useState(false);
  const [maxUses, setMaxUses] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [newCode, setNewCode] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, settingsRes] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/settings'),
      ]);
      setData(overviewRes.data);
      setSettings(settingsRes.data);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to load admin overview.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSysadmin) {
      load();
    }
  }, [isSysadmin]);

  const filteredServers = useMemo(() => {
    if (!data?.servers) return [] as AdminServer[];
    const q = serverQuery.trim().toLowerCase();
    if (!q) return data.servers;
    return data.servers.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.ownerId.toLowerCase().includes(q));
  }, [data, serverQuery]);

  const filteredUsers = useMemo(() => {
    if (!data?.users) return [] as AdminUser[];
    const q = userQuery.trim().toLowerCase();
    if (!q) return data.users;
    return data.users.filter((u) => {
      return u.username.toLowerCase().includes(q)
        || u.displayName.toLowerCase().includes(q)
        || u.id.toLowerCase().includes(q)
        || (u.email || '').toLowerCase().includes(q);
    });
  }, [data, userQuery]);

  const updateInviteOnly = async (enabled: boolean) => {
    if (!settings) return;
    setSavingInviteOnly(true);
    setError(null);
    try {
      await api.put('/admin/settings/invite-only', { inviteOnly: enabled });
      setSettings({ ...settings, inviteOnly: enabled });
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to update invite-only setting.');
    } finally {
      setSavingInviteOnly(false);
    }
  };

  const createInviteCode = async () => {
    setCreatingCode(true);
    setError(null);
    setNewCode(null);
    try {
      const payload: { maxUses?: number; expiresAt?: string } = {};
      const parsedMax = Number(maxUses);
      if (!Number.isNaN(parsedMax) && parsedMax > 0) payload.maxUses = parsedMax;
      if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
      const res = await api.post('/admin/invite-codes', payload);
      const created: InviteCode = res.data;
      setSettings((prev) => prev ? { ...prev, codes: [created, ...prev.codes] } : prev);
      setNewCode(created.code);
      setMaxUses('');
      setExpiresAt('');
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to create invite code.');
    } finally {
      setCreatingCode(false);
    }
  };

  if (!isSysadmin) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal admin-panel-modal" onClick={(e) => e.stopPropagation()}>
          <h2>Admin Panel</h2>
          <div className="admin-empty">You do not have sysadmin access.</div>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-header">
          <div>
            <div className="admin-kicker">System</div>
            <h2>Admin Control Panel</h2>
          </div>
          <button className="btn-secondary" onClick={load} disabled={loading}>Refresh</button>
        </div>

        <div className="admin-tabs">
          <button className={`admin-tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
          <button className={`admin-tab ${tab === 'servers' ? 'active' : ''}`} onClick={() => setTab('servers')}>Servers</button>
          <button className={`admin-tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>Users</button>
          <button className={`admin-tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
        </div>

        {error && <div className="admin-error">{error}</div>}

        {loading && !data && (
          <div className="admin-loading">Loading admin data...</div>
        )}

        {!loading && data && tab === 'overview' && (
          <div className="admin-overview">
            <div className="admin-metric">
              <div className="admin-metric-label">Servers</div>
              <div className="admin-metric-value">{data.servers.length}</div>
            </div>
            <div className="admin-metric">
              <div className="admin-metric-label">Users</div>
              <div className="admin-metric-value">{data.users.length}</div>
            </div>
          </div>
        )}

        {!loading && data && tab === 'servers' && (
          <div className="admin-section">
            <div className="admin-search">
              <input
                type="text"
                placeholder="Search servers by name, id, owner id"
                value={serverQuery}
                onChange={(e) => setServerQuery(e.target.value)}
              />
              <span className="admin-count">{filteredServers.length} results</span>
            </div>
            <div className="admin-table">
              <div className="admin-table-header">
                <span>Name</span>
                <span>Owner</span>
                <span>Members</span>
                <span>Channels</span>
              </div>
              {filteredServers.map((s) => (
                <div key={s.id} className="admin-table-row">
                  <span className="admin-strong">{s.name}</span>
                  <span className="admin-mono">{s.ownerId}</span>
                  <span>{s.memberCount}</span>
                  <span>{s.channelCount}</span>
                </div>
              ))}
              {filteredServers.length === 0 && (
                <div className="admin-empty">No servers found.</div>
              )}
            </div>
          </div>
        )}

        {!loading && data && tab === 'users' && (
          <div className="admin-section">
            <div className="admin-search">
              <input
                type="text"
                placeholder="Search users by name, username, id, email"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
              />
              <span className="admin-count">{filteredUsers.length} results</span>
            </div>
            <div className="admin-table">
              <div className="admin-table-header admin-table-users">
                <span>Display</span>
                <span>Username</span>
                <span>Email</span>
                <span>Status</span>
              </div>
              {filteredUsers.map((u) => (
                <div key={u.id} className="admin-table-row admin-table-users">
                  <span className="admin-strong">{u.displayName}</span>
                  <span className="admin-mono">{u.username}</span>
                  <span className="admin-mono">{u.email || '—'}</span>
                  <span>{u.status}</span>
                </div>
              ))}
              {filteredUsers.length === 0 && (
                <div className="admin-empty">No users found.</div>
              )}
            </div>
          </div>
        )}

        {!loading && tab === 'settings' && (
          <div className="admin-section">
            <div className="admin-setting-card">
              <div>
                <div className="admin-setting-title">Invite-Only Mode</div>
                <div className="admin-setting-desc">Restrict new registrations to users with an admin-generated code.</div>
              </div>
              <button
                className="btn-secondary"
                onClick={() => updateInviteOnly(!(settings?.inviteOnly ?? false))}
                disabled={savingInviteOnly || !settings}
              >
                {savingInviteOnly ? 'Saving...' : (settings?.inviteOnly ? 'Disable' : 'Enable')}
              </button>
            </div>
            <div className="admin-setting-card admin-code-card">
              <div>
                <div className="admin-setting-title">Generate Invite Code</div>
                <div className="admin-setting-desc">Create a code for new registrations. Optional expiry and max uses.</div>
              </div>
              <div className="admin-code-actions">
                <input
                  type="number"
                  min={1}
                  placeholder="Max uses"
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                />
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
                <button className="btn-secondary" onClick={createInviteCode} disabled={creatingCode}>
                  {creatingCode ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
            {newCode && (
              <div className="admin-new-code">
                New code: <span className="admin-mono">{newCode}</span>
              </div>
            )}
            <div className="admin-table">
              <div className="admin-table-header admin-table-codes">
                <span>Code</span>
                <span>Uses</span>
                <span>Expires</span>
                <span>Last Used</span>
              </div>
              {(settings?.codes || []).map((c) => (
                <div key={c.id} className="admin-table-row admin-table-codes">
                  <span className="admin-mono">{c.code}</span>
                  <span>{c.uses}{c.maxUses ? ` / ${c.maxUses}` : ''}</span>
                  <span>{c.expiresAt ? new Date(c.expiresAt).toLocaleString() : '—'}</span>
                  <span>{c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : '—'}</span>
                </div>
              ))}
              {settings && settings.codes.length === 0 && (
                <div className="admin-empty">No invite codes yet.</div>
              )}
            </div>
            <div className="admin-setting-card">
              <div>
                <div className="admin-setting-title">Maintenance / Read-Only</div>
                <div className="admin-setting-desc">Temporarily pause writes and registrations.</div>
              </div>
              <button className="btn-secondary" disabled>Planned</button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
