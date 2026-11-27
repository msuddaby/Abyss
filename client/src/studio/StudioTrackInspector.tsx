import { useStudioStore, studioId } from '@abyss/shared';
import type { StudioTrack, StudioEffect, StudioEffectType, StudioInstrumentType, StudioParams } from '@abyss/shared';
import { INSTRUMENT_LABELS, EFFECT_SPECS, OSC_TYPES, defaultEffectParams } from './engine/instruments';
import CommitSlider from './CommitSlider';
import { TRACK_COLORS } from './studioUtils';

interface Props {
  trackId: string;
  track: StudioTrack;
  editable: boolean;
}

const SYNTH_PARAMS: { key: string; label: string; min: number; max: number; step: number; def: number }[] = [
  { key: 'attack', label: 'Attack', min: 0.001, max: 2, step: 0.001, def: 0.02 },
  { key: 'decay', label: 'Decay', min: 0.01, max: 2, step: 0.01, def: 0.2 },
  { key: 'sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, def: 0.5 },
  { key: 'release', label: 'Release', min: 0.01, max: 4, step: 0.01, def: 0.6 },
];

const HAS_OSC: StudioInstrumentType[] = ['synth', 'mono', 'pluck', 'bass'];
const HAS_CUTOFF: StudioInstrumentType[] = ['mono', 'bass'];

export default function StudioTrackInspector({ trackId, track, editable }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const effects = track.effects ?? [];
  const inst = track.instrument ?? { type: 'synth' as StudioInstrumentType };

  const setInstrument = (type: StudioInstrumentType, params?: StudioParams) =>
    edit([{ t: 'set', path: ['tracks', trackId, 'instrument'], value: params ? { type, params } : { type } }]);

  const setInstParam = (key: string, value: number | string) =>
    setInstrument(inst.type, { ...(inst.params ?? {}), [key]: value });

  const setEffects = (next: StudioEffect[]) => edit([{ t: 'set', path: ['tracks', trackId, 'effects'], value: next }]);

  const addEffect = (type: StudioEffectType) => setEffects([...effects, { id: studioId(), type, params: defaultEffectParams(type) }]);

  const updateEffect = (id: string, patch: Partial<StudioEffect>) =>
    setEffects(effects.map((fx) => (fx.id === id ? { ...fx, ...patch } : fx)));

  const moveEffect = (index: number, dir: -1 | 1) => {
    const next = [...effects];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setEffects(next);
  };

  return (
    <div className="studio-inspector">
      <div className="studio-panel-toolbar">
        <span className="studio-panel-title" style={{ color: track.color }}>{track.kind === 'audio' ? '🎙️' : '🎹'} {track.name}</span>
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
      <div className="studio-inspector-body">
        {track.kind === 'instrument' && (
          <section className="studio-inspector-section">
            <h4>Instrument</h4>
            <select
              className="studio-select"
              value={inst.type}
              disabled={!editable}
              onChange={(e) => setInstrument(e.target.value as StudioInstrumentType)}
            >
              {(Object.keys(INSTRUMENT_LABELS) as StudioInstrumentType[]).map((t) => (
                <option key={t} value={t}>{INSTRUMENT_LABELS[t]}</option>
              ))}
            </select>
            {HAS_OSC.includes(inst.type) && (
              <label className="studio-param">
                <span>Wave</span>
                <select
                  className="studio-select"
                  value={typeof inst.params?.oscillator === 'string' ? inst.params.oscillator : ''}
                  disabled={!editable}
                  onChange={(e) => setInstParam('oscillator', e.target.value)}
                >
                  <option value="">Default</option>
                  {OSC_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            )}
            {inst.type !== 'drums' && SYNTH_PARAMS.map((p) => (
              <label key={p.key} className="studio-param">
                <span>{p.label}</span>
                <CommitSlider
                  className="studio-slider"
                  min={p.min} max={p.max} step={p.step}
                  value={typeof inst.params?.[p.key] === 'number' ? (inst.params[p.key] as number) : p.def}
                  disabled={!editable}
                  onCommit={(v) => setInstParam(p.key, v)}
                />
              </label>
            ))}
            {HAS_CUTOFF.includes(inst.type) && (
              <label className="studio-param">
                <span>Cutoff</span>
                <CommitSlider
                  className="studio-slider"
                  min={40} max={4000} step={10}
                  value={typeof inst.params?.cutoff === 'number' ? inst.params.cutoff : inst.type === 'bass' ? 120 : 300}
                  disabled={!editable}
                  onCommit={(v) => setInstParam('cutoff', v)}
                />
              </label>
            )}
          </section>
        )}

        <section className="studio-inspector-section effects">
          <h4>
            Effects
            {editable && effects.length < 8 && (
              <select
                className="studio-select small"
                value=""
                onChange={(e) => { if (e.target.value) addEffect(e.target.value as StudioEffectType); }}
              >
                <option value="">＋ Add…</option>
                {(Object.keys(EFFECT_SPECS) as StudioEffectType[]).map((t) => <option key={t} value={t}>{EFFECT_SPECS[t].label}</option>)}
              </select>
            )}
          </h4>
          {effects.length === 0 && <div className="studio-muted">No effects.</div>}
          <div className="studio-fx-list">
            {effects.map((fx, i) => (
              <div key={fx.id} className={`studio-fx${fx.bypass ? ' bypassed' : ''}`}>
                <div className="studio-fx-head">
                  <button
                    className={`studio-toggle${fx.bypass ? '' : ' on'}`}
                    disabled={!editable}
                    title={fx.bypass ? 'Enable' : 'Bypass'}
                    onClick={() => updateEffect(fx.id, { bypass: !fx.bypass })}
                  >⏻</button>
                  <span className="studio-fx-name">{EFFECT_SPECS[fx.type].label}</span>
                  {editable && (
                    <>
                      <button className="studio-icon-btn" disabled={i === 0} onClick={() => moveEffect(i, -1)} title="Move up">↑</button>
                      <button className="studio-icon-btn" disabled={i === effects.length - 1} onClick={() => moveEffect(i, 1)} title="Move down">↓</button>
                      <button className="studio-icon-btn danger" onClick={() => setEffects(effects.filter((f) => f.id !== fx.id))} title="Remove">✕</button>
                    </>
                  )}
                </div>
                {EFFECT_SPECS[fx.type].params.map((p) => (
                  <label key={p.key} className="studio-param">
                    <span>{p.label}</span>
                    <CommitSlider
                      className="studio-slider"
                      min={p.min} max={p.max} step={p.step}
                      value={typeof fx.params?.[p.key] === 'number' ? (fx.params[p.key] as number) : p.default}
                      resetValue={p.default}
                      disabled={!editable}
                      onCommit={(v) => updateEffect(fx.id, { params: { ...(fx.params ?? {}), [p.key]: v } })}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
