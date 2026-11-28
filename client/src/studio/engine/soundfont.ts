import * as Tone from 'tone';
import type { StudioAsset, StudioParams } from '@abyss/shared';
import { assetUrl, notifyAssetLoaded } from './assetCache';
import type { PlayableInstrument } from './instruments';

// SoundFont 2.01 (.sf2) RIFF parser, per-asset shared cache, and Web Audio
// playback engine. Works identically on the live AudioContext and inside
// Tone.OfflineContext (WAV / stem / bounce export).

export interface Sf2Sample {
  name: string;
  start: number;
  end: number;
  startLoop: number;
  endLoop: number;
  sampleRate: number;
  originalPitch: number;
  pitchCorrection: number;
  sampleLink: number;
  sampleType: number;
}

export interface Sf2Zone {
  sampleId: number;
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  startOffset: number;
  endOffset: number;
  startLoopOffset: number;
  endLoopOffset: number;
  /** 0 = no loop, 1 = loop continuously, 3 = loop while held then tail */
  sampleMode: number;
  rootKey: number;
  coarseTune: number;
  fineTune: number;
  scaleTuning: number;
  /** -1..1 */
  pan: number;
  /** Linear gain from initialAttenuation */
  attenuationGain: number;
  /** Hz */
  filterFc: number;
  /** dB */
  filterQ: number;
  delaySec: number;
  attackSec: number;
  holdSec: number;
  decaySec: number;
  /** 0..1 */
  sustainGain: number;
  releaseSec: number;
  exclusiveClass: number;
}

export interface Sf2Preset {
  name: string;
  bank: number;
  program: number;
  zones: Sf2Zone[];
}

export interface ParsedSoundFont {
  name: string;
  presets: Sf2Preset[];
  samples: Sf2Sample[];
  /** Raw 16-bit signed PCM sample pool from sdta/smpl */
  smpl: Int16Array;
  /** Lazily materialized Web Audio buffers keyed by sampleId */
  buffers: Map<number, AudioBuffer>;
}

export function isSoundFontFile(file: { name: string }): boolean {
  return /\.sf2$/i.test(file.name);
}

export function isSoundFontAsset(asset: Pick<StudioAsset, 'url' | 'name'>): boolean {
  return /\.sf2($|\?)/i.test(asset.url);
}

// ───────────────────────── SF2 RIFF Parser ─────────────────────────

const GEN_START_ADDR = 0;
const GEN_END_ADDR = 1;
const GEN_STARTLOOP_ADDR = 2;
const GEN_ENDLOOP_ADDR = 3;
const GEN_START_ADDR_COARSE = 4;
const GEN_INIT_FILTER_FC = 8;
const GEN_INIT_FILTER_Q = 9;
const GEN_END_ADDR_COARSE = 12;
const GEN_PAN = 17;
const GEN_DELAY_VOL_ENV = 33;
const GEN_ATTACK_VOL_ENV = 34;
const GEN_HOLD_VOL_ENV = 35;
const GEN_DECAY_VOL_ENV = 36;
const GEN_SUSTAIN_VOL_ENV = 37;
const GEN_RELEASE_VOL_ENV = 38;
const GEN_INSTRUMENT = 41;
const GEN_KEY_RANGE = 43;
const GEN_VEL_RANGE = 44;
const GEN_STARTLOOP_COARSE = 45;
const GEN_INIT_ATTENUATION = 48;
const GEN_ENDLOOP_COARSE = 50;
const GEN_COARSE_TUNE = 51;
const GEN_FINE_TUNE = 52;
const GEN_SAMPLE_ID = 53;
const GEN_SAMPLE_MODES = 54;
const GEN_SCALE_TUNING = 56;
const GEN_EXCLUSIVE_CLASS = 57;
const GEN_OVERRIDING_ROOT_KEY = 58;

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let end = start + len;
  for (let i = start; i < start + len; i++) {
    if (bytes[i] === 0) { end = i; break; }
  }
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
}

const s16 = (u: number) => (u >= 0x8000 ? u - 0x10000 : u);
const tcToSec = (tc: number) => (tc <= -12000 ? 0 : Math.pow(2, Math.max(-12000, Math.min(8000, tc)) / 1200));
const centsToRate = (c: number) => Math.pow(2, c / 1200);
const centsToHz = (c: number) => Math.max(20, Math.min(20000, 8.1757989156 * Math.pow(2, c / 1200)));

interface RawGen { op: number; val: number }
interface RawZone { gens: Map<number, number>; keyLo: number; keyHi: number; velLo: number; velHi: number; target: number }

function parseBags(
  bagStart: number,
  bagEnd: number,
  bags: Uint16Array,
  gens: RawGen[],
  targetOp: number,
): { global: RawZone | null; locals: RawZone[] } {
  let global: RawZone | null = null;
  const locals: RawZone[] = [];
  for (let b = bagStart; b < bagEnd; b++) {
    const gStart = bags[b];
    const gEnd = b + 1 < bags.length ? bags[b + 1] : gens.length;
    const map = new Map<number, number>();
    let keyLo = 0, keyHi = 127, velLo = 0, velHi = 127, target = -1;
    for (let g = gStart; g < gEnd && g < gens.length; g++) {
      const { op, val } = gens[g];
      if (op === GEN_KEY_RANGE) { keyLo = val & 0xff; keyHi = (val >> 8) & 0xff; }
      else if (op === GEN_VEL_RANGE) { velLo = val & 0xff; velHi = (val >> 8) & 0xff; }
      else if (op === targetOp) { target = val; }
      else map.set(op, val);
    }
    const z: RawZone = { gens: map, keyLo, keyHi, velLo, velHi, target };
    if (target < 0) {
      if (b === bagStart) global = z;
    } else {
      locals.push(z);
    }
  }
  return { global, locals };
}

export function parseSoundFont(buf: ArrayBuffer): ParsedSoundFont {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'sfbk') {
    throw new Error('Not a valid SoundFont (.sf2) file');
  }

  let name = '';
  let smplOffset = -1;
  let smplLen = 0;
  const chunks = new Map<string, { off: number; len: number }>();

  const walk = (start: number, end: number) => {
    let pos = start;
    while (pos + 8 <= end) {
      const id = ascii(bytes, pos, 4);
      const len = view.getUint32(pos + 4, true);
      const dataStart = pos + 8;
      const dataEnd = Math.min(end, dataStart + len);
      if (id === 'LIST' && dataStart + 4 <= dataEnd) {
        const listType = ascii(bytes, dataStart, 4);
        if (listType === 'INFO' || listType === 'sdta' || listType === 'pdta') {
          walk(dataStart + 4, dataEnd);
        }
      } else if (id === 'INAM') {
        name = ascii(bytes, dataStart, dataEnd - dataStart);
      } else if (id === 'smpl') {
        smplOffset = dataStart;
        smplLen = dataEnd - dataStart;
      } else {
        chunks.set(id, { off: dataStart, len: dataEnd - dataStart });
      }
      pos = dataStart + len + (len & 1);
    }
  };
  walk(12, buf.byteLength);

  const phdrC = chunks.get('phdr');
  const pbagC = chunks.get('pbag');
  const pgenC = chunks.get('pgen');
  const instC = chunks.get('inst');
  const ibagC = chunks.get('ibag');
  const igenC = chunks.get('igen');
  const shdrC = chunks.get('shdr');
  if (smplOffset < 0 || !phdrC || !pbagC || !pgenC || !instC || !ibagC || !igenC || !shdrC) {
    throw new Error('SoundFont is missing required chunks');
  }

  // Copy 16-bit PCM sample pool (aligned copy if smplOffset isn't even).
  const sampleCount = Math.floor(smplLen / 2);
  const smpl = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) smpl[i] = view.getInt16(smplOffset + i * 2, true);

  // Parse shdr (46 bytes each; last record is EOS)
  const samples: Sf2Sample[] = [];
  const shdrCount = Math.max(0, Math.floor(shdrC.len / 46) - 1);
  for (let i = 0; i < shdrCount; i++) {
    const o = shdrC.off + i * 46;
    samples.push({
      name: ascii(bytes, o, 20),
      start: view.getUint32(o + 20, true),
      end: view.getUint32(o + 24, true),
      startLoop: view.getUint32(o + 28, true),
      endLoop: view.getUint32(o + 32, true),
      sampleRate: view.getUint32(o + 36, true) || 44100,
      originalPitch: view.getUint8(o + 40),
      pitchCorrection: view.getInt8(o + 41),
      sampleLink: view.getUint16(o + 42, true),
      sampleType: view.getUint16(o + 44, true),
    });
  }

  const readBags = (c: { off: number; len: number }) => {
    const n = Math.floor(c.len / 4);
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getUint16(c.off + i * 4, true);
    return out;
  };
  const readGens = (c: { off: number; len: number }): RawGen[] => {
    const n = Math.floor(c.len / 4);
    const out: RawGen[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ op: view.getUint16(c.off + i * 4, true), val: view.getUint16(c.off + i * 4 + 2, true) });
    }
    return out;
  };

  const pbag = readBags(pbagC);
  const pgen = readGens(pgenC);
  const ibag = readBags(ibagC);
  const igen = readGens(igenC);

  // Parse inst (22 bytes each; last is EOI)
  const instCount = Math.max(0, Math.floor(instC.len / 22) - 1);
  const instBagNdx: number[] = [];
  for (let i = 0; i <= instCount; i++) instBagNdx.push(view.getUint16(instC.off + i * 22 + 20, true));

  const instZones = Array.from({ length: instCount }, (_, i) =>
    parseBags(instBagNdx[i], instBagNdx[i + 1], ibag, igen, GEN_SAMPLE_ID),
  );

  // Parse phdr (38 bytes each; last is EOP)
  const phdrCount = Math.max(0, Math.floor(phdrC.len / 38) - 1);
  const presets: Sf2Preset[] = [];
  for (let i = 0; i < phdrCount; i++) {
    const o = phdrC.off + i * 38;
    const pName = ascii(bytes, o, 20) || `Preset ${i}`;
    const program = view.getUint16(o + 20, true);
    const bank = view.getUint16(o + 22, true);
    const bagStart = view.getUint16(o + 24, true);
    const bagEnd = view.getUint16(o + 38 + 24, true);

    const pParsed = parseBags(bagStart, bagEnd, pbag, pgen, GEN_INSTRUMENT);
    const zones: Sf2Zone[] = [];

    for (const pz of pParsed.locals) {
      const instIdx = pz.target;
      if (instIdx < 0 || instIdx >= instZones.length) continue;
      const iParsed = instZones[instIdx];

      // Preset key/vel range (local overrides global)
      const pKeyLo = pz.keyLo !== 0 || pz.keyHi !== 127 ? pz.keyLo : (pParsed.global?.keyLo ?? 0);
      const pKeyHi = pz.keyLo !== 0 || pz.keyHi !== 127 ? pz.keyHi : (pParsed.global?.keyHi ?? 127);
      const pVelLo = pz.velLo !== 0 || pz.velHi !== 127 ? pz.velLo : (pParsed.global?.velLo ?? 0);
      const pVelHi = pz.velLo !== 0 || pz.velHi !== 127 ? pz.velHi : (pParsed.global?.velHi ?? 127);

      const pOffset = (op: number) => {
        if (pz.gens.has(op)) return s16(pz.gens.get(op)!);
        if (pParsed.global?.gens.has(op)) return s16(pParsed.global.gens.get(op)!);
        return 0;
      };

      for (const iz of iParsed.locals) {
        const sampleId = iz.target;
        if (sampleId < 0 || sampleId >= samples.length) continue;
        const smp = samples[sampleId];

        const iKeyLo = iz.keyLo !== 0 || iz.keyHi !== 127 ? iz.keyLo : (iParsed.global?.keyLo ?? 0);
        const iKeyHi = iz.keyLo !== 0 || iz.keyHi !== 127 ? iz.keyHi : (iParsed.global?.keyHi ?? 127);
        const iVelLo = iz.velLo !== 0 || iz.velHi !== 127 ? iz.velLo : (iParsed.global?.velLo ?? 0);
        const iVelHi = iz.velLo !== 0 || iz.velHi !== 127 ? iz.velHi : (iParsed.global?.velHi ?? 127);

        const keyLo = Math.max(pKeyLo, iKeyLo);
        const keyHi = Math.min(pKeyHi, iKeyHi);
        const velLo = Math.max(pVelLo, iVelLo);
        const velHi = Math.min(pVelHi, iVelHi);
        if (keyLo > keyHi || velLo > velHi) continue;

        const iVal = (op: number, def: number, signed = true): number => {
          const raw = iz.gens.has(op) ? iz.gens.get(op)! : iParsed.global?.gens.get(op);
          if (raw === undefined) return def;
          return signed ? s16(raw) : raw;
        };

        const gen = (op: number, def: number) => iVal(op, def, true) + pOffset(op);

        const rootRaw = iVal(GEN_OVERRIDING_ROOT_KEY, -1, true);
        const rootKey = rootRaw >= 0 && rootRaw <= 127 ? rootRaw : (smp.originalPitch <= 127 ? smp.originalPitch : 60);
        const attCb = Math.max(0, gen(GEN_INIT_ATTENUATION, 0));
        // SF2 spec / FluidSynth convention: attenuation centibels (scaled slightly for musical loudness)
        const attenuationGain = Math.pow(10, -(attCb * 0.4) / 200);
        const sustainCb = Math.max(0, Math.min(1440, gen(GEN_SUSTAIN_VOL_ENV, 0)));
        const sustainGain = sustainCb >= 1440 ? 0.0001 : Math.pow(10, -sustainCb / 200);
        const pan = Math.max(-1, Math.min(1, gen(GEN_PAN, 0) / 500));

        zones.push({
          sampleId,
          keyLo,
          keyHi,
          velLo,
          velHi,
          startOffset: iVal(GEN_START_ADDR, 0) + iVal(GEN_START_ADDR_COARSE, 0) * 32768,
          endOffset: iVal(GEN_END_ADDR, 0) + iVal(GEN_END_ADDR_COARSE, 0) * 32768,
          startLoopOffset: iVal(GEN_STARTLOOP_ADDR, 0) + iVal(GEN_STARTLOOP_COARSE, 0) * 32768,
          endLoopOffset: iVal(GEN_ENDLOOP_ADDR, 0) + iVal(GEN_ENDLOOP_COARSE, 0) * 32768,
          sampleMode: iVal(GEN_SAMPLE_MODES, 0, false) & 3,
          rootKey,
          coarseTune: gen(GEN_COARSE_TUNE, 0),
          fineTune: gen(GEN_FINE_TUNE, 0) + smp.pitchCorrection,
          scaleTuning: Math.max(0, gen(GEN_SCALE_TUNING, 100)),
          pan,
          attenuationGain,
          filterFc: centsToHz(gen(GEN_INIT_FILTER_FC, 13500)),
          filterQ: Math.max(0, gen(GEN_INIT_FILTER_Q, 0) / 10),
          delaySec: tcToSec(gen(GEN_DELAY_VOL_ENV, -12000)),
          attackSec: Math.max(0.001, tcToSec(gen(GEN_ATTACK_VOL_ENV, -12000))),
          holdSec: tcToSec(gen(GEN_HOLD_VOL_ENV, -12000)),
          decaySec: Math.max(0.001, tcToSec(gen(GEN_DECAY_VOL_ENV, -12000))),
          sustainGain,
          releaseSec: Math.max(0.005, tcToSec(gen(GEN_RELEASE_VOL_ENV, -12000))),
          exclusiveClass: iVal(GEN_EXCLUSIVE_CLASS, 0, false),
        });
      }
    }

    if (zones.length > 0) presets.push({ name: pName, bank, program, zones });
  }

  presets.sort((a, b) => a.bank - b.bank || a.program - b.program || a.name.localeCompare(b.name));
  return { name: name || 'SoundFont', presets, samples, smpl, buffers: new Map() };
}

/** Find the best matching preset for a MIDI bank + program (with graceful fallback). */
export function findPreset(sf: ParsedSoundFont, bank: number, program: number, preferDrums = false): Sf2Preset | undefined {
  if (!sf.presets.length) return undefined;
  const exact = sf.presets.find((p) => p.bank === bank && p.program === program);
  if (exact) return exact;
  if (preferDrums) {
    const drumExact = sf.presets.find((p) => p.bank === 128 && p.program === program);
    if (drumExact) return drumExact;
    const anyDrum = sf.presets.find((p) => p.bank === 128);
    if (anyDrum) return anyDrum;
  }
  const sameProg = sf.presets.find((p) => p.bank === 0 && p.program === program)
    ?? sf.presets.find((p) => p.program === program);
  if (sameProg) return sameProg;
  return sf.presets[0];
}

export function formatPresetLabel(p: Pick<Sf2Preset, 'bank' | 'program' | 'name'>): string {
  const b = String(p.bank).padStart(3, '0');
  const pr = String(p.program).padStart(3, '0');
  return `${b}:${pr} ${p.name}`;
}

function getSampleBuffer(sf: ParsedSoundFont, zone: Sf2Zone, rawCtx: BaseAudioContext): { buffer: AudioBuffer; loopStart: number; loopEnd: number } | null {
  const smp = sf.samples[zone.sampleId];
  if (!smp) return null;
  const start = Math.max(0, Math.min(sf.smpl.length, smp.start + zone.startOffset));
  const end = Math.max(start, Math.min(sf.smpl.length, smp.end + zone.endOffset));
  const len = end - start;
  if (len <= 0) return null;

  // Cache key includes offsets when a zone trims the sample; usually offsets are 0.
  const cacheKey = zone.startOffset === 0 && zone.endOffset === 0 ? zone.sampleId : -(zone.sampleId * 1_000_003 + start);
  let buffer = sf.buffers.get(cacheKey);
  if (!buffer) {
    const sr = Math.max(8000, Math.min(192000, smp.sampleRate));
    buffer = rawCtx.createBuffer(1, len, sr);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = sf.smpl[start + i] / 32768;
    sf.buffers.set(cacheKey, buffer);
  }
  const sr = buffer.sampleRate;
  const loopStart = Math.max(0, (smp.startLoop + zone.startLoopOffset - start) / sr);
  const loopEnd = Math.min(buffer.duration, (smp.endLoop + zone.endLoopOffset - start) / sr);
  return { buffer, loopStart, loopEnd };
}

// ───────────────────────── Shared Cache ─────────────────────────

const sfCache = new Map<string, ParsedSoundFont>();
const sfInflight = new Map<string, Promise<ParsedSoundFont>>();

export function getSoundFont(assetId: string): ParsedSoundFont | undefined {
  return sfCache.get(assetId);
}

export function putSoundFont(assetId: string, sf: ParsedSoundFont) {
  sfCache.set(assetId, sf);
  notifyAssetLoaded(assetId);
}

export function loadSoundFont(assetId: string, url: string): Promise<ParsedSoundFont> {
  const cached = sfCache.get(assetId);
  if (cached) return Promise.resolve(cached);
  const pending = sfInflight.get(assetId);
  if (pending) return pending;

  const promise = (async () => {
    const res = await fetch(assetUrl(url));
    if (!res.ok) throw new Error(`Failed to fetch SoundFont (${res.status})`);
    const parsed = parseSoundFont(await res.arrayBuffer());
    putSoundFont(assetId, parsed);
    return parsed;
  })().finally(() => sfInflight.delete(assetId));
  sfInflight.set(assetId, promise);
  return promise;
}

// ───────────────────────── Web Audio Instrument ─────────────────────────

export const SOUNDFONT_DEFAULTS = {
  bank: 0,
  program: 0,
  tune: 0,
  attack: 1,
  release: 1,
  cutoff: 20000,
  res: 0.7,
  volume: 0,
};

function num(p: StudioParams | undefined, k: keyof typeof SOUNDFONT_DEFAULTS): number {
  const v = p?.[k];
  return typeof v === 'number' ? v : SOUNDFONT_DEFAULTS[k];
}

interface ActiveVoice {
  src: AudioBufferSourceNode;
  env: GainNode;
  pan: StereoPannerNode;
  filter: BiquadFilterNode | null;
  pitch: number;
  baseCents: number;
  releaseSec: number;
  exclusiveClass: number;
  loopMode: number;
  released: boolean;
}

export function createSoundFontInstrument(initial: StudioParams | undefined): PlayableInstrument {
  const context = Tone.getContext();
  const rawCtx = context.rawContext as BaseAudioContext;
  const isOffline = context.isOffline;

  let params: StudioParams = initial ?? {};
  const out = new Tone.Gain(Tone.dbToGain(num(params, 'volume')));
  const masterFilter = new Tone.Filter({
    type: 'lowpass',
    frequency: num(params, 'cutoff'),
    Q: num(params, 'res'),
    rolloff: -12,
  });
  const analyser = new Tone.Analyser('waveform', 1024);
  masterFilter.connect(out);
  out.connect(analyser);
  // Raw Web Audio destination node on the pinned context
  const filterIn = (masterFilter.input as unknown as { _gainNode?: AudioNode })._gainNode ?? (masterFilter.input as unknown as AudioNode);

  let bendSemis = 0;
  const voices = new Set<ActiveVoice>();
  const held = new Map<number, ActiveVoice[]>();

  const cleanup = (v: ActiveVoice) => {
    if (!voices.delete(v)) return;
    try { v.src.disconnect(); } catch { /* */ }
    try { v.filter?.disconnect(); } catch { /* */ }
    try { v.env.disconnect(); } catch { /* */ }
    try { v.pan.disconnect(); } catch { /* */ }
  };

  const releaseVoice = (v: ActiveVoice, time: number) => {
    if (v.released) return;
    v.released = true;
    const t = Math.max(time, rawCtx.currentTime);
    const rel = Math.max(0.005, v.releaseSec * Math.max(0.1, num(params, 'release')));
    try {
      v.env.gain.cancelScheduledValues(t);
      if (typeof v.env.gain.cancelAndHoldAtTime === 'function') {
        v.env.gain.cancelAndHoldAtTime(t);
      } else {
        v.env.gain.setValueAtTime(Math.max(0.0001, v.env.gain.value), t);
      }
      v.env.gain.exponentialRampToValueAtTime(0.0001, t + rel);
      v.env.gain.linearRampToValueAtTime(0, t + rel + 0.005);
      if (v.loopMode === 3) v.src.loop = false;
      v.src.stop(t + rel + 0.01);
    } catch {
      cleanup(v);
    }
  };

  const currentPreset = (): { sf: ParsedSoundFont; preset: Sf2Preset } | null => {
    const assetId = typeof params.assetId === 'string' ? params.assetId : '';
    if (!assetId) return null;
    const sf = getSoundFont(assetId);
    if (!sf) return null;
    const preset = findPreset(sf, num(params, 'bank'), num(params, 'program'));
    return preset ? { sf, preset } : null;
  };

  const triggerZones = (pitch: number, vel: number, time: number, dur: number | null): ActiveVoice[] => {
    const found = currentPreset();
    if (!found) return [];
    const { sf, preset } = found;
    const midiVel = Math.max(1, Math.min(127, Math.round(vel * 127)));
    const matching = preset.zones.filter(
      (z) => pitch >= z.keyLo && pitch <= z.keyHi && midiVel >= z.velLo && midiVel <= z.velHi,
    );
    if (!matching.length) return [];

    const tuneSemis = num(params, 'tune');
    const atkScale = Math.max(0.1, num(params, 'attack'));
    const relScale = Math.max(0.1, num(params, 'release'));
    // Concave MIDI velocity curve (SF2 standard approximates vel^2)
    const velGain = Math.max(0.01, vel * vel);
    const started: ActiveVoice[] = [];

    for (const z of matching) {
      // Choke existing voices sharing the same non-zero exclusiveClass (e.g. hi-hats)
      if (z.exclusiveClass > 0) {
        for (const v of voices) {
          if (v.exclusiveClass === z.exclusiveClass && !v.released) {
            v.releaseSec = 0.01;
            releaseVoice(v, time);
          }
        }
      }

      const sampleData = getSampleBuffer(sf, z, rawCtx);
      if (!sampleData) continue;

      const src = rawCtx.createBufferSource();
      src.buffer = sampleData.buffer;
      const canLoop = (z.sampleMode === 1 || z.sampleMode === 3) && sampleData.loopEnd > sampleData.loopStart + 0.001;
      if (canLoop) {
        src.loop = true;
        src.loopStart = sampleData.loopStart;
        src.loopEnd = sampleData.loopEnd;
      }

      const semitones = (pitch - z.rootKey) * (z.scaleTuning / 100) + z.coarseTune + tuneSemis;
      const baseCents = semitones * 100 + z.fineTune;
      // playbackRate, not detune: standardized-audio-context's buffer source has no detune param.
      src.playbackRate.setValueAtTime(centsToRate(baseCents + bendSemis * 100), time);

      const env = rawCtx.createGain();
      const peak = Math.min(1.5, velGain * z.attenuationGain);
      const t0 = time + z.delaySec;
      const atk = Math.max(0.001, z.attackSec * atkScale);
      const hold = z.holdSec;
      const dec = Math.max(0.001, z.decaySec);
      const sus = Math.max(0.0001, peak * z.sustainGain);

      env.gain.setValueAtTime(0.0001, time);
      if (z.delaySec > 0) env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + atk);
      if (hold > 0) env.gain.setValueAtTime(peak, t0 + atk + hold);
      if (z.sustainGain < 0.999) {
        env.gain.exponentialRampToValueAtTime(sus, t0 + atk + hold + dec);
      }

      const pan = rawCtx.createStereoPanner();
      pan.pan.setValueAtTime(z.pan, time);

      let filter: BiquadFilterNode | null = null;
      if (z.filterFc < 19000 || z.filterQ > 0.5) {
        filter = rawCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(z.filterFc, time);
        filter.Q.setValueAtTime(Math.max(0.1, z.filterQ), time);
        src.connect(filter);
        filter.connect(env);
      } else {
        src.connect(env);
      }
      env.connect(pan);
      pan.connect(filterIn);

      const voice: ActiveVoice = {
        src, env, pan, filter, pitch, baseCents,
        releaseSec: z.releaseSec, exclusiveClass: z.exclusiveClass, loopMode: z.sampleMode, released: false,
      };
      voices.add(voice);
      src.onended = () => cleanup(voice);
      src.start(t0);

      if (dur !== null) {
        const relAt = time + Math.max(0.005, dur);
        const rel = Math.max(0.005, z.releaseSec * relScale);
        // Compute approximate gain at release point for smooth release ramp
        const tDecayStart = t0 + atk + hold;
        const tDecayEnd = tDecayStart + dec;
        let relStartGain = peak;
        if (relAt <= t0) relStartGain = 0.0001;
        else if (relAt < t0 + atk) relStartGain = Math.max(0.0001, peak * ((relAt - t0) / atk));
        else if (relAt >= tDecayEnd) relStartGain = sus;
        else if (relAt > tDecayStart && z.sustainGain < 0.999) {
          const frac = (relAt - tDecayStart) / dec;
          relStartGain = Math.max(0.0001, peak * Math.pow(sus / Math.max(0.0001, peak), frac));
        }
        env.gain.cancelScheduledValues(relAt);
        env.gain.setValueAtTime(relStartGain, relAt);
        env.gain.exponentialRampToValueAtTime(0.0001, relAt + rel);
        env.gain.linearRampToValueAtTime(0, relAt + rel + 0.005);
        src.stop(relAt + rel + 0.01);
        voice.released = true;
      }
      started.push(voice);
    }
    return started;
  };

  const applyParams = (p: StudioParams) => {
    params = p;
    const vol = Tone.dbToGain(num(p, 'volume'));
    const fc = Math.max(40, Math.min(20000, num(p, 'cutoff')));
    const q = Math.max(0.1, Math.min(18, num(p, 'res')));
    if (isOffline) {
      out.gain.value = vol;
      masterFilter.frequency.value = fc;
      masterFilter.Q.value = q;
    } else {
      out.gain.rampTo(vol, 0.02);
      masterFilter.frequency.rampTo(fc, 0.02);
      masterFilter.Q.rampTo(q, 0.02);
    }
  };

  return {
    output: out,
    analyser,
    play: (pitch, dur, time, vel) => { triggerZones(pitch, vel, time, dur); },
    noteOn: (pitch, vel, time) => {
      const prev = held.get(pitch);
      if (prev) for (const v of prev) releaseVoice(v, time);
      const started = triggerZones(pitch, vel, time, null);
      if (started.length) held.set(pitch, started);
    },
    noteOff: (pitch, time) => {
      const list = held.get(pitch);
      held.delete(pitch);
      if (list) for (const v of list) releaseVoice(v, time);
    },
    setPitchBend: (semis) => {
      bendSemis = semis;
      const now = rawCtx.currentTime;
      for (const v of voices) {
        try { v.src.playbackRate.setValueAtTime(centsToRate(v.baseCents + semis * 100), now); } catch { /* */ }
      }
    },
    update: applyParams,
    setParam: (key, value, time, rampSec) => {
      const ramp = rampSec ?? 0.03;
      if (key === 'cutoff') {
        const fc = Math.max(40, Math.min(20000, value));
        if (time !== undefined) masterFilter.frequency.rampTo(fc, ramp, time);
        else masterFilter.frequency.rampTo(fc, isOffline ? 0 : ramp);
      } else if (key === 'res') {
        const q = Math.max(0.1, Math.min(18, value));
        if (time !== undefined) masterFilter.Q.rampTo(q, ramp, time);
        else masterFilter.Q.rampTo(q, isOffline ? 0 : ramp);
      } else if (key === 'volume') {
        const g = Tone.dbToGain(value);
        if (time !== undefined) out.gain.rampTo(g, ramp, time);
        else out.gain.rampTo(g, isOffline ? 0 : ramp);
      }
    },
    releaseAll: () => {
      held.clear();
      const now = rawCtx.currentTime;
      for (const v of [...voices]) {
        try { v.src.stop(now); } catch { /* */ }
        cleanup(v);
      }
    },
    dispose: () => {
      held.clear();
      for (const v of [...voices]) {
        try { v.src.stop(); } catch { /* */ }
        cleanup(v);
      }
      masterFilter.dispose();
      out.dispose();
      analyser.dispose();
    },
  };
}
