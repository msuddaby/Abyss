import { useEffect, useMemo, useState } from 'react';
import { useSoundboardStore, useVoiceStore, resilientInvoke } from '@abyss/shared';
import { captureKeybindFromEvent, formatKeybind } from '../utils/keybind';

export default function SoundboardPanel() {
  const clips = useSoundboardStore((s) => s.clips);
  const clipKeybinds = useSoundboardStore((s) => s.clipKeybinds);
  const setClipKeybind = useSoundboardStore((s) => s.setClipKeybind);
  const clearClipKeybind = useSoundboardStore((s) => s.clearClipKeybind);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const [query, setQuery] = useState('');
  const [capturingClipId, setCapturingClipId] = useState<string | null>(null);

  const filteredClips = useMemo(() => {
    const sorted = [...clips].sort((a, b) => a.name.localeCompare(b.name));
    if (!query.trim()) return sorted;
    const q = query.trim().toLowerCase();
    return sorted.filter((clip) => clip.name.toLowerCase().includes(q));
  }, [clips, query]);

  const playClip = async (clipId: string) => {
    if (!currentChannelId) return;
    try {
      await resilientInvoke('PlaySoundboardClip', currentChannelId, clipId);
    } catch (err) {
      console.warn('Failed to play soundboard clip', err);
    }
  };

  // Same capture rules as the voice keybinds (mute/deafen/disconnect):
  // bare F-keys/media-macro keys allowed, any typeable key needs a modifier.
  useEffect(() => {
    if (!capturingClipId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bind = captureKeybindFromEvent(e);
      if (!bind) return;
      setClipKeybind(capturingClipId, bind);
      setCapturingClipId(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCapturingClipId(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onEsc);
    };
  }, [capturingClipId, setClipKeybind]);

  if (clips.length === 0) {
    return (
      <div className="soundboard-panel">
        <div className="soundboard-empty">No soundboard clips yet</div>
      </div>
    );
  }

  return (
    <div className="soundboard-panel">
      <div className="soundboard-header-row">
        <div className="soundboard-header">Soundboard</div>
        <div className="soundboard-count">{clips.length}</div>
      </div>
      {clips.length > 8 && (
        <input
          type="text"
          className="soundboard-search"
          placeholder="Search sounds..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      )}
      <div className="soundboard-grid">
        {filteredClips.map((clip) => {
          const bind = clipKeybinds[clip.id];
          const isCapturing = capturingClipId === clip.id;
          return (
            <div key={clip.id} className="soundboard-clip">
              <button
                className="soundboard-clip-btn"
                onClick={() => playClip(clip.id)}
                title={`${clip.name} (${clip.duration.toFixed(1)}s)${bind ? ` — ${formatKeybind(bind)}` : ''}`}
              >
                <span className="soundboard-clip-label">{clip.name}</span>
              </button>
              <button
                type="button"
                className={`soundboard-clip-keybind${isCapturing ? ' recording' : ''}`}
                onClick={() => setCapturingClipId(isCapturing ? null : clip.id)}
                title={bind ? `Keybind: ${formatKeybind(bind)} (click to rebind)` : 'Set a keybind'}
              >
                {isCapturing ? 'Press keys…' : bind ? formatKeybind(bind) : 'Bind'}
              </button>
              {bind && !isCapturing && (
                <button
                  type="button"
                  className="soundboard-clip-keybind-clear"
                  onClick={() => clearClipKeybind(clip.id)}
                  title="Clear keybind"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {filteredClips.length === 0 && (
          <div className="soundboard-empty">No sounds match "{query}"</div>
        )}
      </div>
    </div>
  );
}
