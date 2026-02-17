import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, Switch, FlatList,
  ActivityIndicator, StyleSheet, type ViewStyle, type TextStyle,
} from 'react-native';
import { useAuthStore, useAppConfigStore, api } from '@abyss/shared';
import type { AdminOverview, AdminServer, AdminUser, AdminSettings, Invite } from '@abyss/shared';
import Modal from './Modal';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

type TabKey = 'overview' | 'servers' | 'users' | 'settings';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'servers', label: 'Servers' },
  { key: 'users', label: 'Users' },
  { key: 'settings', label: 'Settings' },
];

export default function AdminPanel() {
  const isSysadmin = useAuthStore((s) => s.isSysadmin);
  const closeModal = useUiStore((s) => s.closeModal);
  const setMaxMessageLength = useAppConfigStore((s) => s.setMaxMessageLength);

  const [tab, setTab] = useState<TabKey>('overview');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Servers tab
  const [serverQuery, setServerQuery] = useState('');

  // Users tab
  const [userQuery, setUserQuery] = useState('');

  // Settings tab
  const [savingInviteOnly, setSavingInviteOnly] = useState(false);
  const [maxMessageLengthInput, setMaxMessageLengthInput] = useState('');
  const [savingMaxMessageLength, setSavingMaxMessageLength] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const [creatingCode, setCreatingCode] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);

  const load = useCallback(async () => {
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
      setError(err?.response?.data || 'Failed to load admin data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSysadmin) {
      load();
    }
  }, [isSysadmin, load]);

  // --- Filtered lists ---

  const filteredServers = useMemo(() => {
    if (!data?.servers) return [] as AdminServer[];
    const q = serverQuery.trim().toLowerCase();
    if (!q) return data.servers;
    return data.servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.ownerId.toLowerCase().includes(q),
    );
  }, [data, serverQuery]);

  const filteredUsers = useMemo(() => {
    if (!data?.users) return [] as AdminUser[];
    const q = userQuery.trim().toLowerCase();
    if (!q) return data.users;
    return data.users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q),
    );
  }, [data, userQuery]);

  // --- Settings handlers ---

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
      const res = await api.put('/admin/settings/max-message-length', {
        maxMessageLength: Math.floor(parsed),
      });
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

  const createInvite = async () => {
    setCreatingCode(true);
    setError(null);
    setNewCode(null);
    try {
      const payload: { maxUses?: number; expiresAt?: string } = {};
      const parsedMax = Number(maxUses);
      if (!Number.isNaN(parsedMax) && parsedMax > 0) payload.maxUses = parsedMax;
      const res = await api.post('/admin/invite-codes', payload);
      const created: Invite = res.data;
      setSettings((prev) =>
        prev ? { ...prev, codes: [created, ...prev.codes] } : prev,
      );
      setNewCode(created.code);
      setMaxUses('');
    } catch (err: any) {
      setError(err?.response?.data || 'Failed to create invite code.');
    } finally {
      setCreatingCode(false);
    }
  };

  // --- Guard ---

  if (!isSysadmin) return null;

  // --- Render helpers ---

  const renderServerItem = ({ item }: { item: AdminServer }) => (
    <View style={styles.listItem}>
      <View style={styles.listItemMain}>
        <Text style={styles.listItemTitle} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.listItemSub} numberOfLines={1}>ID: {item.id}</Text>
      </View>
      <View style={styles.listItemStats}>
        <View style={styles.miniStat}>
          <Text style={styles.miniStatValue}>{item.memberCount}</Text>
          <Text style={styles.miniStatLabel}>MEMBERS</Text>
        </View>
        <View style={styles.miniStat}>
          <Text style={styles.miniStatValue}>{item.channelCount}</Text>
          <Text style={styles.miniStatLabel}>CHANNELS</Text>
        </View>
      </View>
    </View>
  );

  const renderUserItem = ({ item }: { item: AdminUser }) => (
    <View style={styles.listItem}>
      <View style={styles.listItemMain}>
        <Text style={styles.listItemTitle} numberOfLines={1}>{item.displayName}</Text>
        <Text style={styles.listItemSub} numberOfLines={1}>@{item.username}</Text>
        {item.email ? (
          <Text style={styles.listItemMeta} numberOfLines={1}>{item.email}</Text>
        ) : null}
      </View>
      {item.status ? (
        <View style={styles.statusBadge}>
          <Text style={styles.statusBadgeText} numberOfLines={1}>{item.status}</Text>
        </View>
      ) : null}
    </View>
  );

  const renderCodeItem = ({ item }: { item: Invite }) => (
    <View style={styles.codeItem}>
      <View style={{ flex: 1 }}>
        <Text style={styles.codeText} selectable>{item.code}</Text>
        <Text style={styles.codeMeta}>
          Uses: {item.uses}{item.maxUses ? ` / ${item.maxUses}` : ''}
          {'  |  '}
          Created: {new Date(item.createdAt).toLocaleDateString()}
        </Text>
      </View>
    </View>
  );

  return (
    <Modal title="Admin Panel" maxWidth={520}>
      {/* Tab bar */}
      <View style={styles.tabBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBarScroll}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((t) => (
            <Pressable
              key={t.key}
              style={[styles.tab, tab === t.key && styles.tabActive]}
              onPress={() => setTab(t.key)}
            >
              <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>
                {t.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Error banner */}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {/* Loading state */}
      {loading && !data && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brandColor} />
          <Text style={styles.loadingText}>Loading admin data...</Text>
        </View>
      )}

      {/* ─── Overview Tab ─── */}
      {!loading && data && tab === 'overview' && (
        <View>
          <View style={styles.statCardRow}>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>SERVERS</Text>
              <Text style={styles.statValue}>{data.servers.length}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statLabel}>USERS</Text>
              <Text style={styles.statValue}>{data.users.length}</Text>
            </View>
          </View>
          <Pressable style={styles.refreshBtn} onPress={load} disabled={loading}>
            <Text style={styles.refreshBtnText}>{loading ? 'Refreshing...' : 'Refresh'}</Text>
          </Pressable>
        </View>
      )}

      {/* ─── Servers Tab ─── */}
      {!loading && data && tab === 'servers' && (
        <View style={styles.tabContent}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name, id, owner id..."
            placeholderTextColor={colors.textMuted}
            value={serverQuery}
            onChangeText={setServerQuery}
          />
          <Text style={styles.resultCount}>
            {filteredServers.length} server{filteredServers.length !== 1 ? 's' : ''}
          </Text>
          <FlatList
            data={filteredServers}
            renderItem={renderServerItem}
            keyExtractor={(item) => item.id}
            style={styles.flatList}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No servers found.</Text>
            }
          />
        </View>
      )}

      {/* ─── Users Tab ─── */}
      {!loading && data && tab === 'users' && (
        <View style={styles.tabContent}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search by username, name, id, email..."
            placeholderTextColor={colors.textMuted}
            value={userQuery}
            onChangeText={setUserQuery}
          />
          <Text style={styles.resultCount}>
            {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}
          </Text>
          <FlatList
            data={filteredUsers}
            renderItem={renderUserItem}
            keyExtractor={(item) => item.id}
            style={styles.flatList}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No users found.</Text>
            }
          />
        </View>
      )}

      {/* ─── Settings Tab ─── */}
      {!loading && tab === 'settings' && (
        <View>
          {/* Invite-only toggle */}
          <View style={styles.settingCard}>
            <View style={styles.settingCardHeader}>
              <Text style={styles.settingTitle}>Invite-Only Mode</Text>
              <Switch
                value={settings?.inviteOnly ?? false}
                onValueChange={updateInviteOnly}
                disabled={savingInviteOnly || !settings}
                trackColor={{ false: colors.bgTertiary, true: colors.bgAccent }}
                thumbColor={colors.headerPrimary}
              />
            </View>
            <Text style={styles.settingDesc}>
              Restrict new registrations to users with an admin-generated code.
            </Text>
          </View>

          {/* Max message length */}
          <View style={styles.settingCard}>
            <Text style={styles.settingTitle}>Max Message Length</Text>
            <Text style={styles.settingDesc}>
              Maximum number of characters allowed per message.
            </Text>
            <View style={styles.settingInputRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={maxMessageLengthInput}
                onChangeText={setMaxMessageLengthInput}
                keyboardType="numeric"
                placeholderTextColor={colors.textMuted}
              />
              <Pressable
                style={[
                  styles.btnPrimary,
                  (savingMaxMessageLength || !settings) && styles.btnDisabled,
                ]}
                onPress={updateMaxMessageLength}
                disabled={savingMaxMessageLength || !settings}
              >
                <Text style={styles.btnPrimaryText}>
                  {savingMaxMessageLength ? 'Saving...' : 'Save'}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Generate invite code */}
          <View style={styles.settingCard}>
            <Text style={styles.settingTitle}>Generate Invite Code</Text>
            <Text style={styles.settingDesc}>
              Create a registration code. Optionally set max uses.
            </Text>
            <View style={styles.settingInputRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Max uses (optional)"
                placeholderTextColor={colors.textMuted}
                value={maxUses}
                onChangeText={setMaxUses}
                keyboardType="numeric"
              />
              <Pressable
                style={[styles.btnPrimary, creatingCode && styles.btnDisabled]}
                onPress={createInvite}
                disabled={creatingCode}
              >
                <Text style={styles.btnPrimaryText}>
                  {creatingCode ? 'Creating...' : 'Create'}
                </Text>
              </Pressable>
            </View>
            {newCode ? (
              <View style={styles.newCodeBanner}>
                <Text style={styles.newCodeLabel}>New code:</Text>
                <Text style={styles.newCodeValue} selectable>{newCode}</Text>
              </View>
            ) : null}
          </View>

          {/* Invite codes list */}
          <Text style={styles.sectionLabel}>INVITE CODES</Text>
          {settings && settings.codes.length === 0 && (
            <Text style={styles.emptyText}>No invite codes yet.</Text>
          )}
          <FlatList
            data={settings?.codes ?? []}
            renderItem={renderCodeItem}
            keyExtractor={(item) => item.id}
            style={styles.flatList}
            scrollEnabled={false}
          />
        </View>
      )}

      {/* Close button */}
      <View style={styles.actions}>
        <Pressable style={styles.btnSecondary} onPress={closeModal}>
          <Text style={styles.btnSecondaryText}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Tab bar
  tabBar: {
    marginBottom: spacing.lg,
    flexGrow: 0,
    backgroundColor: colors.bgSecondary,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.bgTertiary,
  } as ViewStyle,
  tabBarScroll: {
    width: '100%',
  } as ViewStyle,
  tabBarContent: {
    flexDirection: 'row',
    gap: spacing.xs,
  } as ViewStyle,
  tab: {
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    minWidth: 80,
  } as ViewStyle,
  tabActive: {
    backgroundColor: colors.bgAccent,
  } as ViewStyle,
  tabText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  tabTextActive: {
    color: '#fff',
  } as TextStyle,

  // Common
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  } as TextStyle,
  centered: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    gap: spacing.md,
  } as ViewStyle,
  loadingText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  } as TextStyle,
  tabContent: {
    flex: 1,
  } as ViewStyle,
  searchInput: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
    marginBottom: spacing.sm,
  } as TextStyle,
  resultCount: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  flatList: {
    maxHeight: 300,
  } as ViewStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  } as TextStyle,
  input: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
  } as TextStyle,

  // Overview stat cards
  statCardRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.lg,
  } as ViewStyle,
  statCard: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.bgTertiary,
  } as ViewStyle,
  statLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  } as TextStyle,
  statValue: {
    color: colors.headerPrimary,
    fontSize: fontSize.xxl,
    fontWeight: '700',
  } as TextStyle,
  refreshBtn: {
    backgroundColor: colors.bgModifierActive,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
  } as ViewStyle,
  refreshBtnText: {
    color: colors.textPrimary,
    fontWeight: '600',
    fontSize: fontSize.sm,
  } as TextStyle,

  // Server / User list items
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  listItemMain: {
    flex: 1,
    marginRight: spacing.sm,
  } as ViewStyle,
  listItemTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  listItemSub: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  } as TextStyle,
  listItemMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 2,
  } as TextStyle,
  listItemStats: {
    flexDirection: 'row',
    gap: spacing.md,
  } as ViewStyle,
  miniStat: {
    alignItems: 'center',
  } as ViewStyle,
  miniStatValue: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '700',
  } as TextStyle,
  miniStatLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  } as TextStyle,
  statusBadge: {
    backgroundColor: colors.bgModifierActive,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    maxWidth: 120,
  } as ViewStyle,
  statusBadgeText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  } as TextStyle,

  // Settings
  settingCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.bgTertiary,
  } as ViewStyle,
  settingCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  } as ViewStyle,
  settingTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginBottom: spacing.xs,
  } as TextStyle,
  settingDesc: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
    lineHeight: 18,
  } as TextStyle,
  settingInputRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  } as ViewStyle,
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  } as TextStyle,

  // Invite codes
  codeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  codeText: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
    fontFamily: 'monospace',
  } as TextStyle,
  codeMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  } as TextStyle,
  newCodeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    gap: spacing.sm,
  } as ViewStyle,
  newCodeLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  newCodeValue: {
    color: colors.success,
    fontSize: fontSize.md,
    fontWeight: '700',
    fontFamily: 'monospace',
  } as TextStyle,

  // Actions
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.lg,
  } as ViewStyle,
  btnPrimary: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,
  btnPrimaryText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  btnSecondary: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,
  btnSecondaryText: {
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  btnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
});
