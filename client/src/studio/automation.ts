import { useStudioStore } from '@abyss/shared';
import type { StudioTrack } from '@abyss/shared';
import { EFFECT_DEFS, resolveParams, EQ_BANDS, bandKey, formatParam, type ParamUnit } from './engine/effects';
import { resolveSynthParams } from './engine/wavetable/synthParams';

// Automation lanes: what can be automated on a track, how values map to the
// lane's height, and the recorder that turns live knob moves into points.

export interface LaneDef {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  log?: boolean;
  unit: ParamUnit;
  /** Display multiplier (0..1 params shown as %) */
  scale?: number;
  /** Current (non-automated) value of the parameter */
  base: number;
}

export function toNorm(d: LaneDef, v: number): number {
  const c = Math.min(d.max, Math.max(d.min, v));
  return d.log && d.min > 0 ? Math.log(c / d.min) / Math.log(d.max / d.min) : (c - d.min) / (d.max - d.min);
}

export function fromNorm(d: LaneDef, n: number): number {
  const c = Math.min(1, Math.max(0, n));
  return d.log && d.min > 0 ? d.min * Math.pow(d.max / d.min, c) : d.min + c * (d.max - d.min);
}

export function formatLaneValue(d: LaneDef, v: number): string {
  return formatParam(v * (d.scale ?? 1), d.unit);
}

const SYNTH_LANES: { key: string; label: string; min: number; max: number; log?: boolean; unit: ParamUnit; scale?: number }[] = [
  { key: 'fCutoff', label: 'Filter Cutoff', min: 20, max: 20000, log: true, unit: 'Hz' },
  { key: 'fRes', label: 'Filter Res', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'fDrive', label: 'Filter Drive', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'aPos', label: 'Osc A WT Pos', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'bPos', label: 'Osc B WT Pos', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'aLevel', label: 'Osc A Level', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'bLevel', label: 'Osc B Level', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'aDet', label: 'Osc A Detune', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'bDet', label: 'Osc B Detune', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'aFine', label: 'Osc A Fine', min: -100, max: 100, unit: 'ct' },
  { key: 'bFine', label: 'Osc B Fine', min: -100, max: 100, unit: 'ct' },
  { key: 'subLevel', label: 'Sub Level', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'noiseLevel', label: 'Noise Level', min: 0, max: 1, unit: '%', scale: 100 },
  { key: 'l1Rate', label: 'LFO 1 Rate', min: 0.02, max: 30, log: true, unit: 'Hz' },
  { key: 'l2Rate', label: 'LFO 2 Rate', min: 0.02, max: 30, log: true, unit: 'Hz' },
  { key: 'glide', label: 'Glide', min: 0, max: 1, unit: 's' },
  { key: 'volume', label: 'Synth Master', min: -36, max: 6, unit: 'dB' },
  ...Array.from({ length: 8 }, (_, i) => ({ key: `m${i}amt`, label: `Mod ${i + 1} Amount`, min: -1, max: 1, unit: '%' as ParamUnit, scale: 100 })),
];

/** Every automatable parameter on a track, grouped for the lane picker. */
export function laneDefs(track: StudioTrack): LaneDef[] {
  const out: LaneDef[] = [
    { key: 'vol', label: 'Volume', group: 'Mixer', min: -60, max: 6, unit: 'dB', base: track.volume },
    { key: 'pan', label: 'Pan', group: 'Mixer', min: -1, max: 1, unit: '%', scale: 100, base: track.pan },
  ];
  if (track.kind === 'instrument' && (track.instrument?.type ?? 'synth') === 'synth') {
    const p = resolveSynthParams(track.instrument?.params);
    for (const l of SYNTH_LANES) out.push({ ...l, key: `inst:${l.key}`, group: 'Wavetable', base: Number(p[l.key]) });
  }
  for (const fx of track.effects ?? []) {
    const def = EFFECT_DEFS[fx.type];
    if (!def) continue;
    const p = resolveParams(fx.type, fx.params);
    const group = def.label;
    if (fx.type === 'eq') {
      for (let i = 0; i < EQ_BANDS; i++) {
        out.push({ key: `fx:${fx.id}:${bandKey(i, 'f')}`, label: `Band ${i + 1} Freq`, group, min: 20, max: 20000, log: true, unit: 'Hz', base: Number(p[bandKey(i, 'f')]) });
        out.push({ key: `fx:${fx.id}:${bandKey(i, 'g')}`, label: `Band ${i + 1} Gain`, group, min: -15, max: 15, unit: 'dB', base: Number(p[bandKey(i, 'g')]) });
        out.push({ key: `fx:${fx.id}:${bandKey(i, 'q')}`, label: `Band ${i + 1} Q`, group, min: 0.1, max: 18, log: true, unit: '', base: Number(p[bandKey(i, 'q')]) });
      }
      out.push({ key: `fx:${fx.id}:scale`, label: 'Scale', group, min: -200, max: 200, unit: '%', base: Number(p.scale) });
      out.push({ key: `fx:${fx.id}:out`, label: 'Output', group, min: -24, max: 24, unit: 'dB', base: Number(p.out) });
      continue;
    }
    for (const k of def.params) {
      if (k.kind !== 'knob') continue;
      out.push({ key: `fx:${fx.id}:${k.key}`, label: k.label, group, min: k.min, max: k.max, log: k.log, unit: k.unit, base: Number(p[k.key]) });
    }
  }
  return out;
}

export function laneDef(track: StudioTrack, key: string): LaneDef | undefined {
  return laneDefs(track).find((d) => d.key === key);
}

// ───────────────────────── Recording ─────────────────────────

let context: { armed: boolean; beat: () => number | null } = { armed: false, beat: () => null };
const buffers = new Map<string, { trackId: string; lane: string; points: [number, number][] }>();

/** Called by StudioView: whether recording is armed and how to read the playhead. */
export function setAutomationContext(c: typeof context) {
  context = c;
}

export function isAutomationRecording(): boolean {
  return context.armed && context.beat() !== null;
}

/**
 * Record a live value for a lane (no-op unless armed and playing). Points are
 * buffered and committed as one edit when the control is released, replacing
 * existing points in the recorded span.
 */
export function recordAutomation(trackId: string, lane: string, value: number) {
  if (!context.armed) return;
  const beat = context.beat();
  if (beat === null || !Number.isFinite(value)) return;
  const k = `${trackId}|${lane}`;
  let buf = buffers.get(k);
  const last = buf?.points[buf.points.length - 1];
  if (buf && last && beat < last[0] - 1e-6) {
    // Transport looped: commit what we have and start a new pass.
    commitBuffer(k);
    buf = undefined;
  }
  if (!buf) { buf = { trackId, lane, points: [] }; buffers.set(k, buf); }
  const prev = buf.points[buf.points.length - 1];
  const b = Math.round(beat * 1000) / 1000;
  if (prev && b - prev[0] < 1 / 32) prev[1] = value;
  else buf.points.push([b, value]);
}

/** Commit every buffered lane on a track whose key starts with `prefix`. Returns true if anything was recorded. */
export function finishAutomation(trackId: string, prefix = ''): boolean {
  let any = false;
  for (const [k, buf] of [...buffers]) {
    if (buf.trackId === trackId && buf.lane.startsWith(prefix)) any = commitBuffer(k) || any;
  }
  return any;
}

function commitBuffer(k: string): boolean {
  const buf = buffers.get(k);
  buffers.delete(k);
  if (!buf || !buf.points.length) return false;
  const st = useStudioStore.getState();
  const track = st.doc?.tracks[buf.trackId];
  if (!track) return false;
  const lo = buf.points[0][0], hi = buf.points[buf.points.length - 1][0];
  const kept = (track.automation?.[buf.lane] ?? []).filter(([b]) => b < lo - 1e-6 || b > hi + 1e-6);
  const merged = [...kept, ...buf.points].sort((a, b) => a[0] - b[0]).slice(0, 4000);
  st.edit([{ t: 'set', path: ['tracks', buf.trackId, 'automation', buf.lane], value: merged }]);
  return true;
}

/** Diff two flat param sets and record every changed numeric value under `prefix`. */
export function recordParamDiff(trackId: string, prefix: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  if (!context.armed) return;
  for (const [key, v] of Object.entries(after)) {
    if (typeof v === 'number' && v !== before[key]) recordAutomation(trackId, `${prefix}${key}`, v);
  }
}
