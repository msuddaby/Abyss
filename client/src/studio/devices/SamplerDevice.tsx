import { useState } from 'react';
import { useStudioStore } from '@abyss/shared';
import type { StudioParams } from '@abyss/shared';
import type { StudioEngine } from '../engine/StudioEngine';
import { getPeaks } from '../engine/assetCache';
import { SAMPLER_DEFAULTS } from '../engine/instruments';
import { ASSET_DRAG_TYPE } from '../StudioArrange';
import { uploadAudioFiles, formatDuration } from '../studioUtils';
import Knob from './Knob';
import { useCanvasLoop } from './spectrum';

interface Props {
  trackId: string;
  params: StudioParams;
  editable: boolean;
  engine: StudioEngine | null;
  color: string;
  onCommit: (params: StudioParams) => void;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
const ROOTS = Array.from({ length: 73 }, (_, i) => 24 + i); // C1..C7

export default function SamplerDevice({ trackId, params, editable, engine, color, onCommit }: Props) {
  const assets = useStudioStore((s) => s.assets);
  const [draftStart, setDraftStart] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const num = (k: keyof typeof SAMPLER_DEFAULTS) => (typeof params[k] === 'number' ? (params[k] as number) : SAMPLER_DEFAULTS[k]);
  const assetId = typeof params.assetId === 'string' ? params.assetId : '';
  const asset = assets.find((a) => a.id === assetId);
  const start = draftStart ?? num('start');
  const root = num('root');
  const oneShot = params.mode === 'oneshot';

  const set = (patch: StudioParams) => onCommit({ ...params, ...patch });

  const waveRef = useCanvasLoop((ctx, w, h) => {
    ctx.fillStyle = '#141518';
    ctx.fillRect(0, 0, w, h);
    const peaks = assetId ? getPeaks(assetId) : undefined;
    if (!peaks) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(assetId ? 'Loading sample…' : editable ? 'Drop an audio file here, or pick one above' : 'No sample loaded', w / 2, h / 2 + 4);
      ctx.textAlign = 'start';
      return;
    }
    const buckets = peaks.data.length / 2;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * buckets), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * buckets));
      let lo = 1, hi = -1;
      for (let b = b0; b < b1; b++) { lo = Math.min(lo, peaks.data[b * 2]); hi = Math.max(hi, peaks.data[b * 2 + 1]); }
      ctx.fillStyle = x / w < start ? 'rgba(255,255,255,0.18)' : color;
      ctx.fillRect(x, mid - hi * mid * 0.9, 1, Math.max(1, (hi - lo) * mid * 0.9));
    }
    // Start marker
    const sx = Math.round(start * w) + 0.5;
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
    ctx.fillStyle = '#ffb347';
    ctx.beginPath(); ctx.moveTo(sx - 5, 0); ctx.lineTo(sx + 5, 0); ctx.lineTo(sx, 7); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 1;
  });

  const onWavePointerDown = (e: React.PointerEvent) => {
    if (!editable || !assetId || e.button !== 0) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = (x: number) => Math.round(Math.min(0.99, Math.max(0, (x - rect.left) / rect.width)) * 1000) / 1000;
    let last = at(e.clientX);
    setDraftStart(last);
    const move = (ev: PointerEvent) => { last = at(ev.clientX); setDraftStart(last); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraftStart(null);
      if (last !== num('start')) set({ start: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onDrop = async (e: React.DragEvent) => {
    setDragOver(false);
    if (!editable) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (id) { set({ assetId: id, start: 0 }); return; }
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const [created] = await uploadAudioFiles(files.slice(0, 1));
    if (created) set({ assetId: created.id, start: 0 });
  };

  const knob = (key: keyof typeof SAMPLER_DEFAULTS, label: string, min: number, max: number, unit: Parameters<typeof Knob>[0]['unit'], log = false) => (
    <Knob label={label} value={num(key)} min={min} max={max} def={SAMPLER_DEFAULTS[key]} unit={unit} log={log} color={color}
      disabled={!editable} onCommit={(v) => set({ [key]: v })} />
  );

  return (
    <div
      className={`studio-device-body studio-sampler${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (!editable || (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE) && !e.dataTransfer.types.includes('Files'))) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="studio-device-choices">
        <select
          className="studio-select small studio-sampler-pick"
          value={assetId}
          disabled={!editable}
          onChange={(e) => set({ assetId: e.target.value, start: 0 })}
          title="Sample"
        >
          <option value="">{assets.length ? 'Choose a sample…' : 'Upload audio in the Audio tab'}</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatDuration(a.durationSec)})</option>)}
        </select>
        <button
          className="studio-btn small"
          disabled={!asset}
          onPointerDown={() => void engine?.previewNote(trackId, root)}
          title="Audition at the root note"
        >▶</button>
      </div>
      <canvas
        ref={waveRef}
        className="studio-sampler-wave"
        onPointerDown={onWavePointerDown}
        title={editable && assetId ? 'Click or drag to set the sample start' : undefined}
      />
      <div className="studio-device-choices">
        <div className="studio-seg" title="Playback mode">
          <button className={`studio-seg-btn${!oneShot ? ' on' : ''}`} disabled={!editable} onClick={() => set({ mode: 'classic' })}>Classic</button>
          <button className={`studio-seg-btn${oneShot ? ' on' : ''}`} disabled={!editable} onClick={() => set({ mode: 'oneshot' })}>One-Shot</button>
        </div>
        <label className="studio-sampler-root" title="The note that plays the sample at its original pitch">
          Root
          <select className="studio-select small" value={root} disabled={!editable} onChange={(e) => set({ root: Number(e.target.value) })}>
            {ROOTS.map((p) => <option key={p} value={p}>{noteName(p)}</option>)}
          </select>
        </label>
      </div>
      <div className="studio-device-knobs">
        <Knob label="Start" value={start * 100} min={0} max={99} def={0} unit="%" color={color} disabled={!editable || !assetId}
          onPreview={(v) => setDraftStart(v / 100)} onCommit={(v) => { setDraftStart(null); set({ start: Math.round(v * 10) / 1000 }); }} />
        {knob('tune', 'Transpose', -24, 24, '')}
        {knob('attack', 'Attack', 0.001, 2, 's', true)}
        {knob('release', 'Release', 0.005, 4, 's', true)}
        {knob('cutoff', 'Filter', 40, 20000, 'Hz', true)}
        {knob('res', 'Res', 0.1, 18, '', true)}
        {knob('volume', 'Volume', -36, 12, 'dB')}
      </div>
    </div>
  );
}
