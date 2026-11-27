import type { StudioDoc, StudioOp } from '../types/studio.js';

// Pure op application for Studio docs. Mirrors StudioSessionService.TryApply
// on the server (minus validation — the server is the authority and echoes
// only accepted ops). Updates are copy-on-write along the op path so React
// selectors see new references only for the entities that changed.

type Obj = Record<string, unknown>;

export function getAt(root: unknown, path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Obj)[key];
  }
  return node;
}

function setIn(node: unknown, path: string[], i: number, value: unknown, del: boolean): unknown {
  const obj: Obj = node && typeof node === 'object' ? { ...(node as Obj) } : {};
  const key = path[i];
  if (i === path.length - 1) {
    if (del) delete obj[key];
    else obj[key] = value;
    return obj;
  }
  // Field set on a missing entity is a no-op (matches server rejection).
  if (obj[key] == null || typeof obj[key] !== 'object') return node;
  obj[key] = setIn(obj[key], path, i + 1, value, del);
  return obj;
}

export function applyOp(doc: StudioDoc, op: StudioOp): StudioDoc {
  const { path } = op;
  if (path.length < 2) return doc;
  // Field ops on entities that don't exist are dropped.
  if (path.length > 2 && getAt(doc, path.slice(0, 2)) == null) return doc;
  if (path[2] === 'notes' && path.length > 4 && getAt(doc, path.slice(0, 4)) == null) return doc;

  let next = setIn(doc, path, 0, op.t === 'set' ? op.value : undefined, op.t === 'del') as StudioDoc;

  // Deleting a track cascades to its clips (server does the same).
  if (op.t === 'del' && path[0] === 'tracks' && path.length === 2) {
    const trackId = path[1];
    const clips = { ...next.clips };
    let changed = false;
    for (const [id, clip] of Object.entries(clips)) {
      if (clip.trackId === trackId) { delete clips[id]; changed = true; }
    }
    if (changed) next = { ...next, clips };
  }
  return next;
}

export function applyOps(doc: StudioDoc, ops: StudioOp[]): StudioDoc {
  let next = doc;
  for (const op of ops) next = applyOp(next, op);
  return next;
}

/**
 * Computes the ops that undo `ops` when applied after them, by reading
 * prior values from `doc` (the state the ops will be applied to).
 */
export function invertOps(doc: StudioDoc, ops: StudioOp[]): StudioOp[] {
  // One group per forward op; groups are undone in reverse order. A track
  // delete's group restores the track first, then the clips it cascaded.
  const groups: StudioOp[][] = [];
  let cur = doc;
  for (const op of ops) {
    const group: StudioOp[] = [];
    const entityExists = op.path.length <= 2 || getAt(cur, op.path.slice(0, 2)) != null;
    if (entityExists) {
      const prev = getAt(cur, op.path);
      if (prev !== undefined) group.push({ t: 'set', path: op.path, value: prev });
      else if (op.t === 'set') group.push({ t: 'del', path: op.path });

      if (op.t === 'del' && op.path[0] === 'tracks' && op.path.length === 2 && prev !== undefined) {
        for (const [id, clip] of Object.entries(cur.clips)) {
          if (clip.trackId === op.path[1]) group.push({ t: 'set', path: ['clips', id], value: clip });
        }
      }
    }
    if (group.length) groups.push(group);
    cur = applyOp(cur, op);
  }
  return groups.reverse().flat();
}

let idCounter = 0;
/** Short random id used for tracks, clips, notes and effects. */
export function studioId(): string {
  idCounter = (idCounter + 1) % 1296;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36).slice(-4)}${rand}${idCounter.toString(36)}`.slice(0, 16);
}

/** Tracks sorted by their `order` field (ties broken by id for stability). */
export function sortedTrackIds(doc: StudioDoc): string[] {
  return Object.keys(doc.tracks).sort((a, b) => (doc.tracks[a].order - doc.tracks[b].order) || a.localeCompare(b));
}

/** Seconds ↔ beats at a fixed tempo. */
export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}
export function secondsToBeats(seconds: number, bpm: number): number {
  return (seconds * bpm) / 60;
}

/** End of the arrangement in beats (last clip end), at least `min`. */
export function arrangementEnd(doc: StudioDoc, min = 16): number {
  let end = min;
  for (const clip of Object.values(doc.clips)) end = Math.max(end, clip.start + clip.length);
  return end;
}
