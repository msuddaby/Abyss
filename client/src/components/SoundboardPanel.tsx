import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useSoundboardStore,
  useVoiceStore,
  SOUNDBOARD_FX_PRESETS,
  SOUNDBOARD_SPEED_DETENTS,
  SOUNDBOARD_PITCH_MIN,
  SOUNDBOARD_PITCH_MAX,
  effectiveFx,
  isFxNeutral,
  tapePitch,
  formatSpeed,
  formatPitch,
} from '@abyss/shared';
import type { SoundboardClip } from '@abyss/shared';
import { captureKeybindFromEvent, formatKeybind } from '../utils/keybind';

interface ClipMenu {
  clipId: string;
  x: number;
  y: number;
}

type Tab = 'all' | 'favorites' | 'recent';

// Speed slider is log-scaled so 1× sits in the middle (0.5× and 2× are each
// one octave away). Positions are 0..1000.
const SPEED_POS_MAX = 1000;
const posToSpeed = (p: number) => Math.pow(2, (p - 500) / 500);
const speedToPos = (s: number) => Math.round(500 + 500 * Math.log2(s));
const snapSpeed = (s: number) => {
  for (const d of SOUNDBOARD_SPEED_DETENTS) if (Math.abs(Math.log2(s / d)) < 0.035) return d;
  return Math.round(s * 100) / 100;
};
const pitchToPct = (p: number) => ((p - SOUNDBOARD_PITCH_MIN) / (SOUNDBOARD_PITCH_MAX - SOUNDBOARD_PITCH_MIN)) * 100;

const FX_OPEN_KEY = 'soundboardFxOpen';

function readFxOpen(): boolean {
  try {
    return localStorage.getItem(FX_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function FillTrack({ from, to }: { from: number; to: number }) {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  return (
    <div className="sb-fx-track">
      <div className="sb-fx-fill" style={{ left: `${a}%`, width: `${b - a}%` }} />
    </div>
  );
}

export default function SoundboardPanel() {
  const clips = useSoundboardStore((s) => s.clips);
  const clipKeybinds = useSoundboardStore((s) => s.clipKeybinds);
  const setClipKeybind = useSoundboardStore((s) => s.setClipKeybind);
  const clearClipKeybind = useSoundboardStore((s) => s.clearClipKeybind);
  const fx = useSoundboardStore((s) => s.fx);
  const setFx = useSoundboardStore((s) => s.setFx);
  const resetFx = useSoundboardStore((s) => s.resetFx);
  const favoriteClipIds = useSoundboardStore((s) => s.favoriteClipIds);
  const toggleFavorite = useSoundboardStore((s) => s.toggleFavorite);
  const recentClipIds = useSoundboardStore((s) => s.recentClipIds);
  const playClipInStore = useSoundboardStore((s) => s.playClip);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [fxOpen, setFxOpen] = useState(readFxOpen);
  const [capturingClipId, setCapturingClipId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ClipMenu | null>(null);
  // Local progress indicator: clipId → { startedAt, durationMs }.
  const [playing, setPlaying] = useState<Record<string, { key: number; durationMs: number }>>({});
  const playTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const { speed, pitch } = effectiveFx(fx);
  const altered = !isFxNeutral(speed, pitch);
  const favSet = useMemo(() => new Set(favoriteClipIds), [favoriteClipIds]);

  const visibleClips = useMemo(() => {
    let list: SoundboardClip[];
    if (tab === 'recent') {
      const byId = new Map(clips.map((c) => [c.id, c]));
      list = recentClipIds.map((id) => byId.get(id)).filter((c): c is SoundboardClip => !!c);
    } else {
      list = [...clips].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (tab === 'favorites') list = list.filter((c) => favSet.has(c.id));
    }
    const q = query.trim().toLowerCase();
    return q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
  }, [clips, recentClipIds, favSet, tab, query]);

  useEffect(() => {
    const timers = playTimers.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  const playClip = async (clip: SoundboardClip, original = false) => {
    if (!currentChannelId) return;
    const rate = original ? 1 : speed;
    const durationMs = (clip.duration / rate) * 1000;
    clearTimeout(playTimers.current[clip.id]);
    setPlaying((p) => ({ ...p, [clip.id]: { key: Date.now(), durationMs } }));
    playTimers.current[clip.id] = setTimeout(() => {
      setPlaying((p) => {
        const next = { ...p };
        delete next[clip.id];
        return next;
      });
    }, durationMs);
    try {
      await playClipInStore(currentChannelId, clip.id, { original });
    } catch (err) {
      console.warn('Failed to play soundboard clip', err);
    }
  };

  const toggleFxOpen = () => {
    const next = !fxOpen;
    setFxOpen(next);
    try {
      localStorage.setItem(FX_OPEN_KEY, next ? '1' : '0');
    } catch {
      // Ignore storage errors
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
  const speedPos = speedToPos(speed);
  const emptyText =
    query.trim()
      ? `No sounds match "${query}"`
      : tab === 'favorites'
        ? 'Right-click a sound or use ★ to favorite it'
        : tab === 'recent'
          ? 'Sounds you play show up here'
          : 'No sounds';

  return (
    <div className="soundboard-panel">
      <div className="soundboard-header-row">
        <div className="soundboard-header">Soundboard</div>
        <div className="soundboard-count">{clips.length}</div>
        <div className="soundboard-header-spacer" />
        <button
          type="button"
          className={`sb-fx-chip${altered ? ' altered' : ''}${fxOpen ? ' open' : ''}`}
          onClick={toggleFxOpen}
          aria-expanded={fxOpen}
          title="Speed and pitch for sounds you play"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 2v12M8 2v12M13 2v12" />
            <circle cx="3" cy="10" r="1.6" fill="currentColor" />
            <circle cx="8" cy="5" r="1.6" fill="currentColor" />
            <circle cx="13" cy="9" r="1.6" fill="currentColor" />
          </svg>
          <span>{formatSpeed(speed)} · {formatPitch(pitch)}</span>
        </button>
      </div>

      {fxOpen && (
        <div className="sb-fx">
          <div className="sb-fx-row">
            <div className="sb-fx-label">
              <label htmlFor="sb-fx-speed">Speed</label>
              <output className={speed === 1 ? 'off' : ''}>{formatSpeed(speed)}</output>
            </div>
            <div className="sb-fx-range">
              <FillTrack from={50} to={speedPos / 10} />
              <input
                id="sb-fx-speed"
                type="range"
                min={0}
                max={SPEED_POS_MAX}
                step={1}
                value={speedPos}
                onChange={(e) => setFx({ speed: snapSpeed(posToSpeed(Number(e.target.value))) })}
                onDoubleClick={() => setFx({ speed: 1 })}
              />
            </div>
            <div className="sb-fx-scale"><span>0.5×</span><span>1×</span><span>2×</span></div>
          </div>

          <div className={`sb-fx-row${fx.tape ? ' disabled' : ''}`}>
            <div className="sb-fx-label">
              <label htmlFor="sb-fx-pitch">Pitch</label>
              <output className={Math.round(pitch) === 0 ? 'off' : ''}>
                {formatPitch(pitch)}{fx.tape ? ' (tape)' : ''}
              </output>
            </div>
            <div className="sb-fx-range">
              <FillTrack from={50} to={pitchToPct(pitch)} />
              <input
                id="sb-fx-pitch"
                type="range"
                min={SOUNDBOARD_PITCH_MIN}
                max={SOUNDBOARD_PITCH_MAX}
                step={1}
                value={Math.round(pitch)}
                disabled={fx.tape}
                onChange={(e) => setFx({ pitch: Number(e.target.value) })}
                onDoubleClick={() => setFx({ pitch: 0 })}
              />
            </div>
            <div className="sb-fx-scale"><span>−12</span><span>0</span><span>+12</span></div>
          </div>

          <label className="sb-fx-toggle">
            <input
              type="checkbox"
              checked={fx.tape}
              onChange={(e) =>
                setFx(e.target.checked ? { tape: true } : { tape: false, pitch: Math.round(tapePitch(speed)) })
              }
            />
            <span className="sb-fx-switch" aria-hidden="true" />
            <span>
              Tape mode
              <small>Pitch follows speed, like a record. Turn off to change them separately.</small>
            </span>
          </label>

          <div className="sb-fx-presets">
            {SOUNDBOARD_FX_PRESETS.map((p) => {
              const on = !fx.tape && fx.speed === p.speed && fx.pitch === p.pitch;
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`sb-fx-preset${on ? ' on' : ''}`}
                  onClick={() => setFx({ speed: p.speed, pitch: p.pitch, tape: false })}
                >
                  {p.name}
                </button>
              );
            })}
          </div>

          <div className="sb-fx-foot">
            <span>Everyone in the call hears this</span>
            <button type="button" onClick={resetFx} disabled={!altered && !fx.tape}>Reset</button>
          </div>
        </div>
      )}

      <div className="sb-tools">
        <div className="sb-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'all'} className="sb-tab" onClick={() => setTab('all')}>All</button>
          <button type="button" role="tab" aria-selected={tab === 'favorites'} className="sb-tab" onClick={() => setTab('favorites')} title="Favorites">★</button>
          <button type="button" role="tab" aria-selected={tab === 'recent'} className="sb-tab" onClick={() => setTab('recent')}>Recent</button>
        </div>
        <input
          type="text"
          className="soundboard-search"
          placeholder="Search"
          aria-label="Search sounds"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="soundboard-grid">
        {visibleClips.map((clip) => {
          const bind = clipKeybinds[clip.id];
          const isCapturing = capturingClipId === clip.id;
          const isFav = favSet.has(clip.id);
          const play = playing[clip.id];
          return (
            <div
              key={clip.id}
              role="button"
              tabIndex={0}
              className={`soundboard-clip-btn${isCapturing ? ' recording' : ''}${play ? ' playing' : ''}`}
              onClick={(e) => {
                if (capturingClipId) return;
                playClip(clip, e.shiftKey);
              }}
              onKeyDown={(e) => {
                if (capturingClipId) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  playClip(clip, e.shiftKey);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCapturingClipId(null);
                setMenu({ clipId: clip.id, x: e.clientX, y: e.clientY });
              }}
              title={
                isCapturing
                  ? 'Press a key… (Esc to cancel)'
                  : `${clip.name} (${clip.duration.toFixed(1)}s)${bind ? ` — ${formatKeybind(bind)}` : ''}\nShift-click plays the original · right-click for options`
              }
            >
              {play && (
                <span
                  key={play.key}
                  className="soundboard-clip-progress"
                  style={{ animationDuration: `${play.durationMs}ms` }}
                />
              )}
              <span className="soundboard-clip-label">
                {isCapturing ? 'Press keys…' : clip.name}
              </span>
              <span className="soundboard-clip-meta">
                <span className={speed !== 1 ? 'shifted' : ''}>{(clip.duration / speed).toFixed(1)}s</span>
                {bind && <span className="soundboard-clip-kb">{formatKeybind(bind)}</span>}
              </span>
              <button
                type="button"
                className={`soundboard-clip-star${isFav ? ' on' : ''}`}
                aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(clip.id);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1.5l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.1l-3.9 2.2.9-4.3-3.2-3 4.3-.5z" />
                </svg>
              </button>
            </div>
          );
        })}
        {visibleClips.length === 0 && <div className="soundboard-empty">{emptyText}</div>}
      </div>

      {menu && menuClip && (
        <div
          className="soundboard-clip-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {altered && (
            <button
              className="soundboard-clip-menu-item"
              onClick={() => {
                playClip(menuClip, true);
                setMenu(null);
              }}
            >
              Play Original
            </button>
          )}
          <button
            className="soundboard-clip-menu-item"
            onClick={() => {
              toggleFavorite(menuClip.id);
              setMenu(null);
            }}
          >
            {favSet.has(menuClip.id) ? 'Remove Favorite' : 'Add Favorite'}
          </button>
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
