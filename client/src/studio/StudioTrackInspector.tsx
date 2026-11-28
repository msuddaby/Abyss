import { useStudioStore, studioId } from '@abyss/shared';
import type { StudioTrack, StudioEffect, StudioEffectType, StudioInstrumentType, StudioParams } from '@abyss/shared';
import { MASTER_ID, type StudioEngine } from './engine/StudioEngine';
import { isSidechainCycle } from './engine/routing';
import StudioRouting from './StudioRouting';
import PresetMenu from './PresetMenu';
import Knob from './devices/Knob';
import { INSTRUMENT_LABELS, resolveClassic, type ClassicType } from './engine/instruments';
import { EFFECT_DEFS, resolveParams, type Resolved } from './engine/effects';
import DeviceFrame from './devices/DeviceFrame';
import EffectDevice from './devices/EffectDevice';
import EqEightDevice from './devices/EqEightDevice';
import DelayDevice from './devices/DelayDevice';
import ClassicSynthDevice from './devices/ClassicSynthDevice';
import DrumRackDevice from './devices/DrumRackDevice';
import SamplerDevice from './devices/SamplerDevice';
import SoundFontDevice from './devices/SoundFontDevice';
import SynthDevice from './devices/SynthDevice';
import { SOUNDFONT_DEFAULTS } from './engine/soundfont';
import { TRACK_COLORS } from './studioUtils';
import { recordParamDiff, finishAutomation } from './automation';
import { resolveSynthParams } from './engine/wavetable/synthParams';

interface Props {
  /** A track id, or MASTER_ID for the master bus */
  trackId: string;
  track: StudioTrack;
  editable: boolean;
  canManage: boolean;
  engine: StudioEngine | null;
  onAddReturn?: () => void;
}


/** Instrument device widths in the chain, px */
const CLASSIC_WIDTH: Record<ClassicType, number> = { fm: 690, am: 690, pluck: 690, mono: 800, bass: 800 };
const DRUM_RACK_WIDTH = 700;
const MAX_FX = 8;

/** Strips channel-local audio asset ids before saving/loading server-wide instrument presets. */
function stripInstrumentAssets(type: StudioInstrumentType, params: StudioParams | undefined): StudioParams {
  const out: StudioParams = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if ((type === 'sampler' || type === 'soundfont') && k === 'assetId') continue;
    if (type === 'drums' && /^d\d+_sample$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function mergeInstrumentPreset(type: StudioInstrumentType, cur: StudioParams | undefined, preset: StudioParams): StudioParams {
  const clean = stripInstrumentAssets(type, preset);
  if (type === 'sampler' || type === 'soundfont') {
    return typeof cur?.assetId === 'string' && cur.assetId ? { ...clean, assetId: cur.assetId } : clean;
  }
  if (type === 'drums') {
    const samples: StudioParams = {};
    for (const [k, v] of Object.entries(cur ?? {})) {
      if (/^d\d+_sample$/.test(k)) samples[k] = v;
    }
    return { ...clean, ...samples };
  }
  return clean;
}

/** Drops values equal to defaults' types we can't store (server rejects nested/undefined). */
function storable(p: Resolved): StudioParams {
  const out: StudioParams = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  return out;
}

export default function StudioTrackInspector({ trackId, track, editable, canManage, engine, onAddReturn }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const doc = useStudioStore((s) => s.doc);
  const isMaster = trackId === MASTER_ID;
  const effects = track.effects ?? [];
  const inst = track.instrument ?? { type: 'synth' as StudioInstrumentType };
  const color = track.color ?? '#5865f2';

  const setInstrument = (type: StudioInstrumentType, params?: StudioParams) =>
    edit([{ t: 'set', path: ['tracks', trackId, 'instrument'], value: params ? { type, params } : { type } }]);

  const setEffects = (next: StudioEffect[]) => edit([{ t: 'set', path: isMaster ? ['meta', 'masterEffects'] : ['tracks', trackId, 'effects'], value: next }]);
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

  return (
    <div className="studio-chain">
      <div className="studio-chain-track" style={{ ['--track-color' as string]: color }}>
        <div className="studio-chain-track-name">{isMaster ? '🔊' : track.kind === 'audio' ? '🎙️' : track.kind === 'return' ? '↩' : track.kind === 'group' ? '📁' : '🎹'} {track.name}</div>
        {isMaster ? (
          <div className="studio-master-fader">
            <Knob
              label="Master" value={track.volume} min={-60} max={12} def={0} unit="dB" color={color} disabled={!editable}
              onPreview={(v) => engine?.previewMasterVolume(v)}
              onCommit={(v) => edit([{ t: 'set', path: ['meta', 'masterVolume'], value: Math.round(v * 10) / 10 }])}
            />
            <div className="studio-muted small">Devices here process the whole mix (and the export).</div>
          </div>
        ) : (
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
        )}
      </div>

      {!isMaster && doc && (
        <StudioRouting doc={doc} trackId={trackId} track={track} editable={editable} engine={engine} onAddReturn={onAddReturn} />
      )}

      {track.kind === 'instrument' && (
        <DeviceFrame
          title=""
          width={inst.type === 'drums' ? DRUM_RACK_WIDTH : inst.type === 'sampler' || inst.type === 'soundfont' ? 470 : inst.type === 'synth' ? 1110 : CLASSIC_WIDTH[inst.type as ClassicType] ?? 690}
          color={color}
          editable={editable}
          headerExtra={(
            <>
              <select className="studio-select small studio-device-type" value={inst.type} disabled={!editable} onChange={(e) => setInstrument(e.target.value as StudioInstrumentType)} title="Instrument">
                {(Object.keys(INSTRUMENT_LABELS) as StudioInstrumentType[]).map((t) => <option key={t} value={t}>{INSTRUMENT_LABELS[t]}</option>)}
              </select>
              <PresetMenu
                kind="instrument" type={inst.type} editable={editable} canManage={canManage}
                current={() => stripInstrumentAssets(inst.type, inst.params)}
                onLoad={(params) => setInstrument(inst.type, mergeInstrumentPreset(inst.type, inst.params, params))}
              />
            </>
          )}
        >
          {inst.type === 'synth' ? (
            <SynthDevice trackId={trackId} params={inst.params} editable={editable} engine={engine} color={color}
              onPreviewParams={(next) => recordParamDiff(trackId, 'inst:', resolveSynthParams(inst.params), next)}
              onCommit={(params) => { if (!finishAutomation(trackId, 'inst:')) setInstrument('synth', params); }} />
          ) : inst.type === 'sampler' ? (
            <SamplerDevice trackId={trackId} params={inst.params ?? {}} editable={editable} engine={engine} color={color}
              onCommit={(params) => setInstrument('sampler', params)} />
          ) : inst.type === 'soundfont' ? (
            <SoundFontDevice trackId={trackId} params={inst.params ?? {}} editable={editable} engine={engine} color={color}
              onPreviewParams={(next) => recordParamDiff(trackId, 'inst:', { ...SOUNDFONT_DEFAULTS, ...(inst.params ?? {}) }, next)}
              onCommit={(params) => { if (!finishAutomation(trackId, 'inst:')) setInstrument('soundfont', params); }} />
          ) : inst.type === 'drums' ? (
            <DrumRackDevice trackId={trackId} params={inst.params} editable={editable} engine={engine} color={color}
              onCommit={(params) => setInstrument('drums', params)} />
          ) : (
            <ClassicSynthDevice key={inst.type} type={inst.type as ClassicType} trackId={trackId} params={inst.params} editable={editable} engine={engine} color={color}
              onPreviewParams={(next) => recordParamDiff(trackId, 'inst:', resolveClassic(inst.type as ClassicType, inst.params), next)}
              onCommit={(params) => { if (!finishAutomation(trackId, 'inst:')) setInstrument(inst.type, params); }} />
          )}
        </DeviceFrame>
      )}

      {effects.map((fx, i) => {
        const def = EFFECT_DEFS[fx.type];
        if (!def) return null;
        const params = resolveParams(fx.type, fx.params);
        // While recording automation, moves go to automation lanes instead of the base value.
        // (The master bus has no automation lanes.)
        const commit = (p: Resolved) => { if (isMaster || !finishAutomation(trackId, `fx:${fx.id}:`)) updateEffect(fx.id, { params: storable(p) }); };
        const preview = (p: Resolved) => { engine?.previewEffect(trackId, fx.id, p); if (!isMaster) recordParamDiff(trackId, `fx:${fx.id}:`, params, p); };
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
            headerExtra={(
              <PresetMenu
                kind="effect" type={fx.type} editable={editable} canManage={canManage}
                current={() => { const { sidechain: _sc, ...rest } = storable(params); void _sc; return rest; }}
                onLoad={(p) => updateEffect(fx.id, { params: storable({ ...def.defaults(), ...p, ...(params.sidechain ? { sidechain: params.sidechain } : {}) }) })}
              />
            )}
          >
            {fx.type === 'eq' ? (
              <EqEightDevice params={params} editable={editable} engine={engine} trackId={trackId} fxId={fx.id} onPreview={preview} onCommit={commit} />
            ) : fx.type === 'delay' ? (
              <DelayDevice params={params} editable={editable} color={color} onPreview={preview} onCommit={commit} />
            ) : (
              <EffectDevice
                type={fx.type} params={params} editable={editable} engine={engine} trackId={trackId} fxId={fx.id} color={color} onPreview={preview} onCommit={commit}
                sidechainOptions={fx.type === 'compressor' && doc
                  ? Object.entries(doc.tracks)
                    .filter(([id]) => !isSidechainCycle(doc, isMaster ? '' : trackId, id))
                    .sort((a, b) => a[1].order - b[1].order)
                    .map(([id, t]) => ({ id, name: t.name }))
                  : undefined}
              />
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
      {effects.length === 0 && !editable && <div className="studio-muted studio-device-note">No effects on {isMaster ? 'the master' : 'this track'}.</div>}
    </div>
  );
}
