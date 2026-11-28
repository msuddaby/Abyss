import * as Tone from 'tone';
import type { StudioParams } from '@abyss/shared';
import { getBuffer } from './assetCache';

// Drum Rack: 16 pads, each a synthesized voice (or a sample from the project)
// through its own channel strip: drive → filter → choke/mute gate → pan/level.
// Per-pad params live flat in the instrument params as `d{pitch}_{key}`.

export interface DrumPad { pitch: number; name: string }

/** Pad order: bottom row first (like a hardware 4×4 grid). */
export const DRUM_PADS: DrumPad[] = [
  { pitch: 36, name: 'Kick' }, { pitch: 37, name: 'Rim' }, { pitch: 38, name: 'Snare' }, { pitch: 39, name: 'Clap' },
  { pitch: 42, name: 'Closed Hat' }, { pitch: 44, name: 'Pedal Hat' }, { pitch: 46, name: 'Open Hat' }, { pitch: 54, name: 'Tambourine' },
  { pitch: 45, name: 'Low Tom' }, { pitch: 48, name: 'Mid Tom' }, { pitch: 50, name: 'High Tom' }, { pitch: 56, name: 'Cowbell' },
  { pitch: 49, name: 'Crash' }, { pitch: 51, name: 'Ride' }, { pitch: 70, name: 'Shaker' }, { pitch: 75, name: 'Claves' },
];

/** General MIDI percussion notes that aren't pads, folded onto the nearest pad. */
export const DRUM_ALIASES: Record<number, number> = {
  35: 36, 40: 38, 41: 45, 43: 45, 47: 48, 52: 49, 55: 49, 57: 49, 53: 51, 59: 51, 69: 70, 82: 70, 76: 75, 77: 75,
};

export const PAD_DEFAULTS = { tune: 0, decay: 100, tone: 20000, ftype: 'lp', drive: 0, pan: 0, level: 0, mute: false, solo: false, sample: '' };
export type PadKey = keyof typeof PAD_DEFAULTS;

export const padKey = (pitch: number, k: PadKey) => `d${pitch}_${k}`;

export function padParam<K extends PadKey>(p: StudioParams | undefined, pitch: number, k: K): (typeof PAD_DEFAULTS)[K] {
  const v = p?.[padKey(pitch, k)];
  const def = PAD_DEFAULTS[k];
  return (typeof v === typeof def ? v : def) as (typeof PAD_DEFAULTS)[K];
}

/** Whether closed / pedal hats cut off a ringing open hat (default on). */
export const kitChoke = (p: StudioParams | undefined) => p?.choke !== false;

/** Sample asset ids the kit's pads use. */
export function drumSampleIds(p: StudioParams | undefined): string[] {
  return DRUM_PADS.map((pad) => padParam(p, pad.pitch, 'sample')).filter((s): s is string => !!s);
}

interface Voice {
  output: Tone.ToneAudioNode;
  trigger: (time: number, vel: number, ratio: number, decay: number) => void;
  dispose: () => void;
}

/** Monophonic Tone voices throw on retriggers at the same time; nudge them. */
function monotonic() {
  let last = -Infinity;
  return (t: number) => { last = t > last ? t : last + 0.001; return last; };
}

function membrane(freq: number, decay: number, octaves: number, pitchDecay: number): Voice {
  const s = new Tone.MembraneSynth({ pitchDecay, octaves, envelope: { attack: 0.001, decay, sustain: 0, release: 0.05 } });
  const at = monotonic();
  return {
    output: s,
    trigger: (t, v, r, d) => { s.envelope.decay = decay * d; s.triggerAttackRelease(freq * r, decay * d, at(t), v); },
    dispose: () => s.dispose(),
  };
}

function noise(type: 'white' | 'pink', filter: BiquadFilterType, freq: number, q: number, decay: number, attack = 0.001, gain = 1): Voice {
  const f = new Tone.Filter({ type: filter, frequency: freq, Q: q });
  const s = new Tone.NoiseSynth({ noise: { type }, envelope: { attack, decay, sustain: 0, release: 0.02 } }).connect(f);
  s.volume.value = Tone.gainToDb(gain);
  const at = monotonic();
  return {
    output: f,
    trigger: (t, v, r, d) => {
      f.frequency.setValueAtTime(Math.min(18000, freq * r), t);
      s.envelope.decay = decay * d;
      s.triggerAttackRelease(decay * d, at(t), v);
    },
    dispose: () => { s.dispose(); f.dispose(); },
  };
}

function tone(type: OscillatorType, freq: number, decay: number, filter?: { type: BiquadFilterType; f: number; q: number }): Voice {
  const out = new Tone.Gain(1);
  const f = filter ? new Tone.Filter({ type: filter.type, frequency: filter.f, Q: filter.q }).connect(out) : null;
  const s = new Tone.Synth({ oscillator: { type } as Tone.OmniOscillatorOptions, envelope: { attack: 0.001, decay, sustain: 0, release: 0.01 } }).connect(f ?? out);
  const at = monotonic();
  return {
    output: out,
    trigger: (t, v, r, d) => { s.envelope.decay = decay * d; s.triggerAttackRelease(freq * r, decay * d, at(t), v); },
    dispose: () => { s.dispose(); f?.dispose(); out.dispose(); },
  };
}

function metal(freq: number, decay: number, resonance: number, volume: number): Voice {
  const s = new Tone.MetalSynth({ envelope: { attack: 0.001, decay, release: 0.2 }, harmonicity: 5.1, modulationIndex: 32, resonance, octaves: 1.5 });
  s.volume.value = volume;
  const at = monotonic();
  return {
    output: s,
    trigger: (t, v, r, d) => { s.envelope.decay = decay * d; s.triggerAttackRelease(freq * r, decay * d, at(t), v); },
    dispose: () => s.dispose(),
  };
}

function combine(...voices: Voice[]): Voice {
  const out = new Tone.Gain(1);
  for (const v of voices) v.output.connect(out);
  return {
    output: out,
    trigger: (t, v, r, d) => voices.forEach((x) => x.trigger(t, v, r, d)),
    dispose: () => { voices.forEach((x) => x.dispose()); out.dispose(); },
  };
}

function clap(): Voice {
  const v = noise('pink', 'bandpass', 1100, 1.2, 0.15);
  const at = monotonic();
  return {
    ...v,
    // Three quick bursts then the tail: the classic hand-clap smear.
    trigger: (t, vel, r, d) => {
      const t0 = at(t);
      v.trigger(t0, vel * 0.8, r, 0.05);
      v.trigger(t0 + 0.011, vel * 0.8, r, 0.05);
      v.trigger(t0 + 0.022, vel, r, d);
    },
  };
}

function buildVoice(pitch: number): Voice {
  switch (pitch) {
    case 36: return membrane(32.7, 0.45, 6, 0.05);
    case 37: return tone('square', 1700, 0.03, { type: 'bandpass', f: 2000, q: 2 });
    case 38: return combine(noise('white', 'bandpass', 1800, 0.8, 0.18), tone('triangle', 180, 0.1));
    case 39: return clap();
    case 42: return noise('white', 'highpass', 7000, 0.7, 0.05, 0.001, 0.7);
    case 44: return noise('white', 'highpass', 6500, 0.7, 0.09, 0.001, 0.6);
    case 46: return noise('white', 'highpass', 7000, 0.7, 0.4, 0.001, 0.7);
    case 54: return noise('white', 'bandpass', 9000, 2, 0.14, 0.002, 0.8);
    case 45: return membrane(85, 0.32, 3, 0.08);
    case 48: return membrane(120, 0.3, 3, 0.08);
    case 50: return membrane(165, 0.28, 3, 0.08);
    case 56: return combine(tone('square', 587, 0.35, { type: 'bandpass', f: 900, q: 1.5 }), tone('square', 845, 0.35, { type: 'bandpass', f: 900, q: 1.5 }));
    case 49: return metal(300, 1.3, 4000, -14);
    case 51: return metal(420, 0.9, 6000, -16);
    case 70: return noise('white', 'highpass', 5000, 0.7, 0.07, 0.015, 0.6);
    case 75: return tone('sine', 2500, 0.05);
    default: return membrane(Tone.Frequency(pitch, 'midi').toFrequency(), 0.25, 3, 0.08);
  }
}

function driveCurve(db: number) {
  if (db <= 0) return (x: number) => x;
  const k = Tone.dbToGain(db);
  const norm = Math.tanh(k);
  return (x: number) => Math.tanh(k * x) / norm;
}

interface PadNode {
  voice: Voice | null;
  input: Tone.Gain;
  shaper: Tone.WaveShaper;
  driveDb: number;
  filter: Tone.Filter;
  gate: Tone.Gain;
  panVol: Tone.PanVol;
  ratio: number;
  decay: number;
  sample: string;
}

export function createDrumRack(initial: StudioParams | undefined) {
  // Per-hit nodes (samples) are created at play time; during an offline export
  // that is after Tone has switched back to the live context, so pin ours.
  const context = Tone.getContext();
  const out = new Tone.Gain(1);
  const analyser = new Tone.Analyser('waveform', 1024);
  out.connect(analyser);
  const pads = new Map<number, PadNode>();
  let params = initial ?? {};
  let choke = kitChoke(params);

  for (const pad of DRUM_PADS) {
    const input = new Tone.Gain(1);
    const shaper = new Tone.WaveShaper(driveCurve(0), 2048);
    const filter = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12 });
    const gate = new Tone.Gain(1);
    const panVol = new Tone.PanVol(0, 0);
    input.chain(shaper, filter, gate, panVol, out);
    const voice = buildVoice(pad.pitch);
    voice.output.connect(input);
    pads.set(pad.pitch, { voice, input, shaper, driveDb: 0, filter, gate, panVol, ratio: 1, decay: 1, sample: '' });
  }

  const update = (p: StudioParams) => {
    params = p;
    choke = kitChoke(p);
    const anySolo = DRUM_PADS.some((pad) => padParam(p, pad.pitch, 'solo'));
    for (const pad of DRUM_PADS) {
      const n = pads.get(pad.pitch)!;
      n.ratio = Math.pow(2, padParam(p, pad.pitch, 'tune') / 12);
      n.decay = Math.max(0.05, padParam(p, pad.pitch, 'decay') / 100);
      n.sample = padParam(p, pad.pitch, 'sample');
      const drive = padParam(p, pad.pitch, 'drive');
      if (drive !== n.driveDb) { n.driveDb = drive; n.shaper.setMap(driveCurve(drive)); }
      const ftype = padParam(p, pad.pitch, 'ftype') === 'hp' ? 'highpass' : 'lowpass';
      if (n.filter.type !== ftype) n.filter.type = ftype;
      n.filter.frequency.rampTo(Math.max(20, Math.min(20000, padParam(p, pad.pitch, 'tone'))), 0.02);
      const audible = !padParam(p, pad.pitch, 'mute') && (!anySolo || padParam(p, pad.pitch, 'solo'));
      n.gate.gain.rampTo(audible ? 1 : 0, 0.01);
      n.panVol.pan.rampTo(Math.max(-1, Math.min(1, padParam(p, pad.pitch, 'pan'))), 0.02);
      // Drive adds level; take some back so it mostly changes colour.
      n.panVol.volume.rampTo(padParam(p, pad.pitch, 'level') - drive * 0.4, 0.02);
    }
  };
  update(params);

  const playSample = (n: PadNode, buffer: AudioBuffer, time: number, vel: number) => {
    const g = new Tone.Gain({ context, gain: vel }).connect(n.input);
    const src = new Tone.ToneBufferSource({ context, url: new Tone.ToneAudioBuffer(buffer), playbackRate: n.ratio, fadeOut: 0.01 }).connect(g);
    src.onended = () => { src.dispose(); g.dispose(); };
    src.start(time);
    if (n.decay < 1) src.stop(time + (buffer.duration / n.ratio) * n.decay);
  };

  return {
    output: out,
    analyser,
    update,
    play: (pitch: number, _dur: number, time: number, vel: number) => {
      const padPitch = pads.has(pitch) ? pitch : DRUM_ALIASES[pitch];
      const n = padPitch !== undefined ? pads.get(padPitch) : undefined;
      if (!n || padPitch === undefined) return;
      // Closed / pedal hat chokes the open hat.
      if (choke && (padPitch === 42 || padPitch === 44)) {
        const open = pads.get(46)!;
        open.input.gain.cancelScheduledValues(time);
        open.input.gain.setTargetAtTime(0, time, 0.008);
      }
      if (padPitch === 46) { n.input.gain.cancelScheduledValues(time); n.input.gain.setValueAtTime(1, time); }
      const buf = n.sample ? getBuffer(n.sample) : undefined;
      if (buf) playSample(n, buf, time, vel);
      else n.voice?.trigger(time, vel, n.ratio, n.decay);
    },
    releaseAll: () => {},
    dispose: () => {
      for (const n of pads.values()) {
        n.voice?.dispose();
        n.input.dispose(); n.shaper.dispose(); n.filter.dispose(); n.gate.dispose(); n.panVol.dispose();
      }
      analyser.dispose();
      out.dispose();
    },
    get params() { return params; },
  };
}
