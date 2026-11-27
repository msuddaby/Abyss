import { useState } from 'react';
import { useStudioStore } from '@abyss/shared';
import type { StudioTrack } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { INSTRUMENT_LABELS } from './engine/instruments';
import CommitSlider from './CommitSlider';

interface Props {
  trackId: string;
  track: StudioTrack;
  engine: StudioEngine | null;
  editable: boolean;
  selected: boolean;
  armed: boolean;
  levelDb: number;
  onSelect: () => void;
  onArm: () => void;
  onDelete: () => void;
}

/** Meter: −60 dB … +6 dB mapped to 0…100% */
function levelPct(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(100, ((db + 60) / 66) * 100));
}

export default function StudioTrackHeader({ trackId, track, engine, editable, selected, armed, levelDb, onSelect, onArm, onDelete }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(track.name);

  const set = (field: keyof StudioTrack, value: unknown) =>
    edit([{ t: 'set', path: ['tracks', trackId, field], value }]);

  const commitName = () => {
    setRenaming(false);
    const trimmed = name.trim().slice(0, 40);
    if (trimmed && trimmed !== track.name) set('name', trimmed);
    else setName(track.name);
  };

  return (
    <div
      className={`studio-track-header${selected ? ' selected' : ''}`}
      style={{ ['--track-color' as string]: track.color ?? '#5865f2' }}
      onPointerDown={onSelect}
    >
      <div className="studio-track-color" />
      <div className="studio-track-main">
        <div className="studio-track-title-row">
          <span className="studio-track-kind" title={track.kind === 'audio' ? 'Audio track' : INSTRUMENT_LABELS[track.instrument?.type ?? 'synth']}>
            {track.kind === 'audio' ? '🎙️' : track.instrument?.type === 'drums' ? '🥁' : '🎹'}
          </span>
          {renaming ? (
            <input
              className="studio-track-name-input"
              value={name}
              autoFocus
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') { setName(track.name); setRenaming(false); }
              }}
            />
          ) : (
            <span
              className="studio-track-name"
              title={editable ? 'Double-click to rename' : track.name}
              onDoubleClick={() => { if (editable) { setName(track.name); setRenaming(true); } }}
            >
              {track.name}
            </span>
          )}
          {editable && (
            <button className="studio-icon-btn studio-track-delete" title="Delete track" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
              ✕
            </button>
          )}
        </div>
        <div className="studio-track-buttons">
          <button
            className={`studio-toggle mute${track.mute ? ' on' : ''}`}
            title="Mute"
            disabled={!editable}
            onClick={() => set('mute', !track.mute)}
          >M</button>
          <button
            className={`studio-toggle solo${track.solo ? ' on' : ''}`}
            title="Solo"
            disabled={!editable}
            onClick={() => set('solo', !track.solo)}
          >S</button>
          {track.kind === 'audio' && (
            <button
              className={`studio-toggle arm${armed ? ' on' : ''}`}
              title="Arm for recording"
              disabled={!editable}
              onClick={onArm}
            >●</button>
          )}
          <div className="studio-track-meter" title={Number.isFinite(levelDb) ? `${levelDb.toFixed(1)} dB` : 'Silent'}>
            <div className="studio-track-meter-fill" style={{ width: `${levelPct(levelDb)}%` }} />
          </div>
        </div>
        <div className="studio-track-sliders">
          <CommitSlider
            className="studio-slider volume"
            title={`Volume ${track.volume.toFixed(1)} dB (double-click to reset)`}
            min={-60} max={6} step={0.5}
            value={track.volume}
            resetValue={0}
            disabled={!editable}
            onPreview={(v) => engine?.previewTrackVolume(trackId, v)}
            onCommit={(v) => set('volume', v)}
          />
          <CommitSlider
            className="studio-slider pan"
            title={`Pan ${track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`} (double-click to center)`}
            min={-1} max={1} step={0.02}
            value={track.pan}
            resetValue={0}
            disabled={!editable}
            onPreview={(v) => engine?.previewTrackPan(trackId, v)}
            onCommit={(v) => set('pan', v)}
          />
        </div>
      </div>
    </div>
  );
}
