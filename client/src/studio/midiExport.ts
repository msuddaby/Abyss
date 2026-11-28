import { buildTempoMap, sortedTrackIds } from '@abyss/shared';
import type { StudioDoc } from '@abyss/shared';

// Standard MIDI File (type 1) writer: a conductor track with the tempo map and
// time signatures, then one track per instrument track (its unmuted clips
// merged). Drum Rack tracks go out on channel 10.

const PPQ = 480;

function vlq(n: number): number[] {
  n = Math.max(0, Math.round(n));
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [...[...type].map((c) => c.charCodeAt(0)), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

type Ev = { tick: number; order: number; bytes: number[] };

function trackChunk(events: Ev[], name?: string): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  if (name) {
    const txt = [...new TextEncoder().encode(name.slice(0, 120))];
    data.push(0, 0xff, 0x03, ...vlq(txt.length), ...txt);
  }
  let last = 0;
  for (const e of events) {
    data.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(0, 0xff, 0x2f, 0);
  return chunk('MTrk', data);
}

export function exportMidi(doc: StudioDoc, onlyTrackIds?: string[]): Blob {
  const map = buildTempoMap(doc);
  const conductor: Ev[] = [];
  for (const s of map.segs) {
    const us = Math.round(60_000_000 / s.bpm);
    conductor.push({ tick: Math.round(s.beat * PPQ), order: 0, bytes: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  }
  for (const s of map.sigs) {
    conductor.push({ tick: Math.round(s.beat * PPQ), order: 0, bytes: [0xff, 0x58, 0x04, s.num, Math.round(Math.log2(s.den)), 24, 8] });
  }
  for (const m of Object.values(doc.markers ?? {})) {
    const txt = [...new TextEncoder().encode((m.name || 'Marker').slice(0, 60))];
    conductor.push({ tick: Math.round(m.beat * PPQ), order: 1, bytes: [0xff, 0x06, ...vlq(txt.length), ...txt] });
  }

  const tracks: number[][] = [trackChunk(conductor, doc.meta.bpm ? 'Tempo' : undefined)];
  let channel = 0;
  for (const id of sortedTrackIds(doc)) {
    const t = doc.tracks[id];
    if (t.kind !== 'instrument' || (onlyTrackIds && !onlyTrackIds.includes(id))) continue;
    const drums = t.instrument?.type === 'drums';
    const ch = drums ? 9 : channel;
    if (!drums) { channel = (channel + 1) % 16; if (channel === 9) channel = 10; }
    const evs: Ev[] = [];
    for (const c of Object.values(doc.clips)) {
      if (c.trackId !== id || c.kind !== 'midi' || c.mute) continue;
      for (const n of Object.values(c.notes ?? {})) {
        if (n.start >= c.length) continue;
        const on = Math.round((c.start + n.start) * PPQ);
        const off = Math.round((c.start + Math.min(n.start + n.len, c.length)) * PPQ);
        const vel = Math.max(1, Math.min(127, Math.round(n.vel * 127)));
        evs.push({ tick: on, order: 1, bytes: [0x90 | ch, n.pitch, vel] });
        // Note-offs sort before note-ons at the same tick so repeated notes retrigger.
        evs.push({ tick: Math.max(on + 1, off), order: 0, bytes: [0x80 | ch, n.pitch, 0] });
      }
    }
    tracks.push(trackChunk(evs, t.name));
  }

  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
  const bytes = new Uint8Array([...header, ...tracks.flat()]);
  return new Blob([bytes], { type: 'audio/midi' });
}
