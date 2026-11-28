import * as Tone from 'tone';
import type { StudioParams } from '@abyss/shared';
import workletUrl from './synth.worklet.ts?worker&url';
import { resolveSynthParams } from './synthParams';
import type { PlayableInstrument } from '../instruments';

// Main-thread side of the Wavetable synth: loads the worklet module once per
// audio context (live and each offline export), then wraps the node as a
// PlayableInstrument. Notes are posted with their context time and scheduled
// sample-accurately inside the worklet.
//
// We load the module on the raw context ourselves: Tone caches a single
// worklet module per context for its own processors (e.g. BitCrusher).

type RawWithWorklet = { audioWorklet?: { addModule: (url: string) => Promise<void> } };

const loading = new WeakMap<object, Promise<void>>();
const ready = new WeakSet<object>();

export function ensureSynthWorklet(ctx: Tone.BaseContext = Tone.getContext()): Promise<void> {
  const raw = ctx.rawContext as unknown as RawWithWorklet & object;
  let p = loading.get(raw);
  if (!p) {
    if (!raw.audioWorklet) return Promise.reject(new Error('AudioWorklet unavailable (needs a secure context)'));
    p = raw.audioWorklet.addModule(workletUrl).then(() => { ready.add(raw); });
    loading.set(raw, p);
  }
  return p;
}

export function isSynthReady(ctx: Tone.BaseContext = Tone.getContext()): boolean {
  return ready.has(ctx.rawContext as unknown as object);
}

export function createWavetableSynth(params: StudioParams | undefined): PlayableInstrument {
  const ctx = Tone.getContext();
  const out = new Tone.Gain(1);
  const analyser = new Tone.Analyser({ type: 'waveform', size: 1024 });
  out.connect(analyser);

  if (!isSynthReady(ctx)) {
    // Silent until the module loads; the engine rebuilds instruments then.
    return { output: out, analyser, play: () => {}, releaseAll: () => {}, dispose: () => { out.dispose(); analyser.dispose(); } };
  }

  const node = ctx.createAudioWorkletNode('abyss-wavetable', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  Tone.connect(node, out);
  let bpm = 120;
  let last = params;
  const send = () => node.port.postMessage({ type: 'params', p: resolveSynthParams(last), bpm });
  send();

  return {
    output: out,
    analyser,
    play: (pitch, dur, time, vel) => node.port.postMessage({ type: 'note', time, pitch, vel, dur }),
    noteOn: (pitch, vel) => node.port.postMessage({ type: 'liveOn', pitch, vel }),
    noteOff: (pitch) => node.port.postMessage({ type: 'liveOff', pitch }),
    setParam: (key, value, time) => node.port.postMessage({ type: 'param', key, value, ...(time !== undefined ? { time } : {}) }),
    setPitchBend: (semis) => node.port.postMessage({ type: 'bend', semis }),
    setModWheel: (value) => node.port.postMessage({ type: 'modwheel', value }),
    releaseAll: () => node.port.postMessage({ type: 'off' }),
    update: (p) => { last = p; send(); },
    setBpm: (b, time) => {
      if (time === undefined && b === bpm) return;
      if (time === undefined) bpm = b;
      node.port.postMessage({ type: 'bpm', bpm: b, ...(time !== undefined ? { time } : {}) });
    },
    dispose: () => {
      node.port.postMessage({ type: 'off' });
      node.disconnect();
      node.port.close();
      out.dispose();
      analyser.dispose();
    },
  };
}
