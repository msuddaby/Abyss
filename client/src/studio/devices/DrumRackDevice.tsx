import { useState } from 'react';
import { useStudioStore } from '@abyss/shared';
import type { StudioParams } from '@abyss/shared';
import type { StudioEngine } from '../engine/StudioEngine';
import { DRUM_PADS, PAD_DEFAULTS, padKey, padParam, kitChoke, type PadKey } from '../engine/drumRack';
import { isSoundFontAsset } from '../engine/soundfont';
import Knob from './Knob';
import { Scope } from './SynthDevice';

// Drum Rack: a 4×4 pad grid. Click a pad to hear it and edit its channel:
// source (built-in voice or a project sample), tune, decay, filter, drive,
// pan, level, mute and solo.

interface Props {
  trackId: string;
  params: StudioParams | undefined;
  editable: boolean;
  engine: StudioEngine | null;
  color: string;
  onCommit: (params: StudioParams) => void;
}

/** Drop values equal to their defaults so the kit stays small on the wire. */
function clean(p: StudioParams): StudioParams {
  const out: StudioParams = {};
  for (const [k, v] of Object.entries(p)) {
    const m = /^d(\d+)_(\w+)$/.exec(k);
    if (m && (PAD_DEFAULTS as Record<string, unknown>)[m[2]] === v) continue;
    if (k === 'choke' && v === true) continue;
    out[k] = v;
  }
  return out;
}

const ROWS = [0, 1, 2, 3].map((r) => DRUM_PADS.slice(r * 4, r * 4 + 4)).reverse(); // kick bottom-left

export default function DrumRackDevice({ trackId, params, editable, engine, color, onCommit }: Props) {
  const assets = useStudioStore((s) => s.assets);
  const [sel, setSel] = useState(36);
  const [draft, setDraft] = useState<StudioParams | null>(null);
  const p = draft ?? params ?? {};
  const pad = DRUM_PADS.find((x) => x.pitch === sel) ?? DRUM_PADS[0];
  const anySolo = DRUM_PADS.some((x) => padParam(p, x.pitch, 'solo'));

  const set = (patch: StudioParams) => ({ ...(params ?? {}), ...(draft ?? {}), ...patch });
  const preview = (patch: StudioParams) => { const next = set(patch); setDraft(next); engine?.previewInstrument(trackId, next); };
  const commit = (patch: StudioParams) => { const next = clean(set(patch)); setDraft(null); onCommit(next); };
  const padSet = (k: PadKey, v: number | string | boolean) => ({ [padKey(sel, k)]: v });

  const hit = (pitch: number) => { setSel(pitch); void engine?.previewNote(trackId, pitch, 0.9); };

  const knob = (k: PadKey, label: string, min: number, max: number, unit: 'st' | '%' | 'Hz' | 'dB', opts: { log?: boolean; scale?: number } = {}) => {
    const scale = opts.scale ?? 1;
    const v = Number(padParam(p, sel, k)) * scale;
    return (
      <Knob label={label} value={v} min={min} max={max} def={Number(PAD_DEFAULTS[k]) * scale} unit={unit} log={opts.log}
        color={color} size={34} integer={unit === 'st'} disabled={!editable}
        onPreview={(x) => preview(padSet(k, x / scale))} onCommit={(x) => commit(padSet(k, x / scale))} />
    );
  };

  const sample = padParam(p, sel, 'sample');
  const hp = padParam(p, sel, 'ftype') === 'hp';
  const muted = padParam(p, sel, 'mute');
  const soloed = padParam(p, sel, 'solo');

  return (
    <div className="studio-device-body studio-drumrack">
      <div className="studio-drumrack-grid" role="grid" aria-label="Drum pads">
        {ROWS.map((row, i) => (
          <div key={i} className="studio-drumrack-row" role="row">
            {row.map((x) => {
              const m = padParam(p, x.pitch, 'mute');
              const s = padParam(p, x.pitch, 'solo');
              const silent = m || (anySolo && !s);
              return (
                <button key={x.pitch} role="gridcell"
                  className={`studio-drumrack-pad${x.pitch === sel ? ' selected' : ''}${silent ? ' silent' : ''}`}
                  onPointerDown={() => hit(x.pitch)}
                  title={`${x.name} (note ${x.pitch})`}>
                  <span className="studio-drumrack-pad-name">{x.name}</span>
                  <span className="studio-drumrack-pad-flags">
                    {padParam(p, x.pitch, 'sample') ? '♪' : ''}{m ? ' M' : ''}{s ? ' S' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="studio-drumrack-strip">
        <div className="studio-synth-panel-head">
          <span className="studio-synth-panel-title">{pad.name.toUpperCase()}</span>
          <div className="studio-spacer" />
          <button className={`studio-drumrack-ms${muted ? ' on mute' : ''}`} disabled={!editable} onClick={() => commit(padSet('mute', !muted))} title="Mute pad">M</button>
          <button className={`studio-drumrack-ms${soloed ? ' on solo' : ''}`} disabled={!editable} onClick={() => commit(padSet('solo', !soloed))} title="Solo pad">S</button>
        </div>
        <label className="studio-input-row">
          <span>Source</span>
          <select className="studio-select" value={sample} disabled={!editable} onChange={(e) => commit(padSet('sample', e.target.value))}>
            <option value="">Built-in {pad.name.toLowerCase()}</option>
            {assets.filter((a) => !isSoundFontAsset(a)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <div className="studio-device-knobs">
          {knob('tune', 'Tune', -24, 24, 'st')}
          {knob('decay', 'Decay', 10, 400, '%', { log: true })}
          {knob('drive', 'Drive', 0, 24, 'dB')}
          {knob('tone', hp ? 'Low Cut' : 'High Cut', 20, 20000, 'Hz', { log: true })}
          {knob('pan', 'Pan', -100, 100, '%', { scale: 100 })}
          {knob('level', 'Level', -36, 6, 'dB')}
        </div>
        <div className="studio-drumrack-foot">
          <div className="studio-seg" title="Filter type">
            <button className={`studio-seg-btn${!hp ? ' on' : ''}`} disabled={!editable} onClick={() => commit({ ...padSet('ftype', 'lp'), ...padSet('tone', 20000) })}>LP</button>
            <button className={`studio-seg-btn${hp ? ' on' : ''}`} disabled={!editable} onClick={() => commit({ ...padSet('ftype', 'hp'), ...padSet('tone', 20) })}>HP</button>
          </div>
          <label className="studio-check" title="Closed and pedal hats cut off a ringing open hat">
            <input type="checkbox" checked={kitChoke(p)} disabled={!editable} onChange={(e) => commit({ choke: e.target.checked })} />
            Hat choke
          </label>
        </div>
        <Scope engine={engine} trackId={trackId} color={color} />
      </div>
    </div>
  );
}
