import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, ScrollView, Alert, Image,
  StyleSheet, type ViewStyle, type TextStyle, type ImageStyle,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  useServerStore, useAuthStore, getApiBase, hasPermission, Permission,
  getDisplayColor, getHighestRole, canActOn, useMediaProviderStore,
} from '@abyss/shared';
import type { AuditLog, ServerRole, ServerMember, MediaProviderConnection } from '@abyss/shared';
import Modal from './Modal';
import Avatar from './Avatar';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

const ACTION_LABELS: Record<string, string> = {
  MessageDeleted: 'Deleted a message',
  ChannelCreated: 'Created channel',
  ChannelDeleted: 'Deleted channel',
  ChannelUpdated: 'Updated channel',
  MemberKicked: 'Kicked',
  MemberPromoted: 'Promoted',
  MemberDemoted: 'Demoted',
  ServerDeleted: 'Deleted server',
  MemberBanned: 'Banned',
  MemberUnbanned: 'Unbanned',
  RoleCreated: 'Created role',
  RoleUpdated: 'Updated role',
  RoleDeleted: 'Deleted role',
  MemberRolesUpdated: 'Updated roles of',
  MemberLeft: 'Left the server',
  EmojiCreated: 'Created emoji',
  EmojiDeleted: 'Deleted emoji',
  ServerUpdated: 'Updated server',
  MessagePinned: 'Pinned a message',
  MessageUnpinned: 'Unpinned a message',
};

const ACTION_ICONS: Record<string, string> = {
  MessageDeleted: '\u{1F5D1}',
  ChannelCreated: '\u{2795}',
  ChannelDeleted: '\u{2796}',
  ChannelUpdated: '\u{270F}',
  MemberKicked: '\u{1F6AB}',
  MemberPromoted: '\u{2B06}',
  MemberDemoted: '\u{2B07}',
  ServerDeleted: '\u{1F4A5}',
  MemberBanned: '\u{1F6D1}',
  MemberUnbanned: '\u{2705}',
  RoleCreated: '\u{1F3F7}',
  RoleUpdated: '\u{270F}',
  RoleDeleted: '\u{274C}',
  MemberRolesUpdated: '\u{1F465}',
  MemberLeft: '\u{1F6AA}',
  EmojiCreated: '\u{1F600}',
  EmojiDeleted: '\u{274C}',
  ServerUpdated: '\u{270F}',
  MessagePinned: '\u{1F4CC}',
  MessageUnpinned: '\u{1F4CC}',
};

const PERMISSION_LABELS: { perm: number; label: string }[] = [
  { perm: Permission.ManageChannels, label: 'Manage Channels' },
  { perm: Permission.ManageMessages, label: 'Manage Messages' },
  { perm: Permission.KickMembers, label: 'Kick Members' },
  { perm: Permission.BanMembers, label: 'Ban Members' },
  { perm: Permission.MuteMembers, label: 'Mute Members (Voice)' },
  { perm: Permission.ManageRoles, label: 'Manage Roles' },
  { perm: Permission.ViewAuditLog, label: 'View Audit Log' },
  { perm: Permission.ManageServer, label: 'Manage Server' },
  { perm: Permission.ManageInvites, label: 'Manage Invites' },
  { perm: Permission.ManageEmojis, label: 'Manage Emojis' },
  { perm: Permission.ViewChannel, label: 'View Channels' },
  { perm: Permission.ReadMessageHistory, label: 'Read Message History' },
  { perm: Permission.SendMessages, label: 'Send Messages' },
  { perm: Permission.AddReactions, label: 'Add Reactions' },
  { perm: Permission.AttachFiles, label: 'Attach Files' },
  { perm: Permission.MentionEveryone, label: 'Mention @everyone/@here' },
  { perm: Permission.Connect, label: 'Connect (Voice)' },
  { perm: Permission.Speak, label: 'Speak (Voice)' },
  { perm: Permission.Stream, label: 'Stream (Screen Share)' },
];

function formatTimestamp(dateStr: string) {
  return new Date(dateStr).toLocaleString();
}

type Tab = 'server' | 'members' | 'roles' | 'emojis' | 'bans' | 'audit' | 'media' | 'danger';

const PROVIDER_TYPES = [
  { value: 'Plex' as const, label: 'Plex' },
  { value: 'YouTube' as const, label: 'YouTube' },
];

const PROVIDER_LABELS: Record<string, string> = {
  Plex: 'Plex',
  YouTube: 'YouTube',
  Spotify: 'Spotify',
  Twitch: 'Twitch',
  SoundCloud: 'SoundCloud',
};

export default function ServerSettingsModal() {
  const closeModal = useUiStore((s) => s.closeModal);
  const activeServer = useServerStore((s) => s.activeServer);
  const members = useServerStore((s) => s.members);
  const roles = useServerStore((s) => s.roles);
  const bans = useServerStore((s) => s.bans);
  const emojis = useServerStore((s) => s.emojis);
  const currentUser = useAuthStore((s) => s.user);
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const isOwner = currentMember?.isOwner ?? false;
  const canManageRoles = currentMember ? hasPermission(currentMember, Permission.ManageRoles) : false;
  const canKick = currentMember ? hasPermission(currentMember, Permission.KickMembers) : false;
  const canBan = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const canViewAuditLog = currentMember ? hasPermission(currentMember, Permission.ViewAuditLog) : false;
  const canManageEmojis = currentMember ? hasPermission(currentMember, Permission.ManageEmojis) : false;
  const canManageServer = currentMember ? hasPermission(currentMember, Permission.ManageServer) : false;
  const canManageAnyMembers = canManageRoles || canKick || canBan;

  const serverId = activeServer?.id ?? '';

  // Tab state
  const defaultTab: Tab = canManageServer ? 'server'
    : canManageAnyMembers ? 'members'
    : canManageRoles ? 'roles'
    : 'audit';
  const [tab, setTab] = useState<Tab>(defaultTab);

  // Audit logs
  const [logs, setLogs] = useState<AuditLog[]>([]);

  // Members tab
  const [memberSearch, setMemberSearch] = useState('');
  const [roleAssignTarget, setRoleAssignTarget] = useState<ServerMember | null>(null);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  // Roles tab
  const [editingRole, setEditingRole] = useState<ServerRole | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#99aab5');
  const [rolePerms, setRolePerms] = useState(0);
  const [roleDisplaySeparately, setRoleDisplaySeparately] = useState(false);
  const [creating, setCreating] = useState(false);

  // Emojis tab
  const [emojiName, setEmojiName] = useState('');
  const [emojiUri, setEmojiUri] = useState<string | null>(null);
  const [emojiUploading, setEmojiUploading] = useState(false);
  const [emojiError, setEmojiError] = useState('');

  // Server settings
  const [serverName, setServerName] = useState(activeServer?.name ?? '');
  const [serverIconAsset, setServerIconAsset] = useState<{ uri: string; name: string; type?: string } | null>(null);
  const [serverSaving, setServerSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  // Danger zone
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Media providers
  const connections = useMediaProviderStore((s) => s.connections);
  const isProviderLoading = useMediaProviderStore((s) => s.isLoading);
  const [mediaProviderType, setMediaProviderType] = useState<'Plex' | 'YouTube'>('Plex');
  const [mediaDisplayName, setMediaDisplayName] = useState('');
  const [mediaServerUrl, setMediaServerUrl] = useState('');
  const [mediaAuthToken, setMediaAuthToken] = useState('');
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    if (tab === 'audit' && canViewAuditLog) {
      useServerStore.getState().fetchAuditLogs(serverId).then(setLogs).catch(console.error);
    }
    if (tab === 'bans' && canBan) {
      useServerStore.getState().fetchBans(serverId);
    }
    if (tab === 'media' && canManageServer) {
      useMediaProviderStore.getState().fetchConnections(serverId);
    }
  }, [tab, serverId]);

  useEffect(() => {
    if (activeServer) {
      setServerName(activeServer.name);
      setServerIconAsset(null);
      setServerError('');
    }
  }, [activeServer?.id]);

  const nonDefaultRoles = [...roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
  const showEditor = creating || editingRole != null;

  // ─── Role handlers ───
  const startCreateRole = () => {
    setEditingRole(null);
    setRoleName('');
    setRoleColor('#99aab5');
    setRolePerms(0);
    setRoleDisplaySeparately(false);
    setCreating(true);
  };

  const startEditRole = (role: ServerRole) => {
    setEditingRole(role);
    setRoleName(role.name);
    setRoleColor(role.color);
    setRolePerms(role.permissions);
    setRoleDisplaySeparately(role.displaySeparately);
    setCreating(false);
  };

  const handleSaveRole = async () => {
    const { createRole, updateRole } = useServerStore.getState();
    if (creating) {
      await createRole(serverId, roleName, roleColor, rolePerms, roleDisplaySeparately);
    } else if (editingRole) {
      await updateRole(serverId, editingRole.id, { name: roleName, color: roleColor, permissions: rolePerms, displaySeparately: roleDisplaySeparately });
    }
    setEditingRole(null);
    setCreating(false);
  };

  const handleDeleteRole = async (roleId: string) => {
    await useServerStore.getState().deleteRole(serverId, roleId);
    if (editingRole?.id === roleId) {
      setEditingRole(null);
      setCreating(false);
    }
  };

  const handleMoveRole = async (roleId: string, direction: 'up' | 'down') => {
    const idx = nonDefaultRoles.findIndex((r) => r.id === roleId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= nonDefaultRoles.length) return;
    const reordered = [...nonDefaultRoles];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    await useServerStore.getState().reorderRoles(serverId, [...reordered].reverse().map((r) => r.id));
  };

  const togglePerm = (perm: number) => {
    setRolePerms((p) => (p & perm) ? (p & ~perm) : (p | perm));
  };

  // ─── Delete server ───
  const handleDelete = async () => {
    if (!activeServer || confirmName !== activeServer.name) return;
    setDeleting(true);
    try {
      await useServerStore.getState().deleteServer(serverId);
      closeModal();
    } catch {
      setDeleting(false);
    }
  };

  // ─── Emoji handlers ───
  const pickEmoji = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setEmojiUri(asset.uri);
      setEmojiError('');
      if (!emojiName) {
        const base = (asset.fileName ?? 'emoji')
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .slice(0, 32);
        if (base.length >= 2) setEmojiName(base);
      }
    }
  };

  const handleUploadEmoji = async () => {
    if (!emojiUri || !emojiName) return;
    setEmojiUploading(true);
    setEmojiError('');
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: emojiUri,
        name: `${emojiName}.png`,
        type: 'image/png',
      } as unknown as Blob);
      formData.append('name', emojiName);
      await useServerStore.getState().uploadEmoji(serverId, formData);
      setEmojiName('');
      setEmojiUri(null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setEmojiError(typeof msg === 'string' ? msg : 'Upload failed');
    } finally {
      setEmojiUploading(false);
    }
  };

  // ─── Server settings handlers ───
  const pickServerIcon = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const name = asset.fileName ?? 'server-icon.png';
      const type = asset.mimeType ?? 'image/png';
      setServerIconAsset({ uri: asset.uri, name, type });
      setServerError('');
    }
  };

  const handleSaveServer = async () => {
    if (!activeServer) return;
    const name = serverName.trim();
    if (!name) {
      setServerError('Server name is required.');
      return;
    }
    setServerSaving(true);
    setServerError('');
    try {
      await useServerStore.getState().updateServer(serverId, {
        name,
        icon: serverIconAsset ?? undefined,
      });
      setServerIconAsset(null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setServerError(typeof msg === 'string' ? msg : 'Update failed');
    } finally {
      setServerSaving(false);
    }
  };

  // ─── Media provider handlers ───
  const handleLinkProvider = async () => {
    const name = mediaDisplayName.trim();
    if (!name) {
      setLinkError('Display name is required.');
      return;
    }
    if (mediaProviderType === 'Plex' && !mediaServerUrl.trim()) {
      setLinkError('Server URL is required for Plex.');
      return;
    }
    if (mediaProviderType === 'Plex' && !mediaAuthToken.trim()) {
      setLinkError('Auth token is required for Plex.');
      return;
    }
    setLinkError('');
    try {
      await useMediaProviderStore.getState().linkProvider(serverId, {
        providerType: mediaProviderType,
        displayName: name,
        serverUrl: mediaProviderType === 'Plex' ? mediaServerUrl.trim() : '',
        authToken: mediaProviderType === 'Plex' ? mediaAuthToken.trim() : '',
      });
      // Refresh connections list after linking
      await useMediaProviderStore.getState().fetchConnections(serverId);
      setMediaDisplayName('');
      setMediaServerUrl('');
      setMediaAuthToken('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: string } })?.response?.data;
      setLinkError(typeof msg === 'string' ? msg : 'Failed to link provider');
    }
  };

  const handleUnlinkProvider = async (connectionId: string) => {
    try {
      await useMediaProviderStore.getState().unlinkProvider(serverId, connectionId);
    } catch {
      // unlinkProvider already removes it optimistically from the store
    }
  };

  // ─── Tabs config ───
  const tabs: { key: Tab; label: string; visible: boolean }[] = [
    { key: 'server', label: 'Server', visible: canManageServer },
    { key: 'members', label: 'Members', visible: canManageAnyMembers },
    { key: 'roles', label: 'Roles', visible: canManageRoles },
    { key: 'emojis', label: 'Emojis', visible: canManageEmojis },
    { key: 'bans', label: 'Bans', visible: canBan },
    { key: 'audit', label: 'Audit Log', visible: canViewAuditLog },
    { key: 'media', label: 'Media', visible: canManageServer },
    { key: 'danger', label: 'Danger Zone', visible: isOwner },
  ];

  return (
    <Modal title="Server Settings" maxWidth={520}>
      {/* Tab bar */}
      <View style={styles.tabBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBarScroll}
          contentContainerStyle={styles.tabBarContent}
        >
          {tabs.filter((t) => t.visible).map((t) => (
            <Pressable key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
              <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* ─── Members Tab ─── */}
      {tab === 'server' && canManageServer && (
        <View>
          <Text style={styles.editorTitle}>Server Info</Text>
          <View style={styles.serverRow}>
            <Pressable style={styles.serverIconButton} onPress={pickServerIcon}>
              {(() => {
                const iconUri = serverIconAsset?.uri
                  ?? (activeServer?.iconUrl
                    ? (activeServer.iconUrl.startsWith('http') ? activeServer.iconUrl : `${getApiBase()}${activeServer.iconUrl}`)
                    : null);
                if (iconUri) {
                  return <Image source={{ uri: iconUri }} style={styles.serverIconImage} />;
                }
                return (
                  <View style={styles.serverIconFallback}>
                    <Text style={styles.serverIconText}>{(activeServer?.name || '?').charAt(0).toUpperCase()}</Text>
                  </View>
                );
              })()}
            </Pressable>
            <View style={styles.serverFields}>
              <TextInput
                style={styles.input}
                placeholder="Server name"
                placeholderTextColor={colors.textMuted}
                value={serverName}
                onChangeText={setServerName}
              />
              <Pressable style={styles.smallBtn} onPress={pickServerIcon}>
                <Text style={styles.smallBtnText}>Change Icon</Text>
              </Pressable>
            </View>
          </View>
          {serverError ? <Text style={styles.errorText}>{serverError}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              style={[styles.btnPrimary, (!serverName.trim() || serverSaving) && styles.btnDisabled]}
              onPress={handleSaveServer}
              disabled={!serverName.trim() || serverSaving}
            >
              <Text style={styles.btnPrimaryText}>{serverSaving ? 'Saving...' : 'Save'}</Text>
            </Pressable>
          </View>
        </View>
      )}
      {tab === 'members' && canManageAnyMembers && (
        <View>
          <TextInput
            style={styles.searchInput}
            placeholder="Search members..."
            placeholderTextColor={colors.textMuted}
            value={memberSearch}
            onChangeText={setMemberSearch}
          />
          {members
            .filter((m) =>
              m.user.displayName.toLowerCase().includes(memberSearch.toLowerCase()) ||
              m.user.username.toLowerCase().includes(memberSearch.toLowerCase())
            )
            .map((m) => {
              const displayColor = getDisplayColor(m);
              const highestRole = getHighestRole(m);
              const isSelf = m.userId === currentUser?.id;
              const canActOnMember = !isSelf && currentMember && canActOn(currentMember, m);
              const showManageRoles = canManageRoles && (canActOnMember || (isSelf && isOwner));
              const showKickBtn = canKick && canActOnMember;
              const showBanBtn = canBan && canActOnMember;
              const avatarUri = m.user.avatarUrl
                ? (m.user.avatarUrl.startsWith('http') ? m.user.avatarUrl : `${getApiBase()}${m.user.avatarUrl}`)
                : undefined;

              return (
                <View key={m.userId} style={styles.memberRow}>
                  <View style={styles.memberInfo}>
                    <Avatar uri={avatarUri} name={m.user.displayName} size={32} />
                    <View style={styles.memberNames}>
                      <Text style={[styles.memberName, displayColor ? { color: displayColor } : undefined]} numberOfLines={1}>
                        {m.user.displayName}
                      </Text>
                      <Text style={styles.memberUsername} numberOfLines={1}>@{m.user.username}</Text>
                    </View>
                    {m.isOwner && (
                      <View style={[styles.memberBadge, { backgroundColor: '#faa61a' }]}>
                        <Text style={[styles.memberBadgeText, { color: '#000' }]}>Owner</Text>
                      </View>
                    )}
                    {!m.isOwner && highestRole && (
                      <View style={[styles.memberBadge, { backgroundColor: highestRole.color }]}>
                        <Text style={styles.memberBadgeText}>{highestRole.name}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.memberActions}>
                    {showManageRoles && (
                      <Pressable style={styles.smallBtn} onPress={() => {
                        setRoleAssignTarget(m);
                        setSelectedRoleIds(m.roles.filter((r) => !r.isDefault).map((r) => r.id));
                      }}>
                        <Text style={styles.smallBtnText}>Roles</Text>
                      </Pressable>
                    )}
                    {showKickBtn && (
                      <Pressable style={styles.dangerSmBtn} onPress={() => useServerStore.getState().kickMember(serverId, m.userId)}>
                        <Text style={styles.dangerSmBtnText}>Kick</Text>
                      </Pressable>
                    )}
                    {showBanBtn && (
                      <Pressable style={styles.dangerSmBtn} onPress={() => {
                        Alert.prompt
                          ? Alert.prompt('Ban Reason', 'Optional reason:', (reason) => {
                              useServerStore.getState().banMember(serverId, m.userId, reason || undefined);
                            })
                          : (() => {
                              // Fallback for Android/web: simple confirm
                              Alert.alert('Ban Member', `Ban ${m.user.displayName}?`, [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Ban', style: 'destructive', onPress: () => useServerStore.getState().banMember(serverId, m.userId) },
                              ]);
                            })();
                      }}>
                        <Text style={styles.dangerSmBtnText}>Ban</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            })}

          {/* Role assignment nested modal */}
          {roleAssignTarget && (
            <RoleAssignModal
              target={roleAssignTarget}
              roles={roles}
              selectedRoleIds={selectedRoleIds}
              setSelectedRoleIds={setSelectedRoleIds}
              onSave={async () => {
                await useServerStore.getState().updateMemberRoles(serverId, roleAssignTarget.userId, selectedRoleIds);
                setRoleAssignTarget(null);
              }}
              onCancel={() => setRoleAssignTarget(null)}
            />
          )}
        </View>
      )}

      {/* ─── Roles Tab ─── */}
      {tab === 'roles' && canManageRoles && (
        <View>
          {!showEditor ? (
            <>
              <Pressable style={styles.createBtn} onPress={startCreateRole}>
                <Text style={styles.createBtnText}>+ Create Role</Text>
              </Pressable>
              {nonDefaultRoles.map((role, i) => (
                <Pressable key={role.id} style={styles.roleItem} onPress={() => startEditRole(role)}>
                  <View style={[styles.roleDot, { backgroundColor: role.color }]} />
                  <Text style={styles.roleItemName} numberOfLines={1}>{role.name}</Text>
                  <View style={styles.roleItemActions}>
                    <Pressable disabled={i === 0} onPress={() => handleMoveRole(role.id, 'up')} style={styles.moveBtn}>
                      <Text style={[styles.moveBtnText, i === 0 && styles.moveBtnDisabled]}>{'\u2191'}</Text>
                    </Pressable>
                    <Pressable disabled={i === nonDefaultRoles.length - 1} onPress={() => handleMoveRole(role.id, 'down')} style={styles.moveBtn}>
                      <Text style={[styles.moveBtnText, i === nonDefaultRoles.length - 1 && styles.moveBtnDisabled]}>{'\u2193'}</Text>
                    </Pressable>
                    <Pressable onPress={() => handleDeleteRole(role.id)} style={styles.moveBtn}>
                      <Text style={styles.deleteText}>{'\u00D7'}</Text>
                    </Pressable>
                  </View>
                </Pressable>
              ))}
              {nonDefaultRoles.length === 0 && (
                <Text style={styles.emptyText}>No custom roles yet.</Text>
              )}
            </>
          ) : (
            <View>
              <Text style={styles.editorTitle}>{creating ? 'Create Role' : `Edit: ${editingRole?.name}`}</Text>
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                value={roleName}
                onChangeText={setRoleName}
                placeholderTextColor={colors.textMuted}
              />
              <Text style={styles.label}>Color</Text>
              <View style={styles.colorRow}>
                <View style={[styles.colorSwatch, { backgroundColor: roleColor }]} />
                <TextInput
                  style={[styles.input, { flex: 1, marginBottom: 0 }]}
                  value={roleColor}
                  onChangeText={setRoleColor}
                  maxLength={7}
                  placeholderTextColor={colors.textMuted}
                />
              </View>
              <Pressable
                style={styles.toggleRow}
                onPress={() => setRoleDisplaySeparately((v) => !v)}
              >
                <View style={[styles.checkbox, roleDisplaySeparately && styles.checkboxChecked]}>
                  {roleDisplaySeparately && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                </View>
                <Text style={styles.toggleLabel}>Display members separately in the online list</Text>
              </Pressable>
              <Text style={[styles.label, { marginTop: spacing.lg }]}>Permissions</Text>
              {PERMISSION_LABELS.map(({ perm, label }) => (
                <Pressable
                  key={perm}
                  style={styles.permRow}
                  onPress={() => togglePerm(perm)}
                >
                  <View style={[styles.checkbox, (rolePerms & perm) !== 0 && styles.checkboxChecked]}>
                    {(rolePerms & perm) !== 0 && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                  </View>
                  <Text style={styles.permLabel}>{label}</Text>
                </Pressable>
              ))}
              <View style={styles.actions}>
                <Pressable style={styles.btnSecondary} onPress={() => { setEditingRole(null); setCreating(false); }}>
                  <Text style={styles.btnSecondaryText}>Back</Text>
                </Pressable>
                <Pressable
                  style={[styles.btnPrimary, !roleName.trim() && styles.btnDisabled]}
                  onPress={handleSaveRole}
                  disabled={!roleName.trim()}
                >
                  <Text style={styles.btnPrimaryText}>Save</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      )}

      {/* ─── Emojis Tab ─── */}
      {tab === 'emojis' && canManageEmojis && (
        <View>
          <Text style={styles.editorTitle}>Upload Emoji ({emojis.length} / 50)</Text>
          <View style={styles.emojiUploadRow}>
            <Pressable style={styles.emojiPickBtn} onPress={pickEmoji}>
              {emojiUri ? (
                <Image source={{ uri: emojiUri }} style={styles.emojiPreview} />
              ) : (
                <Text style={styles.emojiPickText}>Pick Image</Text>
              )}
            </Pressable>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              placeholder="emoji_name"
              placeholderTextColor={colors.textMuted}
              value={emojiName}
              onChangeText={(t) => { setEmojiName(t); setEmojiError(''); }}
              maxLength={32}
            />
            <Pressable
              style={[styles.btnPrimary, (!emojiUri || !emojiName || emojiUploading) && styles.btnDisabled]}
              onPress={handleUploadEmoji}
              disabled={!emojiUri || !emojiName || emojiUploading}
            >
              <Text style={styles.btnPrimaryText}>{emojiUploading ? 'Uploading...' : 'Upload'}</Text>
            </Pressable>
          </View>
          {emojiError ? <Text style={styles.errorText}>{emojiError}</Text> : null}

          {emojis.length === 0 && <Text style={styles.emptyText}>No custom emojis yet.</Text>}
          {emojis.map((emoji) => (
            <View key={emoji.id} style={styles.emojiItem}>
              <Image source={{ uri: `${getApiBase()}${emoji.imageUrl}` }} style={styles.emojiItemImg} />
              <Text style={styles.emojiItemName} numberOfLines={1}>:{emoji.name}:</Text>
              <Pressable onPress={() => useServerStore.getState().deleteEmoji(serverId, emoji.id)}>
                <Text style={styles.deleteText}>{'\u00D7'}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* ─── Bans Tab ─── */}
      {tab === 'bans' && canBan && (
        <View>
          {bans.length === 0 && <Text style={styles.emptyText}>No banned users.</Text>}
          {bans.map((ban) => (
            <View key={ban.id} style={styles.banItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.banUser}>{ban.user.displayName}</Text>
                <Text style={styles.banUsername}>@{ban.user.username}</Text>
                {ban.reason ? <Text style={styles.banReason}>Reason: {ban.reason}</Text> : null}
                <Text style={styles.banMeta}>
                  Banned by {ban.bannedBy.displayName} on {formatTimestamp(ban.createdAt)}
                </Text>
              </View>
              <Pressable style={styles.smallBtn} onPress={() => useServerStore.getState().unbanMember(serverId, ban.userId)}>
                <Text style={styles.smallBtnText}>Unban</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* ─── Audit Log Tab ─── */}
      {tab === 'audit' && canViewAuditLog && (
        <View>
          {logs.length === 0 && <Text style={styles.emptyText}>No audit log entries yet.</Text>}
          {logs.map((log) => (
            <View key={log.id} style={styles.auditItem}>
              <Text style={styles.auditIcon}>{ACTION_ICONS[log.action] || '?'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.auditLine}>
                  <Text style={styles.auditActor}>{log.actor.displayName}</Text>
                  {' '}
                  <Text style={styles.auditAction}>{ACTION_LABELS[log.action] || log.action}</Text>
                  {log.targetName ? <Text style={styles.auditTarget}> {log.targetName}</Text> : null}
                  {log.details ? <Text style={styles.auditExtra}> ({log.details})</Text> : null}
                </Text>
                <Text style={styles.auditTime}>{formatTimestamp(log.createdAt)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ─── Media Tab ─── */}
      {tab === 'media' && canManageServer && (
        <View>
          <Text style={styles.editorTitle}>Link Provider</Text>

          {/* Provider type picker */}
          <Text style={styles.label}>Provider Type</Text>
          <View style={styles.mediaProviderPicker}>
            {PROVIDER_TYPES.map((pt) => (
              <Pressable
                key={pt.value}
                style={[
                  styles.mediaProviderOption,
                  mediaProviderType === pt.value && styles.mediaProviderOptionActive,
                ]}
                onPress={() => {
                  setMediaProviderType(pt.value);
                  setLinkError('');
                }}
              >
                <View style={[styles.checkbox, mediaProviderType === pt.value && styles.checkboxChecked]}>
                  {mediaProviderType === pt.value && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                </View>
                <Text style={[
                  styles.mediaProviderOptionText,
                  mediaProviderType === pt.value && styles.mediaProviderOptionTextActive,
                ]}>
                  {pt.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Display name */}
          <Text style={styles.label}>Display Name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. My Plex Server"
            placeholderTextColor={colors.textMuted}
            value={mediaDisplayName}
            onChangeText={(t) => { setMediaDisplayName(t); setLinkError(''); }}
          />

          {/* Plex-only fields */}
          {mediaProviderType === 'Plex' && (
            <>
              <Text style={styles.label}>Server URL</Text>
              <TextInput
                style={styles.input}
                placeholder="http://192.168.1.100:32400"
                placeholderTextColor={colors.textMuted}
                value={mediaServerUrl}
                onChangeText={(t) => { setMediaServerUrl(t); setLinkError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.label}>Auth Token</Text>
              <TextInput
                style={styles.input}
                placeholder="Plex auth token"
                placeholderTextColor={colors.textMuted}
                value={mediaAuthToken}
                onChangeText={(t) => { setMediaAuthToken(t); setLinkError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
            </>
          )}

          {linkError ? <Text style={styles.errorText}>{linkError}</Text> : null}

          <View style={styles.actions}>
            <Pressable
              style={[styles.btnPrimary, (!mediaDisplayName.trim() || isProviderLoading) && styles.btnDisabled]}
              onPress={handleLinkProvider}
              disabled={!mediaDisplayName.trim() || isProviderLoading}
            >
              <Text style={styles.btnPrimaryText}>{isProviderLoading ? 'Linking...' : 'Link'}</Text>
            </Pressable>
          </View>

          {/* Existing connections */}
          <Text style={[styles.editorTitle, { marginTop: spacing.xl }]}>Linked Providers</Text>
          {connections.length === 0 && (
            <Text style={styles.emptyText}>No media providers linked yet.</Text>
          )}
          {connections.map((conn: MediaProviderConnection) => (
            <View key={conn.id} style={styles.mediaConnectionItem}>
              <View style={{ flex: 1 }}>
                <View style={styles.mediaConnectionHeader}>
                  <View style={[styles.mediaProviderBadge, { backgroundColor: conn.providerType === 'Plex' ? '#e5a00d' : '#ff0000' }]}>
                    <Text style={styles.mediaProviderBadgeText}>{PROVIDER_LABELS[conn.providerType] ?? conn.providerType}</Text>
                  </View>
                  <Text style={styles.mediaConnectionName} numberOfLines={1}>{conn.displayName}</Text>
                </View>
                <Text style={styles.mediaConnectionMeta}>
                  Linked {formatTimestamp(conn.linkedAt)}
                </Text>
              </View>
              <Pressable style={styles.dangerSmBtn} onPress={() => handleUnlinkProvider(conn.id)}>
                <Text style={styles.dangerSmBtnText}>Unlink</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* ─── Danger Zone Tab ─── */}
      {tab === 'danger' && isOwner && (
        <View>
          <Text style={styles.dangerWarning}>
            Deleting a server is permanent and cannot be undone. All channels, messages, and members will be lost.
          </Text>
          <Text style={styles.label}>
            Type <Text style={{ fontWeight: '700', color: colors.headerPrimary }}>{activeServer?.name}</Text> to confirm
          </Text>
          <TextInput
            style={styles.input}
            value={confirmName}
            onChangeText={setConfirmName}
            placeholder="Server name"
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            style={[styles.dangerBtn, (confirmName !== activeServer?.name || deleting) && styles.btnDisabled]}
            onPress={handleDelete}
            disabled={confirmName !== activeServer?.name || deleting}
          >
            <Text style={styles.dangerBtnText}>{deleting ? 'Deleting...' : 'Delete Server'}</Text>
          </Pressable>
        </View>
      )}

      {/* Close */}
      <View style={styles.actions}>
        <Pressable style={styles.btnSecondary} onPress={closeModal}>
          <Text style={styles.btnSecondaryText}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// ─── Role Assignment Sub-Modal ───
function RoleAssignModal({ target, roles, selectedRoleIds, setSelectedRoleIds, onSave, onCancel }: {
  target: ServerMember;
  roles: ServerRole[];
  selectedRoleIds: string[];
  setSelectedRoleIds: (ids: string[]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const nonDefault = [...roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);

  return (
    <Modal title={`Manage Roles \u2014 ${target.user.displayName}`} onClose={onCancel} maxWidth={380}>
      {nonDefault.length === 0 && <Text style={styles.emptyText}>No roles created yet.</Text>}
      {nonDefault.map((role) => {
        const checked = selectedRoleIds.includes(role.id);
        return (
          <Pressable
            key={role.id}
            style={styles.roleAssignRow}
            onPress={() => {
              if (checked) {
                setSelectedRoleIds(selectedRoleIds.filter((id) => id !== role.id));
              } else {
                setSelectedRoleIds([...selectedRoleIds, role.id]);
              }
            }}
          >
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
              {checked && <Text style={styles.checkmark}>{'\u2713'}</Text>}
            </View>
            <View style={[styles.roleDot, { backgroundColor: role.color }]} />
            <Text style={styles.roleAssignName}>{role.name}</Text>
          </Pressable>
        );
      })}
      <View style={styles.actions}>
        <Pressable style={styles.btnSecondary} onPress={onCancel}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.btnPrimary} onPress={onSave}>
          <Text style={styles.btnPrimaryText}>Save</Text>
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
    minWidth: 96,
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
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  input: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  } as TextStyle,
  searchInput: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  } as TextStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  } as TextStyle,
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  } as TextStyle,
  editorTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginBottom: spacing.md,
  } as TextStyle,
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

  // Server tab
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  } as ViewStyle,
  serverIconButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  } as ViewStyle,
  serverIconImage: {
    width: 72,
    height: 72,
    borderRadius: 36,
  } as ImageStyle,
  serverIconFallback: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.bgModifierActive,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  serverIconText: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: '700',
  } as TextStyle,
  serverFields: {
    flex: 1,
    gap: spacing.sm,
  } as ViewStyle,

  // Members
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  memberInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: spacing.sm,
    marginRight: spacing.sm,
  } as ViewStyle,
  memberNames: {
    flex: 1,
  } as ViewStyle,
  memberName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  memberUsername: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
  memberBadge: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  } as ViewStyle,
  memberBadgeText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
  memberActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  } as ViewStyle,
  smallBtn: {
    backgroundColor: colors.bgModifierActive,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  smallBtnText: {
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
  dangerSmBtn: {
    backgroundColor: colors.danger,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  dangerSmBtnText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,

  // Roles
  createBtn: {
    backgroundColor: colors.bgModifierActive,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  } as ViewStyle,
  createBtnText: {
    color: colors.headerPrimary,
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  roleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
    gap: spacing.sm,
  } as ViewStyle,
  roleDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  } as ViewStyle,
  roleItemName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    flex: 1,
  } as TextStyle,
  roleItemActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  } as ViewStyle,
  moveBtn: {
    width: 28,
    height: 28,
    borderRadius: 4,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  moveBtnText: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
  } as TextStyle,
  moveBtnDisabled: {
    color: colors.textMuted,
  } as TextStyle,
  deleteText: {
    color: colors.danger,
    fontSize: fontSize.lg,
    fontWeight: '700',
  } as TextStyle,
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,
  colorSwatch: {
    width: 32,
    height: 32,
    borderRadius: borderRadius.sm,
  } as ViewStyle,
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.md,
  } as ViewStyle,
  toggleLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
  } as TextStyle,
  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  checkboxChecked: {
    backgroundColor: colors.bgAccent,
    borderColor: colors.bgAccent,
  } as ViewStyle,
  checkmark: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,
  permLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
  } as TextStyle,

  // Role assign
  roleAssignRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  roleAssignName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
  } as TextStyle,

  // Emojis
  emojiUploadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,
  emojiPickBtn: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  } as ViewStyle,
  emojiPickText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textAlign: 'center',
  } as TextStyle,
  emojiPreview: {
    width: 48,
    height: 48,
  } as ImageStyle,
  emojiItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  emojiItemImg: {
    width: 28,
    height: 28,
  } as ImageStyle,
  emojiItemName: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    flex: 1,
  } as TextStyle,

  // Bans
  banItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
    gap: spacing.sm,
  } as ViewStyle,
  banUser: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  banUsername: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  } as TextStyle,
  banReason: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  } as TextStyle,
  banMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  } as TextStyle,

  // Audit log
  auditItem: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  auditIcon: {
    fontSize: 18,
    width: 24,
    textAlign: 'center',
  } as TextStyle,
  auditLine: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    flexWrap: 'wrap',
  } as TextStyle,
  auditActor: {
    fontWeight: '700',
    color: colors.headerPrimary,
  } as TextStyle,
  auditAction: {
    color: colors.textSecondary,
  } as TextStyle,
  auditTarget: {
    color: colors.textPrimary,
    fontWeight: '600',
  } as TextStyle,
  auditExtra: {
    color: colors.textMuted,
  } as TextStyle,
  auditTime: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  } as TextStyle,

  // Media providers
  mediaProviderPicker: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,
  mediaProviderOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 2,
    borderColor: 'transparent',
  } as ViewStyle,
  mediaProviderOptionActive: {
    borderColor: colors.bgAccent,
  } as ViewStyle,
  mediaProviderOptionText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  mediaProviderOptionTextActive: {
    color: colors.headerPrimary,
  } as TextStyle,
  mediaConnectionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
    gap: spacing.sm,
  } as ViewStyle,
  mediaConnectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 2,
  } as ViewStyle,
  mediaConnectionName: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
    flex: 1,
  } as TextStyle,
  mediaConnectionMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  } as TextStyle,
  mediaProviderBadge: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  } as ViewStyle,
  mediaProviderBadgeText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: '700',
  } as TextStyle,

  // Danger zone
  dangerWarning: {
    color: colors.danger,
    fontSize: fontSize.md,
    marginBottom: spacing.lg,
    lineHeight: 22,
  } as TextStyle,
  dangerBtn: {
    backgroundColor: colors.danger,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
  } as ViewStyle,
  dangerBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.md,
  } as TextStyle,
});
