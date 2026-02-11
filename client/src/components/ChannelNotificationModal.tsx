import { useState } from 'react';
import { useNotificationSettingsStore, useServerStore, NotificationLevel, getNotificationLevelName } from '@abyss/shared';

interface Props {
  serverId: string;
  channelId: string;
  channelName: string;
  onClose: () => void;
}

const MUTE_OPTIONS = [
  { label: '15 minutes', ms: 15 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: 'Until I turn it back on', ms: 100 * 365 * 24 * 60 * 60 * 1000 },
];

export default function ChannelNotificationModal({ serverId, channelId, channelName, onClose }: Props) {
  const { channelSettings, updateChannelSettings } = useNotificationSettingsStore();
  const server = useServerStore((s) => s.servers.find((sv) => sv.id === serverId));
  const setting = channelSettings.get(channelId);

  const [level, setLevel] = useState<number | null>(setting?.notificationLevel ?? null);
  const [saving, setSaving] = useState(false);

  const isMuted = setting?.muteUntil ? new Date(setting.muteUntil) > new Date() : false;

  const handleMute = async (ms: number | null) => {
    setSaving(true);
    const muteUntil = ms ? new Date(Date.now() + ms).toISOString() : new Date(0).toISOString();
    await updateChannelSettings(serverId, channelId, { muteUntil });
    setSaving(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await updateChannelSettings(serverId, channelId, { notificationLevel: level });
    setSaving(false);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal user-settings-modal notification-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="us-content" style={{ flex: 1 }}>
          <div className="us-content-header">
            <h2>Notification Settings — #{channelName}</h2>
            <button className="us-close" onClick={onClose}>&times;</button>
          </div>
          <div className="us-content-body">
            <div className="us-card">
              <div className="us-card-title">Mute Channel</div>
              <div className="notif-mute-row">
                {isMuted ? (
                  <button className="btn-secondary notif-unmute-btn" onClick={() => handleMute(null)} disabled={saving}>
                    Unmute
                  </button>
                ) : (
                  <select
                    className="settings-select"
                    value=""
                    onChange={(e) => {
                      const opt = MUTE_OPTIONS.find((o) => String(o.ms) === e.target.value);
                      if (opt?.ms) handleMute(opt.ms);
                    }}
                    disabled={saving}
                  >
                    <option value="" disabled>Mute for...</option>
                    {MUTE_OPTIONS.map((o) => (
                      <option key={o.label} value={String(o.ms)}>{o.label}</option>
                    ))}
                  </select>
                )}
                {isMuted && <span className="notif-muted-badge">Muted</span>}
              </div>
            </div>

            <div className="us-card">
              <div className="us-card-title">Notification Level</div>
              <div className="settings-help" style={{ marginTop: 0 }}>
                Server default: {getNotificationLevelName(server?.defaultNotificationLevel ?? 0)}
              </div>
              <div className="notif-level-options">
                {[
                  { value: null, label: 'Use server default' },
                  { value: NotificationLevel.AllMessages, label: 'All Messages' },
                  { value: NotificationLevel.OnlyMentions, label: 'Only Mentions' },
                  { value: NotificationLevel.Nothing, label: 'Nothing' },
                ].map((opt) => (
                  <label key={String(opt.value)} className="notif-radio">
                    <input
                      type="radio"
                      name="level"
                      checked={level === opt.value}
                      onChange={() => setLevel(opt.value)}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="us-card-actions">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
