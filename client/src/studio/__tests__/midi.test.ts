import { describe, expect, it } from 'vitest';
import type { StudioDoc } from '@abyss/shared';
import { exportMidi } from '../midiExport';
import { parseMidi } from '../midiImport';
import { crc32 } from '../engine/zip';

describe('MIDI export', () => {
  it('round-trips through the importer', async () => {
    const doc: StudioDoc = {
      meta: { bpm: 96, timeSigNum: 3, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16 },
      tracks: {
        k: { name: 'Keys', kind: 'instrument', order: 0, volume: 0, pan: 0, mute: false, solo: false, instrument: { type: 'fm' } },
        d: { name: 'Drums', kind: 'instrument', order: 1, volume: 0, pan: 0, mute: false, solo: false, instrument: { type: 'drums' } },
      },
      clips: {
        c1: { trackId: 'k', kind: 'midi', start: 4, length: 4, gain: 0, notes: { a: { pitch: 60, start: 0, len: 1, vel: 0.8 }, b: { pitch: 64, start: 1.5, len: 0.5, vel: 0.5 } } },
        c2: { trackId: 'd', kind: 'midi', start: 0, length: 4, gain: 0, notes: { a: { pitch: 36, start: 0, len: 0.25, vel: 1 } } },
        muted: { trackId: 'k', kind: 'midi', start: 0, length: 4, gain: 0, mute: true, notes: { a: { pitch: 50, start: 0, len: 1, vel: 1 } } },
      },
    };
    const info = parseMidi(await exportMidi(doc).arrayBuffer());
    expect(info.bpm).toBeCloseTo(96, 1);
    expect(info.timeSig).toEqual({ num: 3, den: 4 });
    const keys = info.parts.find((p) => p.name === 'Keys')!;
    const notes = [...keys.notes].sort((x, y) => x.start - y.start);
    expect(notes.map((n) => [n.pitch, n.start, n.len])).toEqual([[60, 4, 1], [64, 5.5, 0.5]]);
    expect(info.parts.find((p) => p.name === 'Drums')?.drums).toBe(true);
  });
});

describe('zip', () => {
  it('uses the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
