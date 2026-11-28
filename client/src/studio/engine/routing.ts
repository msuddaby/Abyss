import { bpmAt, spanSec, spanBeats, tempoMap, type TempoMap } from '@abyss/shared';
import type { StudioDoc, StudioClip, StudioEffect, StudioTrack } from '@abyss/shared';

// Pure helpers shared by the engine and the UI: track routing (groups,
// cycles), solo-in-place, and how an audio clip maps timeline ↔ source time.

/**
 * The group a track feeds, or '' for master. Missing ids, non-group targets
 * and cycles (A → B → A) all fall back to master.
 */
export function resolveOutput(doc: StudioDoc, trackId: string): string {
  const t = doc.tracks[trackId];
  const out = t?.output;
  if (!out || t.kind === 'return' || out === trackId) return '';
  const g = doc.tracks[out];
  if (!g || g.kind !== 'group') return '';
  // Walk up from the target; reaching this track again means a cycle.
  const seen = new Set<string>([trackId]);
  let cur: string = out;
  for (let i = 0; i < 64 && cur; i++) {
    if (seen.has(cur)) return '';
    seen.add(cur);
    const next = doc.tracks[cur]?.output;
    if (!next || doc.tracks[next]?.kind !== 'group') break;
    cur = next;
  }
  return out;
}

/** Groups above a track, nearest first. */
export function ancestors(doc: StudioDoc, trackId: string): string[] {
  const out: string[] = [];
  let cur = resolveOutput(doc, trackId);
  while (cur && !out.includes(cur) && out.length < 64) {
    out.push(cur);
    cur = resolveOutput(doc, cur);
  }
  return out;
}

/** Tracks (transitively) routed into a group. */
export function descendants(doc: StudioDoc, groupId: string): string[] {
  return Object.keys(doc.tracks).filter((id) => id !== groupId && ancestors(doc, id).includes(groupId));
}

/**
 * Tracks that stay audible given the solo states (solo-in-place): soloed
 * tracks, the groups they play through, everything inside a soloed group,
 * and return tracks (when any non-return track is soloed so it keeps its
 * sends; when only return track(s) are soloed, only those returns stay open).
 */
export function audibleUnderSolo(doc: StudioDoc): Set<string> {
  const ids = Object.keys(doc.tracks);
  const soloed = ids.filter((id) => doc.tracks[id].solo);
  if (!soloed.length) return new Set(ids);
  const out = new Set<string>();
  let anyNonReturnSolo = false;
  for (const id of soloed) {
    out.add(id);
    if (doc.tracks[id].kind !== 'return') anyNonReturnSolo = true;
    for (const a of ancestors(doc, id)) out.add(a);
    if (doc.tracks[id].kind === 'group') for (const d of descendants(doc, id)) out.add(d);
  }
  if (anyNonReturnSolo) {
    for (const id of ids) if (doc.tracks[id].kind === 'return') out.add(id);
  }
  return out;
}

/** True when soloing only return track(s) (non-return dry outputs mute while sends still feed returns). */
export function isReturnOnlySolo(doc: StudioDoc): boolean {
  const soloed = Object.values(doc.tracks).filter((t) => t.solo);
  return soloed.length > 0 && soloed.every((t) => t.kind === 'return');
}

/**
 * True if keying a compressor on `hostTrackId` from `keyTrackId` would form an
 * audio feedback loop (self, ancestor group, or a return fed by the host or its ancestors).
 */
export function isSidechainCycle(doc: StudioDoc, hostTrackId: string, keyTrackId: string): boolean {
  if (!keyTrackId || !doc.tracks[keyTrackId]) return true;
  if (!hostTrackId) return false; // master bus is downstream of all tracks
  if (keyTrackId === hostTrackId) return true;
  const hostAncestors = ancestors(doc, hostTrackId);
  if (hostAncestors.includes(keyTrackId)) return true;
  const keyTrack = doc.tracks[keyTrackId];
  if (keyTrack.kind === 'return') {
    // Check if host or any of its ancestors sends to this return track.
    for (const tid of [hostTrackId, ...hostAncestors]) {
      const t = doc.tracks[tid];
      if (!t) continue;
      if ((t.sends?.[keyTrackId] ?? -Infinity) > -60) return true;
      if (t.automation?.[`send:${keyTrackId}`]?.length) return true;
    }
  }
  return false;
}

/** Track ids in display order with groups' children nested right after them. */
export function displayOrder(doc: StudioDoc, sorted: string[]): { id: string; depth: number; hidden: boolean }[] {
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of sorted) {
    const parent = resolveOutput(doc, id);
    if (parent && sorted.includes(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(id);
    } else roots.push(id);
  }
  // Returns always sit at the bottom, like a mixer's return section.
  roots.sort((a, b) => Number(doc.tracks[a].kind === 'return') - Number(doc.tracks[b].kind === 'return'));
  const out: { id: string; depth: number; hidden: boolean }[] = [];
  const walk = (id: string, depth: number, hidden: boolean) => {
    out.push({ id, depth, hidden });
    const t = doc.tracks[id];
    for (const c of children.get(id) ?? []) walk(c, depth + 1, hidden || !!t.collapsed);
  };
  for (const r of roots) walk(r, 0, false);
  return out;
}

export interface ClipPlayback {
  /** Time-stretched (pitch kept) via granular playback */
  warp: boolean;
  /** Source seconds consumed per timeline second */
  rate: number;
  /** Timeline seconds the clip spans */
  timelineSec: number;
}

export function clipPlayback(clip: StudioClip, map: TempoMap): ClipPlayback {
  const warp = !!clip.warp && !!clip.srcBpm;
  const rate = warp ? bpmAt(map, clip.start) / clip.srcBpm! : Math.pow(2, (clip.pitch ?? 0) / 12);
  return { warp, rate, timelineSec: spanSec(map, clip.start, clip.start + clip.length) };
}

/** Source seconds covered by clip-relative beats [from, to). */
export function clipSrcSeconds(doc: Pick<StudioDoc, 'meta' | 'tempo'>, clip: StudioClip, from: number, to: number): number {
  const map = tempoMap(doc);
  return spanSec(map, clip.start + from, clip.start + to) * clipPlayback(clip, map).rate;
}

/** Clip-relative beats that `srcSec` of source covers, starting at clip-relative beat `from`. */
export function clipBeatsForSrc(doc: Pick<StudioDoc, 'meta' | 'tempo'>, clip: StudioClip, from: number, srcSec: number): number {
  const map = tempoMap(doc);
  return spanBeats(map, clip.start + from, srcSec / clipPlayback(clip, map).rate);
}

/** Beats an asset of `durationSec` covers when placed at `start` (unwarped). */
export function assetBeatsAt(doc: Pick<StudioDoc, 'meta' | 'tempo'>, start: number, durationSec: number): number {
  return spanBeats(tempoMap(doc), start, durationSec);
}

/** A stand-in track for the master bus (its devices live in meta.masterEffects). */
export function masterTrack(effects: StudioEffect[] | undefined, volume: number | undefined): StudioTrack {
  return { name: 'Master', kind: 'group', order: 1e9, color: '#99aab5', volume: volume ?? 0, pan: 0, mute: false, solo: false, effects };
}