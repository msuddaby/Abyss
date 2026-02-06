import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { API_BASE } from '../services/api';

export default function UserSettingsModal({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user)!;
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const updateAvatar = useAuthStore((s) => s.updateAvatar);

  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio || '');
  const [status, setStatus] = useState(user.status);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [capturingKey, setCapturingKey] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const setPttKey = useVoiceStore((s) => s.setPttKey);

  useEffect(() => {
    if (!capturingKey) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      setPttKey(e.key);
      setCapturingKey(false);
    };
    const onMouse = (e: MouseEvent) => {
      // Only capture non-primary buttons (skip left click = 0, right click = 2)
      if (e.button === 0 || e.button === 2) return;
      e.preventDefault();
      setPttKey(`Mouse${e.button}`);
      setCapturingKey(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
    };
  }, [capturingKey, setPttKey]);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (avatarFile) {
        await updateAvatar(avatarFile);
      }
      await updateProfile({ displayName, bio, status });
      onClose();
    } catch (err) {
      console.error('Failed to update profile', err);
    } finally {
      setSaving(false);
    }
  };

  const currentAvatar = avatarPreview
    || (user.avatarUrl ? (user.avatarUrl.startsWith('http') ? user.avatarUrl : `${API_BASE}${user.avatarUrl}`) : null);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal user-settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>User Settings</h2>

        <div className="settings-avatar-section">
          <div className="settings-avatar" onClick={() => fileInputRef.current?.click()}>
            {currentAvatar ? (
              <img src={currentAvatar} alt={user.displayName} />
            ) : (
              <span className="settings-avatar-letter">{user.displayName.charAt(0).toUpperCase()}</span>
            )}
            <div className="settings-avatar-overlay">Change</div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleAvatarChange}
          />
        </div>

        <label>
          Display Name
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={32}
          />
        </label>

        <label>
          Bio
          <textarea
            className="settings-textarea"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={190}
            rows={3}
            placeholder="Tell us about yourself"
          />
        </label>

        <label>
          Status
          <input
            type="text"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            maxLength={32}
          />
        </label>

        <label>
          Voice Mode
          <div className="channel-type-select">
            <button
              type="button"
              className={`type-option ${voiceMode === 'voice-activity' ? 'active' : ''}`}
              onClick={() => setVoiceMode('voice-activity')}
            >
              Voice Activity
            </button>
            <button
              type="button"
              className={`type-option ${voiceMode === 'push-to-talk' ? 'active' : ''}`}
              onClick={() => setVoiceMode('push-to-talk')}
            >
              Push to Talk
            </button>
          </div>
        </label>

        {voiceMode === 'push-to-talk' && (
          <label>
            PTT Key
            <button
              type="button"
              className={`ptt-key-capture ${capturingKey ? 'recording' : ''}`}
              onClick={() => setCapturingKey(true)}
            >
              {capturingKey ? 'Press any key or mouse button...' : pttKey.startsWith('Mouse') ? `Mouse Button ${pttKey.slice(5)}` : pttKey}
            </button>
          </label>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
