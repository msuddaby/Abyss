import * as Tone from 'tone';
import type { StudioDoc, StudioInstrument, StudioInstrumentType, StudioParams } from '@abyss/shared';
import { getBuffer } from './assetCache';
import { createWavetableSynth } from './wavetable/synthNode';
import { createDrumRack, DRUM_PADS, drumSampleIds } from './drumRack';

// Built-in instruments and effects. Everything here is constructed against the
// *current* Tone context so the same factories work for offline export.

export interface PlayableInstrument {
  output: Tone.ToneAudioNode;
  play: (pitch: number, durationSec: number, time: number, velocity: number) => void;
  releaseAll: () => void;
  dispose: () => void;
  /** Live param change without a rebuild (keeps ringing notes). */
  update?: (params: StudioParams) => void;
  setBpm?: (bpm: number) => void;
  /** Output waveform tap for the device scope */
  analyser?: Tone.Analyser;
  /** Held notes (computer keyboard / live input). Falls back to play() when absent. */
  noteOn?: (pitch: number, velocity: number, time: number) => void;
  noteOff?: (pitch: number, time: number) => void;
  /** Set one numeric param without a full update (automation). */
  setParam?: (key: string, value: number) => void;
  /** Pitch bend in semitones (live input) */
  setPitchBend?: (semis: number) => void;
  /** Mod wheel 0..1 (live input) */
  setModWheel?: (value: number) => void;
}

/** Instrument types that take param changes live via update(). */
export const LIVE_UPDATE_TYPES = new Set<StudioInstrumentType>(['synth', 'fm', 'am', 'mono', 'pluck', 'bass', 'drums']);

export const INSTRUMENT_LABELS: Record<StudioInstrumentType, string> = {
  synth: 'Wavetable',
  fm: 'FM Keys',
  am: 'AM Pad',
  mono: 'Mono Lead',
  pluck: 'Pluck',
  bass: 'Bass',
  drums: 'Drum Rack',
  sampler: 'Sampler',
};

export const OSC_TYPES = ['sine', 'triangle', 'sawtooth', 'square'] as const;

/** GM-ish drum map used by the drum kit and the piano roll's row labels. */
export const DRUM_MAP: Record<number, string> = Object.fromEntries(DRUM_PADS.map((p) => [p.pitch, p.name]));

function num(params: StudioParams | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === 'number' ? v : fallback;
}

export type ClassicType = 'fm' | 'am' | 'mono' | 'pluck' | 'bass';
export const CLASSIC_TYPES: ClassicType[] = ['fm', 'am', 'mono', 'pluck', 'bass'];

/** Defaults per classic synth (these match how projects sounded before the params existed). */
export const CLASSIC_DEFAULTS: Record<ClassicType, Record<string, number | string>> = {
  fm: { oscillator: 'sine', modWave: 'square', harmonicity: 3, modulationIndex: 10, attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.8, tone: 20000, glide: 0, volume: 0 },
  am: { oscillator: 'sine', modWave: 'square', harmonicity: 2, attack: 0.4, decay: 0.3, sustain: 0.7, release: 1.5, tone: 20000, glide: 0, volume: 0 },
  mono: {
    oscillator: 'square', attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3,
    cutoff: 300, res: 1, envAmt: 4, fAttack: 0.01, fDecay: 0.3, fSustain: 0.4, fRelease: 0.4, glide: 0, volume: 0,
  },
  pluck: { oscillator: 'triangle', attack: 0.002, decay: 0.35, sustain: 0, release: 0.3, tone: 20000, glide: 0, volume: 0 },
  bass: {
    oscillator: 'sawtooth', attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.15,
    cutoff: 120, res: 1, envAmt: 3, fAttack: 0.005, fDecay: 0.2, fSustain: 0.3, fRelease: 0.2, glide: 0, volume: 0,
  },
};

/** A classic synth's params with defaults filled in. */
export function resolveClassic(type: ClassicType, p: StudioParams | undefined): Record<string, number | string> {
  const d = CLASSIC_DEFAULTS[type];
  const out: Record<string, number | string> = { ...d };
  for (const k of Object.keys(d)) {
    const v = p?.[k];
    if (typeof v === typeof d[k]) out[k] = v as number | string;
  }
  if (typeof out.oscillator === 'string' && !(OSC_TYPES as readonly string[]).includes(out.oscillator)) out.oscillator = d.oscillator;
  if (typeof out.modWave === 'string' && !(OSC_TYPES as readonly string[]).includes(out.modWave)) out.modWave = d.modWave;
  return out;
}

function classicOptions(type: ClassicType, r: Record<string, number | string>) {
  const n = (k: string) => Number(r[k]);
  const envelope = { attack: n('attack'), decay: n('decay'), sustain: n('sustain'), release: n('release') };
  const oscillator = { type: r.oscillator as OscillatorType };
  const portamento = n('glide');
  switch (type) {
    case 'fm': return { oscillator, modulation: { type: r.modWave as OscillatorType }, harmonicity: n('harmonicity'), modulationIndex: n('modulationIndex'), envelope, portamento };
    case 'am': return { oscillator, modulation: { type: r.modWave as OscillatorType }, harmonicity: n('harmonicity'), envelope, portamento };
    case 'mono':
    case 'bass':
      return {
        oscillator, envelope, portamento, filter: { Q: n('res') },
        filterEnvelope: { attack: n('fAttack'), decay: n('fDecay'), sustain: n('fSustain'), release: n('fRelease'), baseFrequency: n('cutoff'), octaves: n('envAmt') },
      };
    case 'pluck':
    default:
      return { oscillator, envelope, portamento };
  }
}

/** FM / AM / Mono / Pluck / Bass: a PolySynth with live param updates and a scope tap. */
function classicInstrument(type: ClassicType, p: StudioParams | undefined): PlayableInstrument {
  const r = resolveClassic(type, p);
  const voice = type === 'fm' ? Tone.FMSynth : type === 'am' ? Tone.AMSynth : type === 'pluck' ? Tone.Synth : Tone.MonoSynth;
  const synth = new Tone.PolySynth(voice as typeof Tone.Synth, classicOptions(type, r) as Partial<Tone.SynthOptions>);
  synth.maxPolyphony = 24;
  const tone = new Tone.Filter({ type: 'lowpass', frequency: Number(r.tone ?? 20000), rolloff: -12 });
  const out = new Tone.Volume(Number(r.volume));
  const analyser = new Tone.Analyser('waveform', 1024);
  synth.chain(tone, out);
  out.connect(analyser);
  const hz = (pitch: number) => Tone.Frequency(pitch, 'midi').toFrequency();
  const last: Record<string, number> = {};
  return {
    output: out,
    analyser,
    play: (pitch, dur, time, vel) => synth.triggerAttackRelease(hz(pitch), dur, time, vel),
    noteOn: (pitch, vel, time) => synth.triggerAttack(hz(pitch), time, vel),
    noteOff: (pitch, time) => synth.triggerRelease(hz(pitch), time),
    setPitchBend: (semis) => synth.set({ detune: semis * 100 }),
    update: (params) => {
      const next = resolveClassic(type, params);
      synth.set(classicOptions(type, next) as Partial<Tone.SynthOptions>);
      tone.frequency.rampTo(Number(next.tone ?? 20000), 0.03);
      out.volume.rampTo(Number(next.volume), 0.03);
    },
    // Automation: tone/volume ramp; the rest are set on every voice (control rate).
    setParam: (key, value) => {
      if (key === 'tone') { tone.frequency.rampTo(value, 0.03); return; }
      if (key === 'volume') { out.volume.rampTo(value, 0.03); return; }
      if (last[key] !== undefined && Math.abs(last[key] - value) < 1e-4) return;
      last[key] = value;
      switch (key) {
        case 'harmonicity': synth.set({ harmonicity: value } as never); break;
        case 'modulationIndex': synth.set({ modulationIndex: value } as never); break;
        case 'glide': synth.set({ portamento: value }); break;
        case 'cutoff': synth.set({ filterEnvelope: { baseFrequency: value } } as never); break;
        case 'res': synth.set({ filter: { Q: value } } as never); break;
        case 'envAmt': synth.set({ filterEnvelope: { octaves: value } } as never); break;
      }
    },
    releaseAll: () => synth.releaseAll(),
    dispose: () => { synth.dispose(); tone.dispose(); out.dispose(); analyser.dispose(); },
  };
}

/** Asset id of a sampler instrument's sample, if any. */
export function samplerAssetId(inst: StudioInstrument | undefined): string | undefined {
  const id = inst?.type === 'sampler' ? inst.params?.assetId : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

/** Every asset the arrangement needs decoded: clip audio plus sampler samples. */
export function usedAssetIds(doc: StudioDoc): Set<string> {
  const ids = new Set<string>();
  for (const c of Object.values(doc.clips)) if (c.assetId) ids.add(c.assetId);
  for (const t of Object.values(doc.tracks)) {
    const id = samplerAssetId(t.instrument);
    if (id) ids.add(id);
    if (t.instrument?.type === 'drums') for (const sid of drumSampleIds(t.instrument.params)) ids.add(sid);
  }
  return ids;
}

export const SAMPLER_DEFAULTS = { root: 60, tune: 0, start: 0, attack: 0.002, release: 0.08, cutoff: 20000, res: 0.7, volume: 0 };

/**
 * Simpler-style single-sample instrument. Each note gets its own buffer
 * source repitched relative to the root note. Classic mode holds for the note
 * length; one-shot plays the whole sample (good for drum hits).
 */
function sampler(p: StudioParams | undefined): PlayableInstrument {
  const assetId = typeof p?.assetId === 'string' ? p.assetId : '';
  const raw = assetId ? getBuffer(assetId) : undefined;
  const buffer = raw ? new Tone.ToneAudioBuffer(raw) : null;
  const d = SAMPLER_DEFAULTS;
  const root = num(p, 'root', d.root);
  const tune = num(p, 'tune', d.tune);
  const startFrac = Math.min(0.99, Math.max(0, num(p, 'start', d.start)));
  const attack = Math.max(0.001, num(p, 'attack', d.attack));
  const release = Math.max(0.005, num(p, 'release', d.release));
  const oneShot = p?.mode === 'oneshot';

  const out = new Tone.Gain(Tone.dbToGain(num(p, 'volume', d.volume)));
  const filter = new Tone.Filter({ type: 'lowpass', frequency: num(p, 'cutoff', d.cutoff), Q: num(p, 'res', d.res), rolloff: -24 });
  filter.connect(out);
  const context = filter.context;
  const voices = new Set<{ src: Tone.ToneBufferSource; amp: Tone.Gain }>();

  const free = (v: { src: Tone.ToneBufferSource; amp: Tone.Gain }) => {
    if (!voices.delete(v)) return;
    v.src.dispose();
    v.amp.dispose();
  };

  const held = new Map<number, { src: Tone.ToneBufferSource; amp: Tone.Gain }>();
  const startVoice = (pitch: number, time: number, vel: number) => {
    if (!buffer) return null;
    const rate = Math.pow(2, (pitch - root + tune) / 12);
    const src = new Tone.ToneBufferSource({ context, url: buffer, playbackRate: rate, fadeIn: attack, fadeOut: release, curve: 'exponential' });
    const amp = new Tone.Gain({ context, gain: vel });
    src.connect(amp);
    amp.connect(filter);
    const v = { src, amp };
    voices.add(v);
    src.onended = () => free(v);
    src.start(time, startFrac * buffer.duration);
    return v;
  };

  return {
    output: out,
    noteOn: (pitch, vel, time) => {
      const v = startVoice(pitch, time, vel);
      if (v && !oneShot) held.set(pitch, v);
    },
    noteOff: (pitch, time) => {
      const v = held.get(pitch);
      held.delete(pitch);
      if (v) { try { v.src.stop(time); } catch { /* already stopped */ } }
    },
    play: (pitch, dur, time, vel) => {
      if (!buffer) return;
      const rate = Math.pow(2, (pitch - root + tune) / 12);
      const offset = startFrac * buffer.duration;
      // Voices are created at play time; during an offline export that is after
      // Tone has switched back to the live context, so pin the instrument's own.
      const src = new Tone.ToneBufferSource({ context, url: buffer, playbackRate: rate, fadeIn: attack, fadeOut: release, curve: 'exponential' });
      const amp = new Tone.Gain({ context, gain: vel });
      src.connect(amp);
      amp.connect(filter);
      const v = { src, amp };
      voices.add(v);
      src.onended = () => free(v);
      src.start(time, offset);
      if (!oneShot) src.stop(time + Math.max(dur, attack));
    },
    releaseAll: () => {
      for (const v of voices) {
        try { v.src.stop(); } catch { /* not started yet */ }
      }
    },
    dispose: () => {
      for (const v of [...voices]) free(v);
      filter.dispose();
      out.dispose();
    },
  };
}

export function createInstrument(inst: StudioInstrument | undefined): PlayableInstrument {
  const p = inst?.params;
  switch (inst?.type ?? 'synth') {
    case 'fm':
    case 'am':
    case 'mono':
    case 'pluck':
    case 'bass':
      return classicInstrument(inst!.type as ClassicType, p);
    case 'drums':
      return createDrumRack(p);
    case 'sampler':
      return sampler(p);
    case 'synth':
    default:
      return createWavetableSynth(p);
  }
}
