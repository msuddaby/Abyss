import { useStudioStore, tempoMap, bpmAt } from '@abyss/shared';
import type { StudioClip, StudioDoc, StudioOp } from '@abyss/shared';
import { clipSrcSeconds, clipBeatsForSrc } from './engine/routing';
import { MIN_CLIP_BEATS } from './studioUtils';

interface Props {
  doc: StudioDoc;
  clipId: string;
  clip: StudioClip;
  editable: boolean;
}

/** Selected clip's settings: active/muted, gain, and for audio warp / transpose / reverse. */
export default function StudioClipProps({ doc, clipId, clip, editable }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const audio = clip.kind === 'audio';

  /** Apply a change, keeping the same stretch of source audio under the clip. */
  const change = (patch: Partial<StudioClip>) => {
    const next: StudioClip = { ...clip, ...patch };
    const ops: StudioOp[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === false || (k === 'pitch' && v === 0)) ops.push({ t: 'del', path: ['clips', clipId, k] });
      else ops.push({ t: 'set', path: ['clips', clipId, k], value: v });
    }
    if (audio && ('warp' in patch || 'srcBpm' in patch || ('pitch' in patch && !clip.warp))) {
      const src = clipSrcSeconds(doc, clip, 0, clip.length);
      const len = Math.max(MIN_CLIP_BEATS, Math.round(clipBeatsForSrc(doc, next, 0, src) * 1e4) / 1e4);
      if (Math.abs(len - clip.length) > 1e-4) ops.push({ t: 'set', path: ['clips', clipId, 'length'], value: len });
    }
    // Reverse reads the source from the other end; deleting false/0 fields keeps the doc tidy.
    edit(ops.filter((o) => o.t === 'set' || (clip as unknown as Record<string, unknown>)[o.path[2]] !== undefined));
  };

  return (
    <div className="studio-clip-props">
      <span className="studio-clip-props-title">{audio ? '🎙️' : '🎹'} {clip.name || 'Clip'}</span>
      <label className="studio-check" title="Inactive clips stay in place but are silent (unused takes)">
        <input type="checkbox" checked={!clip.mute} disabled={!editable} onChange={(e) => change({ mute: !e.target.checked })} /> Active
      </label>
      <label className="studio-field small" title="Clip gain">
        Gain
        <input
          type="number" min={-60} max={24} step={0.5} disabled={!editable}
          defaultValue={clip.gain ?? 0} key={`g${clip.gain}`}
          onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== (clip.gain ?? 0)) edit([{ t: 'set', path: ['clips', clipId, 'gain'], value: Math.max(-60, Math.min(24, v)) }]); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        /> dB
      </label>
      {audio && (
        <>
          <label className="studio-check" title="Warp: follow the project tempo (time-stretch, pitch kept). The clip's own tempo is its original BPM.">
            <input
              type="checkbox" checked={!!clip.warp} disabled={!editable}
              onChange={(e) => change(e.target.checked ? { warp: true, srcBpm: clip.srcBpm ?? bpmAt(tempoMap(doc), clip.start) } : { warp: false })}
            /> Warp
          </label>
          {clip.warp && (
            <label className="studio-field small" title="The tempo this audio was recorded at">
              Orig.
              <input
                type="number" min={20} max={400} step={0.1} disabled={!editable}
                defaultValue={clip.srcBpm ?? doc.meta.bpm} key={`b${clip.srcBpm}`}
                onBlur={(e) => { const v = Math.round(Number(e.target.value) * 10) / 10; if (v >= 20 && v <= 400 && v !== clip.srcBpm) change({ srcBpm: v }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              /> BPM
            </label>
          )}
          <label className="studio-field small" title={clip.warp ? 'Transpose (length kept)' : 'Transpose (repitch: changes speed, like a turntable). Turn on Warp to keep the length.'}>
            Pitch
            <input
              type="number" min={-24} max={24} step={1} disabled={!editable}
              defaultValue={clip.pitch ?? 0} key={`p${clip.pitch}`}
              onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v >= -24 && v <= 24 && v !== (clip.pitch ?? 0)) change({ pitch: v }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            /> st
          </label>
          <button className={`studio-btn small${clip.reverse ? ' on' : ''}`} disabled={!editable} onClick={() => change({ reverse: !clip.reverse })} title="Play backwards">⇆ Reverse</button>
          {clip.warp && <span className="studio-muted small">Fades apply to un-warped clips only.</span>}
        </>
      )}
    </div>
  );
}
