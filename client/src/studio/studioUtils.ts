import { useServerStore, useStudioStore, useToastStore, studioId, tempoMap, barAt } from '@abyss/shared';
import type { StudioAsset, StudioDoc, StudioClip, StudioMeta, StudioOp } from '@abyss/shared';
import { decodeBlob, putBuffer } from './engine/assetCache';
import { isSoundFontFile, parseSoundFont, putSoundFont } from './engine/soundfont';
import { clipSrcSeconds, assetBeatsAt } from './engine/routing';

/** Track header width; narrower on phones (matches --studio-header-w in App.css). */
const narrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches;
export let HEADER_WIDTH = narrow() ? 132 : 220;
/** Re-reads the header width after a resize; true when it changed (caller re-renders). */
export function syncHeaderWidth(): boolean {
  const w = narrow() ? 132 : 220;
  if (w === HEADER_WIDTH) return false;
  HEADER_WIDTH = w;
  return true;
}

/** Double-tap detector for touch (dblclick is unreliable on touch screens). */
let lastTap: { key: string; t: number; x: number; y: number } | null = null;
export function isDoubleTap(e: React.PointerEvent, key: string): boolean {
  if (e.pointerType !== 'touch') return false;
  const now = performance.now();
  const hit = !!lastTap && lastTap.key === key && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
  lastTap = hit ? null : { key, t: now, x: e.clientX, y: e.clientY };
  return hit;
}
export const TRACK_HEIGHT = 72;
export const RULER_HEIGHT = 28;
export const MIN_CLIP_BEATS = 1 / 16;

export const TRACK_COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#3ba4f5', '#f47b67', '#a970ff', '#2dd4bf', '#f59e0b'];

const USER_COLORS = ['#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c'];

export function colorForUser(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return USER_COLORS[Math.abs(h) % USER_COLORS.length];
}

export function useMemberName(userId: string): string {
  return useServerStore((s) => s.members.find((m) => m.userId === userId)?.user.displayName ?? 'Someone');
}

export function memberName(userId: string): string {
  return useServerStore.getState().members.find((m) => m.userId === userId)?.user.displayName ?? 'Someone';
}

export function barBeats(meta: StudioMeta): number {
  return (meta.timeSigNum * 4) / meta.timeSigDen;
}

export const SNAP_OPTIONS: { label: string; value: number }[] = [
  { label: 'Bar', value: -1 },
  { label: '1/4', value: 1 },
  { label: '1/8', value: 0.5 },
  { label: '1/16', value: 0.25 },
  { label: '1/32', value: 0.125 },
  { label: 'Off', value: 0 },
];

/** Resolves the snap setting (−1 = one bar) to a beat grid size; 0 = no snapping. */
export function snapSize(snap: number, meta: StudioMeta): number {
  return snap === -1 ? barBeats(meta) : snap;
}

export function snapBeats(beats: number, grid: number): number {
  return grid > 0 ? Math.round(beats / grid) * grid : beats;
}

export function floorBeats(beats: number, grid: number): number {
  return grid > 0 ? Math.floor(beats / grid) * grid : beats;
}

/** "bar.beat.sixteenth" display of a beat position (follows signature changes). */
export function formatPosition(beats: number, doc: Pick<StudioDoc, 'meta' | 'tempo'>): string {
  const b = barAt(tempoMap(doc), beats);
  const unit = 4 / b.den;
  const inBar = (beats - b.start) / unit;
  const beat = Math.floor(inBar + 1e-6) + 1;
  const sixteenth = Math.floor(((inBar * unit) % 1) * 4 + 1e-6) + 1;
  return `${b.bar + 1}.${beat}.${sixteenth}`;
}

/** Bar length (beats) at a position, following signature changes. */
export function barBeatsAt(doc: Pick<StudioDoc, 'meta' | 'tempo'>, beat: number): number {
  return barAt(tempoMap(doc), beat).len;
}

/** Start of the bar containing `beat`. */
export function barFloor(doc: Pick<StudioDoc, 'meta' | 'tempo'>, beat: number): number {
  return barAt(tempoMap(doc), beat).start;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function nextTrackOrder(doc: StudioDoc): number {
  return Object.values(doc.tracks).reduce((max, t) => Math.max(max, t.order), -1) + 1;
}

export function nextTrackColor(doc: StudioDoc): string {
  return TRACK_COLORS[Object.keys(doc.tracks).length % TRACK_COLORS.length];
}

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file']);

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * True when this key press belongs to the focused control rather than to
 * studio shortcuts: anything typed into text fields, navigation/typeahead in
 * a dropdown, and arrows on a slider. Space, modifier combos and other keys
 * still reach the shortcuts.
 */
export function keyBelongsToTarget(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const el = e.target;
  if (isTypingTarget(el) && !(el instanceof HTMLSelectElement)) return true;
  if (el instanceof HTMLSelectElement) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === ' ' || e.key === 'Escape' || e.key.startsWith('F')) return false;
    return NAV_KEYS.has(e.key) || e.key === 'Enter' || e.key.length === 1;
  }
  if (el instanceof HTMLInputElement && el.type === 'range') return NAV_KEYS.has(e.key);
  return false;
}

/** True when keystrokes should go to a text field rather than shortcuts. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
}

/**
 * Decodes (to validate and get duration), uploads and caches audio files.
 * Returns the created assets in order; failures are toasted and skipped.
 */
export async function uploadAudioFiles(files: File[], onProgress?: (name: string, pct: number) => void): Promise<StudioAsset[]> {
  const out: StudioAsset[] = [];
  for (const file of files) {
    try {
      if (isSoundFontFile(file)) {
        const parsed = parseSoundFont(await file.arrayBuffer());
        const asset = await useStudioStore.getState().uploadAsset(file, file.name, 0, (pct) => onProgress?.(file.name, pct));
        putSoundFont(asset.id, parsed);
        out.push(asset);
        continue;
      }
      const buffer = await decodeBlob(await file.arrayBuffer());
      const asset = await useStudioStore.getState().uploadAsset(file, file.name, buffer.duration, (pct) => onProgress?.(file.name, pct));
      putBuffer(asset.id, buffer);
      out.push(asset);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: unknown } })?.response?.data;
      useToastStore.getState().addToast(
        typeof msg === 'string' ? msg : `Couldn't add ${file.name} — is it an audio or SoundFont (.sf2) file?`,
        'error',
      );
    }
  }
  return out;
}

/** Op that places an asset as a new clip on an audio track. */
export function audioClipOp(asset: StudioAsset, trackId: string, startBeats: number, doc: Pick<StudioDoc, 'meta' | 'tempo'>) {
  const start = Math.max(0, startBeats);
  const clip: StudioClip = {
    trackId,
    kind: 'audio',
    start,
    length: Math.max(MIN_CLIP_BEATS, assetBeatsAt(doc, start, asset.durationSec)),
    assetId: asset.id,
    offset: 0,
    gain: 0,
    fadeIn: 0,
    fadeOut: 0,
    name: asset.name,
  };
  return { t: 'set' as const, path: ['clips', studioId()], value: clip };
}

/**
 * Ops that clear [start, end) on a track, like Ableton's arrangement record:
 * clips fully inside are deleted, clips crossing an edge are trimmed, and a
 * clip spanning the whole range is split around it.
 */
export function carveRangeOps(doc: StudioDoc, trackId: string, start: number, end: number): StudioOp[] {
  const ops: StudioOp[] = [];
  const slice = (c: StudioClip, from: number, to: number) => sliceClip(doc, c, from, to);
  for (const [id, c] of Object.entries(doc.clips)) {
    if (c.trackId !== trackId) continue;
    const cEnd = c.start + c.length;
    if (cEnd <= start + 1e-9 || c.start >= end - 1e-9) continue;
    const keepLeft = c.start < start - 1e-9;
    const keepRight = cEnd > end + 1e-9;
    if (!keepLeft && !keepRight) { ops.push({ t: 'del', path: ['clips', id] }); continue; }
    if (keepLeft) ops.push({ t: 'set', path: ['clips', id], value: slice(c, 0, start - c.start) });
    if (keepRight) {
      const right = slice(c, end - c.start, c.length);
      ops.push(keepLeft ? { t: 'set', path: ['clips', studioId()], value: right } : { t: 'set', path: ['clips', id], value: right });
    }
  }
  return ops;
}

/** The part of clip `c` between clip-relative beats [from, to). */
export function sliceClip(doc: Pick<StudioDoc, 'meta' | 'tempo'>, c: StudioClip, from: number, to: number): StudioClip {
  const out: StudioClip = { ...c, start: c.start + from, length: to - from };
  if (c.kind === 'audio') {
    // A reversed clip reads its source backwards: trimming the start eats the source's end.
    if (!c.reverse) out.offset = (c.offset ?? 0) + clipSrcSeconds(doc, c, 0, from);
    else out.offset = (c.offset ?? 0) + clipSrcSeconds(doc, c, to, c.length);
  } else {
    const notes: NonNullable<StudioClip['notes']> = {};
    for (const [id, n] of Object.entries(c.notes ?? {})) {
      if (n.start >= from && n.start < to) notes[id] = { ...n, start: n.start - from, len: Math.min(n.len, to - n.start) };
    }
    out.notes = notes;
  }
  return out;
}

/**
 * Non-destructive version of carveRangeOps for takes: active clips under
 * [start, end) are split at the range edges and the covered parts muted, so
 * every earlier take stays available for comping. `except` is left alone.
 */
export function muteRangeOps(doc: StudioDoc, trackId: string, start: number, end: number, except?: string): StudioOp[] {
  const ops: StudioOp[] = [];
  for (const [id, c] of Object.entries(doc.clips)) {
    if (c.trackId !== trackId || id === except || c.mute) continue;
    const cEnd = c.start + c.length;
    if (cEnd <= start + 1e-9 || c.start >= end - 1e-9) continue;
    const a = Math.max(0, start - c.start), b = Math.min(c.length, end - c.start);
    const pieces: StudioClip[] = [];
    if (a > 1e-9) pieces.push(sliceClip(doc, c, 0, a));
    pieces.push({ ...sliceClip(doc, c, a, b), mute: true });
    if (b < c.length - 1e-9) pieces.push(sliceClip(doc, c, b, c.length));
    pieces.forEach((p, i) => ops.push({ t: 'set', path: ['clips', i === 0 ? id : studioId()], value: p }));
  }
  return ops;
}

/** Make a take the active one for its range: unmute it, mute what it covers. */
export function compOps(doc: StudioDoc, clipId: string): StudioOp[] {
  const c = doc.clips[clipId];
  if (!c) return [];
  return [
    ...muteRangeOps(doc, c.trackId, c.start, c.start + c.length, clipId),
    ...(c.mute ? [{ t: 'del' as const, path: ['clips', clipId, 'mute'] }] : []),
  ];
}

/** Stacks overlapping clips into lanes (take view). Returns clipId → lane and the lane count. */
export function packLanes(clips: [string, StudioClip][]): { lane: Record<string, number>; count: number } {
  const sorted = [...clips].sort((a, b) => a[1].start - b[1].start || Number(!!a[1].mute) - Number(!!b[1].mute));
  const ends: number[] = [];
  const lane: Record<string, number> = {};
  for (const [id, c] of sorted) {
    let i = ends.findIndex((e) => e <= c.start + 1e-9);
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = c.start + c.length;
    lane[id] = i;
  }
  return { lane, count: Math.max(1, ends.length) };
}

/** The tracks clips can live on, by kind. */
export function clipFitsTrack(clipKind: StudioClip['kind'], trackKind: string | undefined): boolean {
  return (clipKind === 'audio' && trackKind === 'audio') || (clipKind === 'midi' && trackKind === 'instrument');
}
