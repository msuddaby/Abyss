import * as Tone from 'tone';
import type { StudioEffectType, StudioParams } from '@abyss/shared';
import { isSynthReady } from './wavetable/synthNode';

// Effect "devices" in the spirit of Ableton's: each has a parameter schema
// (drives the knobs), a live-updatable Tone.js graph, and an output analyser
// for the spectrum display. Param changes call update() on the running device;
// only `structKey` changes (e.g. delay mode) force a rebuild.

export type ParamUnit = 'Hz' | 'dB' | 'ms' | 's' | '%' | ':1' | 'beats' | 'bits' | '°' | 'st' | 'ct' | 'oct' | 'octw' | 'x' | '';

export interface KnobDef {
  kind: 'knob';
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  unit: ParamUnit;
  log?: boolean;
  /** Only shown when this returns true */
  when?: (p: Resolved) => boolean;
}

export interface ChoiceDef {
  kind: 'choice';
  key: string;
  label: string;
  def: string;
  options: { value: string; label: string }[];
  when?: (p: Resolved) => boolean;
}

export type ParamDef = KnobDef | ChoiceDef;
export type Resolved = Record<string, number | string | boolean>;

export interface FxDevice {
  input: Tone.Gain;
  output: Tone.Gain;
  analyser: Tone.Analyser;
  structKey: string;
  ready: Promise<void>;
  update: (p: Resolved, bpm: number, time?: number, ramp?: number) => void;
  /** Compressor gain reduction in dB (≤ 0) */
  getReduction?: () => number;
  /** Sidechain key input (compressor in sidechain mode); the engine wires the key track here */
  sidechain?: Tone.Gain;
  dispose: () => void;
}

export const FFT_SIZE = 2048;

// ───────────────────────── EQ Eight ─────────────────────────

export type EqBandType = 'lowcut48' | 'lowcut12' | 'lowshelf' | 'bell' | 'notch' | 'highshelf' | 'highcut12' | 'highcut48';

export const EQ_BAND_TYPES: { value: EqBandType; label: string; short: string }[] = [
  { value: 'lowcut48', label: 'Low Cut 48 dB', short: '⟋⁴' },
  { value: 'lowcut12', label: 'Low Cut 12 dB', short: '⟋' },
  { value: 'lowshelf', label: 'Low Shelf', short: '⌊' },
  { value: 'bell', label: 'Bell', short: '⌒' },
  { value: 'notch', label: 'Notch', short: 'V' },
  { value: 'highshelf', label: 'High Shelf', short: '⌉' },
  { value: 'highcut12', label: 'High Cut 12 dB', short: '⟍' },
  { value: 'highcut48', label: 'High Cut 48 dB', short: '⟍⁴' },
];

export const EQ_BAND_COLORS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6'];

const EQ_DEFAULT_BANDS: { type: EqBandType; f: number; on: boolean }[] = [
  { type: 'lowcut48', f: 30, on: false },
  { type: 'lowshelf', f: 100, on: false },
  { type: 'bell', f: 250, on: false },
  { type: 'bell', f: 500, on: false },
  { type: 'bell', f: 1000, on: false },
  { type: 'bell', f: 2500, on: false },
  { type: 'highshelf', f: 6000, on: false },
  { type: 'highcut48', f: 18000, on: false },
];

export const EQ_BANDS = 8;
export const bandKey = (i: number, k: 'on' | 'type' | 'f' | 'g' | 'q') => `b${i}${k}`;

function eqDefaults(): Resolved {
  const p: Resolved = { scale: 100, out: 0 };
  EQ_DEFAULT_BANDS.forEach((b, i) => {
    p[bandKey(i, 'on')] = b.on;
    p[bandKey(i, 'type')] = b.type;
    p[bandKey(i, 'f')] = b.f;
    p[bandKey(i, 'g')] = 0;
    p[bandKey(i, 'q')] = 0.71;
  });
  return p;
}

interface BiquadSetting { type: BiquadFilterType; frequency: number; Q: number; gain: number }
const PASS: BiquadSetting = { type: 'peaking', frequency: 1000, Q: 1, gain: 0 };

/** The 4 cascaded biquad stages a band uses (unused stages are transparent). */
export function bandStages(type: EqBandType, f: number, gainDb: number, q: number, on: boolean): BiquadSetting[] {
  if (!on) return [PASS, PASS, PASS, PASS];
  // Web Audio treats lowpass/highpass Q as resonance in dB.
  const resDb = 20 * Math.log10(Math.max(0.1, q) / Math.SQRT1_2);
  switch (type) {
    case 'lowcut48': return Array(4).fill({ type: 'highpass', frequency: f, Q: 0, gain: 0 });
    case 'highcut48': return Array(4).fill({ type: 'lowpass', frequency: f, Q: 0, gain: 0 });
    case 'lowcut12': return [{ type: 'highpass', frequency: f, Q: resDb, gain: 0 }, PASS, PASS, PASS];
    case 'highcut12': return [{ type: 'lowpass', frequency: f, Q: resDb, gain: 0 }, PASS, PASS, PASS];
    case 'lowshelf': return [{ type: 'lowshelf', frequency: f, Q: 1, gain: gainDb }, PASS, PASS, PASS];
    case 'highshelf': return [{ type: 'highshelf', frequency: f, Q: 1, gain: gainDb }, PASS, PASS, PASS];
    case 'notch': return [{ type: 'notch', frequency: f, Q: q, gain: 0 }, PASS, PASS, PASS];
    case 'bell':
    default: return [{ type: 'peaking', frequency: f, Q: q, gain: gainDb }, PASS, PASS, PASS];
  }
}

export function eqBand(p: Resolved, i: number) {
  const scale = Number(p.scale ?? 100) / 100;
  return {
    on: p[bandKey(i, 'on')] === true,
    type: (p[bandKey(i, 'type')] as EqBandType) ?? 'bell',
    f: Number(p[bandKey(i, 'f')] ?? 1000),
    g: Number(p[bandKey(i, 'g')] ?? 0),
    gScaled: Number(p[bandKey(i, 'g')] ?? 0) * scale,
    q: Number(p[bandKey(i, 'q')] ?? 0.71),
  };
}

export function bandHasGain(type: EqBandType) {
  return type === 'bell' || type === 'lowshelf' || type === 'highshelf';
}
export function bandHasQ(type: EqBandType) {
  return type === 'bell' || type === 'notch' || type === 'lowcut12' || type === 'highcut12';
}

function buildEq(p: Resolved): FxDevice {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);
  const filters: Tone.BiquadFilter[][] = [];
  let prev: Tone.ToneAudioNode = input;
  for (let i = 0; i < EQ_BANDS; i++) {
    const stages: Tone.BiquadFilter[] = [];
    for (let s = 0; s < 4; s++) {
      const f = new Tone.BiquadFilter({ type: 'peaking', frequency: 1000, Q: 1, gain: 0 });
      prev.connect(f);
      prev = f;
      stages.push(f);
    }
    filters.push(stages);
  }
  prev.connect(output);
  const analyser = new Tone.Analyser({ type: 'fft', size: FFT_SIZE, smoothing: 0.8 });
  output.connect(analyser);

  const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
    void _bpm;
    const r = ramp ?? 0.02;
    for (let i = 0; i < EQ_BANDS; i++) {
      const b = eqBand(p, i);
      bandStages(b.type, b.f, b.gScaled, b.q, b.on).forEach((st, s) => {
        const f = filters[i][s];
        if (f.type !== st.type) f.type = st.type;
        setAudioParam(f.frequency, st.frequency, r, time);
        setAudioParam(f.Q, st.Q, r, time);
        setAudioParam(f.gain, st.gain, r, time);
      });
    }
    setAudioParam(output.gain, Tone.dbToGain(Number(p.out ?? 0)), r, time);
  };
  update(p, 120, undefined, 0);

  return {
    input, output, analyser, structKey: 'eq', ready: Promise.resolve(), update,
    dispose: () => { input.dispose(); output.dispose(); analyser.dispose(); filters.flat().forEach((f) => f.dispose()); },
  };
}

/**
 * Exact combined magnitude response of an EQ Eight setting, computed by real
 * Web Audio biquads (never connected), so the drawn curve matches playback.
 */
const curveNodes: BiquadFilterNode[] = [];
export function eqResponse(p: Resolved, freqs: Float32Array<ArrayBuffer>, onlyBand?: number): Float32Array {
  const ctx = Tone.getContext().rawContext as BaseAudioContext;
  while (curveNodes.length < 4) curveNodes.push(ctx.createBiquadFilter());
  const total = new Float32Array(freqs.length).fill(0); // dB
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  for (let i = 0; i < EQ_BANDS; i++) {
    if (onlyBand !== undefined && i !== onlyBand) continue;
    const b = eqBand(p, i);
    if (!b.on) continue;
    for (const st of bandStages(b.type, b.f, b.gScaled, b.q, true)) {
      if (st === PASS) continue;
      const n = curveNodes[0];
      n.type = st.type;
      n.frequency.value = st.frequency;
      n.Q.value = st.Q;
      n.gain.value = st.gain;
      n.getFrequencyResponse(freqs, mag, phase);
      for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(Math.max(1e-6, mag[k]));
    }
  }
  return total;
}

// ───────────────────────── Shared helpers ─────────────────────────

/**
 * Set or schedule a Tone Param/Signal. Uses immediate `.value` on initial
 * construction (ramp <= 0) or unscheduled offline updates to prevent beat-0
 * ramp pops, and schedules at `time` when driven by automation.
 */
function setAudioParam(param: { value: unknown; rampTo: (v: number, r: number, t?: number) => unknown; setValueAtTime?: (v: number, t: number) => unknown }, val: number, ramp: number, time?: number) {
  if (time !== undefined) {
    if (ramp <= 0 && param.setValueAtTime) param.setValueAtTime(val, time);
    else param.rampTo(val, ramp, time);
    return;
  }
  if (ramp <= 0 || Tone.getContext().isOffline) {
    param.value = val;
    return;
  }
  param.rampTo(val, ramp);
}

/** Equal-power dry/wet around a wet chain. */
function dryWet(input: Tone.Gain, output: Tone.Gain) {
  const dry = new Tone.Gain(1);
  const wet = new Tone.Gain(0);
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  return {
    wet,
    set(mix01: number, time?: number, ramp = 0.03) {
      const m = Math.max(0, Math.min(1, mix01));
      setAudioParam(dry.gain, Math.cos((m * Math.PI) / 2), ramp, time);
      setAudioParam(wet.gain, Math.sin((m * Math.PI) / 2), ramp, time);
    },
    dispose() { dry.dispose(); wet.dispose(); },
  };
}

function base(structKey: string) {
  const input = new Tone.Gain(1);
  const output = new Tone.Gain(1);
  const analyser = new Tone.Analyser({ type: 'fft', size: FFT_SIZE, smoothing: 0.8 });
  output.connect(analyser);
  return { input, output, analyser, structKey };
}

const mix: KnobDef = { kind: 'knob', key: 'mix', label: 'Dry/Wet', min: 0, max: 100, def: 100, unit: '%' };
const num = (p: Resolved, k: string) => Number(p[k]);

// ───────────────────────── Device definitions ─────────────────────────

export interface EffectDef {
  label: string;
  /** Device width in the chain, px */
  width: number;
  params: ParamDef[];
  defaults: () => Resolved;
  structKey: (p: Resolved) => string;
  build: (p: Resolved, bpm: number) => FxDevice;
}

function defaultsFrom(params: ParamDef[]): Resolved {
  return Object.fromEntries(params.map((d) => [d.key, d.def]));
}

const COMP_PARAMS: ParamDef[] = [
  { kind: 'knob', key: 'threshold', label: 'Threshold', min: -60, max: 0, def: -18, unit: 'dB' },
  { kind: 'knob', key: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, unit: ':1', log: true },
  { kind: 'knob', key: 'attack', label: 'Attack', min: 0.1, max: 200, def: 10, unit: 'ms', log: true },
  { kind: 'knob', key: 'release', label: 'Release', min: 10, max: 2000, def: 150, unit: 'ms', log: true },
  { kind: 'knob', key: 'knee', label: 'Knee', min: 0, max: 30, def: 6, unit: 'dB' },
  { kind: 'knob', key: 'makeup', label: 'Makeup', min: 0, max: 24, def: 0, unit: 'dB' },
  mix,
];

const LIMITER_PARAMS: ParamDef[] = [
  { kind: 'knob', key: 'gain', label: 'Gain', min: 0, max: 24, def: 0, unit: 'dB' },
  { kind: 'knob', key: 'ceiling', label: 'Ceiling', min: -12, max: 0, def: -0.3, unit: 'dB' },
  { kind: 'knob', key: 'release', label: 'Release', min: 10, max: 1000, def: 100, unit: 'ms', log: true },
];

const REVERB_PARAMS: ParamDef[] = [
  { kind: 'knob', key: 'decay', label: 'Decay', min: 0.2, max: 20, def: 2.5, unit: 's', log: true },
  { kind: 'knob', key: 'predelay', label: 'Pre-Delay', min: 0, max: 250, def: 20, unit: 'ms' },
  { kind: 'knob', key: 'lowcut', label: 'Low Cut', min: 20, max: 2000, def: 120, unit: 'Hz', log: true },
  { kind: 'knob', key: 'highcut', label: 'High Cut', min: 1000, max: 20000, def: 9000, unit: 'Hz', log: true },
  { ...mix, def: 30 },
];

// Ableton-style Delay: two delay lines, each synced (16th-note divisions plus
// a ±33% swing offset) or free (ms). Link makes the right follow the left.
export const DELAY_DIVISIONS = [1, 2, 3, 4, 5, 6, 8, 16];
export const DELAY_MAX_SEC = 5;

const DELAY_PARAMS: ParamDef[] = [
  { kind: 'choice', key: 'mode', label: 'Mode', def: 'stereo', options: [{ value: 'stereo', label: 'Stereo' }, { value: 'pingpong', label: 'Ping Pong' }] },
  { kind: 'knob', key: 'lMs', label: 'L Time', min: 1, max: 5000, def: 250, unit: 'ms', log: true },
  { kind: 'knob', key: 'lOff', label: 'L Offset', min: -33, max: 33, def: 0, unit: '%' },
  { kind: 'knob', key: 'rMs', label: 'R Time', min: 1, max: 5000, def: 250, unit: 'ms', log: true },
  { kind: 'knob', key: 'rOff', label: 'R Offset', min: -33, max: 33, def: 0, unit: '%' },
  { kind: 'knob', key: 'feedback', label: 'Feedback', min: 0, max: 95, def: 35, unit: '%' },
  { kind: 'knob', key: 'fFreq', label: 'Filter Freq', min: 50, max: 18000, def: 1000, unit: 'Hz', log: true },
  { kind: 'knob', key: 'fWidth', label: 'Filter Width', min: 0.5, max: 9, def: 6, unit: 'octw' },
  { ...mix, def: 25 },
];

function delayDefaults(): Resolved {
  return {
    ...defaultsFrom(DELAY_PARAMS),
    link: true, lSync: true, rSync: true, lDiv: 3, rDiv: 4,
    filterOn: true, freeze: false,
  };
}

/** One side's delay time in seconds. */
export function delaySideSeconds(p: Resolved, side: 'l' | 'r', bpm: number): number {
  const s = p.link === true ? 'l' : side;
  const sec = p[`${s}Sync`] === false
    ? Number(p[`${s}Ms`]) / 1000
    : (Number(p[`${s}Div`]) * (1 + Number(p[`${s}Off`]) / 100) * 60) / bpm / 4;
  return Math.min(DELAY_MAX_SEC, Math.max(0.001, sec));
}

// Retro tape / vinyl: saturation, head bump, high-end loss, wow & flutter,
// hiss and crackle (the noises follow the signal, so silence stays silent).
const TAPE_PARAMS: ParamDef[] = [
  { kind: 'knob', key: 'drive', label: 'Drive', min: 0, max: 24, def: 6, unit: 'dB' },
  { kind: 'knob', key: 'bump', label: 'Bump', min: 0, max: 9, def: 3, unit: 'dB' },
  { kind: 'knob', key: 'age', label: 'Age', min: 0, max: 100, def: 30, unit: '%' },
  { kind: 'knob', key: 'wow', label: 'Wow', min: 0, max: 100, def: 25, unit: '%' },
  { kind: 'knob', key: 'flutter', label: 'Flutter', min: 0, max: 100, def: 20, unit: '%' },
  { kind: 'knob', key: 'hiss', label: 'Hiss', min: 0, max: 100, def: 15, unit: '%' },
  { kind: 'knob', key: 'crackle', label: 'Crackle', min: 0, max: 100, def: 0, unit: '%' },
  { kind: 'knob', key: 'output', label: 'Output', min: -18, max: 6, def: 0, unit: 'dB' },
  { ...mix, def: 100 },
];

/** Constant tape delay that wow/flutter modulate around (dry is aligned to it). */
const TAPE_BASE_DELAY = 0.006;

/** A few seconds of sparse vinyl clicks and pops, looped. */
function crackleBuffer(sampleRate: number): AudioBuffer {
  const len = Math.floor(sampleRate * 4.7);
  const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const r = Math.random();
      if (r < 0.0006) {
        // A click: a short decaying burst, occasionally a bigger pop.
        const amp = (Math.random() < 0.08 ? 0.9 : 0.3) * (Math.random() * 0.7 + 0.3);
        const n = 20 + Math.floor(Math.random() * 120);
        for (let k = 0; k < n && i + k < len; k++) d[i + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / (n / 4));
      }
    }
  }
  return buf;
}

function tanhCurve(driveDb: number) {
  const k = Tone.dbToGain(driveDb);
  const norm = Math.tanh(k);
  return (x: number) => Math.tanh(k * x) / norm;
}

const SAT_PARAMS: ParamDef[] = [
  { kind: 'choice', key: 'curve', label: 'Type', def: 'soft', options: [
    { value: 'soft', label: 'Soft Sine' }, { value: 'hard', label: 'Hard Clip' }, { value: 'fold', label: 'Wave Fold' }, { value: 'crush', label: 'Bit Crush' },
  ] },
  { kind: 'knob', key: 'drive', label: 'Drive', min: 0, max: 36, def: 12, unit: 'dB' },
  { kind: 'knob', key: 'bits', label: 'Bits', min: 1, max: 16, def: 6, unit: 'bits', when: (p) => p.curve === 'crush' },
  { kind: 'knob', key: 'tone', label: 'Tone', min: 500, max: 20000, def: 12000, unit: 'Hz', log: true },
  { kind: 'knob', key: 'output', label: 'Output', min: -36, max: 6, def: -6, unit: 'dB' },
  mix,
];

const CHORUS_PARAMS: ParamDef[] = [
  { kind: 'knob', key: 'rate', label: 'Rate', min: 0.05, max: 10, def: 1.2, unit: 'Hz', log: true },
  { kind: 'knob', key: 'depth', label: 'Amount', min: 0, max: 100, def: 60, unit: '%' },
  { kind: 'knob', key: 'delay', label: 'Delay', min: 1, max: 25, def: 4, unit: 'ms' },
  { kind: 'knob', key: 'spread', label: 'Width', min: 0, max: 180, def: 180, unit: '°' },
  { kind: 'knob', key: 'feedback', label: 'Feedback', min: 0, max: 90, def: 10, unit: '%' },
  { ...mix, def: 50 },
];

const FILTER_PARAMS: ParamDef[] = [
  { kind: 'choice', key: 'mode', label: 'Type', def: 'lowpass', options: [
    { value: 'lowpass', label: 'Low-pass' }, { value: 'highpass', label: 'High-pass' }, { value: 'bandpass', label: 'Band-pass' }, { value: 'notch', label: 'Notch' },
  ] },
  { kind: 'choice', key: 'slope', label: 'Slope', def: '-24', options: [{ value: '-12', label: '12 dB' }, { value: '-24', label: '24 dB' }, { value: '-48', label: '48 dB' }] },
  { kind: 'knob', key: 'freq', label: 'Freq', min: 20, max: 20000, def: 2000, unit: 'Hz', log: true },
  { kind: 'knob', key: 'res', label: 'Res', min: 0.1, max: 18, def: 1, unit: '', log: true },
  { kind: 'knob', key: 'lfoAmt', label: 'LFO Amt', min: 0, max: 100, def: 0, unit: '%' },
  { kind: 'knob', key: 'lfoRate', label: 'LFO Rate', min: 0.05, max: 20, def: 1, unit: 'Hz', log: true },
  mix,
];

function satCurve(kind: string): (x: number) => number {
  switch (kind) {
    case 'hard': return (x) => Math.max(-1, Math.min(1, x));
    case 'fold': return (x) => Math.sin(x * Math.PI / 2);
    default: return (x) => Math.tanh(x);
  }
}

export const EFFECT_DEFS: Record<StudioEffectType, EffectDef> = {
  eq: {
    label: 'EQ Eight',
    width: 520,
    params: [],
    defaults: eqDefaults,
    structKey: () => 'eq',
    build: (p) => buildEq(p),
  },

  compressor: {
    label: 'Compressor',
    width: 452,
    params: COMP_PARAMS,
    // sidechain: id of the track that keys the compressor ('' = its own input)
    defaults: () => ({ ...defaultsFrom(COMP_PARAMS), sidechain: '' }),
    structKey: (p) => (p.sidechain ? `comp-sc|${isSynthReady()}` : 'comp'),
    build: (p) => {
      if (p.sidechain) return buildSidechainComp(p);
      const b = base('comp');
      const dw = dryWet(b.input, b.output);
      const comp = new Tone.Compressor();
      const makeup = new Tone.Gain(1);
      b.input.connect(comp);
      comp.connect(makeup);
      makeup.connect(dw.wet);
      const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
        void _bpm;
        const r = ramp ?? 0.02;
        setAudioParam(comp.threshold, num(p, 'threshold'), r, time);
        setAudioParam(comp.ratio, num(p, 'ratio'), r, time);
        setAudioParam(comp.attack, num(p, 'attack') / 1000, r, time);
        setAudioParam(comp.release, num(p, 'release') / 1000, r, time);
        setAudioParam(comp.knee, num(p, 'knee'), r, time);
        setAudioParam(makeup.gain, Tone.dbToGain(num(p, 'makeup')), r, time);
        dw.set(num(p, 'mix') / 100, time, ramp ?? 0.03);
      };
      update(p, 120, undefined, 0);
      return {
        ...b, ready: Promise.resolve(), update,
        getReduction: () => {
          const r = (comp as unknown as { reduction?: number }).reduction;
          return typeof r === 'number' ? r : 0;
        },
        dispose: () => { comp.dispose(); makeup.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },

  limiter: {
    label: 'Limiter',
    width: 300,
    params: LIMITER_PARAMS,
    defaults: () => defaultsFrom(LIMITER_PARAMS),
    structKey: () => 'limiter',
    build: (p) => {
      const b = base('limiter');
      const drive = new Tone.Gain(1);
      // Fast-attack, high-ratio compression at the ceiling, then a hard clip
      // as the final safety so nothing exceeds it.
      const comp = new Tone.Compressor({ ratio: 20, attack: 0.001, knee: 0 });
      const clip = new Tone.WaveShaper((x) => Math.max(-1, Math.min(1, x)), 1024);
      const pre = new Tone.Gain(1);
      const post = new Tone.Gain(1);
      b.input.chain(drive, comp, pre, clip, post, b.output);
      const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
        void _bpm;
        const r = ramp ?? 0.02;
        const ceil = num(p, 'ceiling');
        setAudioParam(drive.gain, Tone.dbToGain(num(p, 'gain')), r, time);
        setAudioParam(comp.threshold, ceil - 1, r, time);
        setAudioParam(comp.release, num(p, 'release') / 1000, r, time);
        // clip at the ceiling: scale up into the shaper, back down after
        setAudioParam(pre.gain, 1 / Tone.dbToGain(ceil), r, time);
        setAudioParam(post.gain, Tone.dbToGain(ceil), r, time);
      };
      update(p, 120, undefined, 0);
      return {
        ...b, ready: Promise.resolve(), update,
        getReduction: () => {
          const r = (comp as unknown as { reduction?: number }).reduction;
          return typeof r === 'number' ? r : 0;
        },
        dispose: () => { drive.dispose(); comp.dispose(); clip.dispose(); pre.dispose(); post.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },

  reverb: {
    label: 'Reverb',
    width: 326,
    params: REVERB_PARAMS,
    defaults: () => defaultsFrom(REVERB_PARAMS),
    structKey: () => 'reverb',
    build: (p) => {
      const b = base('reverb');
      const dw = dryWet(b.input, b.output);
      const reverb = new Tone.Reverb({ decay: num(p, 'decay'), preDelay: num(p, 'predelay') / 1000, wet: 1 });
      const hp = new Tone.Filter({ type: 'highpass', frequency: num(p, 'lowcut'), rolloff: -12 });
      const lp = new Tone.Filter({ type: 'lowpass', frequency: num(p, 'highcut'), rolloff: -12 });
      b.input.chain(reverb, hp, lp, dw.wet);
      let decay = num(p, 'decay'), pre = num(p, 'predelay');
      const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
        void _bpm;
        const r = ramp ?? 0.02;
        // Decay / pre-delay regenerate the impulse response — skip during scheduled automation.
        if (time === undefined) {
          if (num(p, 'decay') !== decay) { decay = num(p, 'decay'); reverb.decay = decay; }
          if (num(p, 'predelay') !== pre) { pre = num(p, 'predelay'); reverb.preDelay = pre / 1000; }
        }
        setAudioParam(hp.frequency, num(p, 'lowcut'), r, time);
        setAudioParam(lp.frequency, num(p, 'highcut'), r, time);
        dw.set(num(p, 'mix') / 100, time, ramp ?? 0.03);
      };
      update(p, 120, undefined, 0);
      return {
        ...b, ready: reverb.ready, update,
        dispose: () => { reverb.dispose(); hp.dispose(); lp.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },

  delay: {
    label: 'Delay',
    width: 470,
    params: DELAY_PARAMS,
    defaults: delayDefaults,
    structKey: () => 'delay2',
    build: (p, bpm) => {
      const b = base('delay2');
      const dw = dryWet(b.input, b.output);
      const split = new Tone.Split(2);
      const merge = new Tone.Merge(2);
      b.input.connect(split);
      const g = (v = 0) => new Tone.Gain(v);
      // Input routing (stereo: L→L, R→R; ping pong: mono sum into the left line)
      const inLL = g(), inRR = g(), inRL = g();
      // Feedback routing (stereo: each line into itself; ping pong: L→R, R→L)
      const fbLL = g(), fbRR = g(), xLR = g(), xRL = g();
      const sumL = g(1), sumR = g(1);
      split.connect(inLL, 0); split.connect(inRR, 1); split.connect(inRL, 1);
      inLL.connect(sumL); inRL.connect(sumL); inRR.connect(sumR);
      const line = (sum: Tone.Gain) => {
        const delay = new Tone.Delay({ delayTime: 0.25, maxDelay: DELAY_MAX_SEC });
        const hp = new Tone.Filter({ type: 'highpass', frequency: 20, rolloff: -12 });
        const lp = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12 });
        sum.chain(delay, hp, lp);
        return { delay, hp, lp, out: lp };
      };
      const L = line(sumL), R = line(sumR);
      L.out.connect(fbLL); fbLL.connect(sumL);
      R.out.connect(fbRR); fbRR.connect(sumR);
      L.out.connect(xLR); xLR.connect(sumR);
      R.out.connect(xRL); xRL.connect(sumL);
      L.out.connect(merge, 0, 0);
      R.out.connect(merge, 0, 1);
      merge.connect(dw.wet);

      const update = (p: Resolved, bpm: number, time?: number, ramp?: number) => {
        const r = ramp ?? 0.02;
        setAudioParam(L.delay.delayTime, delaySideSeconds(p, 'l', bpm), ramp ?? 0.05, time);
        setAudioParam(R.delay.delayTime, delaySideSeconds(p, 'r', bpm), ramp ?? 0.05, time);
        const freeze = p.freeze === true;
        const pp = p.mode === 'pingpong';
        const fb = freeze ? 1 : Math.min(0.95, num(p, 'feedback') / 100);
        const inGain = freeze ? 0 : 1;
        const set = (n: Tone.Gain, v: number) => setAudioParam(n.gain, v, r, time);
        set(inLL, inGain * (pp ? 0.5 : 1));
        set(inRL, pp ? inGain * 0.5 : 0);
        set(inRR, pp ? 0 : inGain);
        set(fbLL, pp ? 0 : fb);
        set(fbRR, pp ? 0 : fb);
        set(xLR, pp ? 1 : 0);
        set(xRL, pp ? fb : 0);
        // Band-pass in the feedback loop, so each repeat gets darker/thinner.
        // Bypassed while frozen so the loop holds instead of fading.
        const filt = p.filterOn === true && !freeze;
        const half = Math.pow(2, num(p, 'fWidth') / 2);
        const lo = filt ? Math.max(20, num(p, 'fFreq') / half) : 10;
        const hi = filt ? Math.min(20000, num(p, 'fFreq') * half) : 22000;
        for (const side of [L, R]) {
          setAudioParam(side.hp.frequency, lo, r, time);
          setAudioParam(side.lp.frequency, hi, r, time);
        }
        dw.set(num(p, 'mix') / 100, time, ramp ?? 0.03);
      };
      update(p, bpm, undefined, 0);
      const nodes = [split, merge, inLL, inRR, inRL, fbLL, fbRR, xLR, xRL, sumL, sumR, L.delay, L.hp, L.lp, R.delay, R.hp, R.lp];
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => { for (const n of nodes) n.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },

  distortion: {
    label: 'Saturator',
    width: 330,
    params: SAT_PARAMS,
    defaults: () => defaultsFrom(SAT_PARAMS),
    structKey: (p) => `sat:${p.curve}`,
    build: (p) => {
      const b = base(`sat:${p.curve}`);
      const dw = dryWet(b.input, b.output);
      const drive = new Tone.Gain(1);
      const tone = new Tone.Filter({ type: 'lowpass', frequency: 12000, rolloff: -12 });
      const out = new Tone.Gain(1);
      let shaper: Tone.WaveShaper | Tone.BitCrusher;
      if (p.curve === 'crush') {
        shaper = new Tone.BitCrusher(num(p, 'bits'));
      } else {
        const ws = new Tone.WaveShaper(satCurve(String(p.curve)), 4096);
        ws.oversample = '4x';
        shaper = ws;
      }
      b.input.chain(drive, shaper, tone, out, dw.wet);
      const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
        void _bpm;
        const r = ramp ?? 0.02;
        setAudioParam(drive.gain, Tone.dbToGain(num(p, 'drive')), r, time);
        if (shaper instanceof Tone.BitCrusher) setAudioParam(shaper.bits, Math.round(num(p, 'bits')), 0, time);
        setAudioParam(tone.frequency, num(p, 'tone'), r, time);
        setAudioParam(out.gain, Tone.dbToGain(num(p, 'output')), r, time);
        dw.set(num(p, 'mix') / 100, time, ramp ?? 0.03);
      };
      update(p, 120, undefined, 0);
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => { drive.dispose(); shaper.dispose(); tone.dispose(); out.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },

  chorus: {
    label: 'Chorus',
    width: 392,
    params: CHORUS_PARAMS,
    defaults: () => defaultsFrom(CHORUS_PARAMS),
    structKey: () => 'chorus',
    build: (p) => {
      const b = base('chorus');
      const dw = dryWet(b.input, b.output);
      const chorus = new Tone.Chorus({ wet: 1 }).start();
      b.input.chain(chorus, dw.wet);
      const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
        void _bpm;
        setAudioParam(chorus.frequency, num(p, 'rate'), ramp ?? 0.05, time);
        if (time === undefined || !Tone.getContext().isOffline) {
          chorus.depth = num(p, 'depth') / 100;
          chorus.delayTime = num(p, 'delay');
          chorus.spread = num(p, 'spread');
        }
        setAudioParam(chorus.feedback, num(p, 'feedback') / 100, ramp ?? 0.02, time);
        dw.set(num(p, 'mix') / 100, time, ramp ?? 0.03);
      };
      update(p, 120, undefined, 0);
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => { chorus.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },

  tape: {
    label: 'Tape',
    width: 330,
    params: TAPE_PARAMS,
    defaults: () => defaultsFrom(TAPE_PARAMS),
    structKey: () => 'tape',
    build: (p) => {
      const b = base('tape');
      const ctx = Tone.getContext();
      // Dry path delayed by the same constant tape delay, so Mix < 100% doesn't comb.
      const dryDelay = new Tone.Delay(TAPE_BASE_DELAY, 0.05);
      const dry = new Tone.Gain(0), wet = new Tone.Gain(1);
      b.input.connect(dryDelay); dryDelay.connect(dry); dry.connect(b.output);
      wet.connect(b.output);

      let driveDb = num(p, 'drive');
      const shaper = new Tone.WaveShaper(tanhCurve(driveDb), 4096);
      shaper.oversample = '4x';
      const bump = new Tone.Filter({ type: 'peaking', frequency: 90, Q: 0.9, gain: 3 });
      const lp = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12, Q: 0.5 });
      const hp = new Tone.Filter({ type: 'highpass', frequency: 25, rolloff: -12 });
      const tape = new Tone.Delay(TAPE_BASE_DELAY, 0.05);
      const out = new Tone.Gain(1);
      b.input.chain(shaper, bump, hp, lp, tape, out, wet);

      // Wow (slow) + flutter (fast) sum onto the delay time.
      const wow = new Tone.LFO({ frequency: 0.6, min: TAPE_BASE_DELAY, max: TAPE_BASE_DELAY, type: 'sine' }).start();
      const flutter = new Tone.LFO({ frequency: 9, min: 0, max: 0, type: 'triangle' }).start();
      wow.connect(tape.delayTime);
      flutter.connect(tape.delayTime);

      // Noise beds, gated by the input level (fast attack, slow release).
      const follower = new Tone.Follower(0.4);
      const gate = new Tone.WaveShaper((x) => Math.min(1, Math.max(0, x * 60)), 1024);
      b.input.connect(follower); follower.connect(gate);
      const noiseGate = new Tone.Gain(0);
      gate.connect(noiseGate.gain);
      const hiss = new Tone.Noise('pink').start();
      const hissHp = new Tone.Filter({ type: 'highpass', frequency: 3000, rolloff: -12 });
      const hissLevel = new Tone.Gain(0);
      hiss.chain(hissHp, hissLevel, noiseGate);
      const crackle = new Tone.Player({ url: new Tone.ToneAudioBuffer(crackleBuffer(ctx.sampleRate)), loop: true });
      crackle.start();
      const crackleBp = new Tone.Filter({ type: 'bandpass', frequency: 2500, Q: 0.7 });
      const crackleLevel = new Tone.Gain(0);
      crackle.chain(crackleBp, crackleLevel, noiseGate);
      noiseGate.connect(wet);

      const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
        void _bpm;
        const nextDrive = num(p, 'drive');
        if (nextDrive !== driveDb && (time === undefined || !ctx.isOffline)) {
          driveDb = nextDrive;
          shaper.setMap(tanhCurve(driveDb));
        }
        // Drive adds level; pull it back so the knob mostly changes colour.
        setAudioParam(out.gain, Tone.dbToGain(num(p, 'output') - nextDrive * 0.5), ramp ?? 0.03, time);
        setAudioParam(bump.gain, num(p, 'bump'), ramp ?? 0.03, time);
        const age = num(p, 'age') / 100;
        setAudioParam(lp.frequency, 20000 * Math.pow(2500 / 20000, age), ramp ?? 0.05, time);
        setAudioParam(hp.frequency, 25 + age * 90, ramp ?? 0.05, time);
        const w = num(p, 'wow') / 100, f = num(p, 'flutter') / 100;
        if (time === undefined || !ctx.isOffline) {
          wow.min = TAPE_BASE_DELAY - w * 0.003; wow.max = TAPE_BASE_DELAY + w * 0.003;
          flutter.min = -f * 0.00035; flutter.max = f * 0.00035;
        }
        setAudioParam(wow.frequency, 0.4 + w * 0.6, ramp ?? 0.1, time);
        setAudioParam(hissLevel.gain, Tone.dbToGain(-62 + (num(p, 'hiss') / 100) * 32) * (num(p, 'hiss') > 0 ? 1 : 0), ramp ?? 0.05, time);
        setAudioParam(crackleLevel.gain, (num(p, 'crackle') / 100) * 0.35, ramp ?? 0.05, time);
        const m = Math.max(0, Math.min(1, num(p, 'mix') / 100));
        setAudioParam(dry.gain, Math.cos((m * Math.PI) / 2), ramp ?? 0.03, time);
        setAudioParam(wet.gain, Math.sin((m * Math.PI) / 2), ramp ?? 0.03, time);
      };
      update(p, 120, undefined, 0);
      const nodes = [dryDelay, dry, wet, shaper, bump, lp, hp, tape, out, wow, flutter, follower, gate, noiseGate, hiss, hissHp, hissLevel, crackle, crackleBp, crackleLevel];
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => {
          try { hiss.stop(); crackle.stop(); } catch { /* not started */ }
          for (const n of nodes) n.dispose();
          b.input.dispose(); b.output.dispose(); b.analyser.dispose();
        },
      };
    },
  },

  filter: {
    label: 'Auto Filter',
    width: 326,
    params: FILTER_PARAMS,
    defaults: () => defaultsFrom(FILTER_PARAMS),
    structKey: (p) => `filter:${p.slope}`,
    build: (p) => {
      const b = base(`filter:${p.slope}`);
      const dw = dryWet(b.input, b.output);
      const af = new Tone.AutoFilter({ frequency: 1, baseFrequency: 2000, octaves: 0, depth: 0, wet: 1,
        filter: { type: 'lowpass', rolloff: Number(p.slope) as -12 | -24 | -48, Q: 1 } }).start();
      b.input.chain(af, dw.wet);
      const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
        void _bpm;
        const amt = num(p, 'lfoAmt') / 100;
        af.filter.type = String(p.mode) as BiquadFilterType;
        setAudioParam(af.filter.Q, num(p, 'res'), ramp ?? 0.02, time);
        // LFO sweeps upward from the cutoff by up to 4 octaves.
        const freq = num(p, 'freq');
        if (time !== undefined && amt <= 0) {
          setAudioParam(af.filter.frequency, freq, ramp ?? 0.02, time);
        } else if (time === undefined || !Tone.getContext().isOffline) {
          af.baseFrequency = freq;
          af.octaves = Math.max(0.0001, amt * 4);
        }
        setAudioParam(af.depth, amt > 0 ? 1 : 0, ramp ?? 0.02, time);
        setAudioParam(af.frequency, num(p, 'lfoRate'), ramp ?? 0.05, time);
        dw.set(num(p, 'mix') / 100, time, ramp ?? 0.03);
      };
      update(p, 120, undefined, 0);
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => { af.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },
};

/** Compressor keyed by another track (AudioWorklet; passes audio through until it loads). */
function buildSidechainComp(p: Resolved): FxDevice {
  // Must equal EFFECT_DEFS.compressor.structKey(p), or the engine rebuilds it every sync.
  const b = base(`comp-sc|${isSynthReady()}`);
  const dw = dryWet(b.input, b.output);
  const sidechain = new Tone.Gain(1);
  const ctx = Tone.getContext();
  let reduction = 0;
  let node: AudioWorkletNode | null = null;
  if (isSynthReady(ctx)) {
    node = ctx.createAudioWorkletNode('abyss-sidechain', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2] });
    Tone.connect(b.input, node, 0, 0);
    Tone.connect(sidechain, node, 0, 1);
    Tone.connect(node, dw.wet);
    node.port.onmessage = (e: MessageEvent) => { if (typeof e.data === 'number') reduction = e.data; };
  } else {
    b.input.connect(dw.wet);
  }
  const update = (p: Resolved, _bpm = 120, time?: number, ramp?: number) => {
    void _bpm;
    node?.port.postMessage({
      type: 'params', threshold: num(p, 'threshold'), ratio: num(p, 'ratio'), attack: num(p, 'attack'),
      release: num(p, 'release'), knee: num(p, 'knee'), makeup: num(p, 'makeup'),
      ...(time !== undefined ? { time } : {}),
    });
    dw.set(num(p, 'mix') / 100, time, ramp ?? 0.03);
  };
  update(p, 120, undefined, 0);
  return {
    ...b, ready: Promise.resolve(), update, sidechain,
    getReduction: () => reduction,
    dispose: () => {
      if (node) { node.port.onmessage = null; node.disconnect(); node.port.close(); }
      sidechain.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose();
    },
  };
}

/**
 * Full parameter set for a device: defaults overlaid with stored params, with
 * older project formats mapped onto the current schema.
 */
export function resolveParams(type: StudioEffectType, raw: StudioParams | undefined): Resolved {
  const def = EFFECT_DEFS[type];
  const p: Resolved = { ...def.defaults() };
  const r = raw ?? {};
  // Legacy (pre-device) formats
  if (type === 'eq' && ('low' in r || 'mid' in r || 'high' in r) && !(bandKey(0, 'type') in r)) {
    const legacy: [number, EqBandType, number, number][] = [[1, 'lowshelf', 250, Number(r.low ?? 0)], [4, 'bell', 1000, Number(r.mid ?? 0)], [6, 'highshelf', 4000, Number(r.high ?? 0)]];
    for (const [i, t, f, g] of legacy) {
      p[bandKey(i, 'type')] = t; p[bandKey(i, 'f')] = f; p[bandKey(i, 'g')] = g; p[bandKey(i, 'on')] = g !== 0;
    }
    return p;
  }
  for (const [k, v] of Object.entries(r)) if (k in p) p[k] = v;
  if (type === 'delay' && !('lDiv' in r) && ('beats' in r || 'sync' in r || 'ms' in r || 'lowcut' in r)) migrateDelayV1(p, r);
  // Projects saved before devices had 0..1 'wet' and no 'mix' key.
  const legacy = type !== 'eq' && !('mix' in r);
  if (legacy) {
    if (typeof r.wet === 'number') p.mix = r.wet * 100;
    if (type === 'delay' && typeof r.time === 'number') { p.lDiv = r.time * 4; p.rDiv = r.time * 4; }
    if (type === 'delay' && typeof r.feedback === 'number') p.feedback = r.feedback * 100;
    if (type === 'distortion' && typeof r.amount === 'number') p.drive = r.amount * 36;
    if (type === 'chorus' && typeof r.frequency === 'number') p.rate = r.frequency;
    if (type === 'chorus' && typeof r.depth === 'number') p.depth = r.depth * 100;
  }
  return p;
}

/** Single-time delay (one Division or ms value, low/high cut) → linked L/R. */
function migrateDelayV1(p: Resolved, r: StudioParams) {
  const free = r.sync === 'free';
  const div = Number(r.beats ?? 0.5) * 4; // beats were quarter notes; divisions are 16ths
  const ms = Number(r.ms ?? 250);
  p.link = true;
  p.lSync = p.rSync = !free;
  p.lDiv = p.rDiv = Number.isFinite(div) && div > 0 ? div : 2;
  p.lMs = p.rMs = Number.isFinite(ms) ? ms : 250;
  const lo = Number(r.lowcut ?? 200), hi = Number(r.highcut ?? 8000);
  if (lo > 0 && hi > lo) {
    p.filterOn = true;
    p.fFreq = Math.sqrt(lo * hi);
    p.fWidth = Math.min(9, Math.max(0.5, Math.log2(hi / lo)));
  }
}

export function buildDevice(type: StudioEffectType, params: Resolved, bpm: number): FxDevice {
  return EFFECT_DEFS[type].build(params, bpm);
}

// ───────────────────────── Formatting ─────────────────────────

export function formatParam(v: number, unit: ParamUnit): string {
  switch (unit) {
    case 'Hz': return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v.toFixed(v < 100 ? 1 : 0)} Hz`;
    case 'dB': return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`;
    case 's': return `${v.toFixed(2)} s`;
    case '%': return `${Math.round(v)} %`;
    case ':1': return `${v.toFixed(1)} : 1`;
    case 'bits': return `${Math.round(v)} bit`;
    case '°': return `${Math.round(v)}°`;
    case 'st': return `${v > 0 ? '+' : ''}${Math.round(v)} st`;
    case 'ct': return `${v > 0 ? '+' : ''}${Math.round(v)} ct`;
    case 'oct': return `${v > 0 ? '+' : ''}${Math.round(v)} oct`;
    case 'octw': return `${v.toFixed(1)} oct`;
    case 'x': return `${Math.round(v)}`;
    default: return v.toFixed(2);
  }
}
