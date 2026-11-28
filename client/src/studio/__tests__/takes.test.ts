import { describe, expect, it, vi } from 'vitest';
import type { StudioDoc, StudioClip } from '@abyss/shared';

vi.mock('../engine/assetCache', () => ({ decodeBlob: vi.fn(), putBuffer: vi.fn() }));
const { muteRangeOps, compOps, packLanes, sliceClip } = await import('../studioUtils');
const { applyOps } = await import('@abyss/shared');

const clip = (start: number, length: number, extra: Partial<StudioClip> = {}): StudioClip =>
  ({ trackId: 'a', kind: 'audio', start, length, gain: 0, assetId: 'x', offset: 0, ...extra });
const mk = (clips: Record<string, StudioClip>): StudioDoc => ({
  meta: { bpm: 60, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16 },
  tracks: { a: { name: 'A', kind: 'audio', order: 0, volume: 0, pan: 0, mute: false, solo: false } },
  clips,
});

describe('takes and comping', () => {
  it('slices audio offsets in source seconds (forward and reversed)', () => {
    const d = mk({});
    // 60 BPM: 1 beat = 1 s
    expect(sliceClip(d, clip(0, 8, { offset: 1 }), 2, 5)).toMatchObject({ start: 2, length: 3, offset: 3 });
    // Reversed: the timeline's start reads the source's end, so the right part keeps the offset.
    expect(sliceClip(d, clip(0, 8, { offset: 1, reverse: true }), 5, 8)).toMatchObject({ start: 5, length: 3, offset: 1 });
    expect(sliceClip(d, clip(0, 8, { offset: 1, reverse: true }), 0, 5)).toMatchObject({ start: 0, length: 5, offset: 4 });
    // Repitched an octave up: twice the source per beat.
    expect(sliceClip(d, clip(0, 8, { pitch: 12 }), 2, 4).offset).toBeCloseTo(4);
  });

  it('mutes what a new take covers, keeping the rest active', () => {
    const d = mk({ old: clip(0, 8) });
    const after = applyOps(d, muteRangeOps(d, 'a', 2, 5));
    const list = Object.values(after.clips).sort((x, y) => x.start - y.start);
    expect(list.map((c) => [c.start, c.length, !!c.mute])).toEqual([[0, 2, false], [2, 3, true], [5, 3, false]]);
    expect(list[2].offset).toBeCloseTo(5);
  });

  it('comps a take in: unmutes it and mutes the overlap', () => {
    const d = mk({ t1: clip(0, 8), t2: clip(0, 8, { mute: true }) });
    const after = applyOps(d, compOps(d, 't2'));
    expect(after.clips.t2.mute).toBeUndefined();
    expect(after.clips.t1.mute).toBe(true);
  });

  it('packs overlapping clips into lanes', () => {
    const { lane, count } = packLanes([['a', clip(0, 4)], ['b', clip(2, 4)], ['c', clip(4, 2)]]);
    expect(count).toBe(2);
    expect(lane).toEqual({ a: 0, b: 1, c: 0 });
  });
});
