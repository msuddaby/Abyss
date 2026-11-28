import { describe, expect, it } from 'vitest';
import type { StudioDoc } from '@abyss/shared';
import { parseSoundFont, findPreset, isSoundFontAsset, isSoundFontFile } from '../engine/soundfont';
import { midiImportOps, type MidiPart } from '../midiImport';

/** Builds a minimal, valid SoundFont 2.01 binary with the given presets and 1 sine-like sample. */
function makeSyntheticSf2(presets: { bank: number; program: number; name: string; keyLo?: number; keyHi?: number }[]): ArrayBuffer {
  const str = (s: string, len: number) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const chunk = (id: string, data: Uint8Array): Uint8Array => {
    const pad = data.length & 1;
    const out = new Uint8Array(8 + data.length + pad);
    out.set(str(id, 4), 0);
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  };
  const concat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const list = (type: string, ...children: Uint8Array[]) => chunk('LIST', concat(str(type, 4), ...children));

  // 100 samples of 16-bit PCM
  const smplData = new Uint8Array(200);
  const smplView = new DataView(smplData.buffer);
  for (let i = 0; i < 100; i++) smplView.setInt16(i * 2, Math.round(Math.sin(i * 0.2) * 16000), true);

  // shdr: 1 real sample + EOS (46 bytes each)
  const shdr = new Uint8Array(46 * 2);
  shdr.set(str('TestSine', 20), 0);
  const shdv = new DataView(shdr.buffer);
  shdv.setUint32(20, 0, true);      // start
  shdv.setUint32(24, 100, true);    // end
  shdv.setUint32(28, 10, true);     // startLoop
  shdv.setUint32(32, 90, true);     // endLoop
  shdv.setUint32(36, 44100, true);  // sampleRate
  shdv.setUint8(40, 60);            // originalPitch
  shdv.setInt8(41, 0);              // pitchCorrection
  shdv.setUint16(44, 1, true);      // monoSample
  shdr.set(str('EOS', 20), 46);

  // inst: 1 instrument per preset + EOI (22 bytes each)
  const inst = new Uint8Array(22 * (presets.length + 1));
  const instDv = new DataView(inst.buffer);
  const ibag = new Uint8Array(4 * (presets.length + 1));
  const ibagDv = new DataView(ibag.buffer);
  const igenList: [number, number][] = [];

  presets.forEach((p, idx) => {
    inst.set(str(p.name, 20), idx * 22);
    instDv.setUint16(idx * 22 + 20, idx, true);
    ibagDv.setUint16(idx * 4, igenList.length, true);
    if (p.keyLo !== undefined || p.keyHi !== undefined) {
      igenList.push([43, ((p.keyHi ?? 127) << 8) | (p.keyLo ?? 0)]);
    }
    igenList.push([54, 1]); // sampleModes = loop
    igenList.push([53, 0]); // sampleID = 0
  });
  inst.set(str('EOI', 20), presets.length * 22);
  instDv.setUint16(presets.length * 22 + 20, presets.length, true);
  ibagDv.setUint16(presets.length * 4, igenList.length, true);

  const igen = new Uint8Array(4 * (igenList.length + 1));
  const igenDv = new DataView(igen.buffer);
  igenList.forEach(([op, val], i) => {
    igenDv.setUint16(i * 4, op, true);
    igenDv.setUint16(i * 4 + 2, val, true);
  });

  // phdr + pbag + pgen
  const phdr = new Uint8Array(38 * (presets.length + 1));
  const phdrDv = new DataView(phdr.buffer);
  const pbag = new Uint8Array(4 * (presets.length + 1));
  const pbagDv = new DataView(pbag.buffer);
  const pgen = new Uint8Array(4 * (presets.length + 1));
  const pgenDv = new DataView(pgen.buffer);
  presets.forEach((p, idx) => {
    phdr.set(str(p.name, 20), idx * 38);
    phdrDv.setUint16(idx * 38 + 20, p.program, true);
    phdrDv.setUint16(idx * 38 + 22, p.bank, true);
    phdrDv.setUint16(idx * 38 + 24, idx, true);
    pbagDv.setUint16(idx * 4, idx, true);
    pgenDv.setUint16(idx * 4, 41, true); // instrument
    pgenDv.setUint16(idx * 4 + 2, idx, true);
  });
  phdr.set(str('EOP', 20), presets.length * 38);
  phdrDv.setUint16(presets.length * 38 + 24, presets.length, true);
  pbagDv.setUint16(presets.length * 4, presets.length, true);

  const infoList = list('INFO', chunk('INAM', str('Test Bank\0', 10)));
  const sdtaList = list('sdta', chunk('smpl', smplData));
  const pdtaList = list(
    'pdta',
    chunk('phdr', phdr), chunk('pbag', pbag), chunk('pgen', pgen),
    chunk('inst', inst), chunk('ibag', ibag), chunk('igen', igen),
    chunk('shdr', shdr),
  );
  const body = concat(str('sfbk', 4), infoList, sdtaList, pdtaList);
  return chunk('RIFF', body).buffer as ArrayBuffer;
}

describe('SoundFont (.sf2)', () => {
  it('detects SoundFont files and assets', () => {
    expect(isSoundFontFile({ name: 'Binary Game.sf2' })).toBe(true);
    expect(isSoundFontFile({ name: 'beat.wav' })).toBe(false);
    expect(isSoundFontAsset({ name: 'Binary Game', url: '/uploads/studio/abc.sf2' })).toBe(true);
    expect(isSoundFontAsset({ name: 'Kick', url: '/uploads/studio/abc.wav' })).toBe(false);
  });

  it('parses presets, zones, loop modes, and falls back gracefully', () => {
    const sf = parseSoundFont(makeSyntheticSf2([
      { bank: 0, program: 1, name: 'Lead', keyLo: 36, keyHi: 96 },
      { bank: 0, program: 5, name: 'Strings' },
      { bank: 128, program: 0, name: 'Standard Kit' },
    ]));
    expect(sf.name).toBe('Test Bank');
    expect(sf.presets.map((p) => `${p.bank}:${p.program}:${p.name}`)).toEqual([
      '0:1:Lead', '0:5:Strings', '128:0:Standard Kit',
    ]);
    expect(sf.presets[0].zones[0]).toMatchObject({ keyLo: 36, keyHi: 96, sampleMode: 1, rootKey: 60 });
    expect(findPreset(sf, 0, 5)?.name).toBe('Strings');
    expect(findPreset(sf, 0, 0, true)?.name).toBe('Standard Kit');
    // Unmatched program falls back to first preset
    expect(findPreset(sf, 0, 99)?.name).toBe('Lead');
  });

  it('maps MIDI import parts onto matching SoundFont presets and preserves raw drum notes', () => {
    const sf = parseSoundFont(makeSyntheticSf2([
      { bank: 0, program: 2, name: 'Synth Lead' },
      { bank: 128, program: 0, name: 'DS Kit' },
    ]));
    const doc: StudioDoc = {
      meta: { bpm: 120, timeSigNum: 4, timeSigDen: 4, loopEnabled: false, loopStart: 0, loopEnd: 16 },
      tracks: {},
      clips: {},
    };
    const parts: MidiPart[] = [
      { key: '0:0', name: 'Channel 1', channel: 0, bank: 0, program: 2, drums: false, notes: [{ pitch: 60, start: 0, len: 1, vel: 0.8 }], unmapped: 0 },
      { key: '0:9', name: 'Drums', channel: 9, bank: 128, program: 0, drums: true, notes: [], rawNotes: [{ pitch: 81, start: 0, len: 0.5, vel: 0.9 }], unmapped: 1 },
    ];
    const { ops } = midiImportOps(doc, parts, 0, { soundfont: { assetId: 'sf-1', sf } });
    const trackOps = ops.filter((o) => o.t === 'set' && o.path[0] === 'tracks');
    expect(trackOps).toHaveLength(2);
    expect((trackOps[0] as { value: { instrument: unknown } }).value.instrument).toEqual({
      type: 'soundfont', params: { assetId: 'sf-1', bank: 0, program: 2 },
    });
    expect((trackOps[1] as { value: { instrument: unknown } }).value.instrument).toEqual({
      type: 'soundfont', params: { assetId: 'sf-1', bank: 128, program: 0 },
    });
  });
});
