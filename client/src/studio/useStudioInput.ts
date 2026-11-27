import { useLayoutEffect, useRef } from 'react';
import { useStudioStore, studioId, secondsToBeats } from '@abyss/shared';
import type { StudioDoc, StudioClip, StudioNote, StudioOp } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { barBeats, carveRangeOps } from './studioUtils';

// Live note input (hardware MIDI + computer keyboard), Ableton-style:
//  • notes play on the armed instrument tracks, or the selected instrument
//    track when nothing is armed ("auto-arm")
//  • sustain pedal defers note-offs; pitch bend / mod wheel go to the targets
//  • while recording, notes are captured at the audible playhead and turned
//    into a clip per track that replaces what was under it (arrangement record)

interface RecNote { pitch: number; start: number; len: number; vel: number }
interface Take {
  tracks: string[];
  startBeat: number;
  startWall: number;
  notes: Map<string, RecNote[]>;
  open: Map<string, { beat: number; vel: number }>;
}

export interface InputOptions {
  engine: StudioEngine | null;
  doc: StudioDoc | null;
  armedTrackIds: string[];
  selectedTrackId: string | null;
  /** Record quantize grid in beats (0 = off) */
  recQuantize: number;
}

export function inputTargets(doc: StudioDoc | null, armed: string[], selected: string | null): string[] {
  if (!doc) return [];
  const armedInst = armed.filter((id) => doc.tracks[id]?.kind === 'instrument');
  if (armedInst.length) return armedInst;
  return selected && doc.tracks[selected]?.kind === 'instrument' ? [selected] : [];
}

export function useStudioInput(opts: InputOptions) {
  const o = useRef(opts);
  useLayoutEffect(() => { o.current = opts; });
  const held = useRef(new Map<number, string[]>()); // sounding pitch → tracks
  const physical = useRef(new Set<number>());
  const sustained = useRef(new Set<number>());
  const sustainDown = useRef(false);
  const take = useRef<Take | null>(null);

  const targets = () => inputTargets(o.current.doc, o.current.armedTrackIds, o.current.selectedTrackId);
  const beatNow = () => o.current.engine?.getAudiblePositionBeats() ?? 0;

  const closeNote = (trackId: string, pitch: number) => {
    const t = take.current;
    const doc = o.current.doc;
    if (!t || !doc) return;
    const key = `${trackId}:${pitch}`;
    const open = t.open.get(key);
    if (!open) return;
    t.open.delete(key);
    let end = beatNow();
    const m = doc.meta;
    if (end < open.beat) end = m.loopEnabled && m.loopEnd > m.loopStart ? m.loopEnd : open.beat + 0.25; // wrapped
    const list = t.notes.get(trackId) ?? [];
    list.push({ pitch, start: open.beat, len: Math.max(1 / 64, end - open.beat), vel: open.vel });
    t.notes.set(trackId, list);
  };

  const release = (pitch: number) => {
    const tracks = held.current.get(pitch);
    if (!tracks) return;
    held.current.delete(pitch);
    for (const id of tracks) {
      o.current.engine?.noteOff(id, pitch);
      closeNote(id, pitch);
    }
  };

  const noteOn = (pitch: number, vel: number) => {
    if (held.current.has(pitch)) release(pitch); // retrigger
    sustained.current.delete(pitch);
    physical.current.add(pitch);
    const ts = targets();
    if (!ts.length) return;
    held.current.set(pitch, ts);
    for (const id of ts) void o.current.engine?.noteOn(id, pitch, vel);
    const t = take.current;
    if (t && o.current.engine?.isPlaying) {
      const beat = beatNow();
      for (const id of ts) if (t.tracks.includes(id)) t.open.set(`${id}:${pitch}`, { beat, vel });
    }
  };

  const noteOff = (pitch: number) => {
    physical.current.delete(pitch);
    if (sustainDown.current) { sustained.current.add(pitch); return; }
    release(pitch);
  };

  const sustain = (down: boolean) => {
    sustainDown.current = down;
    if (down) return;
    for (const p of [...sustained.current]) if (!physical.current.has(p)) release(p);
    sustained.current.clear();
  };

  const pitchBend = (semis: number) => { for (const id of targets()) o.current.engine?.pitchBend(id, semis); };
  const modWheel = (value: number) => { for (const id of targets()) o.current.engine?.modWheel(id, value); };

  const releaseAll = () => {
    sustainDown.current = false;
    sustained.current.clear();
    physical.current.clear();
    for (const p of [...held.current.keys()]) release(p);
  };

  // ───────────── Recording ─────────────

  const beginTake = (tracks: string[], startBeat: number) => {
    take.current = tracks.length ? { tracks, startBeat, startWall: performance.now(), notes: new Map(), open: new Map() } : null;
  };

  /** Clip range a take covers: the loop if it wrapped, otherwise whole bars around it. */
  const takeRange = (t: Take, doc: StudioDoc, endBeat: number, notes: RecNote[]) => {
    const m = doc.meta;
    const bar = barBeats(m);
    const loop = m.loopEnabled && m.loopEnd > m.loopStart;
    const elapsed = secondsToBeats((performance.now() - t.startWall) / 1000, m.bpm);
    if (loop && t.startBeat < m.loopEnd && t.startBeat + elapsed > m.loopEnd) return { start: m.loopStart, end: m.loopEnd };
    const lo = Math.min(t.startBeat, ...notes.map((n) => n.start));
    const hi = Math.max(endBeat, ...notes.map((n) => n.start + n.len));
    const start = Math.floor(lo / bar + 1e-9) * bar;
    return { start, end: Math.max(start + bar, Math.ceil(hi / bar - 1e-9) * bar) };
  };

  /** Close open notes, then write one clip per track (replacing what was under it). */
  const endTake = () => {
    const t = take.current;
    const doc = useStudioStore.getState().doc;
    if (!t || !doc) { take.current = null; return; }
    for (const key of [...t.open.keys()]) {
      const sep = key.lastIndexOf(':');
      closeNote(key.slice(0, sep), Number(key.slice(sep + 1)));
    }
    take.current = null;
    const endBeat = beatNow();
    const q = o.current.recQuantize;
    const ops: StudioOp[] = [];
    for (const trackId of t.tracks) {
      const list = t.notes.get(trackId);
      const track = doc.tracks[trackId];
      if (!list?.length || !track) continue;
      const { start, end } = takeRange(t, doc, endBeat, list);
      const notes: Record<string, StudioNote> = {};
      for (const n of list) {
        let s = n.start - start;
        if (q > 0) s = Math.round(s / q) * q;
        if (s < 0 || s >= end - start) continue;
        notes[studioId()] = { pitch: n.pitch, start: s, len: Math.min(n.len, end - start - s), vel: Math.round(n.vel * 100) / 100 };
      }
      if (!Object.keys(notes).length) continue;
      ops.push(...carveRangeOps(doc, trackId, start, end));
      const clip: StudioClip = { trackId, kind: 'midi', start, length: end - start, gain: 0, notes, name: `${track.name} take` };
      ops.push({ t: 'set', path: ['clips', studioId()], value: clip });
    }
    if (ops.length) useStudioStore.getState().edit(ops);
  };

  /** In-progress takes for drawing (red clips that grow while recording). */
  const liveTakes = (playhead: number): { trackId: string; clip: StudioClip }[] => {
    const t = take.current;
    const doc = o.current.doc;
    if (!t || !doc) return [];
    const out: { trackId: string; clip: StudioClip }[] = [];
    for (const trackId of t.tracks) {
      const list = [...(t.notes.get(trackId) ?? [])];
      for (const [key, n] of t.open) {
        if (key.startsWith(`${trackId}:`)) list.push({ pitch: Number(key.slice(trackId.length + 1)), start: n.beat, len: Math.max(1 / 16, playhead - n.beat), vel: n.vel });
      }
      const { start, end } = takeRange(t, doc, playhead, list);
      const notes: Record<string, StudioNote> = {};
      list.forEach((n, i) => { notes[`r${i}`] = { pitch: n.pitch, start: n.start - start, len: n.len, vel: n.vel }; });
      out.push({ trackId, clip: { trackId, kind: 'midi', start, length: end - start, gain: 0, notes, name: '● Recording' } });
    }
    return out;
  };

  return { noteOn, noteOff, sustain, pitchBend, modWheel, releaseAll, beginTake, endTake, liveTakes, targets };
}
