import { useEffect, useMemo, useState } from 'react';
import { api, getApiBase, useAuthStore, useAppConfigStore, parseCosmeticCss, CosmeticRarityNames, CosmeticRarityColors, CosmeticTypeNames, CosmeticType, CosmeticRarity } from '@abyss/shared';
import type { AdminOverview, AdminServer, AdminUser, AdminSettings, InviteCode, CosmeticItem, UserCosmetic as UserCosmeticT } from '@abyss/shared';

type TabKey = 'overview' | 'servers' | 'users' | 'settings' | 'cosmetics';

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
  const [savingMaxMessageLength, setSavingMaxMessageLength] = useState(false);
  const [maxMessageLengthInput, setMaxMessageLengthInput] = useState<string>('');
  const setMaxMessageLength = useAppConfigStore((s) => s.setMaxMessageLength);

  // Cosmetics state
  const [cosmeticItems, setCosmeticItems] = useState<CosmeticItem[]>([]);
  const [cosmeticsLoading, setCosmeticsLoading] = useState(false);
  const [selectedCosmetic, setSelectedCosmetic] = useState<CosmeticItem | null>(null);
  const [cosmeticFormMode, setCosmeticFormMode] = useState<'list' | 'create' | 'edit' | 'presets'>('list');
  const [cosmeticForm, setCosmeticForm] = useState({ name: '', description: '', type: 0, rarity: 0, cssData: '{}' });
  const [cosmeticTypeFilter, setCosmeticTypeFilter] = useState<number>(-1);
  const [cosmeticSearch, setCosmeticSearch] = useState('');
  const [cosmeticOwners, setCosmeticOwners] = useState<AdminUser[]>([]);
  const [assignUserQuery, setAssignUserQuery] = useState('');
  const [assignUserDropdownOpen, setAssignUserDropdownOpen] = useState(false);
  const [userCosmeticSearch, setUserCosmeticSearch] = useState('');
  const [userCosmeticResults, setUserCosmeticResults] = useState<UserCosmeticT[]>([]);
  const [userCosmeticTarget, setUserCosmeticTarget] = useState<AdminUser | null>(null);

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
      setMaxMessageLengthInput(String(settingsRes.data.maxMessageLength ?? 4000));
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

  const handleSearchUserCosmetics = () => {
    const q = userCosmeticSearch.trim().toLowerCase();
    if (!q || !data?.users) return;
    const found = data.users.find((u) => u.username.toLowerCase() === q || u.id === q || u.displayName.toLowerCase() === q);
    if (found) {
      setUserCosmeticTarget(found);
      loadUserCosmetics(found.id);
    } else {
      setError('User not found.');
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

  const filteredCosmetics = useMemo(() => {
    let items = cosmeticItems;
    if (cosmeticTypeFilter >= 0) items = items.filter((c) => c.type === cosmeticTypeFilter);
    const q = cosmeticSearch.trim().toLowerCase();
    if (q) items = items.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
    return items;
  }, [cosmeticItems, cosmeticTypeFilter, cosmeticSearch]);

  const assignUserResults = useMemo(() => {
    const q = assignUserQuery.trim().toLowerCase();
    if (!q || !data?.users) return [];
    return data.users.filter((u) =>
      u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [data, assignUserQuery]);

  const COSMETIC_PRESETS = [
    // Nameplates - Static Gradients
    { name: 'Crimson Fire', desc: 'A fiery gradient nameplate', type: 0, rarity: 1, css: '{"background":"linear-gradient(90deg, #ff6b6b, #ff8e53)","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700"}' },
    { name: 'Ocean Breeze', desc: 'Cool blue ocean gradient', type: 0, rarity: 1, css: '{"background":"linear-gradient(90deg, #36d1dc, #5b86e5)","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700"}' },
    { name: 'Sakura', desc: 'Soft pink cherry blossom gradient', type: 0, rarity: 1, css: '{"background":"linear-gradient(90deg, #fbc2eb, #a6c1ee)","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700"}' },
    { name: 'Volcanic', desc: 'Hot lava pink-red gradient', type: 0, rarity: 2, css: '{"background":"linear-gradient(90deg, #ff512f, #dd2476)","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700"}' },
    // Nameplates - Glow Effects
    { name: 'Emerald Glow', desc: 'Green glow emanating from text', type: 0, rarity: 2, css: '{"color":"#43b581","textShadow":"0 0 8px rgba(67,181,129,0.6), 0 0 16px rgba(67,181,129,0.3)","fontWeight":"700"}' },
    { name: 'Neon Purple', desc: 'Purple neon glow effect', type: 0, rarity: 2, css: '{"color":"#b388ff","textShadow":"0 0 8px rgba(179,136,255,0.7), 0 0 20px rgba(179,136,255,0.4)","fontWeight":"700"}' },
    { name: 'Shadow Lord', desc: 'Deep shadow effect on text', type: 0, rarity: 3, css: '{"color":"#c0c0c0","textShadow":"0 2px 4px rgba(0,0,0,0.8), 0 0 12px rgba(0,0,0,0.5)","fontWeight":"700","letterSpacing":"0.5px"}' },
    { name: 'Midnight Pulse', desc: 'Pulsing blue glow', type: 0, rarity: 3, css: '{"color":"#7289da","textShadow":"0 0 6px rgba(114,137,218,0.5)","fontWeight":"700","animation":"nameplate-pulse 2s ease-in-out infinite"}' },
    // Nameplates - Animated Shimmer
    { name: 'Gold Shimmer', desc: 'Animated golden shimmer', type: 0, rarity: 3, css: '{"background":"linear-gradient(90deg, #f7971e, #ffd200, #f7971e)","backgroundSize":"200% auto","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700","animation":"nameplate-shimmer 3s linear infinite"}' },
    { name: 'Frost Bite', desc: 'Icy pastel shimmer', type: 0, rarity: 3, css: '{"background":"linear-gradient(90deg, #a8edea, #fed6e3, #a8edea)","backgroundSize":"200% auto","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700","animation":"nameplate-shimmer 5s linear infinite"}' },
    { name: 'Blood Moon', desc: 'Dark crimson shimmer', type: 0, rarity: 3, css: '{"background":"linear-gradient(90deg, #8b0000, #dc143c, #8b0000)","backgroundSize":"200% auto","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700","animation":"nameplate-shimmer 4s linear infinite"}' },
    { name: 'Arctic Aurora', desc: 'Cyan-green northern lights', type: 0, rarity: 3, css: '{"background":"linear-gradient(90deg, #00c9ff, #92fe9d, #00c9ff)","backgroundSize":"200% auto","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700","animation":"nameplate-shimmer 4s linear infinite"}' },
    // Nameplates - Legendary
    { name: 'Rainbow Shift', desc: 'Full spectrum rainbow shimmer', type: 0, rarity: 4, css: '{"background":"linear-gradient(90deg, #ff6b6b, #ffa500, #ffd700, #43b581, #5b86e5, #b388ff, #ff6b6b)","backgroundSize":"300% auto","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700","animation":"nameplate-shimmer-300 4s linear infinite"}' },
    { name: 'Cyber Punk', desc: 'Neon cyberpunk color shift', type: 0, rarity: 4, css: '{"background":"linear-gradient(90deg, #f72585, #7209b7, #3a0ca3, #4cc9f0, #f72585)","backgroundSize":"300% auto","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700","animation":"nameplate-shimmer-300 3s linear infinite"}' },
    { name: 'Holographic', desc: 'Holographic multi-color effect', type: 0, rarity: 4, css: '{"background":"linear-gradient(135deg, #ff0080, #ff8c00, #40e0d0, #7b68ee, #ff0080)","backgroundSize":"400% auto","backgroundClip":"text","WebkitBackgroundClip":"text","WebkitTextFillColor":"transparent","fontWeight":"700","animation":"nameplate-shimmer-400 6s linear infinite","filter":"brightness(1.1)"}' },
    { name: 'Static Glitch', desc: 'Glitchy terminal aesthetic', type: 0, rarity: 4, css: '{"color":"#00ff41","textShadow":"-1px 0 #ff0000, 1px 0 #00ffff","fontWeight":"700","letterSpacing":"1px"}' },
    // Message Styles - Simple
    { name: 'Royal Blue', desc: 'Clean blue accent border', type: 1, rarity: 0, css: '{"borderLeft":"3px solid #5865f2","background":"linear-gradient(90deg, rgba(88,101,242,0.1), transparent)","borderRadius":"0 4px 4px 0"}' },
    { name: 'Crimson Edge', desc: 'Bold red border accent', type: 1, rarity: 0, css: '{"borderLeft":"3px solid #ed4245","background":"linear-gradient(90deg, rgba(237,66,69,0.08), transparent)","borderRadius":"0 4px 4px 0"}' },
    { name: 'Emerald Accent', desc: 'Natural green border', type: 1, rarity: 0, css: '{"borderLeft":"3px solid #43b581","background":"linear-gradient(90deg, rgba(67,181,129,0.08), transparent)","borderRadius":"0 4px 4px 0"}' },
    { name: 'Sunset Glow', desc: 'Warm golden accent', type: 1, rarity: 1, css: '{"borderLeft":"3px solid #faa61a","background":"linear-gradient(90deg, rgba(250,166,26,0.08), transparent)","borderRadius":"0 4px 4px 0"}' },
    // Message Styles - Enhanced
    { name: 'Neon Border', desc: 'Neon purple glow border', type: 1, rarity: 2, css: '{"borderLeft":"3px solid #b388ff","background":"linear-gradient(90deg, rgba(179,136,255,0.06), transparent)","boxShadow":"-4px 0 12px rgba(179,136,255,0.15)","borderRadius":"0 4px 4px 0"}' },
    { name: 'Gradient Border', desc: 'Pink-purple gradient left border', type: 1, rarity: 2, css: '{"borderLeft":"3px solid #f72585","background":"linear-gradient(90deg, rgba(247,37,133,0.05), transparent)"}' },
    { name: 'Cherry Blossom', desc: 'Soft pink pastel border', type: 1, rarity: 2, css: '{"borderLeft":"3px solid #fbc2eb","background":"linear-gradient(90deg, rgba(251,194,235,0.06), rgba(166,193,238,0.02), transparent)","borderRadius":"0 4px 4px 0"}' },
    // Message Styles - Premium
    { name: 'Golden Frame', desc: 'Full golden border frame', type: 1, rarity: 3, css: '{"border":"1px solid rgba(243,156,18,0.3)","borderLeft":"3px solid #f39c12","background":"linear-gradient(90deg, rgba(243,156,18,0.06), transparent)","borderRadius":"4px"}' },
    { name: 'Frost Glass', desc: 'Frosted glass effect', type: 1, rarity: 3, css: '{"background":"rgba(168,237,234,0.04)","border":"1px solid rgba(168,237,234,0.12)","borderRadius":"8px"}' },
    { name: 'Dark Aura', desc: 'Dark void-like depth', type: 1, rarity: 3, css: '{"background":"rgba(0,0,0,0.2)","borderLeft":"3px solid #2c2f33","boxShadow":"inset 0 0 20px rgba(0,0,0,0.3)","borderRadius":"0 4px 4px 0"}' },
    { name: 'Glowing Ember', desc: 'Warm smoldering glow', type: 1, rarity: 3, css: '{"borderLeft":"3px solid #ff512f","background":"linear-gradient(90deg, rgba(255,81,47,0.08), rgba(221,36,118,0.04), transparent)","boxShadow":"-2px 0 8px rgba(255,81,47,0.12)","borderRadius":"0 4px 4px 0"}' },
    { name: 'Double Border', desc: 'Symmetrical side borders', type: 1, rarity: 3, css: '{"borderLeft":"3px solid #5865f2","borderRight":"3px solid #5865f2","background":"linear-gradient(90deg, rgba(88,101,242,0.06), transparent, rgba(88,101,242,0.06))","borderRadius":"4px"}' },
    // Message Styles - Legendary
    { name: 'Rainbow Border', desc: 'Full rainbow spectrum border', type: 1, rarity: 4, css: '{"borderLeft":"4px solid transparent","borderImage":"linear-gradient(to bottom, #ff6b6b, #ffa500, #ffd700, #43b581, #5b86e5, #b388ff) 1","background":"linear-gradient(90deg, rgba(114,137,218,0.04), transparent)"}' },
    { name: 'Holographic Frame', desc: 'Animated rainbow shimmer border', type: 1, rarity: 4, css: '{"background":"linear-gradient(var(--bg-primary), var(--bg-primary)) padding-box, linear-gradient(90deg, #ff6b6b, #ffa500, #ffd700, #43b581, #5b86e5, #b388ff, #ff6b6b) border-box","backgroundSize":"100% 100%, 300% auto","border":"2px solid transparent","borderLeft":"3px solid transparent","borderRadius":"4px","animation":"msg-holo-shimmer 4s linear infinite"}' },
    { name: 'Terminal', desc: 'Retro hacker terminal look', type: 1, rarity: 4, css: '{"borderLeft":"3px solid #00ff41","background":"rgba(0,255,65,0.03)","borderRadius":"0 4px 4px 0","fontFamily":"\'Courier New\', Consolas, monospace","color":"#00ff41"}' },
    { name: 'Pulsing Glow', desc: 'Gently pulsing border glow', type: 1, rarity: 3, css: '{"borderLeft":"3px solid #7289da","background":"linear-gradient(90deg, rgba(114,137,218,0.06), transparent)","borderRadius":"0 4px 4px 0","animation":"msg-glow 3s ease-in-out infinite"}' },
  ];

  const handleAddPreset = async (preset: typeof COSMETIC_PRESETS[0]) => {
    setError(null);
    try {
      const res = await api.post('/cosmetics', {
        name: preset.name,
        description: preset.desc,
        type: preset.type,
        rarity: preset.rarity,
        cssData: preset.css,
      });
      setCosmeticItems((prev) => [...prev, res.data]);
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to create preset.');
    }
  };

  const handleSyncAllPresets = async () => {
    setError(null);
    const existingByName = new Map(cosmeticItems.map((c) => [c.name, c]));
    for (const preset of COSMETIC_PRESETS) {
      const existing = existingByName.get(preset.name);
      if (existing) {
        // Update if anything differs
        if (existing.cssData !== preset.css || existing.description !== preset.desc || existing.rarity !== preset.rarity) {
          try {
            const res = await api.put(`/cosmetics/${existing.id}`, {
              description: preset.desc,
              rarity: preset.rarity,
              cssData: preset.css,
            });
            setCosmeticItems((prev) => prev.map((c) => c.id === existing.id ? res.data : c));
          } catch { /* skip */ }
        }
      } else {
        try {
          const res = await api.post('/cosmetics', {
            name: preset.name,
            description: preset.desc,
            type: preset.type,
            rarity: preset.rarity,
            cssData: preset.css,
          });
          setCosmeticItems((prev) => [...prev, res.data]);
        } catch { /* skip */ }
      }
    }
  };

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
    return (
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
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal user-settings-modal admin-panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="us-sidebar">
          <div className="us-sidebar-header">Admin</div>
          <button className={`us-nav-item ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
          <button className={`us-nav-item ${tab === 'servers' ? 'active' : ''}`} onClick={() => setTab('servers')}>Servers</button>
          <button className={`us-nav-item ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>Users</button>
          <button className={`us-nav-item ${tab === 'cosmetics' ? 'active' : ''}`} onClick={() => setTab('cosmetics')}>Cosmetics</button>
          <div className="us-nav-separator" />
          <button className={`us-nav-item ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
        </div>

        <div className="us-content">
          <div className="us-content-header">
            <h2>
              {tab === 'overview' && 'Overview'}
              {tab === 'servers' && 'Servers'}
              {tab === 'users' && 'Users'}
              {tab === 'cosmetics' && 'Cosmetics'}
              {tab === 'settings' && 'Settings'}
            </h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn-secondary" onClick={load} disabled={loading} style={{ padding: '6px 12px', fontSize: 13 }}>Refresh</button>
              <button className="us-close" onClick={onClose}>&times;</button>
            </div>
          </div>

          {error && <div className="admin-error">{error}</div>}

          <div className="us-content-body">
            {loading && !data && (
              <div className="admin-loading">Loading admin data...</div>
            )}

            {!loading && data && tab === 'overview' && (
              <div className="admin-overview">
                <div className="us-card admin-metric">
                  <div className="us-card-title">Servers</div>
                  <div className="admin-metric-value">{data.servers.length}</div>
                </div>
                <div className="us-card admin-metric">
                  <div className="us-card-title">Users</div>
                  <div className="admin-metric-value">{data.users.length}</div>
                </div>
              </div>
            )}

            {!loading && data && tab === 'servers' && (
              <div className="admin-section">
                <div className="us-card">
                  <div className="admin-search">
                    <input
                      type="text"
                      placeholder="Search servers by name, id, owner id"
                      value={serverQuery}
                      onChange={(e) => setServerQuery(e.target.value)}
                    />
                    <span className="admin-count">{filteredServers.length} results</span>
                  </div>
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
                <div className="us-card">
                  <div className="admin-search">
                    <input
                      type="text"
                      placeholder="Search users by name, username, id, email"
                      value={userQuery}
                      onChange={(e) => setUserQuery(e.target.value)}
                    />
                    <span className="admin-count">{filteredUsers.length} results</span>
                  </div>
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
                      <button className="btn-secondary" onClick={() => setCosmeticFormMode('presets')} style={{ padding: '6px 12px', fontSize: 13 }}>
                        Presets
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

                {cosmeticFormMode === 'presets' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div className="admin-setting-title">Preset Cosmetics</div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-secondary" onClick={handleSyncAllPresets} style={{ padding: '6px 12px', fontSize: 12 }}>Sync All Presets</button>
                        <button className="btn-secondary" onClick={() => setCosmeticFormMode('list')} style={{ padding: '6px 12px', fontSize: 12 }}>Back</button>
                      </div>
                    </div>
                    <div className="admin-setting-desc" style={{ marginBottom: 12 }}>Click a preset to add it as a cosmetic item. Already-added items are dimmed.</div>
                    <div className="cosmetic-preset-grid">
                      {COSMETIC_PRESETS.map((p) => {
                        const exists = cosmeticItems.some((c) => c.name === p.name);
                        return (
                          <div
                            key={p.name}
                            className="cosmetic-preset-item"
                            style={exists ? { opacity: 0.4 } : undefined}
                            onClick={() => !exists && handleAddPreset(p)}
                          >
                            <div className="cosmetic-preset-preview">
                              {renderCosmeticPreview(p.css, p.type, p.name)}
                            </div>
                            <div className="cosmetic-preset-label">{p.name}</div>
                            <div className="cosmetic-preset-rarity" style={{ color: CosmeticRarityColors[p.rarity] }}>
                              {CosmeticRarityNames[p.rarity]} &middot; {CosmeticTypeNames[p.type]}
                            </div>
                          </div>
                        );
                      })}
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
                    <button className="btn-secondary" onClick={createInviteCode} disabled={creatingCode}>
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
          </div>
        </div>
      </div>
    </div>
  );
}
