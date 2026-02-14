import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, Permission } from '@abyss/shared';
import type { ServerRole } from '@abyss/shared';
import { useServerStore } from '@abyss/shared';
import { isMobile } from '../stores/mobileStore';

type OverrideEntry = { allow: number; deny: number };

const CHANNEL_PERM_SECTIONS = [
  {
    section: 'General',
    perms: [
      { key: 'ViewChannel', label: 'View Channel', desc: 'See this channel in the channel list', value: Permission.ViewChannel },
    ],
  },
  {
    section: 'Text',
    perms: [
      { key: 'ReadMessageHistory', label: 'Read Message History', desc: 'Read previous messages', value: Permission.ReadMessageHistory },
      { key: 'SendMessages', label: 'Send Messages', desc: 'Send messages in this channel', value: Permission.SendMessages },
      { key: 'AddReactions', label: 'Add Reactions', desc: 'React to messages', value: Permission.AddReactions },
      { key: 'AttachFiles', label: 'Attach Files', desc: 'Upload files and images', value: Permission.AttachFiles },
      { key: 'MentionEveryone', label: 'Mention @everyone', desc: 'Use @everyone and @here', value: Permission.MentionEveryone },
    ],
  },
  {
    section: 'Voice',
    perms: [
      { key: 'Connect', label: 'Connect', desc: 'Join this voice channel', value: Permission.Connect },
      { key: 'Speak', label: 'Speak', desc: 'Talk in this voice channel', value: Permission.Speak },
      { key: 'Stream', label: 'Stream', desc: 'Share screen in this channel', value: Permission.Stream },
    ],
  },
  {
    section: 'Watch Together',
    perms: [
      { key: 'AddToWatchTogether', label: 'Add to Queue', desc: 'Add items to the Watch Together queue', value: Permission.AddToWatchTogether },
      { key: 'ModerateWatchTogether', label: 'Moderate Watch Together', desc: 'Pause, stop, skip, and reorder queue', value: Permission.ModerateWatchTogether },
    ],
  },
];

export default function ChannelPermissionsModal({
  serverId,
  channelId,
  channelName,
  onClose,
}: {
  serverId: string;
  channelId: string;
  channelName: string;
  onClose: () => void;
}) {
  const roles = useServerStore((s) => s.roles);
  const [overrides, setOverrides] = useState<Record<string, OverrideEntry>>({});
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileShowContent, setMobileShowContent] = useState(false);

  const sortedRoles = useMemo<ServerRole[]>(() => {
    return [...roles].sort((a, b) => (b.position - a.position));
  }, [roles]);

  useEffect(() => {
    const defaultRole = sortedRoles.find((r) => r.isDefault) ?? sortedRoles[0];
    setSelectedRoleId(defaultRole?.id ?? null);
  }, [sortedRoles]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/servers/${serverId}/channels/${channelId}/permissions`)
      .then((res) => {
        if (cancelled) return;
        const next: Record<string, OverrideEntry> = {};
        for (const ov of res.data.overrides ?? []) {
          next[ov.roleId] = { allow: ov.allow ?? 0, deny: ov.deny ?? 0 };
        }
        setOverrides(next);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.response?.data || 'Failed to load permissions.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [serverId, channelId]);

  const current = selectedRoleId ? overrides[selectedRoleId] ?? { allow: 0, deny: 0 } : { allow: 0, deny: 0 };

  const updateOverride = (roleId: string, next: OverrideEntry) => {
    setOverrides((prev) => ({ ...prev, [roleId]: next }));
  };

  const toggleAllow = (perm: number) => {
    if (!selectedRoleId) return;
    const entry = { ...current };
    const hasAllow = (entry.allow & perm) === perm;
    if (hasAllow) {
      entry.allow &= ~perm;
    } else {
      entry.allow |= perm;
      entry.deny &= ~perm;
    }
    updateOverride(selectedRoleId, entry);
  };

  const toggleDeny = (perm: number) => {
    if (!selectedRoleId) return;
    const entry = { ...current };
    const hasDeny = (entry.deny & perm) === perm;
    if (hasDeny) {
      entry.deny &= ~perm;
    } else {
      entry.deny |= perm;
      entry.allow &= ~perm;
    }
    updateOverride(selectedRoleId, entry);
  };

  const clearOverrides = () => {
    if (!selectedRoleId) return;
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[selectedRoleId];
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = Object.entries(overrides)
        .map(([roleId, entry]) => ({ roleId, allow: entry.allow || 0, deny: entry.deny || 0 }))
        .filter((entry) => entry.allow !== 0 || entry.deny !== 0);
      await api.put(`/servers/${serverId}/channels/${channelId}/permissions`, { overrides: payload });
      onClose();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to save permissions.');
    } finally {
      setSaving(false);
    }
  };

  const selectedRole = sortedRoles.find((r) => r.id === selectedRoleId);
  const hasOverrides = selectedRoleId ? ((current.allow !== 0) || (current.deny !== 0)) : false;

  const handleRoleSelect = (roleId: string) => {
    setSelectedRoleId(roleId);
    if (isMobile()) setMobileShowContent(true);
  };

  const handleMobileBack = () => {
    setMobileShowContent(false);
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal permissions-modal${mobileShowContent ? ' perms-mobile-content' : ''}`} onClick={(e) => e.stopPropagation()}>
        <h2>Channel Permissions</h2>
        <div className="permissions-channel-name">#{channelName}</div>
        {error && <div className="auth-error">{error}</div>}
        <div className="permissions-layout">
          <div className="permissions-role-sidebar">
            <div className="permissions-role-sidebar-label">Roles</div>
            {sortedRoles.map((r) => {
              const isSelected = r.id === selectedRoleId;
              const roleHasOverride = overrides[r.id] && (overrides[r.id].allow !== 0 || overrides[r.id].deny !== 0);
              return (
                <button
                  key={r.id}
                  className={`permissions-role-item${isSelected ? ' active' : ''}`}
                  onClick={() => handleRoleSelect(r.id)}
                >
                  <span className="permissions-role-dot" style={{ background: r.isDefault ? 'var(--text-muted)' : r.color }} />
                  <span className="permissions-role-name">{r.isDefault ? '@everyone' : r.name}</span>
                  {roleHasOverride && <span className="permissions-role-badge" />}
                </button>
              );
            })}
          </div>

          <div className="permissions-content">
            {selectedRole && (
              <div className="permissions-content-header">
                <button className="permissions-back" onClick={handleMobileBack}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                  </svg>
                </button>
                <span className="permissions-editing-role" style={{ color: selectedRole.isDefault ? 'var(--text-secondary)' : selectedRole.color }}>
                  {selectedRole.isDefault ? '@everyone' : selectedRole.name}
                </span>
                {hasOverrides && (
                  <button className="permissions-reset-btn" onClick={clearOverrides}>Reset Overrides</button>
                )}
              </div>
            )}

            {loading ? (
              <div className="permissions-loading">Loading...</div>
            ) : (
              <div className="permissions-perm-list">
                {CHANNEL_PERM_SECTIONS.map(({ section, perms }) => (
                  <div key={section} className="permissions-perm-section">
                    <div className="permissions-section-label">{section}</div>
                    {perms.map((perm) => {
                      const allowed = (current.allow & perm.value) === perm.value;
                      const denied = (current.deny & perm.value) === perm.value;
                      return (
                        <div key={perm.key} className="permissions-perm-row">
                          <div className="permissions-perm-info">
                            <span className="permissions-perm-name">{perm.label}</span>
                            <span className="permissions-perm-desc">{perm.desc}</span>
                          </div>
                          <div className="permissions-tri-toggle">
                            <button
                              className={`tri-btn tri-deny${denied ? ' active' : ''}`}
                              onClick={() => toggleDeny(perm.value)}
                              title="Deny"
                            >&times;</button>
                            <button
                              className={`tri-btn tri-inherit${!allowed && !denied ? ' active' : ''}`}
                              onClick={() => { if (allowed) toggleAllow(perm.value); if (denied) toggleDeny(perm.value); }}
                              title="Inherit"
                            >/</button>
                            <button
                              className={`tri-btn tri-allow${allowed ? ' active' : ''}`}
                              onClick={() => toggleAllow(perm.value)}
                              title="Allow"
                            >&#10003;</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
