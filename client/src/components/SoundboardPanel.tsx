import { useEffect, useMemo, useState } from 'react';
import { useSoundboardStore, useVoiceStore, resilientInvoke } from '@abyss/shared';
import { captureKeybindFromEvent, formatKeybind } from '../utils/keybind';

interface ClipMenu {
  clipId: string;
  x: number;
  y: number;
}

export default function SoundboardPanel() {
  const clips = useSoundboardStore((s) => s.clips);
  const clipKeybinds = useSoundboardStore((s) => s.clipKeybinds);
  const setClipKeybind = useSoundboardStore((s) => s.setClipKeybind);
  const clearClipKeybind = useSoundboardStore((s) => s.clearClipKeybind);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const [query, setQuery] = useState('');
  const [capturingClipId, setCapturingClipId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ClipMenu | null>(null);

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
    // Capture phase + stopPropagation, so the keypress never reaches the app's
    // own shortcuts while we're recording. That means Escape has to be handled
    // here too — a separate bubble-phase listener would never see it.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturingClipId(null);
        return;
      }
      const bind = captureKeybindFromEvent(e);
      if (!bind) return;
      setClipKeybind(capturingClipId, bind);
      setCapturingClipId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturingClipId, setClipKeybind]);

  // Dismiss the right-click menu on outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    document.addEventListener('keydown', onEsc);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menu]);

  if (clips.length === 0) {
    return (
      <div className="soundboard-panel">
        <div className="soundboard-empty">No soundboard clips yet</div>
      </div>
    );
  }

  const menuClip = menu ? clips.find((c) => c.id === menu.clipId) : null;
  const menuBind = menuClip ? clipKeybinds[menuClip.id] : undefined;

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
            <button
              key={clip.id}
              className={`soundboard-clip-btn${bind ? ' has-keybind' : ''}${isCapturing ? ' recording' : ''}`}
              onClick={() => {
                if (capturingClipId) return;
                playClip(clip.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCapturingClipId(null);
                setMenu({ clipId: clip.id, x: e.clientX, y: e.clientY });
              }}
              title={
                isCapturing
                  ? 'Press a key… (Esc to cancel)'
                  : `${clip.name} (${clip.duration.toFixed(1)}s)${bind ? ` — ${formatKeybind(bind)}` : ''} — right-click to bind`
              }
            >
              <span className="soundboard-clip-label">
                {isCapturing ? 'Press keys…' : clip.name}
              </span>
            </button>
          );
        })}
        {filteredClips.length === 0 && (
          <div className="soundboard-empty">No sounds match "{query}"</div>
        )}
      </div>
      {menu && menuClip && (
        <div
          className="soundboard-clip-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="soundboard-clip-menu-item"
            onClick={() => {
              setCapturingClipId(menuClip.id);
              setMenu(null);
            }}
          >
            {menuBind ? `Rebind Key (${formatKeybind(menuBind)})` : 'Set Keybind'}
          </button>
          {menuBind && (
            <button
              className="soundboard-clip-menu-item danger"
              onClick={() => {
                clearClipKeybind(menuClip.id);
                setMenu(null);
              }}
            >
              Clear Keybind
            </button>
          )}
        </div>
      )}
    </div>
  );
}
