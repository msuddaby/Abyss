import { useMemo, useState } from 'react';
import { useSoundboardStore, useVoiceStore, resilientInvoke } from '@abyss/shared';

export default function SoundboardPanel() {
  const clips = useSoundboardStore((s) => s.clips);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const [query, setQuery] = useState('');

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
        {filteredClips.map((clip) => (
          <button
            key={clip.id}
            className="soundboard-clip-btn"
            onClick={() => playClip(clip.id)}
            title={`${clip.name} (${clip.duration.toFixed(1)}s)`}
          >
            <span className="soundboard-clip-label">{clip.name}</span>
          </button>
        ))}
        {filteredClips.length === 0 && (
          <div className="soundboard-empty">No sounds match "{query}"</div>
        )}
      </div>
    </div>
  );
}
