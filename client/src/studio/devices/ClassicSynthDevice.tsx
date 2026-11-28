import { useState } from 'react';
import type { StudioParams } from '@abyss/shared';
import type { StudioEngine } from '../engine/StudioEngine';
import { OSC_TYPES, resolveClassic, CLASSIC_DEFAULTS, type ClassicType } from '../engine/instruments';
import type { ParamUnit } from '../engine/effects';
import Knob from './Knob';
import { EnvView, Scope } from './SynthDevice';

// Panel for the classic Tone synths (FM Keys, AM Pad, Mono Lead, Pluck, Bass):
// oscillator, filter or tone, amp envelope and output, all live while you turn.

interface Props {
  type: ClassicType;
  trackId: string;
  params: StudioParams | undefined;
  editable: boolean;
  engine: StudioEngine | null;
  color: string;
  onCommit: (params: StudioParams) => void;
  /** Live moves (automation recording) */
  onPreviewParams?: (params: R) => void;
}

type R = Record<string, number | string>;
const KNOB = 32;

const WAVE_PATHS: Record<string, string> = {
  sine: 'M1 7 C4 -1 8 -1 11 7 S18 15 21 7',
  triangle: 'M1 7 L6 1 L16 13 L21 7',
  sawtooth: 'M1 12 L11 2 L11 12 L21 2 L21 12',
  square: 'M1 12 L1 2 L11 2 L11 12 L21 12 L21 2',
};

function WavePicker({ value, onPick, disabled, label }: { value: string; onPick: (w: string) => void; disabled: boolean; label: string }) {
  return (
    <div className="studio-classic-waves" role="radiogroup" aria-label={label}>
      {OSC_TYPES.map((w) => (
        <button key={w} className={`studio-classic-wave${value === w ? ' on' : ''}`} disabled={disabled} onClick={() => onPick(w)} title={w} aria-checked={value === w} role="radio">
          <svg viewBox="0 0 22 14" width={22} height={14}><path d={WAVE_PATHS[w]} /></svg>
        </button>
      ))}
    </div>
  );
}

export default function ClassicSynthDevice({ type, trackId, params, editable, engine, color, onCommit, onPreviewParams }: Props) {
  const [draft, setDraft] = useState<R | null>(null);
  const r = draft ?? resolveClassic(type, params);
  const d = CLASSIC_DEFAULTS[type];
  const hasFilter = type === 'mono' || type === 'bass';
  const hasMod = type === 'fm' || type === 'am';

  const merged = (patch: R): R => ({ ...resolveClassic(type, params), ...(draft ?? {}), ...patch });
  const preview = (patch: R) => { const next = merged(patch); setDraft(next); engine?.previewInstrument(trackId, next); onPreviewParams?.(next); };
  const commit = (patch: R) => { const next = merged(patch); setDraft(null); onCommit(next); };

  const knob = (key: string, label: string, min: number, max: number, unit: ParamUnit, log = false) => (
    <Knob key={key} label={label} value={Number(r[key])} min={min} max={max} def={Number(d[key])} unit={unit} log={log}
      color={color} size={KNOB} disabled={!editable}
      onPreview={(v) => preview({ [key]: v })} onCommit={(v) => commit({ [key]: v })} />
  );

  return (
    <div className="studio-device-body studio-classic">
      <div className="studio-synth-row">
        <div className="studio-synth-panel studio-classic-panel osc">
          <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">{hasMod ? 'CARRIER' : 'OSCILLATOR'}</span></div>
          <WavePicker label="Waveform" value={String(r.oscillator)} disabled={!editable} onPick={(w) => commit({ oscillator: w })} />
          {hasMod && (
            <>
              <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">MODULATOR</span></div>
              <WavePicker label="Modulator waveform" value={String(r.modWave)} disabled={!editable} onPick={(w) => commit({ modWave: w })} />
            </>
          )}
          <div className="studio-device-knobs">
            {hasMod && knob('harmonicity', 'Ratio', 0.25, 12, '', true)}
            {type === 'fm' && knob('modulationIndex', 'FM Amt', 0, 40, '')}
            {!hasMod && knob('glide', 'Glide', 0, 1, 's')}
          </div>
        </div>

        {hasFilter ? (
          <div className="studio-synth-panel studio-classic-panel filter">
            <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">FILTER</span></div>
            <div className="studio-device-knobs">
              {knob('cutoff', 'Cutoff', 30, 8000, 'Hz', true)}
              {knob('res', 'Res', 0.1, 20, '', true)}
              {knob('envAmt', 'Env Amt', 0, 7, 'oct')}
            </div>
            <EnvView a={Number(r.fAttack)} d={Number(r.fDecay)} s={Number(r.fSustain)} r={Number(r.fRelease)} color={color} />
            <div className="studio-device-knobs">
              {knob('fAttack', 'A', 0.001, 4, 's', true)}
              {knob('fDecay', 'D', 0.001, 4, 's', true)}
              {knob('fSustain', 'S', 0, 1, '')}
              {knob('fRelease', 'R', 0.001, 4, 's', true)}
            </div>
          </div>
        ) : (
          <div className="studio-synth-panel studio-classic-panel narrow">
            <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">TONE</span></div>
            <div className="studio-device-knobs">
              {knob('tone', 'Tone', 200, 20000, 'Hz', true)}
              {hasMod && knob('glide', 'Glide', 0, 1, 's')}
            </div>
          </div>
        )}

        <div className="studio-synth-panel env">
          <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">AMP</span></div>
          <EnvView a={Number(r.attack)} d={Number(r.decay)} s={Number(r.sustain)} r={Number(r.release)} color={color} />
          <div className="studio-device-knobs">
            {knob('attack', 'Attack', 0.001, 4, 's', true)}
            {knob('decay', 'Decay', 0.001, 4, 's', true)}
            {knob('sustain', 'Sustain', 0, 1, '')}
            {knob('release', 'Release', 0.001, 8, 's', true)}
          </div>
        </div>

        <div className="studio-synth-panel studio-classic-panel out">
          <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">OUTPUT</span></div>
          <Scope engine={engine} trackId={trackId} color={color} />
          <div className="studio-device-knobs">
            {knob('volume', 'Volume', -36, 6, 'dB')}
          </div>
        </div>
      </div>
    </div>
  );
}
