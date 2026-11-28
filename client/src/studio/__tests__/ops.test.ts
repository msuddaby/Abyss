import { describe, expect, it } from 'vitest';
import { applyOps, invertOps } from '@abyss/shared';
import type { StudioDoc, StudioOp } from '@abyss/shared';

const base = (): StudioDoc => ({
  meta: { bpm: 120, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16 },
  tracks: {
    a: { name: 'A', kind: 'audio', order: 0, volume: 0, pan: 0, mute: false, solo: false },
    r: { name: 'R', kind: 'return', order: 1, volume: 0, pan: 0, mute: false, solo: false },
  },
  clips: { c: { trackId: 'a', kind: 'audio', start: 0, length: 4, gain: 0, assetId: 'x' } },
  markers: {},
  tempo: {},
});

/** Absent ≡ {} for containers inside an entity (a track's sends after the last one is removed). */
function canon(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => canon(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => !(depth >= 2 && x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length))
    .map(([k, x]) => [k, canon(x, depth + 1)]));
}

describe('studio ops', () => {
  const batches: StudioOp[][] = [
    [{ t: 'set', path: ['tracks', 'a', 'sends', 'r'], value: -6 }, { t: 'set', path: ['tracks', 'a', 'output'], value: 'g' }],
    [{ t: 'set', path: ['markers', 'm'], value: { beat: 8, name: 'Verse' } }, { t: 'set', path: ['tempo', 't'], value: { beat: 16, bpm: 100 } }],
    [{ t: 'set', path: ['clips', 'c', 'warp'], value: true }, { t: 'set', path: ['meta', 'masterVolume'], value: -3 }],
    [{ t: 'del', path: ['tracks', 'a'] }],
  ];

  it('inverts every batch exactly', () => {
    let doc = base();
    for (const ops of batches) {
      const inv = invertOps(doc, ops);
      const after = applyOps(doc, ops);
      expect(canon(applyOps(after, inv))).toEqual(canon(doc));
      doc = after;
    }
  });

  it('cascades track deletes to clips', () => {
    const d = applyOps(base(), [{ t: 'del', path: ['tracks', 'a'] }]);
    expect(d.clips.c).toBeUndefined();
  });

  it('drops field ops on missing entities', () => {
    const d = base();
    expect(applyOps(d, [{ t: 'set', path: ['markers', 'nope', 'name'], value: 'x' }])).toEqual(d);
  });
});
