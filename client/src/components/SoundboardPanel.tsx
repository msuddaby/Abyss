import { useSoundboardStore, useVoiceStore, ensureConnected } from '@abyss/shared';

export default function SoundboardPanel() {
  const clips = useSoundboardStore((s) => s.clips);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);

  const playClip = async (clipId: string) => {
    if (!currentChannelId) return;
    try {
      const conn = await ensureConnected();
      await conn.invoke('PlaySoundboardClip', currentChannelId, clipId);
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
      <div className="soundboard-header">Soundboard</div>
      <div className="soundboard-grid">
        {clips.map((clip) => (
          <button
            key={clip.id}
            className="soundboard-clip-btn"
            onClick={() => playClip(clip.id)}
            title={`${clip.name} (${clip.duration.toFixed(1)}s)`}
          >
            <span className="soundboard-clip-label">{clip.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
