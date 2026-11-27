import { useServerStore, useStudioStore, useToastStore, studioId, secondsToBeats } from '@abyss/shared';
import type { StudioAsset, StudioDoc, StudioClip, StudioMeta, StudioOp } from '@abyss/shared';
import { decodeBlob, putBuffer } from './engine/assetCache';

export const HEADER_WIDTH = 220;
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

/** "bar.beat.sixteenth" display of a beat position. */
export function formatPosition(beats: number, meta: StudioMeta): string {
  const perBar = barBeats(meta);
  const bar = Math.floor(beats / perBar) + 1;
  const inBar = beats - (bar - 1) * perBar;
  const beat = Math.floor(inBar) + 1;
  const sixteenth = Math.floor((inBar % 1) * 4) + 1;
  return `${bar}.${beat}.${sixteenth}`;
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
      const buffer = await decodeBlob(await file.arrayBuffer());
      const asset = await useStudioStore.getState().uploadAsset(file, file.name, buffer.duration, (pct) => onProgress?.(file.name, pct));
      putBuffer(asset.id, buffer);
      out.push(asset);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: unknown } })?.response?.data;
      useToastStore.getState().addToast(
        typeof msg === 'string' ? msg : `Couldn't add ${file.name} — is it an audio file?`,
        'error',
      );
    }
  }
  return out;
}

/** Op that places an asset as a new clip on an audio track. */
export function audioClipOp(asset: StudioAsset, trackId: string, startBeats: number, bpm: number) {
  const clip: StudioClip = {
    trackId,
    kind: 'audio',
    start: Math.max(0, startBeats),
    length: Math.max(MIN_CLIP_BEATS, secondsToBeats(asset.durationSec, bpm)),
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
  const bpm = doc.meta.bpm;
  /** The part of clip `c` between clip-relative beats [from, to) */
  const slice = (c: StudioClip, from: number, to: number): StudioClip => {
    const out: StudioClip = { ...c, start: c.start + from, length: to - from };
    if (c.kind === 'audio') out.offset = (c.offset ?? 0) + (from * 60) / bpm;
    else {
      const notes: NonNullable<StudioClip['notes']> = {};
      for (const [id, n] of Object.entries(c.notes ?? {})) {
        if (n.start >= from && n.start < to) notes[id] = { ...n, start: n.start - from, len: Math.min(n.len, to - n.start) };
      }
      out.notes = notes;
    }
    return out;
  };
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
