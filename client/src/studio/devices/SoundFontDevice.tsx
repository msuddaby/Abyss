import { useEffect, useState } from 'react';
import { useStudioStore } from '@abyss/shared';
import type { StudioParams } from '@abyss/shared';
import type { StudioEngine } from '../engine/StudioEngine';
import { onAssetLoaded } from '../engine/assetCache';
import {
  SOUNDFONT_DEFAULTS, findPreset, formatPresetLabel, getSoundFont,
  isSoundFontAsset, isSoundFontFile, loadSoundFont,
} from '../engine/soundfont';
import { ASSET_DRAG_TYPE } from '../StudioArrange';
import { uploadAudioFiles } from '../studioUtils';
import Knob from './Knob';
import { useCanvasLoop } from './spectrum';

interface Props {
  trackId: string;
  params: StudioParams;
  editable: boolean;
  engine: StudioEngine | null;
  color: string;
  onPreviewParams?: (next: StudioParams) => void;
  onCommit: (params: StudioParams) => void;
}

export default function SoundFontDevice({ trackId, params, editable, engine, color, onPreviewParams, onCommit }: Props) {
  const assets = useStudioStore((s) => s.assets);
  const sfAssets = assets.filter(isSoundFontAsset);
  const [dragOver, setDragOver] = useState(false);
  const [, setLoadedTick] = useState(0);

  const assetId = typeof params.assetId === 'string' ? params.assetId : '';
  const asset = sfAssets.find((a) => a.id === assetId);
  const sf = assetId ? getSoundFont(assetId) : undefined;
  const num = (k: keyof typeof SOUNDFONT_DEFAULTS) => (typeof params[k] === 'number' ? (params[k] as number) : SOUNDFONT_DEFAULTS[k]);

  useEffect(() => {
    if (!assetId || !asset || getSoundFont(assetId)) return;
    loadSoundFont(assetId, asset.url).catch((e) => console.warn('[studio] soundfont load failed', e));
  }, [assetId, asset]);

  useEffect(() => onAssetLoaded((id) => { if (id === assetId) setLoadedTick((n) => n + 1); }), [assetId]);

  const set = (patch: StudioParams) => onCommit({ ...params, ...patch });
  const preview = (patch: StudioParams) => {
    const next = { ...params, ...patch };
    engine?.previewInstrument(trackId, next);
    onPreviewParams?.(next);
  };

  const bank = num('bank');
  const program = num('program');
  const activePreset = sf ? findPreset(sf, bank, program) : undefined;
  const activeIdx = sf && activePreset ? sf.presets.indexOf(activePreset) : -1;
  const presetKey = activePreset ? `${activePreset.bank}:${activePreset.program}` : '';

  const stepPreset = (dir: -1 | 1) => {
    if (!sf || !sf.presets.length || !editable) return;
    const nextIdx = (activeIdx + dir + sf.presets.length) % sf.presets.length;
    const p = sf.presets[nextIdx];
    set({ bank: p.bank, program: p.program });
  };

  const scopeRef = useCanvasLoop((ctx, w, h) => {
    ctx.fillStyle = '#141518';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    const samples = engine?.getInstrumentAnalyser(trackId)?.getValue();
    if (!(samples instanceof Float32Array) || !samples.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const x = (i / (samples.length - 1)) * w;
      const y = h / 2 - samples[i] * (h * 0.44);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  const onDrop = async (e: React.DragEvent) => {
    setDragOver(false);
    if (!editable) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (id) {
      const dropped = sfAssets.find((a) => a.id === id);
      if (dropped) {
        const loaded = getSoundFont(dropped.id);
        const first = loaded?.presets[0];
        set({ assetId: dropped.id, bank: first?.bank ?? 0, program: first?.program ?? 0 });
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter(isSoundFontFile);
    if (!files.length) return;
    const [created] = await uploadAudioFiles(files.slice(0, 1));
    if (created) {
      const loaded = getSoundFont(created.id);
      const first = loaded?.presets[0];
      set({ assetId: created.id, bank: first?.bank ?? 0, program: first?.program ?? 0 });
    }
  };

  const knob = (
    key: keyof typeof SOUNDFONT_DEFAULTS,
    label: string,
    min: number,
    max: number,
    unit: Parameters<typeof Knob>[0]['unit'],
    log = false,
  ) => (
    <Knob
      label={label}
      value={num(key)}
      min={min}
      max={max}
      def={SOUNDFONT_DEFAULTS[key]}
      unit={unit}
      log={log}
      color={color}
      disabled={!editable}
      onPreview={(v) => preview({ [key]: v })}
      onCommit={(v) => set({ [key]: v })}
    />
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
          onChange={(e) => {
            const nextId = e.target.value;
            const loaded = nextId ? getSoundFont(nextId) : undefined;
            const first = loaded?.presets[0];
            set({ assetId: nextId, bank: first?.bank ?? 0, program: first?.program ?? 0 });
          }}
          title="SoundFont (.sf2)"
        >
          <option value="">{sfAssets.length ? 'Choose a SoundFont (.sf2)…' : 'Drop a .sf2 file here or upload in Audio tab'}</option>
          {sfAssets.map((a) => (
            <option key={a.id} value={a.id}>{a.name} ({(a.fileSize / (1024 * 1024)).toFixed(1)} MB)</option>
          ))}
        </select>
        <button
          className="studio-btn small"
          disabled={!sf}
          onPointerDown={() => void engine?.previewNote(trackId, 60)}
          title="Audition C4"
        >▶</button>
      </div>

      <div className="studio-device-choices">
        <button className="studio-btn small" disabled={!editable || !sf || sf.presets.length < 2} onClick={() => stepPreset(-1)} title="Previous preset">◀</button>
        <select
          className="studio-select small studio-sampler-pick"
          value={presetKey}
          disabled={!editable || !sf}
          onChange={(e) => {
            const [b, p] = e.target.value.split(':').map(Number);
            if (Number.isFinite(b) && Number.isFinite(p)) set({ bank: b, program: p });
          }}
          title="SoundFont preset"
        >
          {!sf && <option value="">{assetId ? 'Loading SoundFont…' : 'No SoundFont selected'}</option>}
          {sf?.presets.map((p) => (
            <option key={`${p.bank}:${p.program}`} value={`${p.bank}:${p.program}`}>{formatPresetLabel(p)}</option>
          ))}
        </select>
        <button className="studio-btn small" disabled={!editable || !sf || sf.presets.length < 2} onClick={() => stepPreset(1)} title="Next preset">▶</button>
      </div>

      <div className="studio-sf-info">
        <canvas ref={scopeRef} className="studio-device-scope studio-sf-scope" />
        {sf && <span className="studio-muted small">{sf.presets.length} preset{sf.presets.length === 1 ? '' : 's'}</span>}
      </div>

      <div className="studio-device-knobs">
        {knob('tune', 'Transpose', -24, 24, 'st')}
        {knob('attack', 'Attack', 0.1, 4, 'x', true)}
        {knob('release', 'Release', 0.1, 4, 'x', true)}
        {knob('cutoff', 'Filter', 40, 20000, 'Hz', true)}
        {knob('res', 'Res', 0.1, 18, '', true)}
        {knob('volume', 'Volume', -36, 12, 'dB')}
      </div>
    </div>
  );
}
