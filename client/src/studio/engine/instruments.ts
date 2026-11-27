import * as Tone from 'tone';
import type { StudioInstrument, StudioInstrumentType, StudioEffect, StudioEffectType, StudioParams } from '@abyss/shared';

// Built-in instruments and effects. Everything here is constructed against the
// *current* Tone context so the same factories work for offline export.

export interface PlayableInstrument {
  output: Tone.ToneAudioNode;
  play: (pitch: number, durationSec: number, time: number, velocity: number) => void;
  releaseAll: () => void;
  dispose: () => void;
}

export const INSTRUMENT_LABELS: Record<StudioInstrumentType, string> = {
  synth: 'Poly Synth',
  fm: 'FM Keys',
  am: 'AM Pad',
  mono: 'Mono Lead',
  pluck: 'Pluck',
  bass: 'Bass',
  drums: 'Drum Kit',
};

export const OSC_TYPES = ['sine', 'triangle', 'sawtooth', 'square'] as const;

/** GM-ish drum map used by the drum kit and the piano roll's row labels. */
export const DRUM_MAP: Record<number, string> = {
  36: 'Kick',
  38: 'Snare',
  39: 'Clap',
  42: 'Closed Hat',
  46: 'Open Hat',
  45: 'Low Tom',
  48: 'Mid Tom',
  50: 'High Tom',
  49: 'Crash',
  51: 'Ride',
};

function num(params: StudioParams | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === 'number' ? v : fallback;
}

function osc(params: StudioParams | undefined, fallback: string): string {
  const v = params?.oscillator;
  return typeof v === 'string' && (OSC_TYPES as readonly string[]).includes(v) ? v : fallback;
}

function envelope(params: StudioParams | undefined, d: { attack: number; decay: number; sustain: number; release: number }) {
  return {
    attack: num(params, 'attack', d.attack),
    decay: num(params, 'decay', d.decay),
    sustain: num(params, 'sustain', d.sustain),
    release: num(params, 'release', d.release),
  };
}

function polyInstrument(synth: Tone.PolySynth): PlayableInstrument {
  synth.maxPolyphony = 24;
  return {
    output: synth,
    play: (pitch, dur, time, vel) => synth.triggerAttackRelease(Tone.Frequency(pitch, 'midi').toFrequency(), dur, time, vel),
    releaseAll: () => synth.releaseAll(),
    dispose: () => synth.dispose(),
  };
}

function drumKit(): PlayableInstrument {
  const out = new Tone.Gain(1);
  const kick = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 6, envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.1 } }).connect(out);
  const tom = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 } }).connect(out);
  const snareFilter = new Tone.Filter(1800, 'bandpass').connect(out);
  const snare = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.18, sustain: 0 } }).connect(snareFilter);
  const snareBody = new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.05 } }).connect(out);
  const clap = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.005, decay: 0.12, sustain: 0 } }).connect(snareFilter);
  const hatFilter = new Tone.Filter(7000, 'highpass').connect(out);
  const hat = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.05, sustain: 0 } }).connect(hatFilter);
  const openHat = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.35, sustain: 0 } }).connect(hatFilter);
  const cymbal = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 1.2, release: 0.3 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }).connect(out);
  cymbal.volume.value = -14;
  const nodes = [kick, tom, snare, snareBody, clap, hat, openHat, cymbal, snareFilter, hatFilter];

  const tomFreq: Record<number, number> = { 41: 80, 43: 95, 45: 110, 47: 130, 48: 150, 50: 180 };

  return {
    output: out,
    play: (pitch, _dur, time, vel) => {
      // Mono drum voices throw if retriggered at the exact same time; nudge.
      const t = time;
      switch (pitch) {
        case 35: case 36: kick.triggerAttackRelease('C1', 0.3, t, vel); break;
        case 37: case 38: case 40:
          snare.triggerAttackRelease(0.18, t, vel);
          snareBody.triggerAttackRelease(180, 0.08, t, vel * 0.6);
          break;
        case 39: clap.triggerAttackRelease(0.12, t, vel); break;
        case 42: case 44: hat.triggerAttackRelease(0.05, t, vel * 0.7); break;
        case 46: openHat.triggerAttackRelease(0.35, t, vel * 0.7); break;
        case 49: case 51: case 52: case 55: case 57: case 59:
          cymbal.triggerAttackRelease(pitch === 51 || pitch === 59 ? 400 : 300, 0.6, t, vel);
          break;
        default: {
          const f = tomFreq[pitch] ?? Tone.Frequency(pitch, 'midi').toFrequency();
          tom.triggerAttackRelease(f, 0.25, t, vel);
        }
      }
    },
    releaseAll: () => {},
    dispose: () => { for (const n of nodes) n.dispose(); out.dispose(); },
  };
}

export function createInstrument(inst: StudioInstrument | undefined): PlayableInstrument {
  const p = inst?.params;
  switch (inst?.type ?? 'synth') {
    case 'fm':
      return polyInstrument(new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: num(p, 'harmonicity', 3),
        modulationIndex: num(p, 'modulationIndex', 10),
        envelope: envelope(p, { attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.8 }),
      }));
    case 'am':
      return polyInstrument(new Tone.PolySynth(Tone.AMSynth, {
        harmonicity: num(p, 'harmonicity', 2),
        envelope: envelope(p, { attack: 0.4, decay: 0.3, sustain: 0.7, release: 1.5 }),
      }));
    case 'mono':
      return polyInstrument(new Tone.PolySynth(Tone.MonoSynth, {
        oscillator: { type: osc(p, 'square') as OscillatorType },
        envelope: envelope(p, { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 }),
        filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.4, baseFrequency: num(p, 'cutoff', 300), octaves: 4 },
      }));
    case 'pluck':
      return polyInstrument(new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: osc(p, 'triangle') as OscillatorType },
        envelope: envelope(p, { attack: 0.002, decay: 0.35, sustain: 0, release: 0.3 }),
      }));
    case 'bass':
      return polyInstrument(new Tone.PolySynth(Tone.MonoSynth, {
        oscillator: { type: osc(p, 'sawtooth') as OscillatorType },
        envelope: envelope(p, { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.15 }),
        filterEnvelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: num(p, 'cutoff', 120), octaves: 3 },
      }));
    case 'drums':
      return drumKit();
    case 'synth':
    default:
      return polyInstrument(new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: osc(p, 'sawtooth') as OscillatorType },
        envelope: envelope(p, { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.6 }),
      }));
  }
}

// ───────────────────────── Effects ─────────────────────────

export interface EffectParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export const EFFECT_SPECS: Record<StudioEffectType, { label: string; params: EffectParamSpec[] }> = {
  reverb: { label: 'Reverb', params: [
    { key: 'decay', label: 'Decay', min: 0.2, max: 10, step: 0.1, default: 2.5 },
    { key: 'wet', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.3 },
  ] },
  delay: { label: 'Delay', params: [
    { key: 'time', label: 'Time (beats)', min: 0.125, max: 2, step: 0.125, default: 0.5 },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, default: 0.35 },
    { key: 'wet', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.25 },
  ] },
  eq: { label: 'EQ', params: [
    { key: 'low', label: 'Low (dB)', min: -24, max: 12, step: 0.5, default: 0 },
    { key: 'mid', label: 'Mid (dB)', min: -24, max: 12, step: 0.5, default: 0 },
    { key: 'high', label: 'High (dB)', min: -24, max: 12, step: 0.5, default: 0 },
  ] },
  compressor: { label: 'Compressor', params: [
    { key: 'threshold', label: 'Threshold (dB)', min: -60, max: 0, step: 1, default: -24 },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, default: 4 },
  ] },
  distortion: { label: 'Distortion', params: [
    { key: 'amount', label: 'Drive', min: 0, max: 1, step: 0.01, default: 0.4 },
    { key: 'wet', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1 },
  ] },
  chorus: { label: 'Chorus', params: [
    { key: 'frequency', label: 'Rate (Hz)', min: 0.1, max: 8, step: 0.1, default: 1.5 },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: 'wet', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.5 },
  ] },
};

export function defaultEffectParams(type: StudioEffectType): StudioParams {
  return Object.fromEntries(EFFECT_SPECS[type].params.map((p) => [p.key, p.default]));
}

export async function createEffect(fx: StudioEffect, bpm: number): Promise<Tone.ToneAudioNode> {
  const p = { ...defaultEffectParams(fx.type), ...fx.params };
  const n = (k: string) => Number(p[k]);
  switch (fx.type) {
    case 'reverb': {
      const r = new Tone.Reverb({ decay: n('decay'), wet: n('wet') });
      await r.ready;
      return r;
    }
    case 'delay':
      return new Tone.FeedbackDelay({ delayTime: (n('time') * 60) / bpm, feedback: n('feedback'), wet: n('wet') });
    case 'eq':
      return new Tone.EQ3({ low: n('low'), mid: n('mid'), high: n('high') });
    case 'compressor':
      return new Tone.Compressor({ threshold: n('threshold'), ratio: n('ratio') });
    case 'distortion':
      return new Tone.Distortion({ distortion: n('amount'), wet: n('wet') });
    case 'chorus':
      return new Tone.Chorus({ frequency: n('frequency'), depth: n('depth'), wet: n('wet') }).start();
  }
}
