import { studioId } from '@abyss/shared';
import type { StudioDoc, StudioNote, StudioOp } from '@abyss/shared';
import { DRUM_PADS, DRUM_ALIASES } from './engine/drumRack';
import { findPreset, type ParsedSoundFont } from './engine/soundfont';
import { barBeats, nextTrackColor, nextTrackOrder } from './studioUtils';

// Standard MIDI File (format 0/1) import: each (track, channel) with notes
// becomes an instrument track with one clip. Channel 10 becomes a drum track
// mapped onto the studio kit (or Bank 128 when importing with a SoundFont).

export interface MidiPart {
  /** Stable key for the import dialog */
  key: string;
  name: string;
  channel: number;
  bank: number;
  program: number | null;
  drums: boolean;
  /** Notes in beats from the start of the file (with GM drums mapped to studio kit) */
  notes: StudioNote[];
  /** Unmapped raw notes (used for Channel 10 when importing into a SoundFont) */
  rawNotes?: StudioNote[];
  /** Drum hits with no matching kit piece (dropped when using the built-in drum rack) */
  unmapped: number;
}

export interface MidiFileInfo {
  parts: MidiPart[];
  /** First tempo in the file, if any */
  bpm: number | null;
  timeSig: { num: number; den: number } | null;
  /** True when the tempo changes later in the file (we use the first tempo) */
  tempoChanges: boolean;
  lengthBeats: number;
}

export function isMidiFile(f: File): boolean {
  return /\.(mid|midi|smf|kar)$/i.test(f.name) || f.type === 'audio/midi' || f.type === 'audio/mid' || f.type === 'audio/x-midi';
}

/** General MIDI percussion → the studio's drum rack pads. */
const GM_TO_KIT: Record<number, number> = {
  ...Object.fromEntries(DRUM_PADS.map((p) => [p.pitch, p.pitch])),
  ...DRUM_ALIASES,
};

/** General MIDI program families, for track names when a track has none. */
const GM_FAMILIES = [
  'Piano', 'Chromatic Perc', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth FX', 'Ethnic', 'Percussive', 'SFX',
];

class Reader {
  pos = 0;
  private readonly view: DataView;
  constructor(view: DataView) { this.view = view; }
  get length() { return this.view.byteLength; }
  u8() { if (this.pos >= this.view.byteLength) throw new Error('Unexpected end of MIDI data'); return this.view.getUint8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  str(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('Bad variable-length value');
  }
}

function decodeText(bytes: number[]): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)).trim(); }
  catch { return String.fromCharCode(...bytes).trim(); }
}

export function parseMidi(buf: ArrayBuffer): MidiFileInfo {
  const r = new Reader(new DataView(buf));
  if (r.length < 14 || r.str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = r.u32();
  const format = r.u16();
  const ntracks = r.u16();
  const division = r.u16();
  r.pos = 8 + hlen;
  if (format > 1) throw new Error('MIDI format 2 (pattern) files are not supported');
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const tpq = division || 480;

  let bpm: number | null = null;
  let timeSig: MidiFileInfo['timeSig'] = null;
  let tempoChanges = false;
  let lengthTicks = 0;
  const parts: MidiPart[] = [];

  for (let t = 0; t < ntracks && r.pos + 8 <= r.length; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = Math.min(r.length, r.pos + len);
    if (id !== 'MTrk') { r.pos = end; continue; }

    let tick = 0;
    let status = 0;
    let trackName = '';
    const program: (number | null)[] = Array(16).fill(null);
    const bank: number[] = Array(16).fill(0);
    const byChannel = new Map<number, StudioNote[]>();
    // Sounding notes per channel+pitch (FIFO, so overlapping repeats pair up in order)
    const open = new Map<number, { tick: number; vel: number }[]>();

    const close = (ch: number, pitch: number, at: number) => {
      const stack = open.get(ch * 128 + pitch);
      const on = stack?.shift();
      if (!on) return;
      const list = byChannel.get(ch) ?? [];
      list.push({ pitch, start: on.tick / tpq, len: Math.max(1 / 64, (at - on.tick) / tpq), vel: Math.max(0.01, on.vel / 127) });
      byChannel.set(ch, list);
    };

    while (r.pos < end) {
      tick += r.vlq();
      if (r.pos >= end) break;
      let b = r.u8();
      if (b === 0xff) {
        const type = r.u8();
        const n = Math.min(r.vlq(), Math.max(0, end - r.pos));
        const data: number[] = [];
        for (let i = 0; i < n; i++) data.push(r.u8());
        if (type === 0x03 && !trackName) trackName = decodeText(data);
        else if (type === 0x51 && n === 3) {
          const us = (data[0] << 16) | (data[1] << 8) | data[2];
          if (us > 0) {
            const v = Math.round((60_000_000 / us) * 100) / 100;
            if (bpm === null) bpm = v; else if (Math.abs(v - bpm) > 0.01) tempoChanges = true;
          }
        } else if (type === 0x58 && n >= 2 && !timeSig) {
          timeSig = { num: data[0], den: 2 ** data[1] };
        } else if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        // Read VLQ before mutating r.pos: `r.pos += r.vlq()` evaluates the old
        // r.pos first, leaving r.pos 1+ bytes short on the SysEx terminator 0xf7!
        const n = r.vlq();
        r.pos = Math.min(end, r.pos + n);
        continue;
      }
      if (b >= 0xf1) {
        // System common / real-time bytes (rare in SMF, but shouldn't desync the stream).
        if (b === 0xf1 || b === 0xf3) r.pos = Math.min(end, r.pos + 1);
        else if (b === 0xf2) r.pos = Math.min(end, r.pos + 2);
        continue;
      }
      if (b & 0x80) status = b; else { r.pos--; b = status; } // running status
      if (!status) throw new Error('Corrupt MIDI track');
      const kind = status & 0xf0, ch = status & 0x0f;
      const d1 = r.u8() & 0x7f;
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : (r.u8() & 0x7f);
      if (kind === 0x90 && d2 > 0) {
        const k = ch * 128 + d1;
        const stack = open.get(k) ?? [];
        stack.push({ tick, vel: d2 });
        open.set(k, stack);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        close(ch, d1, tick);
      } else if (kind === 0xc0 && program[ch] === null) {
        program[ch] = d1;
      } else if (kind === 0xb0 && d1 === 0 && program[ch] === null) {
        // Bank Select MSB (CC 0)
        bank[ch] = d2;
      }
    }
    // Notes never released end at the track's last event.
    for (const [k, stack] of open) while (stack.length) close(Math.floor(k / 128), k % 128, Math.max(tick, stack[0].tick + tpq / 4));
    lengthTicks = Math.max(lengthTicks, tick);
    r.pos = end;

    for (const [ch, list] of byChannel) {
      if (!list.length) continue;
      const drums = ch === 9;
      let notes = list;
      let unmapped = 0;
      if (drums) {
        notes = [];
        for (const n of list) {
          const kit = GM_TO_KIT[n.pitch];
          if (kit === undefined) unmapped++; else notes.push({ ...n, pitch: kit, len: Math.min(n.len, 0.25) });
        }
      }
      const prog = program[ch];
      const fallback = drums ? 'Drums' : prog !== null ? GM_FAMILIES[prog >> 3] : `Channel ${ch + 1}`;
      const multi = byChannel.size > 1;
      parts.push({
        key: `${t}:${ch}`,
        name: (trackName ? (multi ? `${trackName} (${fallback})` : trackName) : fallback).slice(0, 40),
        channel: ch, bank: drums ? 128 : bank[ch], program: prog, drums, notes, rawNotes: drums ? list : undefined, unmapped,
      });
    }
  }

  return { parts: parts.filter((p) => p.notes.length || p.rawNotes?.length), bpm, timeSig, tempoChanges, lengthBeats: lengthTicks / tpq };
}

/** Max notes per clip on the server; longer parts are split at bar lines. */
const MAX_CLIP_NOTES = 4000;

/**
 * Ops that add the chosen parts as new instrument tracks, starting at `atBeats`.
 * Each part keeps its position relative to the file start.
 */
export function midiImportOps(
  doc: StudioDoc,
  parts: MidiPart[],
  atBeats: number,
  meta?: { bpm?: number; timeSig?: { num: number; den: number }; soundfont?: { assetId: string; sf: ParsedSoundFont } },
): { ops: StudioOp[]; trackIds: string[] } {
  const ops: StudioOp[] = [];
  const trackIds: string[] = [];
  const m = { ...doc.meta };
  if (meta?.bpm && meta.bpm >= 20 && meta.bpm <= 400) { ops.push({ t: 'set', path: ['meta', 'bpm'], value: meta.bpm }); m.bpm = meta.bpm; }
  if (meta?.timeSig && [2, 4, 8, 16].includes(meta.timeSig.den) && meta.timeSig.num >= 1 && meta.timeSig.num <= 16) {
    ops.push({ t: 'set', path: ['meta', 'timeSigNum'], value: meta.timeSig.num }, { t: 'set', path: ['meta', 'timeSigDen'], value: meta.timeSig.den });
    m.timeSigNum = meta.timeSig.num; m.timeSigDen = meta.timeSig.den;
  }
  const bar = barBeats(m);
  // nextTrackOrder/Color look at doc.tracks, so keep a working copy as we add.
  const working: StudioDoc = { ...doc, tracks: { ...doc.tracks } };
  const sfOpt = meta?.soundfont;

  for (const part of parts) {
    const partNotes = sfOpt && part.rawNotes?.length ? part.rawNotes : part.notes;
    if (!partNotes.length) continue;
    const trackId = studioId();
    let instrument: StudioDoc['tracks'][string]['instrument'];
    let trackName = part.name || 'MIDI';
    if (sfOpt) {
      const matched = findPreset(sfOpt.sf, part.bank, part.program ?? 0, part.drums);
      instrument = {
        type: 'soundfont',
        params: { assetId: sfOpt.assetId, bank: matched?.bank ?? 0, program: matched?.program ?? 0 },
      };
      if (matched && (!part.name || part.name.startsWith('Channel ') || part.name.includes(' ('))) {
        trackName = matched.name.slice(0, 40) || trackName;
      }
    } else {
      instrument = { type: part.drums ? 'drums' : part.program !== null && part.program >= 32 && part.program <= 39 ? 'bass' : 'synth' };
    }
    const track = {
      name: trackName, kind: 'instrument' as const, order: nextTrackOrder(working), color: nextTrackColor(working),
      volume: -6, pan: 0, mute: false, solo: false,
      instrument,
    };
    working.tracks[trackId] = track as StudioDoc['tracks'][string];
    ops.push({ t: 'set', path: ['tracks', trackId], value: track });
    trackIds.push(trackId);

    const sorted = [...partNotes].sort((a, b) => a.start - b.start);
    // Chunk into clips of ≤ MAX_CLIP_NOTES, each starting on a bar line.
    let i = 0;
    while (i < sorted.length) {
      const clipStart = Math.floor(sorted[i].start / bar) * bar;
      let j = Math.min(sorted.length, i + MAX_CLIP_NOTES);
      if (j < sorted.length) {
        const cut = Math.floor(sorted[j].start / bar) * bar;
        let k = j;
        while (k > i && sorted[k - 1].start >= cut) k--;
        if (k > i) j = k;
      }
      const chunk = sorted.slice(i, j);
      const next = j < sorted.length ? Math.floor(sorted[j].start / bar) * bar : Infinity;
      const end = Math.max(...chunk.map((n) => n.start + n.len));
      const length = Math.max(bar, Math.min(next, Math.ceil(end / bar - 1e-9) * bar) - clipStart);
      const notes: Record<string, StudioNote> = {};
      for (const n of chunk) {
        notes[studioId()] = {
          pitch: n.pitch,
          start: Math.round((n.start - clipStart) * 1e6) / 1e6,
          len: Math.round(Math.max(1 / 64, n.len) * 1e6) / 1e6,
          vel: Math.round(n.vel * 100) / 100,
        };
      }
      ops.push({
        t: 'set', path: ['clips', studioId()],
        value: { trackId, kind: 'midi', start: atBeats + clipStart, length, gain: 0, notes, name: part.name },
      });
      i = j;
    }
  }
  return { ops, trackIds };
}

/** Split ops into batches that fit the hub's message limit (and op count). */
export function batchOps(ops: StudioOp[], maxBytes = 900_000, maxOps = 400): StudioOp[][] {
  const out: StudioOp[][] = [];
  let cur: StudioOp[] = [], size = 0;
  for (const op of ops) {
    const s = JSON.stringify(op).length;
    if (cur.length && (size + s > maxBytes || cur.length >= maxOps)) { out.push(cur); cur = []; size = 0; }
    cur.push(op); size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}
