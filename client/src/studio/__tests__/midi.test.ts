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

  it('skips leading SysEx events without corrupting subsequent delta times', () => {
    // Format 0, 1 track, 48 TPQ, with two SysEx events at tick 0 followed by C4 at tick 0.
    const track = [
      0x00, 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7, // GM System On SysEx (5 bytes)
      0x00, 0xf0, 0x04, 0x41, 0x10, 0x42, 0xf7,       // second SysEx (4 bytes)
      0x00, 0x90, 60, 100,                            // Note On C4 at tick 0
      48,   0x80, 60, 0,                              // Note Off C4 at tick 48 (1 beat)
      0x00, 0xff, 0x2f, 0x00,                         // End of track
    ];
    const header = [
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 48,
      0x4d, 0x54, 0x72, 0x6b,
      (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff,
      ...track,
    ];
    const info = parseMidi(new Uint8Array(header).buffer);
    expect(info.parts).toHaveLength(1);
    expect(info.parts[0].notes).toHaveLength(1);
    expect(info.parts[0].notes[0]).toMatchObject({ pitch: 60, start: 0, len: 1 });
  });
});

describe('zip', () => {
  it('uses the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
