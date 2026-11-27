import { useStudioStore, studioId } from '@abyss/shared';
import type { StudioTrack, StudioEffect, StudioEffectType, StudioInstrumentType, StudioParams } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { INSTRUMENT_LABELS, OSC_TYPES } from './engine/instruments';
import { EFFECT_DEFS, resolveParams, type Resolved } from './engine/effects';
import DeviceFrame from './devices/DeviceFrame';
import EffectDevice from './devices/EffectDevice';
import EqEightDevice from './devices/EqEightDevice';
import Knob from './devices/Knob';
import SamplerDevice from './devices/SamplerDevice';
import SynthDevice from './devices/SynthDevice';
import { TRACK_COLORS } from './studioUtils';
import { recordParamDiff, finishAutomation } from './automation';
import { resolveSynthParams } from './engine/wavetable/synthParams';

interface Props {
  trackId: string;
  track: StudioTrack;
  editable: boolean;
  engine: StudioEngine | null;
}

const ENV_KNOBS = [
  { key: 'attack', label: 'Attack', min: 0.001, max: 2, def: 0.02 },
  { key: 'decay', label: 'Decay', min: 0.01, max: 2, def: 0.2 },
  { key: 'sustain', label: 'Sustain', min: 0, max: 1, def: 0.5 },
  { key: 'release', label: 'Release', min: 0.01, max: 4, def: 0.6 },
];
const HAS_OSC: StudioInstrumentType[] = ['synth', 'mono', 'pluck', 'bass'];
const HAS_CUTOFF: StudioInstrumentType[] = ['mono', 'bass'];
const HAS_HARM: StudioInstrumentType[] = ['fm', 'am'];
const MAX_FX = 8;

/** Drops values equal to defaults' types we can't store (server rejects nested/undefined). */
function storable(p: Resolved): StudioParams {
  const out: StudioParams = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  return out;
}

export default function StudioTrackInspector({ trackId, track, editable, engine }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const effects = track.effects ?? [];
  const inst = track.instrument ?? { type: 'synth' as StudioInstrumentType };
  const color = track.color ?? '#5865f2';

  const setInstrument = (type: StudioInstrumentType, params?: StudioParams) =>
    edit([{ t: 'set', path: ['tracks', trackId, 'instrument'], value: params ? { type, params } : { type } }]);
  const setInstParam = (key: string, value: number | string) =>
    setInstrument(inst.type, { ...(inst.params ?? {}), [key]: value });

  const setEffects = (next: StudioEffect[]) => edit([{ t: 'set', path: ['tracks', trackId, 'effects'], value: next }]);
  const addEffect = (type: StudioEffectType) =>
    setEffects([...effects, { id: studioId(), type, params: storable(EFFECT_DEFS[type].defaults()) }]);
  const updateEffect = (id: string, patch: Partial<StudioEffect>) =>
    setEffects(effects.map((fx) => (fx.id === id ? { ...fx, ...patch } : fx)));
  const moveEffect = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= effects.length) return;
    const next = [...effects];
    [next[index], next[j]] = [next[j], next[index]];
    setEffects(next);
  };

  const instParam = (key: string, def: number) => (typeof inst.params?.[key] === 'number' ? (inst.params[key] as number) : def);

  return (
    <div className="studio-chain">
      <div className="studio-chain-track" style={{ ['--track-color' as string]: color }}>
        <div className="studio-chain-track-name">{track.kind === 'audio' ? '🎙️' : '🎹'} {track.name}</div>
        <div className="studio-color-swatches">
          {TRACK_COLORS.map((c) => (
            <button
              key={c}
              className={`studio-swatch${track.color === c ? ' on' : ''}`}
              style={{ background: c }}
              disabled={!editable}
              onClick={() => edit([{ t: 'set', path: ['tracks', trackId, 'color'], value: c }])}
              title="Track color"
            />
          ))}
        </div>
      </div>

      {track.kind === 'instrument' && (
        <DeviceFrame
          title=""
          width={inst.type === 'drums' ? 220 : inst.type === 'sampler' ? 470 : inst.type === 'synth' ? 1110 : 330}
          color={color}
          editable={editable}
          headerExtra={(
            <select className="studio-select small studio-device-type" value={inst.type} disabled={!editable} onChange={(e) => setInstrument(e.target.value as StudioInstrumentType)} title="Instrument">
              {(Object.keys(INSTRUMENT_LABELS) as StudioInstrumentType[]).map((t) => <option key={t} value={t}>{INSTRUMENT_LABELS[t]}</option>)}
            </select>
          )}
        >
          {inst.type === 'synth' ? (
            <SynthDevice trackId={trackId} params={inst.params} editable={editable} engine={engine} color={color}
              onPreviewParams={(next) => recordParamDiff(trackId, 'inst:', resolveSynthParams(inst.params), next)}
              onCommit={(params) => { if (!finishAutomation(trackId, 'inst:')) setInstrument('synth', params); }} />
          ) : inst.type === 'sampler' ? (
            <SamplerDevice trackId={trackId} params={inst.params ?? {}} editable={editable} engine={engine} color={color}
              onCommit={(params) => setInstrument('sampler', params)} />
          ) : (
          <div className="studio-device-body">
            <div className="studio-device-choices">
              {HAS_OSC.includes(inst.type) && (
                <div className="studio-seg" title="Oscillator">
                  {OSC_TYPES.map((o) => (
                    <button
                      key={o}
                      className={`studio-seg-btn${inst.params?.oscillator === o ? ' on' : ''}`}
                      disabled={!editable}
                      onClick={() => setInstParam('oscillator', o)}
                    >{o === 'sawtooth' ? 'saw' : o === 'triangle' ? 'tri' : o === 'square' ? 'sqr' : 'sin'}</button>
                  ))}
                </div>
              )}
            </div>
            {inst.type !== 'drums' ? (
              <div className="studio-device-knobs">
                {ENV_KNOBS.map((k) => (
                  <Knob key={k.key} label={k.label} value={instParam(k.key, k.def)} min={k.min} max={k.max} def={k.def}
                    unit={k.key === 'sustain' ? '' : 's'} log={k.key !== 'sustain'} color={color} disabled={!editable}
                    onCommit={(v) => setInstParam(k.key, v)} />
                ))}
                {HAS_CUTOFF.includes(inst.type) && (
                  <Knob label="Cutoff" value={instParam('cutoff', inst.type === 'bass' ? 120 : 300)} min={40} max={4000} def={inst.type === 'bass' ? 120 : 300}
                    unit="Hz" log color={color} disabled={!editable} onCommit={(v) => setInstParam('cutoff', v)} />
                )}
                {HAS_HARM.includes(inst.type) && (
                  <Knob label="Harmonics" value={instParam('harmonicity', inst.type === 'fm' ? 3 : 2)} min={0.5} max={8} def={inst.type === 'fm' ? 3 : 2}
                    unit="" color={color} disabled={!editable} onCommit={(v) => setInstParam('harmonicity', v)} />
                )}
                {inst.type === 'fm' && (
                  <Knob label="Mod Index" value={instParam('modulationIndex', 10)} min={0} max={40} def={10}
                    unit="" color={color} disabled={!editable} onCommit={(v) => setInstParam('modulationIndex', v)} />
                )}
              </div>
            ) : (
              <div className="studio-muted studio-device-note">Kick, snare, clap, hats, toms and cymbals — draw them in the piano roll.</div>
            )}
          </div>
          )}
        </DeviceFrame>
      )}

      {effects.map((fx, i) => {
        const def = EFFECT_DEFS[fx.type];
        if (!def) return null;
        const params = resolveParams(fx.type, fx.params);
        // While recording automation, moves go to automation lanes instead of the base value.
        const commit = (p: Resolved) => { if (!finishAutomation(trackId, `fx:${fx.id}:`)) updateEffect(fx.id, { params: storable(p) }); };
        const preview = (p: Resolved) => { engine?.previewEffect(trackId, fx.id, p); recordParamDiff(trackId, `fx:${fx.id}:`, params, p); };
        return (
          <DeviceFrame
            key={fx.id}
            title={def.label}
            width={def.width}
            color={color}
            on={!fx.bypass}
            editable={editable}
            onToggle={() => updateEffect(fx.id, { bypass: !fx.bypass })}
            onMoveLeft={i > 0 ? () => moveEffect(i, -1) : undefined}
            onMoveRight={i < effects.length - 1 ? () => moveEffect(i, 1) : undefined}
            onRemove={() => setEffects(effects.filter((f) => f.id !== fx.id))}
          >
            {fx.type === 'eq' ? (
              <EqEightDevice params={params} editable={editable} engine={engine} trackId={trackId} fxId={fx.id} onPreview={preview} onCommit={commit} />
            ) : (
              <EffectDevice type={fx.type} params={params} editable={editable} engine={engine} trackId={trackId} fxId={fx.id} color={color} onPreview={preview} onCommit={commit} />
            )}
          </DeviceFrame>
        );
      })}

      {editable && effects.length < MAX_FX && (
        <div className="studio-device add">
          <div className="studio-device-head"><span className="studio-device-title">Add effect</span></div>
          <div className="studio-add-fx">
            {(Object.keys(EFFECT_DEFS) as StudioEffectType[]).map((t) => (
              <button key={t} className="studio-btn small" onClick={() => addEffect(t)}>{EFFECT_DEFS[t].label}</button>
            ))}
          </div>
        </div>
      )}
      {effects.length === 0 && !editable && <div className="studio-muted studio-device-note">No effects on this track.</div>}
    </div>
  );
}
