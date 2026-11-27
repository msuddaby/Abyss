import * as Tone from 'tone';
import type { StudioEffectType, StudioParams } from '@abyss/shared';

// Effect "devices" in the spirit of Ableton's: each has a parameter schema
// (drives the knobs), a live-updatable Tone.js graph, and an output analyser
// for the spectrum display. Param changes call update() on the running device;
// only `structKey` changes (e.g. delay mode) force a rebuild.

export type ParamUnit = 'Hz' | 'dB' | 'ms' | 's' | '%' | ':1' | 'beats' | 'bits' | '°' | 'st' | 'ct' | 'oct' | 'x' | '';

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
  update: (p: Resolved, bpm: number) => void;
  /** Compressor gain reduction in dB (≤ 0) */
  getReduction?: () => number;
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

  const update = (p: Resolved) => {
    for (let i = 0; i < EQ_BANDS; i++) {
      const b = eqBand(p, i);
      bandStages(b.type, b.f, b.gScaled, b.q, b.on).forEach((st, s) => {
        const f = filters[i][s];
        if (f.type !== st.type) f.type = st.type;
        f.frequency.rampTo(st.frequency, 0.02);
        f.Q.rampTo(st.Q, 0.02);
        f.gain.rampTo(st.gain, 0.02);
      });
    }
    output.gain.rampTo(Tone.dbToGain(Number(p.out ?? 0)), 0.02);
  };
  update(p);

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

/** Equal-power dry/wet around a wet chain. */
function dryWet(input: Tone.Gain, output: Tone.Gain) {
  const dry = new Tone.Gain(1);
  const wet = new Tone.Gain(0);
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  return {
    wet,
    set(mix01: number) {
      const m = Math.max(0, Math.min(1, mix01));
      dry.gain.rampTo(Math.cos((m * Math.PI) / 2), 0.03);
      wet.gain.rampTo(Math.sin((m * Math.PI) / 2), 0.03);
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

const DELAY_SYNC_OPTIONS = [
  { value: '0.25', label: '1/16' }, { value: '0.5', label: '1/8' }, { value: '0.75', label: '1/8 D' },
  { value: '1', label: '1/4' }, { value: '1.5', label: '1/4 D' }, { value: '2', label: '1/2' }, { value: '4', label: '1 bar' },
];

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

const REVERB_PARAMS: ParamDef[] = [
  { kind: 'knob', key: 'decay', label: 'Decay', min: 0.2, max: 20, def: 2.5, unit: 's', log: true },
  { kind: 'knob', key: 'predelay', label: 'Pre-Delay', min: 0, max: 250, def: 20, unit: 'ms' },
  { kind: 'knob', key: 'lowcut', label: 'Low Cut', min: 20, max: 2000, def: 120, unit: 'Hz', log: true },
  { kind: 'knob', key: 'highcut', label: 'High Cut', min: 1000, max: 20000, def: 9000, unit: 'Hz', log: true },
  { ...mix, def: 30 },
];

const DELAY_PARAMS: ParamDef[] = [
  { kind: 'choice', key: 'mode', label: 'Mode', def: 'stereo', options: [{ value: 'stereo', label: 'Stereo' }, { value: 'pingpong', label: 'Ping Pong' }] },
  { kind: 'choice', key: 'sync', label: 'Time', def: 'sync', options: [{ value: 'sync', label: 'Sync' }, { value: 'free', label: 'ms' }] },
  { kind: 'choice', key: 'beats', label: 'Division', def: '0.5', options: DELAY_SYNC_OPTIONS, when: (p) => p.sync !== 'free' },
  { kind: 'knob', key: 'ms', label: 'Time', min: 1, max: 2000, def: 250, unit: 'ms', log: true, when: (p) => p.sync === 'free' },
  { kind: 'knob', key: 'feedback', label: 'Feedback', min: 0, max: 95, def: 35, unit: '%' },
  { kind: 'knob', key: 'lowcut', label: 'Low Cut', min: 20, max: 2000, def: 200, unit: 'Hz', log: true },
  { kind: 'knob', key: 'highcut', label: 'High Cut', min: 1000, max: 20000, def: 8000, unit: 'Hz', log: true },
  { ...mix, def: 25 },
];

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
    defaults: () => defaultsFrom(COMP_PARAMS),
    structKey: () => 'comp',
    build: (p) => {
      const b = base('comp');
      const dw = dryWet(b.input, b.output);
      const comp = new Tone.Compressor();
      const makeup = new Tone.Gain(1);
      b.input.connect(comp);
      comp.connect(makeup);
      makeup.connect(dw.wet);
      const update = (p: Resolved) => {
        comp.threshold.rampTo(num(p, 'threshold'), 0.02);
        comp.ratio.rampTo(num(p, 'ratio'), 0.02);
        comp.attack.rampTo(num(p, 'attack') / 1000, 0.02);
        comp.release.rampTo(num(p, 'release') / 1000, 0.02);
        comp.knee.rampTo(num(p, 'knee'), 0.02);
        makeup.gain.rampTo(Tone.dbToGain(num(p, 'makeup')), 0.02);
        dw.set(num(p, 'mix') / 100);
      };
      update(p);
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
      const update = (p: Resolved) => {
        // Decay / pre-delay regenerate the impulse response — only when changed.
        if (num(p, 'decay') !== decay) { decay = num(p, 'decay'); reverb.decay = decay; }
        if (num(p, 'predelay') !== pre) { pre = num(p, 'predelay'); reverb.preDelay = pre / 1000; }
        hp.frequency.rampTo(num(p, 'lowcut'), 0.02);
        lp.frequency.rampTo(num(p, 'highcut'), 0.02);
        dw.set(num(p, 'mix') / 100);
      };
      update(p);
      return {
        ...b, ready: reverb.ready, update,
        dispose: () => { reverb.dispose(); hp.dispose(); lp.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },

  delay: {
    label: 'Delay',
    width: 340,
    params: DELAY_PARAMS,
    defaults: () => defaultsFrom(DELAY_PARAMS),
    structKey: (p) => `delay:${p.mode}`,
    build: (p, bpm) => {
      const b = base(`delay:${p.mode}`);
      const dw = dryWet(b.input, b.output);
      const delay = p.mode === 'pingpong'
        ? new Tone.PingPongDelay({ delayTime: 0.25, feedback: 0.3, wet: 1, maxDelay: 4 })
        : new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 1, maxDelay: 4 });
      const hp = new Tone.Filter({ type: 'highpass', frequency: 200, rolloff: -12 });
      const lp = new Tone.Filter({ type: 'lowpass', frequency: 8000, rolloff: -12 });
      b.input.chain(delay, hp, lp, dw.wet);
      const update = (p: Resolved, bpm: number) => {
        const sec = p.sync === 'free' ? num(p, 'ms') / 1000 : (Number(p.beats) * 60) / bpm;
        delay.delayTime.rampTo(Math.min(4, Math.max(0.001, sec)), 0.05);
        delay.feedback.rampTo(num(p, 'feedback') / 100, 0.02);
        hp.frequency.rampTo(num(p, 'lowcut'), 0.02);
        lp.frequency.rampTo(num(p, 'highcut'), 0.02);
        dw.set(num(p, 'mix') / 100);
      };
      update(p, bpm);
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => { delay.dispose(); hp.dispose(); lp.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
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
      const update = (p: Resolved) => {
        drive.gain.rampTo(Tone.dbToGain(num(p, 'drive')), 0.02);
        if (shaper instanceof Tone.BitCrusher) shaper.bits.value = Math.round(num(p, 'bits'));
        tone.frequency.rampTo(num(p, 'tone'), 0.02);
        out.gain.rampTo(Tone.dbToGain(num(p, 'output')), 0.02);
        dw.set(num(p, 'mix') / 100);
      };
      update(p);
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
      const update = (p: Resolved) => {
        chorus.frequency.rampTo(num(p, 'rate'), 0.05);
        chorus.depth = num(p, 'depth') / 100;
        chorus.delayTime = num(p, 'delay');
        chorus.spread = num(p, 'spread');
        chorus.feedback.rampTo(num(p, 'feedback') / 100, 0.02);
        dw.set(num(p, 'mix') / 100);
      };
      update(p);
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => { chorus.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
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
      const update = (p: Resolved) => {
        const amt = num(p, 'lfoAmt') / 100;
        af.filter.type = String(p.mode) as BiquadFilterType;
        af.filter.Q.rampTo(num(p, 'res'), 0.02);
        // LFO sweeps upward from the cutoff by up to 4 octaves.
        af.baseFrequency = num(p, 'freq');
        af.octaves = Math.max(0.0001, amt * 4);
        af.depth.rampTo(amt > 0 ? 1 : 0, 0.02);
        af.frequency.rampTo(num(p, 'lfoRate'), 0.05);
        dw.set(num(p, 'mix') / 100);
      };
      update(p);
      return {
        ...b, ready: Promise.resolve(), update,
        dispose: () => { af.dispose(); dw.dispose(); b.input.dispose(); b.output.dispose(); b.analyser.dispose(); },
      };
    },
  },
};

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
  // Projects saved before devices had 0..1 'wet' and no 'mix' key.
  const legacy = type !== 'eq' && !('mix' in r);
  if (legacy) {
    if (typeof r.wet === 'number') p.mix = r.wet * 100;
    if (type === 'delay' && typeof r.time === 'number') p.beats = String(r.time);
    if (type === 'delay' && typeof r.feedback === 'number') p.feedback = r.feedback * 100;
    if (type === 'distortion' && typeof r.amount === 'number') p.drive = r.amount * 36;
    if (type === 'chorus' && typeof r.frequency === 'number') p.rate = r.frequency;
    if (type === 'chorus' && typeof r.depth === 'number') p.depth = r.depth * 100;
  }
  return p;
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
    case 'x': return `${Math.round(v)}`;
    default: return v.toFixed(2);
  }
}
