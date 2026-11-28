import { useState } from 'react';
import { useStudioStore, useToastStore, sortedTrackIds } from '@abyss/shared';
import type { StudioDoc, StudioTrack } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { descendants, resolveOutput } from './engine/routing';
import { recordAutomation, finishAutomation } from './automation';
import Knob from './devices/Knob';
import { bounceTrack } from './bounce';

interface Props {
  doc: StudioDoc;
  trackId: string;
  track: StudioTrack;
  editable: boolean;
  engine: StudioEngine | null;
  onAddReturn?: () => void;
}

/** I/O column at the start of a track's chain: output (master or a group), sends, bounce. */
export default function StudioRouting({ doc, trackId, track, editable, engine, onAddReturn }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const [bouncing, setBouncing] = useState(false);
  const color = track.color ?? '#5865f2';
  const ids = sortedTrackIds(doc);
  const returns = ids.filter((id) => doc.tracks[id].kind === 'return' && id !== trackId);
  const inside = track.kind === 'group' ? new Set(descendants(doc, trackId)) : new Set<string>();
  const groups = ids.filter((id) => doc.tracks[id].kind === 'group' && id !== trackId && !inside.has(id));
  const out = resolveOutput(doc, trackId);
  const canRoute = track.kind !== 'return';

  const setSend = (rid: string, db: number) => {
    if (db <= -59.5) {
      if (track.sends?.[rid] !== undefined) edit([{ t: 'del', path: ['tracks', trackId, 'sends', rid] }]);
    } else edit([{ t: 'set', path: ['tracks', trackId, 'sends', rid], value: Math.round(db * 10) / 10 }]);
  };

  const bounce = async () => {
    setBouncing(true);
    try {
      await bounceTrack(trackId);
      useToastStore.getState().addToast(`Bounced “${track.name}” to audio. The original is muted — unmute it to go back.`, 'success');
    } catch (e) {
      console.error('[studio] bounce failed', e);
      useToastStore.getState().addToast('Bounce failed.', 'error');
    } finally { setBouncing(false); }
  };

  return (
    <div className="studio-device studio-routing" style={{ ['--device-color' as string]: color }}>
      <div className="studio-device-head"><span className="studio-device-title">I/O</span></div>
      <div className="studio-routing-body">
        {canRoute && (
          <label className="studio-routing-field">
            <span>Output</span>
            <select
              className="studio-select small"
              value={out}
              disabled={!editable}
              onChange={(e) => edit([{ t: 'set', path: ['tracks', trackId, 'output'], value: e.target.value }])}
            >
              <option value="">Master</option>
              {groups.map((g) => <option key={g} value={g}>📁 {doc.tracks[g].name}</option>)}
            </select>
          </label>
        )}
        {track.kind === 'return' && <div className="studio-routing-note">Fed by other tracks' sends. Output: Master.</div>}
        {track.kind === 'group' && <div className="studio-routing-note">{inside.size ? `${inside.size} track${inside.size === 1 ? '' : 's'} inside` : 'Route tracks here with their Output.'}</div>}

        {canRoute && (
          <div className="studio-routing-sends">
            <div className="studio-routing-label">Sends</div>
            {returns.length === 0 ? (
              <div className="studio-routing-note">
                No return tracks.
                {editable && onAddReturn && <button className="studio-btn small" onClick={onAddReturn}>＋ Return</button>}
              </div>
            ) : (
              <div className="studio-routing-knobs">
                {returns.map((rid) => (
                  <Knob
                    key={rid}
                    label={doc.tracks[rid].name}
                    value={track.sends?.[rid] ?? -60}
                    min={-60} max={6} def={-60} unit="dB"
                    color={doc.tracks[rid].color ?? color}
                    size={34}
                    disabled={!editable}
                    onPreview={(v) => { engine?.previewSend(trackId, rid, v); recordAutomation(trackId, `send:${rid}`, v); }}
                    onCommit={(v) => { if (!finishAutomation(trackId, `send:${rid}`)) setSend(rid, v); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {editable && (track.kind === 'audio' || track.kind === 'instrument') && (
          <button className="studio-btn small" disabled={bouncing} onClick={() => void bounce()} title="Freeze: render this track through its devices to audio (adds a new audio track, mutes this one)">
            {bouncing ? 'Rendering…' : '❄ Bounce to audio'}
          </button>
        )}
      </div>
    </div>
  );
}
