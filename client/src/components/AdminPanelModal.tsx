import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, getApiBase, useAuthStore, useAppConfigStore, parseCosmeticCss, CosmeticRarityNames, CosmeticRarityColors, CosmeticTypeNames, CosmeticType, useToastStore } from '@abyss/shared';
import type { AdminOverviewStats, AdminServer, AdminUser, AdminSettings, Invite, CosmeticItem, UserCosmetic as UserCosmeticT } from '@abyss/shared';
import SettingsModal from './SettingsModal';
import type { SettingsTab } from './SettingsModal';
import ConfirmModal from './ConfirmModal';

type TabKey = 'overview' | 'servers' | 'users' | 'settings' | 'cosmetics';

const PAGE_SIZE = 50;

export default function AdminPanelModal({ onClose }: { onClose: () => void }) {
  const isSysadmin = useAuthStore((s) => s.isSysadmin);
  const [tab, setTab] = useState<TabKey>('overview');
  const [stats, setStats] = useState<AdminOverviewStats | null>(null);
  const [servers, setServers] = useState<AdminServer[]>([]);
  const [serversTotalCount, setServersTotalCount] = useState(0);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersTotalCount, setUsersTotalCount] = useState(0);
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
  const [savingMaxMessageLength, setSavingMaxMessageLength] = useState(false);
  const [maxMessageLengthInput, setMaxMessageLengthInput] = useState<string>('');
  const setMaxMessageLength = useAppConfigStore((s) => s.setMaxMessageLength);
  const [savingForceRelay, setSavingForceRelay] = useState(false);
  const setForceRelayMode = useAppConfigStore((s) => s.setForceRelayMode);

  // Pagination state
  const [serverPage, setServerPage] = useState(0);
  const [userPage, setUserPage] = useState(0);
  const [serverSort, setServerSort] = useState<{ field: string; order: 'asc' | 'desc' }>({
    field: 'name',
    order: 'asc',
  });
  const [userSort, setUserSort] = useState<{ field: string; order: 'asc' | 'desc' }>({
    field: 'username',
    order: 'asc',
  });

  // Cosmetics state
  const [cosmeticItems, setCosmeticItems] = useState<CosmeticItem[]>([]);
  const [cosmeticsLoading, setCosmeticsLoading] = useState(false);
  const [selectedCosmetic, setSelectedCosmetic] = useState<CosmeticItem | null>(null);
  const [cosmeticFormMode, setCosmeticFormMode] = useState<'list' | 'create' | 'edit'>('list');
  const [cosmeticForm, setCosmeticForm] = useState({ name: '', description: '', type: 0, rarity: 0, cssData: '{}' });
  const [cosmeticTypeFilter, setCosmeticTypeFilter] = useState<number>(-1);
  const [cosmeticSearch, setCosmeticSearch] = useState('');
  const [cosmeticOwners, setCosmeticOwners] = useState<AdminUser[]>([]);
  const [assignUserQuery, setAssignUserQuery] = useState('');
  const [assignUserDropdownOpen, setAssignUserDropdownOpen] = useState(false);
  const [userCosmeticSearch, setUserCosmeticSearch] = useState('');
  const [userCosmeticResults, setUserCosmeticResults] = useState<UserCosmeticT[]>([]);
  const [userCosmeticTarget, setUserCosmeticTarget] = useState<AdminUser | null>(null);

  // Delete confirmations
  const [serverToDelete, setServerToDelete] = useState<AdminServer | null>(null);
  const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null);
  const [codeToDelete, setCodeToDelete] = useState<Invite | null>(null);

  // Transfer ownership
  const [transferOwnershipServer, setTransferOwnershipServer] = useState<AdminServer | null>(null);
  const [ownershipSearchQuery, setOwnershipSearchQuery] = useState('');
  const [ownershipSearchResults, setOwnershipSearchResults] = useState<AdminUser[]>([]);
  const [ownershipDropdownOpen, setOwnershipDropdownOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, settingsRes] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/settings'),
      ]);
      setStats(overviewRes.data);
      setSettings(settingsRes.data);
      setMaxMessageLengthInput(String(settingsRes.data.maxMessageLength ?? 4000));
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to load admin overview.');
    } finally {
      setLoading(false);
    }
  };

  const loadServers = async (page: number, search?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        offset: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
        sortBy: serverSort.field,
        sortOrder: serverSort.order,
      });
      if (search) params.set('search', search);

      const res = await api.get(`/admin/servers?${params}`);
      setServers(res.data.servers);
      setServersTotalCount(res.data.totalCount);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to load servers.');
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async (page: number, search?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        offset: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
        sortBy: userSort.field,
        sortOrder: userSort.order,
      });
      if (search) params.set('search', search);

      const res = await api.get(`/admin/users?${params}`);
      setUsers(res.data.users);
      setUsersTotalCount(res.data.totalCount);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSysadmin) {
      load();
    }
  }, [isSysadmin]);

  useEffect(() => {
    if (tab === 'servers') loadServers(serverPage, serverQuery);
  }, [tab, serverPage, serverSort]);

  useEffect(() => {
    if (tab === 'users') loadUsers(userPage, userQuery);
  }, [tab, userPage, userSort]);

  // Debounced search
  useEffect(() => {
    if (tab !== 'servers') return;
    const timer = setTimeout(() => {
      setServerPage(0);
      loadServers(0, serverQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [serverQuery]);

  useEffect(() => {
    if (tab !== 'users') return;
    const timer = setTimeout(() => {
      setUserPage(0);
      loadUsers(0, userQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [userQuery]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    useToastStore.getState().addToast(`${label} copied`, 'success', 2000);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

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

  const createInvite = async () => {
    setCreatingCode(true);
    setError(null);
    setNewCode(null);
    try {
      const payload: { maxUses?: number; expiresAt?: string } = {};
      const parsedMax = Number(maxUses);
      if (!Number.isNaN(parsedMax) && parsedMax > 0) payload.maxUses = parsedMax;
      if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
      const res = await api.post('/admin/invite-codes', payload);
      const created: Invite = res.data;
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

  const updateMaxMessageLength = async () => {
    if (!settings) return;
    const parsed = Number(maxMessageLengthInput);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setError('Max message length must be a positive number.');
      return;
    }
    setSavingMaxMessageLength(true);
    setError(null);
    try {
      const res = await api.put('/admin/settings/max-message-length', { maxMessageLength: Math.floor(parsed) });
      const updated = res.data?.maxMessageLength ?? Math.floor(parsed);
      setSettings({ ...settings, maxMessageLength: updated });
      setMaxMessageLengthInput(String(updated));
      setMaxMessageLength(updated);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to update max message length.');
    } finally {
      setSavingMaxMessageLength(false);
    }
  };

  const updateForceRelayMode = async (enabled: boolean) => {
    if (!settings) return;
    setSavingForceRelay(true);
    setError(null);
    try {
      await api.put('/admin/settings/force-relay-mode', { forceRelayMode: enabled });
      setSettings({ ...settings, forceRelayMode: enabled });
      setForceRelayMode(enabled);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to update force relay mode.');
    } finally {
      setSavingForceRelay(false);
    }
  };

  const loadCosmetics = async () => {
    setCosmeticsLoading(true);
    try {
      const res = await api.get('/cosmetics');
      setCosmeticItems(res.data);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to load cosmetics.');
    } finally {
      setCosmeticsLoading(false);
    }
  };

  const loadCosmeticOwners = async (cosmeticId: string) => {
    try {
      const res = await api.get(`/cosmetics/${cosmeticId}/owners`);
      setCosmeticOwners(res.data);
    } catch { setCosmeticOwners([]); }
  };

  const handleCreateCosmetic = async () => {
    setError(null);
    try {
      const res = await api.post('/cosmetics', {
        name: cosmeticForm.name,
        description: cosmeticForm.description,
        type: cosmeticForm.type,
        rarity: cosmeticForm.rarity,
        cssData: cosmeticForm.cssData,
      });
      setCosmeticItems((prev) => [...prev, res.data]);
      setCosmeticFormMode('list');
      setCosmeticForm({ name: '', description: '', type: 0, rarity: 0, cssData: '{}' });
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to create cosmetic.');
    }
  };

  const handleUpdateCosmetic = async () => {
    if (!selectedCosmetic) return;
    setError(null);
    try {
      const res = await api.put(`/cosmetics/${selectedCosmetic.id}`, {
        name: cosmeticForm.name || undefined,
        description: cosmeticForm.description || undefined,
        rarity: cosmeticForm.rarity,
        cssData: cosmeticForm.cssData || undefined,
      });
      setCosmeticItems((prev) => prev.map((c) => (c.id === selectedCosmetic.id ? res.data : c)));
      setSelectedCosmetic(res.data);
      setCosmeticFormMode('list');
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to update cosmetic.');
    }
  };

  const handleDeleteCosmetic = async (id: string) => {
    try {
      await api.delete(`/cosmetics/${id}`);
      setCosmeticItems((prev) => prev.map((c) => (c.id === id ? { ...c, isActive: false } : c)));
      if (selectedCosmetic?.id === id) setSelectedCosmetic(null);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to delete cosmetic.');
    }
  };

  const handleAssignCosmetic = async (userId: string) => {
    if (!selectedCosmetic || !userId) return;
    setError(null);
    try {
      await api.post('/cosmetics/assign', { userId, cosmeticItemId: selectedCosmetic.id });
      setAssignUserQuery('');
      setAssignUserDropdownOpen(false);
      loadCosmeticOwners(selectedCosmetic.id);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to assign cosmetic.');
    }
  };

  const handleUnassignCosmetic = async (userId: string) => {
    if (!selectedCosmetic) return;
    try {
      await api.delete('/cosmetics/assign', { data: { userId, cosmeticItemId: selectedCosmetic.id } });
      loadCosmeticOwners(selectedCosmetic.id);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to unassign cosmetic.');
    }
  };

  const handleAdminEquip = async (userId: string, cosmeticItemId: string) => {
    try {
      await api.put('/cosmetics/admin-equip', { userId, cosmeticItemId });
      if (userCosmeticTarget) loadUserCosmetics(userCosmeticTarget.id);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to equip cosmetic.');
    }
  };

  const handleAdminUnequip = async (userId: string, cosmeticItemId: string) => {
    try {
      await api.put('/cosmetics/admin-unequip', { userId, cosmeticItemId });
      if (userCosmeticTarget) loadUserCosmetics(userCosmeticTarget.id);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to unequip cosmetic.');
    }
  };

  const loadUserCosmetics = async (userId: string) => {
    try {
      const res = await api.get(`/cosmetics/user/${userId}`);
      setUserCosmeticResults(res.data);
    } catch { setUserCosmeticResults([]); }
  };

  const handleSearchUserCosmetics = async () => {
    const q = userCosmeticSearch.trim().toLowerCase();
    if (!q) return;

    // Search in current users list first
    const found = users.find((u) => u.username.toLowerCase() === q || u.id === q || u.displayName.toLowerCase() === q);
    if (found) {
      setUserCosmeticTarget(found);
      loadUserCosmetics(found.id);
      return;
    }

    // If not found, search via API
    try {
      const res = await api.get(`/admin/users?search=${encodeURIComponent(q)}&limit=1`);
      if (res.data.users && res.data.users.length > 0) {
        setUserCosmeticTarget(res.data.users[0]);
        loadUserCosmetics(res.data.users[0].id);
      } else {
        setError('User not found.');
      }
    } catch {
      setError('User not found.');
    }
  };

  const handleDeleteServer = async (server: AdminServer) => {
    setError(null);
    try {
      await api.delete(`/admin/servers/${server.id}`);
      useToastStore.getState().addToast('Server deleted successfully', 'success');
      setServerToDelete(null);
      loadServers(serverPage, serverQuery);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to delete server.');
    }
  };

  const handleDeleteUser = async (user: AdminUser) => {
    setError(null);
    try {
      await api.delete(`/admin/users/${user.id}`);
      useToastStore.getState().addToast('User deleted successfully', 'success');
      setUserToDelete(null);
      loadUsers(userPage, userQuery);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to delete user.');
    }
  };

  const handleDeleteInvite = async (code: Invite) => {
    setError(null);
    try {
      await api.delete(`/admin/invite-codes/${code.id}`);
      useToastStore.getState().addToast('Invite code deleted', 'success');
      setSettings((prev) => prev ? { ...prev, codes: prev.codes.filter(c => c.id !== code.id) } : prev);
      setCodeToDelete(null);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to delete code.');
    }
  };

  const handleTransferOwnership = async (newOwnerId: string) => {
    if (!transferOwnershipServer) return;
    setError(null);
    try {
      await api.post(`/admin/servers/${transferOwnershipServer.id}/transfer-owner`, { newOwnerId });
      useToastStore.getState().addToast('Ownership transferred', 'success');
      setTransferOwnershipServer(null);
      setOwnershipSearchQuery('');
      setOwnershipSearchResults([]);
      loadServers(serverPage, serverQuery);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to transfer ownership.');
    }
  };

  const searchUsersForOwnership = async (query: string) => {
    if (!query.trim()) {
      setOwnershipSearchResults([]);
      return;
    }

    try {
      const res = await api.get(`/admin/users?search=${encodeURIComponent(query)}&limit=10`);
      setOwnershipSearchResults(res.data.users || []);
    } catch {
      setOwnershipSearchResults([]);
    }
  };

  useEffect(() => {
    if (tab === 'cosmetics' && cosmeticItems.length === 0 && !cosmeticsLoading) {
      loadCosmetics();
    }
  }, [tab]);

  useEffect(() => {
    if (selectedCosmetic) {
      loadCosmeticOwners(selectedCosmetic.id);
    }
  }, [selectedCosmetic?.id]);

  // Debounced user search for ownership transfer
  useEffect(() => {
    if (!ownershipSearchQuery.trim()) {
      setOwnershipSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      searchUsersForOwnership(ownershipSearchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [ownershipSearchQuery]);

  const filteredCosmetics = useMemo(() => {
    let items = cosmeticItems;
    if (cosmeticTypeFilter >= 0) items = items.filter((c) => c.type === cosmeticTypeFilter);
    const q = cosmeticSearch.trim().toLowerCase();
    if (q) items = items.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
    return [...items].sort((a, b) => b.rarity - a.rarity);
  }, [cosmeticItems, cosmeticTypeFilter, cosmeticSearch]);

  const assignUserResults = useMemo(() => {
    const q = assignUserQuery.trim().toLowerCase();
    if (!q || users.length === 0) return [];
    return users.filter((u) =>
      u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [users, assignUserQuery]);

  const renderCosmeticPreview = (cssData: string, type: number, name?: string) => {
    if (type === CosmeticType.Nameplate) {
      const style = parseCosmeticCss(cssData, 'nameplate');
      return <span className="cosmetic-preview-name" style={style}>{name || 'SampleUser'}</span>;
    }
    if (type === CosmeticType.MessageStyle) {
      const style = parseCosmeticCss(cssData, 'messageStyle');
      return (
        <div className="cosmetic-preview-msg" style={style}>
          <div className="cosmetic-preview-msg-author">SampleUser</div>
          <div className="cosmetic-preview-msg-text">This is a preview message with this style applied.</div>
        </div>
      );
    }
    return <span className="cosmetic-preview-name">{name || 'Preview'}</span>;
  };

  if (!isSysadmin) {
    return createPortal(
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal user-settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="us-content" style={{ flex: 1 }}>
            <div className="us-content-header">
              <h2>Admin Panel</h2>
              <button className="us-close" onClick={onClose}>&times;</button>
            </div>
            <div className="us-content-body">
              <div className="admin-empty">You do not have sysadmin access.</div>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const settingsTabs: SettingsTab[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'servers', label: 'Servers' },
    { id: 'users', label: 'Users' },
    { id: 'cosmetics', label: 'Cosmetics' },
    { id: 'settings', label: 'Settings', separatorBefore: true },
  ];

  return (
    <SettingsModal
      title="Admin"
      tabs={settingsTabs}
      activeTab={tab}
      onTabChange={(id) => setTab(id as TabKey)}
      onClose={onClose}
      className="admin-panel-modal"
      headerExtra={<button className="btn-secondary" onClick={load} disabled={loading} style={{ padding: '6px 12px', fontSize: 13 }}>Refresh</button>}
    >
          {error && <div className="admin-error">{error}</div>}
            {loading && !stats && (
              <div className="admin-loading">Loading admin data...</div>
            )}

            {!loading && stats && tab === 'overview' && (
              <div className="admin-overview">
                <div className="us-card admin-metric">
                  <div className="us-card-title">Servers</div>
                  <div className="admin-metric-value">{stats.serverCount}</div>
                </div>
                <div className="us-card admin-metric">
                  <div className="us-card-title">Users</div>
                  <div className="admin-metric-value">{stats.userCount}</div>
                </div>
                <div className="us-card admin-metric">
                  <div className="us-card-title">Messages</div>
                  <div className="admin-metric-value">{stats.messageCount}</div>
                </div>
              </div>
            )}

            {!loading && tab === 'servers' && (
              <div className="admin-section">
                <div className="us-card">
                  <div className="admin-search">
                    <input
                      type="text"
                      placeholder="Search servers by name, owner, id..."
                      value={serverQuery}
                      onChange={(e) => setServerQuery(e.target.value)}
                    />
                    <span className="admin-count">{serversTotalCount} total</span>
                  </div>

                  <div className="admin-sort-row">
                    {[
                      { field: 'name', label: 'Name' },
                      { field: 'members', label: 'Members' },
                      { field: 'channels', label: 'Channels' },
                      { field: 'created', label: 'Created' },
                    ].map((sort) => (
                      <button
                        key={sort.field}
                        className={`admin-sort-btn ${serverSort.field === sort.field ? 'active' : ''}`}
                        onClick={() => {
                          setServerSort({
                            field: sort.field,
                            order:
                              serverSort.field === sort.field && serverSort.order === 'asc'
                                ? 'desc'
                                : 'asc',
                          });
                        }}
                      >
                        {sort.label}{' '}
                        {serverSort.field === sort.field && (serverSort.order === 'asc' ? '↑' : '↓')}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="admin-table">
                  <div className="admin-table-header">
                    <span>Name</span>
                    <span>Owner</span>
                    <span>Members</span>
                    <span>Channels</span>
                    <span>Created</span>
                    <span>Actions</span>
                  </div>
                  {servers.map((s) => (
                    <div key={s.id} className="admin-table-row">
                      <span className="admin-strong">{s.name}</span>
                      <span>
                        {s.ownerName}
                        <button
                          className="admin-copy-btn"
                          onClick={() => copyToClipboard(s.ownerId, 'Owner ID')}
                          title="Copy owner ID"
                        >
                          📋
                        </button>
                      </span>
                      <span>{s.memberCount}</span>
                      <span>{s.channelCount}</span>
                      <span className="admin-date">{formatDate(s.createdAt)}</span>
                      <span className="admin-actions-cell">
                        <button
                          className="admin-action-btn"
                          onClick={() => copyToClipboard(s.id, 'Server ID')}
                          title="Copy server ID"
                        >
                          📋
                        </button>
                        <button
                          className="admin-action-btn"
                          onClick={() => setTransferOwnershipServer(s)}
                          title="Transfer ownership"
                        >
                          👑
                        </button>
                        <button
                          className="admin-action-btn admin-danger"
                          onClick={() => setServerToDelete(s)}
                          title="Delete server"
                        >
                          🗑️
                        </button>
                      </span>
                    </div>
                  ))}
                  {servers.length === 0 && <div className="admin-empty">No servers found.</div>}
                </div>

                <div className="admin-pagination">
                  <button
                    onClick={() => setServerPage((p) => Math.max(0, p - 1))}
                    disabled={serverPage === 0 || loading}
                  >
                    ← Previous
                  </button>
                  <span>
                    Page {serverPage + 1} of {Math.max(1, Math.ceil(serversTotalCount / PAGE_SIZE))} ({serversTotalCount} total)
                  </span>
                  <button
                    onClick={() => setServerPage((p) => p + 1)}
                    disabled={serverPage >= Math.ceil(serversTotalCount / PAGE_SIZE) - 1 || loading}
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}

            {!loading && tab === 'users' && (
              <div className="admin-section">
                <div className="us-card">
                  <div className="admin-search">
                    <input
                      type="text"
                      placeholder="Search users by name, username, id, email..."
                      value={userQuery}
                      onChange={(e) => setUserQuery(e.target.value)}
                    />
                    <span className="admin-count">{usersTotalCount} total</span>
                  </div>

                  <div className="admin-sort-row">
                    {[
                      { field: 'username', label: 'Username' },
                      { field: 'displayname', label: 'Display Name' },
                      { field: 'email', label: 'Email' },
                      { field: 'created', label: 'Created' },
                    ].map((sort) => (
                      <button
                        key={sort.field}
                        className={`admin-sort-btn ${userSort.field === sort.field ? 'active' : ''}`}
                        onClick={() => {
                          setUserSort({
                            field: sort.field,
                            order:
                              userSort.field === sort.field && userSort.order === 'asc'
                                ? 'desc'
                                : 'asc',
                          });
                        }}
                      >
                        {sort.label}{' '}
                        {userSort.field === sort.field && (userSort.order === 'asc' ? '↑' : '↓')}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="admin-table">
                  <div className="admin-table-header admin-table-users">
                    <span>Display Name</span>
                    <span>Username</span>
                    <span>Email</span>
                    <span>Created</span>
                    <span>Actions</span>
                  </div>
                  {users.map((u) => (
                    <div key={u.id} className="admin-table-row admin-table-users">
                      <span className="admin-strong">{u.displayName}</span>
                      <span className="admin-mono">{u.username}</span>
                      <span className="admin-mono">{u.email || '—'}</span>
                      <span className="admin-date">{formatDate(u.createdAt)}</span>
                      <span className="admin-actions-cell">
                        <button
                          className="admin-action-btn"
                          onClick={() => copyToClipboard(u.id, 'User ID')}
                          title="Copy user ID"
                        >
                          📋
                        </button>
                        <button
                          className="admin-action-btn admin-danger"
                          onClick={() => setUserToDelete(u)}
                          title="Delete user"
                        >
                          🗑️
                        </button>
                      </span>
                    </div>
                  ))}
                  {users.length === 0 && <div className="admin-empty">No users found.</div>}
                </div>

                <div className="admin-pagination">
                  <button
                    onClick={() => setUserPage((p) => Math.max(0, p - 1))}
                    disabled={userPage === 0 || loading}
                  >
                    ← Previous
                  </button>
                  <span>
                    Page {userPage + 1} of {Math.max(1, Math.ceil(usersTotalCount / PAGE_SIZE))} ({usersTotalCount} total)
                  </span>
                  <button
                    onClick={() => setUserPage((p) => p + 1)}
                    disabled={userPage >= Math.ceil(usersTotalCount / PAGE_SIZE) - 1 || loading}
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}

            {tab === 'cosmetics' && (
              <div className="admin-section">
                {cosmeticFormMode === 'list' && (
                  <>
                    <div className="cosmetic-filter-bar">
                      <select value={cosmeticTypeFilter} onChange={(e) => setCosmeticTypeFilter(Number(e.target.value))}>
                        <option value={-1}>All Types</option>
                        <option value={0}>Nameplate</option>
                        <option value={1}>Message Style</option>
                        <option value={2}>Profile Effect</option>
                        <option value={3}>Avatar Decoration</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Search cosmetics..."
                        value={cosmeticSearch}
                        onChange={(e) => setCosmeticSearch(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button className="btn-secondary" onClick={() => { setCosmeticFormMode('create'); setCosmeticForm({ name: '', description: '', type: 0, rarity: 0, cssData: '{}' }); }} style={{ padding: '6px 12px', fontSize: 13 }}>
                        + Create
                      </button>
                    </div>
                    <div className="admin-cosmetics-grid">
                      {filteredCosmetics.map((c) => (
                        <div key={c.id} className={`cosmetic-card${selectedCosmetic?.id === c.id ? ' selected' : ''}${!c.isActive ? ' inactive' : ''}`} onClick={() => setSelectedCosmetic(selectedCosmetic?.id === c.id ? null : c)}>
                          <div className="cosmetic-card-header">
                            <span className="cosmetic-card-name">{c.name}</span>
                            <span className="cosmetic-card-rarity" style={{ background: `${CosmeticRarityColors[c.rarity]}22`, color: CosmeticRarityColors[c.rarity] }}>
                              {CosmeticRarityNames[c.rarity]}
                            </span>
                          </div>
                          <div className="cosmetic-card-type">{CosmeticTypeNames[c.type]}{!c.isActive ? ' (Disabled)' : ''}</div>
                          <div className="cosmetic-card-preview">
                            {renderCosmeticPreview(c.cssData, c.type, c.name)}
                          </div>
                          {c.description && <div className="cosmetic-card-desc">{c.description}</div>}
                        </div>
                      ))}
                      {filteredCosmetics.length === 0 && !cosmeticsLoading && (
                        <div className="admin-empty">No cosmetics found. Create one or add presets.</div>
                      )}
                    </div>
                    {selectedCosmetic && (
                      <div className="us-card" style={{ marginTop: 16 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                          <div className="admin-setting-title">{selectedCosmetic.name} — Details</div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => {
                              setCosmeticForm({ name: selectedCosmetic.name, description: selectedCosmetic.description, type: selectedCosmetic.type, rarity: selectedCosmetic.rarity, cssData: selectedCosmetic.cssData });
                              setCosmeticFormMode('edit');
                            }}>Edit</button>
                            {selectedCosmetic.isActive && (
                              <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12, color: '#ed4245' }} onClick={() => handleDeleteCosmetic(selectedCosmetic.id)}>Disable</button>
                            )}
                          </div>
                        </div>
                        <div className="cosmetic-assign-section">
                          <div className="admin-setting-title" style={{ fontSize: 13 }}>Assign to User</div>
                          <div className="cosmetic-assign-row" style={{ position: 'relative' }}>
                            <input
                              type="text"
                              placeholder="Search by username..."
                              value={assignUserQuery}
                              onChange={(e) => { setAssignUserQuery(e.target.value); setAssignUserDropdownOpen(true); }}
                              onFocus={() => setAssignUserDropdownOpen(true)}
                              onBlur={() => setTimeout(() => setAssignUserDropdownOpen(false), 200)}
                              style={{ background: 'var(--bg-tertiary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 13, flex: 1 }}
                            />
                            {assignUserDropdownOpen && assignUserQuery.trim() && assignUserResults.length > 0 && (
                              <div className="cosmetic-user-dropdown">
                                {assignUserResults.map((u) => (
                                  <div key={u.id} className="cosmetic-user-dropdown-item" onMouseDown={() => handleAssignCosmetic(u.id)}>
                                    <div className="cosmetic-user-dropdown-avatar">
                                      {u.avatarUrl ? (
                                        <img src={u.avatarUrl.startsWith('http') ? u.avatarUrl : `${getApiBase()}${u.avatarUrl}`} alt={u.displayName} />
                                      ) : (
                                        <div className="cosmetic-user-dropdown-avatar-fallback">{u.displayName[0]}</div>
                                      )}
                                    </div>
                                    <div className="cosmetic-user-dropdown-info">
                                      <span className="cosmetic-user-dropdown-display">{u.displayName}</span>
                                      <span className="cosmetic-user-dropdown-username">@{u.username}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {assignUserDropdownOpen && assignUserQuery.trim() && assignUserResults.length === 0 && (
                              <div className="cosmetic-user-dropdown">
                                <div className="cosmetic-user-dropdown-empty">No users found</div>
                              </div>
                            )}
                          </div>
                          {cosmeticOwners.length > 0 && (
                            <>
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Owners ({cosmeticOwners.length}):</div>
                              <div className="cosmetic-owners-list">
                                {cosmeticOwners.map((o) => (
                                  <span key={o.id} className="cosmetic-owner-chip">
                                    {o.displayName}
                                    <button onClick={() => handleUnassignCosmetic(o.id)} title="Remove">&times;</button>
                                  </span>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="us-card" style={{ marginTop: 16 }}>
                      <div className="admin-setting-title">User Inventory</div>
                      <div className="admin-setting-desc">Search for a user to see and manage their cosmetics.</div>
                      <div className="cosmetic-assign-row" style={{ marginTop: 8 }}>
                        <input
                          type="text"
                          placeholder="Username or User ID"
                          value={userCosmeticSearch}
                          onChange={(e) => setUserCosmeticSearch(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSearchUserCosmetics()}
                          style={{ background: 'var(--bg-tertiary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 13, flex: 1 }}
                        />
                        <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={handleSearchUserCosmetics}>Search</button>
                      </div>
                      {userCosmeticTarget && (
                        <div className="cosmetic-user-inventory">
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                            {userCosmeticTarget.displayName}'s Cosmetics ({userCosmeticResults.length})
                          </div>
                          {userCosmeticResults.map((uc) => (
                            <div key={uc.item.id} className="cosmetic-user-item">
                              <div className="cosmetic-user-item-info">
                                <div>
                                  <div className="cosmetic-user-item-name">
                                    {uc.item.name}
                                    {uc.isEquipped && <span className="cosmetic-equipped-badge" style={{ marginLeft: 6 }}>Equipped</span>}
                                  </div>
                                  <div className="cosmetic-user-item-type">
                                    {CosmeticTypeNames[uc.item.type]} &middot;{' '}
                                    <span style={{ color: CosmeticRarityColors[uc.item.rarity] }}>{CosmeticRarityNames[uc.item.rarity]}</span>
                                  </div>
                                </div>
                              </div>
                              <div className="cosmetic-user-item-actions">
                                {uc.isEquipped ? (
                                  <button onClick={() => handleAdminUnequip(userCosmeticTarget.id, uc.item.id)}>Unequip</button>
                                ) : (
                                  <button onClick={() => handleAdminEquip(userCosmeticTarget.id, uc.item.id)}>Equip</button>
                                )}
                                <button style={{ color: '#ed4245' }} onClick={() => {
                                  api.delete('/cosmetics/assign', { data: { userId: userCosmeticTarget.id, cosmeticItemId: uc.item.id } })
                                    .then(() => loadUserCosmetics(userCosmeticTarget.id))
                                    .catch(() => {});
                                }}>Remove</button>
                              </div>
                            </div>
                          ))}
                          {userCosmeticResults.length === 0 && (
                            <div className="admin-empty">No cosmetics assigned to this user.</div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {(cosmeticFormMode === 'create' || cosmeticFormMode === 'edit') && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div className="admin-setting-title">{cosmeticFormMode === 'create' ? 'Create Cosmetic' : `Edit: ${selectedCosmetic?.name}`}</div>
                      <button className="btn-secondary" onClick={() => setCosmeticFormMode('list')} style={{ padding: '6px 12px', fontSize: 12 }}>Cancel</button>
                    </div>
                    <div className="cosmetic-form">
                      <div className="cosmetic-form-row">
                        <label>
                          Name
                          <input type="text" value={cosmeticForm.name} onChange={(e) => setCosmeticForm({ ...cosmeticForm, name: e.target.value })} />
                        </label>
                        {cosmeticFormMode === 'create' && (
                          <label>
                            Type
                            <select value={cosmeticForm.type} onChange={(e) => setCosmeticForm({ ...cosmeticForm, type: Number(e.target.value) })}>
                              <option value={0}>Nameplate</option>
                              <option value={1}>Message Style</option>
                              <option value={2}>Profile Effect</option>
                              <option value={3}>Avatar Decoration</option>
                            </select>
                          </label>
                        )}
                        <label>
                          Rarity
                          <select value={cosmeticForm.rarity} onChange={(e) => setCosmeticForm({ ...cosmeticForm, rarity: Number(e.target.value) })}>
                            <option value={0}>Common</option>
                            <option value={1}>Uncommon</option>
                            <option value={2}>Rare</option>
                            <option value={3}>Epic</option>
                            <option value={4}>Legendary</option>
                          </select>
                        </label>
                      </div>
                      <label>
                        Description
                        <input type="text" value={cosmeticForm.description} onChange={(e) => setCosmeticForm({ ...cosmeticForm, description: e.target.value })} />
                      </label>
                      <label>
                        CSS Data (JSON)
                        <textarea
                          value={cosmeticForm.cssData}
                          onChange={(e) => setCosmeticForm({ ...cosmeticForm, cssData: e.target.value })}
                          spellCheck={false}
                        />
                      </label>
                      <div className="cosmetic-live-preview">
                        <div className="cosmetic-live-preview-label">Live Preview</div>
                        {renderCosmeticPreview(cosmeticForm.cssData, cosmeticFormMode === 'edit' ? (selectedCosmetic?.type ?? 0) : cosmeticForm.type, cosmeticForm.name || 'Preview')}
                      </div>
                      <div className="cosmetic-form-actions">
                        <button className="btn-secondary" onClick={() => setCosmeticFormMode('list')}>Cancel</button>
                        <button onClick={cosmeticFormMode === 'create' ? handleCreateCosmetic : handleUpdateCosmetic}>
                          {cosmeticFormMode === 'create' ? 'Create' : 'Save Changes'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {!loading && tab === 'settings' && (
              <div className="admin-section">
                <div className="us-card admin-setting-card">
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
                <div className="us-card admin-setting-card">
                  <div>
                    <div className="admin-setting-title">Force Relay Mode</div>
                    <div className="admin-setting-desc">
                      Route all voice through the relay server (LiveKit SFU) instead of peer-to-peer.
                      {!settings?.liveKitConfigured && ' LiveKit is not configured on this server.'}
                    </div>
                  </div>
                  <button
                    className="btn-secondary"
                    onClick={() => updateForceRelayMode(!(settings?.forceRelayMode ?? false))}
                    disabled={savingForceRelay || !settings || !settings.liveKitConfigured}
                  >
                    {savingForceRelay ? 'Saving...' : (settings?.forceRelayMode ? 'Disable' : 'Enable')}
                  </button>
                </div>
                <div className="us-card admin-setting-card admin-code-card">
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
                    <button className="btn-secondary" onClick={createInvite} disabled={creatingCode}>
                      {creatingCode ? 'Creating...' : 'Create'}
                    </button>
                  </div>
                </div>
                {newCode && (
                  <div className="us-card admin-new-code">
                    New code: <span className="admin-mono">{newCode}</span>
                  </div>
                )}
                <div className="admin-table">
                  <div className="admin-table-header admin-table-codes">
                    <span>Code</span>
                    <span>Uses</span>
                    <span>Expires</span>
                    <span>Last Used</span>
                    <span>Actions</span>
                  </div>
                  {(settings?.codes || []).map((c) => (
                    <div key={c.id} className="admin-table-row admin-table-codes">
                      <span className="admin-mono">{c.code}</span>
                      <span>{c.uses}{c.maxUses ? ` / ${c.maxUses}` : ''}</span>
                      <span>{c.expiresAt ? new Date(c.expiresAt).toLocaleString() : '—'}</span>
                      <span>{c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : '—'}</span>
                      <span className="admin-actions-cell">
                        <button
                          className="admin-action-btn admin-danger"
                          onClick={() => setCodeToDelete(c)}
                          title="Delete invite code"
                        >
                          🗑️
                        </button>
                      </span>
                    </div>
                  ))}
                  {settings && settings.codes.length === 0 && (
                    <div className="admin-empty">No invite codes yet.</div>
                  )}
                </div>
                <div className="us-card admin-setting-card">
                  <div>
                    <div className="admin-setting-title">Maintenance / Read-Only</div>
                    <div className="admin-setting-desc">Temporarily pause writes and registrations.</div>
                  </div>
                  <button className="btn-secondary" disabled>Planned</button>
                </div>
                <div className="us-card admin-setting-card">
                  <div>
                    <div className="admin-setting-title">Max Message Length</div>
                    <div className="admin-setting-desc">Maximum number of characters allowed per message.</div>
                  </div>
                  <div className="admin-code-actions">
                    <input
                      type="number"
                      min={1}
                      value={maxMessageLengthInput}
                      onChange={(e) => setMaxMessageLengthInput(e.target.value)}
                    />
                    <button
                      className="btn-secondary"
                      onClick={updateMaxMessageLength}
                      disabled={savingMaxMessageLength || !settings}
                    >
                      {savingMaxMessageLength ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}

      {/* Delete Server Confirmation */}
      {serverToDelete && (
        <ConfirmModal
          title="Delete Server"
          message={`Are you sure you want to permanently delete "${serverToDelete.name}"? This will delete all channels, messages, and data. This action cannot be undone.`}
          confirmLabel="Delete Server"
          onConfirm={() => handleDeleteServer(serverToDelete)}
          onClose={() => setServerToDelete(null)}
          danger
        />
      )}

      {/* Delete User Confirmation */}
      {userToDelete && (
        <ConfirmModal
          title="Delete User"
          message={`Are you sure you want to permanently delete user "${userToDelete.displayName}" (@${userToDelete.username})? This will remove them from all servers and delete their data. Messages will be preserved but marked as deleted. This action cannot be undone.`}
          confirmLabel="Delete User"
          onConfirm={() => handleDeleteUser(userToDelete)}
          onClose={() => setUserToDelete(null)}
          danger
        />
      )}

      {/* Delete Invite Code Confirmation */}
      {codeToDelete && (
        <ConfirmModal
          title="Delete Invite Code"
          message={`Are you sure you want to delete invite code "${codeToDelete.code}"? This code will no longer be usable.`}
          confirmLabel="Delete Code"
          onConfirm={() => handleDeleteInvite(codeToDelete)}
          onClose={() => setCodeToDelete(null)}
          danger
        />
      )}

      {/* Transfer Ownership Modal */}
      {transferOwnershipServer && createPortal(
        <div className="modal-overlay" onClick={() => setTransferOwnershipServer(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: '450px' }}>
            <h2>Transfer Server Ownership</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Transfer ownership of "{transferOwnershipServer.name}" to another user. The new owner will have full control.
            </p>

            <div style={{ position: 'relative', marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 600 }}>
                Search for new owner
              </label>
              <input
                type="text"
                placeholder="Search by username or display name..."
                value={ownershipSearchQuery}
                onChange={(e) => { setOwnershipSearchQuery(e.target.value); setOwnershipDropdownOpen(true); }}
                onFocus={() => setOwnershipDropdownOpen(true)}
                onBlur={() => setTimeout(() => setOwnershipDropdownOpen(false), 200)}
                style={{
                  width: '100%',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4,
                  padding: '8px',
                  color: 'var(--text-primary)',
                  fontSize: 14
                }}
              />

              {ownershipDropdownOpen && ownershipSearchResults.length > 0 && (
                <div className="cosmetic-user-dropdown" style={{ top: '100%', marginTop: '4px' }}>
                  {ownershipSearchResults.map((u) => (
                    <div
                      key={u.id}
                      className="cosmetic-user-dropdown-item"
                      onMouseDown={() => {
                        handleTransferOwnership(u.id);
                        setOwnershipDropdownOpen(false);
                      }}
                    >
                      <div className="cosmetic-user-dropdown-avatar">
                        {u.avatarUrl ? (
                          <img src={u.avatarUrl.startsWith('http') ? u.avatarUrl : `${getApiBase()}${u.avatarUrl}`} alt={u.displayName} />
                        ) : (
                          <div className="cosmetic-user-dropdown-avatar-fallback">{u.displayName[0]}</div>
                        )}
                      </div>
                      <div className="cosmetic-user-dropdown-info">
                        <span className="cosmetic-user-dropdown-display">{u.displayName}</span>
                        <span className="cosmetic-user-dropdown-username">@{u.username}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {ownershipDropdownOpen && ownershipSearchQuery.trim() && ownershipSearchResults.length === 0 && (
                <div className="cosmetic-user-dropdown" style={{ top: '100%', marginTop: '4px' }}>
                  <div className="cosmetic-user-dropdown-empty">No users found</div>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setTransferOwnershipServer(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </SettingsModal>
  );
}
