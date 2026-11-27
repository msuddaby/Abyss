import type { StudioParams } from '@abyss/shared';

// Parameter schema for the Wavetable synth. Stored flat in the track's
// instrument.params (the server allows up to 128 keys). Shared by the worklet,
// the main-thread node wrapper and the device UI.

export type SynthParams = Record<string, number | string | boolean>;

export const MOD_SLOTS = 8;

export const MOD_SOURCES = [
  { value: 'env2', label: 'Env 2' },
  { value: 'env3', label: 'Env 3' },
  { value: 'lfo1', label: 'LFO 1' },
  { value: 'lfo2', label: 'LFO 2' },
  { value: 'vel', label: 'Velocity' },
  { value: 'note', label: 'Note #' },
  { value: 'rand', label: 'Random' },
  { value: 'env1', label: 'Env 1 (amp)' },
  { value: 'modwheel', label: 'Mod Wheel' },
] as const;

export const MOD_TARGETS = [
  { value: 'cutoff', label: 'Filter Cutoff' },
  { value: 'res', label: 'Filter Res' },
  { value: 'drive', label: 'Filter Drive' },
  { value: 'posA', label: 'Osc A WT Pos' },
  { value: 'posB', label: 'Osc B WT Pos' },
  { value: 'pitch', label: 'Pitch (±24 st)' },
  { value: 'levelA', label: 'Osc A Level' },
  { value: 'levelB', label: 'Osc B Level' },
  { value: 'detA', label: 'Osc A Detune' },
  { value: 'detB', label: 'Osc B Detune' },
  { value: 'pan', label: 'Pan' },
  { value: 'sub', label: 'Sub Level' },
  { value: 'noise', label: 'Noise Level' },
  { value: 'amp', label: 'Amp' },
] as const;

export const FILTER_TYPES = [
  { value: 'lp24', label: 'LP 24' },
  { value: 'lp12', label: 'LP 12' },
  { value: 'hp24', label: 'HP 24' },
  { value: 'hp12', label: 'HP 12' },
  { value: 'bp', label: 'BP' },
  { value: 'notch', label: 'Notch' },
] as const;

export const LFO_SHAPES = [
  { value: 'sine', label: 'Sine' },
  { value: 'tri', label: 'Tri' },
  { value: 'saw', label: 'Saw' },
  { value: 'ramp', label: 'Ramp' },
  { value: 'square', label: 'Square' },
  { value: 'sh', label: 'S&H' },
] as const;

/** LFO sync divisions, in beats */
export const LFO_SYNC = [
  { value: 8, label: '2 bar' }, { value: 4, label: '1 bar' }, { value: 2, label: '1/2' }, { value: 1, label: '1/4' },
  { value: 0.5, label: '1/8' }, { value: 0.25, label: '1/16' }, { value: 1 / 3, label: '1/8T' }, { value: 0.125, label: '1/32' },
];

function osc(prefix: 'a' | 'b', on: boolean): SynthParams {
  return {
    [`${prefix}On`]: on, [`${prefix}Wt`]: 'basic', [`${prefix}Pos`]: 0.66,
    [`${prefix}Oct`]: 0, [`${prefix}Semi`]: 0, [`${prefix}Fine`]: 0,
    [`${prefix}Uni`]: 1, [`${prefix}Det`]: 0.25, [`${prefix}Blend`]: 0.75, [`${prefix}Width`]: 0.8,
    [`${prefix}Level`]: 0.75, [`${prefix}Pan`]: 0,
  };
}

export function synthDefaults(): SynthParams {
  const p: SynthParams = {
    ...osc('a', true),
    ...osc('b', false),
    bWt: 'basic', bPos: 0, bOct: -1,
    subShape: 'sine', subOct: -1, subLevel: 0,
    noiseLevel: 0,
    fOn: true, fType: 'lp24', fCutoff: 9000, fRes: 0.15, fDrive: 0, fKey: 0,
    e1a: 0.005, e1d: 0.4, e1s: 0.75, e1r: 0.3,
    e2a: 0.005, e2d: 0.5, e2s: 0, e2r: 0.3,
    e3a: 0.2, e3d: 1, e3s: 0.5, e3r: 0.5,
    l1Shape: 'sine', l1Rate: 2, l1Sync: false, l1Div: 1, l1Retrig: true,
    l2Shape: 'tri', l2Rate: 0.3, l2Sync: false, l2Div: 4, l2Retrig: false,
    poly: 8, glide: 0, volume: -6,
    preset: 'Init',
  };
  for (let i = 0; i < MOD_SLOTS; i++) { p[`m${i}src`] = ''; p[`m${i}dst`] = ''; p[`m${i}amt`] = 0; }
  return p;
}

const OSC_POS: Record<string, number> = { sine: 0, triangle: 1 / 3, sawtooth: 2 / 3, square: 1 };

/** Full parameter set; maps the old PolySynth "synth" params onto the new engine. */
export function resolveSynthParams(raw: StudioParams | undefined): SynthParams {
  const p = synthDefaults();
  const r = raw ?? {};
  if (!('aWt' in r)) {
    // Legacy: { oscillator, attack, decay, sustain, release }
    if (typeof r.oscillator === 'string' && r.oscillator in OSC_POS) p.aPos = OSC_POS[r.oscillator];
    for (const [from, to] of [['attack', 'e1a'], ['decay', 'e1d'], ['sustain', 'e1s'], ['release', 'e1r']] as const) {
      if (typeof r[from] === 'number') p[to] = r[from] as number;
    }
    return p;
  }
  for (const [k, v] of Object.entries(r)) if (k in p) p[k] = v;
  return p;
}

// ───────────────────────── Presets ─────────────────────────

function mods(...slots: [string, string, number][]): SynthParams {
  const p: SynthParams = {};
  slots.forEach(([src, dst, amt], i) => { p[`m${i}src`] = src; p[`m${i}dst`] = dst; p[`m${i}amt`] = amt; });
  return p;
}

export const SYNTH_PRESETS: { name: string; params: SynthParams }[] = [
  { name: 'Init', params: {} },
  {
    name: 'Supersaw Lead',
    params: { aWt: 'basic', aPos: 0.66, aUni: 7, aDet: 0.35, aBlend: 0.7, aWidth: 1, bOn: true, bWt: 'pwm', bPos: 0.3, bOct: 1, bLevel: 0.3,
      fType: 'lp24', fCutoff: 7000, fRes: 0.1, e1a: 0.01, e1d: 0.6, e1s: 0.8, e1r: 0.45, glide: 0.03,
      ...mods(['env2', 'cutoff', 0.25]), e2d: 0.4 },
  },
  {
    name: 'Reese Bass',
    params: { aWt: 'basic', aPos: 0.66, aOct: -1, aUni: 2, aDet: 0.12, aBlend: 1, aWidth: 0.4, bOn: true, bWt: 'basic', bPos: 0.66, bOct: -1, bFine: 9, bLevel: 0.7,
      subLevel: 0.4, subOct: -1, fType: 'lp24', fCutoff: 900, fRes: 0.2, fDrive: 0.35, e1a: 0.005, e1s: 1, e1r: 0.15, poly: 1, glide: 0.05,
      l2Rate: 0.25, ...mods(['lfo2', 'cutoff', 0.12], ['lfo2', 'posA', 0.15]) },
  },
  {
    name: 'Wobble Bass',
    params: { aWt: 'growl', aPos: 0.4, aOct: -1, aUni: 3, aDet: 0.08, aBlend: 0.4, subLevel: 0.5, subOct: -1,
      fType: 'lp24', fCutoff: 220, fRes: 0.45, fDrive: 0.5, e1a: 0.003, e1s: 1, e1r: 0.1, poly: 1,
      l1Shape: 'sine', l1Sync: true, l1Div: 0.5, l1Retrig: true, ...mods(['lfo1', 'cutoff', 0.55], ['lfo1', 'posA', 0.5]) },
  },
  {
    name: 'FM Pluck',
    params: { aWt: 'fm', aPos: 0.35, aUni: 2, aDet: 0.1, fType: 'lp24', fCutoff: 500, fRes: 0.25,
      e1a: 0.001, e1d: 0.55, e1s: 0, e1r: 0.35, e2a: 0.001, e2d: 0.22, e2s: 0, e2r: 0.2, ...mods(['env2', 'cutoff', 0.6], ['env2', 'posA', 0.3], ['vel', 'cutoff', 0.2]) },
  },
  {
    name: 'Vowel Pad',
    params: { aWt: 'vowel', aPos: 0.2, aUni: 5, aDet: 0.22, aBlend: 0.8, aWidth: 1, bOn: true, bWt: 'basic', bPos: 0, bOct: 1, bLevel: 0.25,
      fType: 'lp12', fCutoff: 5000, e1a: 0.9, e1d: 1.2, e1s: 0.85, e1r: 1.8, l2Shape: 'tri', l2Rate: 0.12, ...mods(['lfo2', 'posA', 0.7], ['env3', 'cutoff', 0.15]) },
  },
  {
    name: 'Sync Lead',
    params: { aWt: 'sync', aPos: 0.2, aUni: 3, aDet: 0.15, fType: 'lp24', fCutoff: 8000, e1a: 0.005, e1s: 0.9, e1r: 0.25, glide: 0.06,
      e2a: 0.001, e2d: 0.7, e2s: 0, ...mods(['env2', 'posA', 0.7], ['vel', 'amp', 0.2]) },
  },
  {
    name: 'Sub Bass',
    params: { aWt: 'basic', aPos: 0, aOct: -1, aLevel: 0.9, fOn: false, e1a: 0.004, e1d: 0.2, e1s: 1, e1r: 0.12, poly: 1, glide: 0.02, volume: -3 },
  },
];

export function presetParams(name: string): SynthParams {
  const preset = SYNTH_PRESETS.find((p) => p.name === name);
  return { ...synthDefaults(), ...(preset?.params ?? {}), preset: name };
}
