import * as Tone from 'tone';
import type { StudioDoc, StudioInstrument, StudioInstrumentType, StudioParams } from '@abyss/shared';
import { getBuffer } from './assetCache';
import { createWavetableSynth } from './wavetable/synthNode';

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
export const LIVE_UPDATE_TYPES = new Set<StudioInstrumentType>(['synth']);

export const INSTRUMENT_LABELS: Record<StudioInstrumentType, string> = {
  synth: 'Wavetable',
  fm: 'FM Keys',
  am: 'AM Pad',
  mono: 'Mono Lead',
  pluck: 'Pluck',
  bass: 'Bass',
  drums: 'Drum Kit',
  sampler: 'Sampler',
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
  const hz = (pitch: number) => Tone.Frequency(pitch, 'midi').toFrequency();
  return {
    output: synth,
    play: (pitch, dur, time, vel) => synth.triggerAttackRelease(hz(pitch), dur, time, vel),
    noteOn: (pitch, vel, time) => synth.triggerAttack(hz(pitch), time, vel),
    noteOff: (pitch, time) => synth.triggerRelease(hz(pitch), time),
    setPitchBend: (semis) => synth.set({ detune: semis * 100 }),
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
  // Drum voices are monophonic; Tone throws if one is retriggered at the same
  // (or an earlier) time, which happens at loop wraps and with stacked notes.
  const last = new Map<object, number>();
  const at = (voice: object, time: number) => {
    const prev = last.get(voice) ?? -Infinity;
    const t = time > prev ? time : prev + 0.001;
    last.set(voice, t);
    return t;
  };

  return {
    output: out,
    play: (pitch, _dur, time, vel) => {
      switch (pitch) {
        case 35: case 36: kick.triggerAttackRelease('C1', 0.3, at(kick, time), vel); break;
        case 37: case 38: case 40:
          snare.triggerAttackRelease(0.18, at(snare, time), vel);
          snareBody.triggerAttackRelease(180, 0.08, at(snareBody, time), vel * 0.6);
          break;
        case 39: clap.triggerAttackRelease(0.12, at(clap, time), vel); break;
        case 42: case 44: hat.triggerAttackRelease(0.05, at(hat, time), vel * 0.7); break;
        case 46: openHat.triggerAttackRelease(0.35, at(openHat, time), vel * 0.7); break;
        case 49: case 51: case 52: case 55: case 57: case 59:
          cymbal.triggerAttackRelease(pitch === 51 || pitch === 59 ? 400 : 300, 0.6, at(cymbal, time), vel);
          break;
        default: {
          const f = tomFreq[pitch] ?? Tone.Frequency(pitch, 'midi').toFrequency();
          tom.triggerAttackRelease(f, 0.25, at(tom, time), vel);
        }
      }
    },
    releaseAll: () => {},
    dispose: () => { for (const n of nodes) n.dispose(); out.dispose(); },
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
    case 'sampler':
      return sampler(p);
    case 'synth':
    default:
      return createWavetableSynth(p);
  }
}
