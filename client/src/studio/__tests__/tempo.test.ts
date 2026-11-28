import { describe, expect, it } from 'vitest';
import { buildTempoMap, beatToSec, secToBeat, bpmAt, barsIn, barAt, barStart, formatBarBeat, spanBeats } from '@abyss/shared';
import type { StudioMeta, StudioTempoEvent } from '@abyss/shared';

const meta: StudioMeta = { bpm: 120, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16 };
const doc = (tempo: Record<string, StudioTempoEvent> = {}) => ({ meta, tempo });

describe('tempo map', () => {
  it('is linear without changes', () => {
    const m = buildTempoMap(doc());
    expect(beatToSec(m, 8)).toBeCloseTo(4);
    expect(secToBeat(m, 4)).toBeCloseTo(8);
  });

  it('integrates tempo changes', () => {
    // 120 BPM for 8 beats (4 s), then 60 BPM (1 s per beat)
    const m = buildTempoMap(doc({ a: { beat: 8, bpm: 60 } }));
    expect(beatToSec(m, 8)).toBeCloseTo(4);
    expect(beatToSec(m, 10)).toBeCloseTo(6);
    expect(secToBeat(m, 6)).toBeCloseTo(10);
    expect(bpmAt(m, 7.99)).toBe(120);
    expect(bpmAt(m, 8)).toBe(60);
    // A span crossing the change
    // From beat 6: 1 s reaches beat 8 (at 120), the next 2 s are 2 beats (at 60).
    expect(spanBeats(m, 6, 3)).toBeCloseTo(4);
  });

  it('round-trips seconds and beats', () => {
    const m = buildTempoMap(doc({ a: { beat: 4, bpm: 90 }, b: { beat: 20, bpm: 174 }, c: { beat: 33, bpm: 70 } }));
    for (const b of [0, 3.3, 4, 11, 20, 27.5, 33, 64]) expect(secToBeat(m, beatToSec(m, b))).toBeCloseTo(b, 6);
  });

  it('moves signature changes onto the next bar line', () => {
    // 4/4 then 7/8 asked for at beat 5 (mid bar 2) → starts at bar 3 (beat 8)
    const m = buildTempoMap(doc({ s: { beat: 5, num: 7, den: 8 } }));
    expect(m.sigs).toHaveLength(2);
    expect(m.sigs[1]).toMatchObject({ beat: 8, bar: 2, num: 7, den: 8 });
    const bars = barsIn(m, 0, 15);
    expect(bars.map((b) => b.start)).toEqual([0, 4, 8, 11.5]);
    expect(bars.map((b) => b.len)).toEqual([4, 4, 3.5, 3.5]);
    expect(barAt(m, 12).bar).toBe(3);
    expect(barStart(m, 4)).toBeCloseTo(15);
    expect(formatBarBeat(m, 9)).toBe('3.3'); // 7/8: eighth-note beats
  });
});
