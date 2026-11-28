import type { StudioDoc, StudioMeta, StudioTempoEvent } from '../types/studio.js';

// Tempo and time-signature map. The project starts with meta.bpm and
// meta.timeSigNum/Den; doc.tempo holds step changes from a beat onwards.
// Beats are always quarter notes, so the arrangement data never moves when
// tempo changes — only the beat↔seconds mapping and the bar grid do.

export interface TempoSeg { beat: number; sec: number; bpm: number }
export interface SigSeg { beat: number; bar: number; num: number; den: number }
export interface TempoMap { segs: TempoSeg[]; sigs: SigSeg[] }

type TempoSource = { meta: StudioMeta; tempo?: Record<string, StudioTempoEvent> };

const EPS = 1e-6;

export const sigBarBeats = (num: number, den: number) => (num * 4) / den;

let memo: { meta: StudioMeta; tempo: unknown; map: TempoMap } | null = null;

export function tempoMap(doc: TempoSource): TempoMap {
  if (memo && memo.meta === doc.meta && memo.tempo === doc.tempo) return memo.map;
  const map = buildTempoMap(doc);
  memo = { meta: doc.meta, tempo: doc.tempo, map };
  return map;
}

export function buildTempoMap(doc: TempoSource): TempoMap {
  const events = Object.values(doc.tempo ?? {})
    .filter((e) => e && Number.isFinite(e.beat) && e.beat > EPS)
    .sort((a, b) => a.beat - b.beat);

  const segs: TempoSeg[] = [{ beat: 0, sec: 0, bpm: doc.meta.bpm }];
  for (const e of events) {
    if (!e.bpm) continue;
    const last = segs[segs.length - 1];
    if (Math.abs(e.beat - last.beat) < EPS) { last.bpm = e.bpm; continue; }
    if (e.bpm === last.bpm) continue;
    segs.push({ beat: e.beat, sec: last.sec + ((e.beat - last.beat) * 60) / last.bpm, bpm: e.bpm });
  }

  const sigs: SigSeg[] = [{ beat: 0, bar: 0, num: doc.meta.timeSigNum, den: doc.meta.timeSigDen }];
  for (const e of events) {
    if (!e.num || !e.den) continue;
    const last = sigs[sigs.length - 1];
    const len = sigBarBeats(last.num, last.den);
    // Signature changes take effect on the first bar line at or after their beat.
    const bars = Math.ceil((e.beat - last.beat) / len - EPS);
    const beat = last.beat + bars * len;
    if (bars === 0) { last.num = e.num; last.den = e.den; continue; }
    if (e.num === last.num && e.den === last.den) continue;
    sigs.push({ beat, bar: last.bar + bars, num: e.num, den: e.den });
  }
  return { segs, sigs };
}

function segAt<T extends { beat: number }>(list: T[], beat: number): T {
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].beat <= beat + EPS) lo = mid; else hi = mid - 1;
  }
  return list[lo];
}

export function bpmAt(map: TempoMap, beat: number): number {
  return segAt(map.segs, beat).bpm;
}

export function beatToSec(map: TempoMap, beat: number): number {
  const s = segAt(map.segs, beat);
  return s.sec + ((beat - s.beat) * 60) / s.bpm;
}

export function secToBeat(map: TempoMap, sec: number): number {
  let s = map.segs[0];
  for (const seg of map.segs) { if (seg.sec <= sec + EPS) s = seg; else break; }
  return s.beat + ((sec - s.sec) * s.bpm) / 60;
}

/** Seconds between two beats (handles tempo changes in between). */
export function spanSec(map: TempoMap, fromBeat: number, toBeat: number): number {
  return beatToSec(map, toBeat) - beatToSec(map, fromBeat);
}

/** Beats covered by `sec` seconds starting at `fromBeat`. */
export function spanBeats(map: TempoMap, fromBeat: number, sec: number): number {
  return secToBeat(map, beatToSec(map, fromBeat) + sec) - fromBeat;
}

export function sigAt(map: TempoMap, beat: number): SigSeg {
  return segAt(map.sigs, beat);
}

export interface BarInfo { bar: number; start: number; len: number; num: number; den: number }

/** The bar containing `beat` (bar 0 is the first bar). */
export function barAt(map: TempoMap, beat: number): BarInfo {
  const s = sigAt(map, Math.max(0, beat));
  const len = sigBarBeats(s.num, s.den);
  const n = Math.floor((Math.max(0, beat) - s.beat) / len + EPS);
  return { bar: s.bar + n, start: s.beat + n * len, len, num: s.num, den: s.den };
}

/** Start beat of bar `bar` (0-based). */
export function barStart(map: TempoMap, bar: number): number {
  let s = map.sigs[0];
  for (const seg of map.sigs) { if (seg.bar <= bar) s = seg; else break; }
  return s.beat + (bar - s.bar) * sigBarBeats(s.num, s.den);
}

/** Every bar overlapping [from, to). */
export function barsIn(map: TempoMap, from: number, to: number): BarInfo[] {
  const out: BarInfo[] = [];
  let b = barAt(map, Math.max(0, from));
  for (let guard = 0; b.start < to && guard < 100000; guard++) {
    out.push(b);
    b = barAt(map, b.start + b.len);
  }
  return out;
}

/** "bar.beat" position (1-based) honoring signature changes. */
export function formatBarBeat(map: TempoMap, beat: number): string {
  const b = barAt(map, beat);
  const unit = 4 / b.den;
  const inBar = (beat - b.start) / unit;
  return `${b.bar + 1}.${Math.floor(inBar + EPS) + 1}`;
}

export function hasTempoChanges(doc: Pick<StudioDoc, 'tempo'>): boolean {
  return Object.keys(doc.tempo ?? {}).length > 0;
}
