import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore, studioId } from '@abyss/shared';
import type { StudioClip, StudioNote, StudioOp, StudioTrack, StudioMeta } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { DRUM_MAP } from './engine/instruments';
import { barBeats, snapBeats, floorBeats, MIN_CLIP_BEATS, keyBelongsToTarget } from './studioUtils';
import { SCALES, PITCH_CLASSES, projectScale, inScale, nearestInScale } from './scales';

interface Props {
  clipId: string;
  clip: StudioClip;
  track: StudioTrack;
  trackId: string;
  meta: StudioMeta;
  engine: StudioEngine | null;
  editable: boolean;
  /** Clip-relative playhead in beats (null when outside the clip) */
  playheadInClip: number | null;
  onClose: () => void;
}

/** Note clipboard, shared across clips in this session. */
let noteClipboard: StudioNote[] | null = null;

const ROW_H = 14;
const RULER_H = 20;
const KEY_W = 64;
const VEL_H = 64;
const VEL_PAD = 4;
const EDGE_PX = 6;
const MIN_LEN = 1 / 64;
const NOTE_NAMES = PITCH_CLASSES;
const BLACK = new Set([1, 3, 6, 8, 10]);

/** Piano-roll grid sizes in beats, finest last (Ctrl+1 / Ctrl+2 step through). */
const GRID_OPTIONS = [
  { label: '1/4', value: 1 },
  { label: '1/8', value: 0.5 },
  { label: '1/8T', value: 1 / 3 },
  { label: '1/16', value: 0.25 },
  { label: '1/16T', value: 1 / 6 },
  { label: '1/32', value: 0.125 },
];
const QUANTIZE_AMOUNTS = [100, 75, 50, 25];

type Tool = 'draw' | 'select';
type Fold = 'off' | 'scale' | 'notes';

function noteName(pitch: number) {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** A small persisted per-device preference (never synced to collaborators). */
function usePref<T>(key: string, def: T, valid: (v: unknown) => boolean) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) { const parsed = JSON.parse(raw); if (valid(parsed)) return parsed as T; }
    } catch { /* ignore */ }
    return def;
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }, [key, v]);
  return [v, setV] as const;
}

type NoteDrag = {
  mode: 'move' | 'resize' | 'resizeStart' | 'draw';
  ids: string[];
  startX: number;
  startY: number;
  origin: Record<string, StudioNote>;
  moved: boolean;
  /** Ctrl/Cmd-drag: move copies, leave the originals */
  copy?: boolean;
  /** Pitch last auditioned during a vertical move (so each row sounds once). */
  heard?: number;
};

const copyKey = (id: string) => `copy:${id}`;

export default function PianoRoll({ clipId, clip, track, trackId, meta, engine, editable, playheadInClip, onClose }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const isDrums = track.instrument?.type === 'drums';
  const color = track.color ?? '#5865f2';
  const [pxPerBeat, setPxPerBeat] = useState(64);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreviewState] = useState<Record<string, StudioNote> | null>(null);
  const previewRef = useRef<Record<string, StudioNote> | null>(null);
  const setPreview = (p: Record<string, StudioNote> | null) => { previewRef.current = p; setPreviewState(p); };
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [hoverPitch, setHoverPitch] = useState<number | null>(null);
  const [popover, setPopover] = useState<'quantize' | 'scale' | null>(null);

  const [grid, setGrid] = usePref('studio.roll.grid', 0.25, (v) => GRID_OPTIONS.some((o) => o.value === v));
  const [tool, setTool] = usePref<Tool>('studio.roll.tool', 'draw', (v) => v === 'draw' || v === 'select');
  const [fold, setFold] = usePref<Fold>('studio.roll.fold', 'off', (v) => v === 'off' || v === 'scale' || v === 'notes');
  const [showVel, setShowVel] = usePref('studio.roll.velocity', true, (v) => typeof v === 'boolean');
  const [qAmount, setQAmount] = usePref('studio.roll.qAmount', 100, (v) => QUANTIZE_AMOUNTS.includes(v as number));
  const [qEnds, setQEnds] = usePref('studio.roll.qEnds', false, (v) => typeof v === 'boolean');

  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const velInnerRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const lastLen = useRef(grid);

  const scale = isDrums ? null : projectScale(meta);
  const notes = useMemo(() => clip.notes ?? {}, [clip.notes]);
  const shown = preview ? { ...notes, ...preview } : notes;

  const pitches = useMemo(() => {
    const base: number[] = isDrums
      ? Object.keys(DRUM_MAP).map(Number).sort((a, b) => b - a)
      : Array.from({ length: 108 - 24 + 1 }, (_, i) => 108 - i);
    const used = new Set(Object.values(notes).map((n) => n.pitch));
    if (fold === 'notes' && used.size) return base.filter((p) => used.has(p));
    if (fold === 'scale' && scale) return base.filter((p) => inScale(scale, p) || used.has(p));
    return base;
  }, [isDrums, notes, fold, scale]);
  const rowOf = useMemo(() => new Map(pitches.map((p, i) => [p, i])), [pitches]);
  /** Vertical moves step by row (semitones unfolded, scale degrees / kit pieces otherwise). */
  const rowStepping = isDrums || fold !== 'off';

  const viewBeats = Math.max(clip.length + barBeats(meta) * 2, barBeats(meta) * 4);
  const width = viewBeats * pxPerBeat;
  const perBar = barBeats(meta);

  // Scroll so existing notes (or middle C) are in view on open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isDrums) return;
    const ps = Object.values(clip.notes ?? {}).map((n) => n.pitch);
    const center = ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : 60;
    const row = rowOf.get(center) ?? rowOf.get(nearestRow(center)) ?? 0;
    el.scrollTop = Math.max(0, row * ROW_H - el.clientHeight / 2);
    // only on clip change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, isDrums]);

  useEffect(() => setSelected([]), [clipId]);

  // Close a popover on any outside click.
  useEffect(() => {
    if (!popover) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!popRef.current?.contains(t) && !t.closest('[data-roll-pop]')) setPopover(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [popover]);

  // Ctrl/Cmd + wheel zooms around the pointer. Native listener: React's is passive.
  const zoomRef = useRef(pxPerBeat);
  zoomRef.current = pxPerBeat;
  const pendingScroll = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const px = zoomRef.current;
      const next = Math.max(16, Math.min(256, px * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const offset = e.clientX - el.getBoundingClientRect().left - KEY_W;
      const beatAt = (el.scrollLeft + offset) / px;
      pendingScroll.current = beatAt * next - offset;
      setPxPerBeat(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
    }
    syncVelScroll();
  });

  function nearestRow(pitch: number): number {
    let best = pitches[0], dist = Infinity;
    for (const p of pitches) { const d = Math.abs(p - pitch); if (d < dist) { dist = d; best = p; } }
    return best;
  }

  const syncVelScroll = () => {
    const el = scrollRef.current, inner = velInnerRef.current;
    if (el && inner) inner.style.transform = `translateX(${-el.scrollLeft}px)`;
  };

  const posFromEvent = (clientX: number, clientY: number) => {
    const rect = gridRef.current!.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const row = Math.floor(y / ROW_H);
    return { x, y, beats: Math.max(0, x / pxPerBeat), pitch: pitches[Math.max(0, Math.min(pitches.length - 1, row))] };
  };

  const audition = (pitch: number) => { void engine?.previewNote(trackId, pitch); };

  const noteOps = (next: Record<string, StudioNote>, base: Record<string, StudioNote>) => {
    const ops: StudioOp[] = [];
    for (const [id, n] of Object.entries(next)) {
      const o = base[id];
      if (!o) continue;
      for (const f of ['start', 'pitch', 'len', 'vel'] as const) {
        if (n[f] !== o[f]) ops.push({ t: 'set', path: ['clips', clipId, 'notes', id, f], value: n[f] });
      }
    }
    return ops;
  };

  // ───────────── Note dragging ─────────────

  const beginDrag = (e: React.PointerEvent, d: NoteDrag) => {
    const move = (ev: PointerEvent) => {
      if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 3) return;
      d.moved = true;
      const g = ev.altKey ? 0 : grid; // Alt: off the grid
      const minLen = g > 0 ? Math.min(g, grid / 2) : MIN_LEN;
      const dxBeats = (ev.clientX - d.startX) / pxPerBeat;
      const dRows = Math.round((ev.clientY - d.startY) / ROW_H);
      const out: Record<string, StudioNote> = {};
      if (d.mode === 'move') {
        const prim = d.origin[d.ids[0]];
        let delta = snapBeats(prim.start + dxBeats, g) - prim.start;
        delta = Math.max(delta, -Math.min(...d.ids.map((id) => d.origin[id].start)));
        for (const id of d.ids) {
          const o = d.origin[id];
          const row = (rowOf.get(o.pitch) ?? 0) + dRows;
          const pitch = pitches[Math.max(0, Math.min(pitches.length - 1, row))];
          out[d.copy ? copyKey(id) : id] = { ...o, start: o.start + delta, pitch };
        }
        const lead = out[d.copy ? copyKey(d.ids[0]) : d.ids[0]].pitch;
        if (lead !== (d.heard ?? prim.pitch)) { d.heard = lead; audition(lead); }
      } else if (d.mode === 'resizeStart') {
        for (const id of d.ids) {
          const o = d.origin[id];
          const end = o.start + o.len;
          const start = Math.max(0, Math.min(end - minLen, snapBeats(o.start + dxBeats, g)));
          out[id] = { ...o, start, len: end - start };
        }
      } else {
        for (const id of d.ids) {
          const o = d.origin[id];
          const len = Math.max(minLen, snapBeats(o.start + o.len + dxBeats, g) - o.start);
          out[id] = { ...o, len };
        }
      }
      setPreview(out);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const result = previewRef.current;
      setPreview(null);
      if (d.mode === 'draw') {
        // Commit the freshly drawn note (with whatever length it was dragged to).
        const [id] = d.ids;
        const note = result?.[id] ?? d.origin[id];
        lastLen.current = note.len;
        edit([{ t: 'set', path: ['clips', clipId, 'notes', id], value: note }]);
        return;
      }
      if (!d.moved || !result) return;
      if (d.copy) {
        const ids: string[] = [];
        const ops: StudioOp[] = d.ids.map((id) => {
          const nid = studioId();
          ids.push(nid);
          return { t: 'set', path: ['clips', clipId, 'notes', nid], value: result[copyKey(id)] };
        });
        edit(ops);
        setSelected(ids);
        return;
      }
      const ops = noteOps(result, d.origin);
      if (d.mode !== 'move') { const first = result[d.ids[0]]; if (first) lastLen.current = first.len; }
      if (ops.length) edit(ops);
    };
    e.preventDefault();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addNoteAt = (e: React.PointerEvent | React.MouseEvent, drag: boolean) => {
    const { beats, pitch } = posFromEvent(e.clientX, e.clientY);
    const id = studioId();
    const g = e.altKey ? 0 : grid;
    const note: StudioNote = { pitch, start: floorBeats(beats, g), len: isDrums ? grid : lastLen.current, vel: 0.8 };
    setSelected([id]);
    audition(pitch);
    if (drag) {
      setPreview({ [id]: note });
      beginDrag(e as React.PointerEvent, { mode: 'draw', ids: [id], startX: e.clientX, startY: e.clientY, origin: { [id]: note }, moved: false });
    } else {
      edit([{ t: 'set', path: ['clips', clipId, 'notes', id], value: note }]);
    }
  };

  // Rubber-band selection over empty grid (Select tool).
  const beginMarquee = (e: React.PointerEvent) => {
    const start = posFromEvent(e.clientX, e.clientY);
    const base = e.shiftKey ? selected : [];
    if (!e.shiftKey) setSelected([]);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const cur = posFromEvent(ev.clientX, ev.clientY);
      if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) < 3) return;
      moved = true;
      const box = { x0: Math.min(start.x, cur.x), y0: Math.min(start.y, cur.y), x1: Math.max(start.x, cur.x), y1: Math.max(start.y, cur.y) };
      setMarquee(box);
      const hit: string[] = [];
      for (const [id, n] of Object.entries(notes)) {
        const row = rowOf.get(n.pitch);
        if (row === undefined) continue;
        const l = n.start * pxPerBeat, r = (n.start + n.len) * pxPerBeat, t = row * ROW_H, b = t + ROW_H;
        if (r >= box.x0 && l <= box.x1 && b >= box.y0 && t <= box.y1) hit.push(id);
      }
      setSelected([...new Set([...base, ...hit])]);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
    };
    e.preventDefault();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onGridPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    rootRef.current?.focus({ preventScroll: true });
    setPopover(null);
    if (tool === 'select' || !editable) { beginMarquee(e); return; }
    addNoteAt(e, true);
  };

  const onGridDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select' || !editable || e.target !== gridRef.current) return;
    addNoteAt(e, false);
  };

  const onGridPointerMove = (e: React.PointerEvent) => {
    const { pitch } = posFromEvent(e.clientX, e.clientY);
    if (pitch !== hoverPitch) setHoverPitch(pitch);
  };

  const onNotePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    setPopover(null);
    if (e.button === 2) return;
    const note = notes[id];
    if (!note) return;
    let sel = selected;
    if (e.shiftKey) {
      sel = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
      setSelected(sel);
      return;
    }
    if (!selected.includes(id)) { sel = [id]; setSelected(sel); }
    audition(note.pitch);
    if (!editable) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edges = rect.width > EDGE_PX * 3;
    const mode: NoteDrag['mode'] = e.clientX >= rect.right - EDGE_PX ? 'resize' : edges && e.clientX <= rect.left + EDGE_PX ? 'resizeStart' : 'move';
    // Resizing applies to every selected note, like moving does.
    const ids = sel.filter((s) => notes[s]);
    const origin: Record<string, StudioNote> = {};
    for (const s of ids) origin[s] = notes[s];
    const copy = mode === 'move' && (e.ctrlKey || e.metaKey);
    beginDrag(e, { mode, ids: [id, ...ids.filter((s) => s !== id)], startX: e.clientX, startY: e.clientY, origin, moved: false, copy });
  };

  const onKeyPointerDown = (e: React.PointerEvent, pitch: number) => {
    audition(pitch);
    rootRef.current?.focus({ preventScroll: true });
    // Clicking a key selects every note on that row (Shift adds).
    const ids = Object.entries(notes).filter(([, n]) => n.pitch === pitch).map(([id]) => id);
    setSelected((s) => (e.shiftKey ? [...new Set([...s, ...ids])] : ids));
  };

  // ───────────── Edits on the selection ─────────────

  /** Selected notes, or every note in the clip when nothing is selected. */
  const targets = () => {
    const sel = selected.filter((id) => notes[id]);
    return sel.length ? sel : Object.keys(notes);
  };

  const deleteNotes = (ids: string[]) => {
    if (!editable || !ids.length) return;
    edit(ids.filter((id) => notes[id]).map((id) => ({ t: 'del' as const, path: ['clips', clipId, 'notes', id] })));
    setSelected((s) => s.filter((x) => !ids.includes(x)));
  };

  const transform = (ids: string[], fn: (n: StudioNote) => StudioNote | null) => {
    const next: Record<string, StudioNote> = {};
    for (const id of ids) {
      const n = notes[id];
      if (!n) continue;
      const t = fn(n);
      if (!t) return; // a note would leave the valid range — do nothing
      next[id] = t;
    }
    const ops = noteOps(next, notes);
    if (ops.length) edit(ops);
  };

  const quantize = () => {
    if (!editable) return;
    const amt = qAmount / 100;
    const q = (v: number) => v + (snapBeats(v, grid) - v) * amt;
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    transform(targets(), (n) => {
      const start = round(Math.max(0, q(n.start)));
      let len = qEnds ? q(n.start + n.len) - start : n.len;
      if (qEnds && len < grid / 2) len = grid; // never quantize a note away
      return { ...n, start, len: round(Math.max(MIN_LEN, len)) };
    });
  };

  const fitToScale = () => {
    if (!editable || !scale) return;
    transform(targets(), (n) => ({ ...n, pitch: nearestInScale(scale, n.pitch) }));
  };

  const pasteNotes = (list: StudioNote[], at: number) => {
    if (!list.length) return;
    const anchor = Math.min(...list.map((n) => n.start));
    const ids: string[] = [];
    const ops: StudioOp[] = list.map((n) => {
      const id = studioId();
      ids.push(id);
      return { t: 'set', path: ['clips', clipId, 'notes', id], value: { ...n, start: Math.max(0, at + n.start - anchor) } };
    });
    edit(ops);
    setSelected(ids);
  };

  const stepGrid = (finer: boolean) => {
    const i = GRID_OPTIONS.findIndex((o) => o.value === grid);
    const j = Math.max(0, Math.min(GRID_OPTIONS.length - 1, i + (finer ? 1 : -1)));
    setGrid(GRID_OPTIONS[j].value);
  };

  const setScale = (patch: { scaleRoot?: number; scaleMode?: string }) => {
    if (!editable) return;
    const ops: StudioOp[] = Object.entries(patch).map(([k, v]) => ({ t: 'set', path: ['meta', k], value: v }));
    edit(ops);
  };

  // Note-editing shortcuts while the roll has focus. Handled keys stop here so
  // the arrange view's shortcuts don't also fire.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (keyBelongsToTarget(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const sel = selected.filter((id) => notes[id]);

    if (mod && key === 'a') { done(); setSelected(Object.keys(notes)); return; }
    if (mod && key === 'c' && sel.length) { done(); noteClipboard = sel.map((id) => notes[id]); return; }
    if (mod && key === '1') { done(); stepGrid(true); return; }
    if (mod && key === '2') { done(); stepGrid(false); return; }
    if (key === 'Escape') { done(); if (popover) setPopover(null); else if (selected.length) setSelected([]); else onClose(); return; }
    if (!mod && key === 'b') { done(); setTool((t) => (t === 'draw' ? 'select' : 'draw')); return; }
    if (!editable) return;
    if ((key === 'Delete' || key === 'Backspace') && sel.length) { done(); deleteNotes(sel); return; }
    if (mod && key === 'u') { done(); quantize(); return; }
    if (mod && key === 'x' && sel.length) { done(); noteClipboard = sel.map((id) => notes[id]); deleteNotes(sel); return; }
    if (mod && key === 'v' && noteClipboard?.length) {
      done();
      pasteNotes(noteClipboard, playheadInClip ?? 0);
      return;
    }
    if (mod && key === 'd' && sel.length) {
      done();
      const list = sel.map((id) => notes[id]);
      const start = Math.min(...list.map((n) => n.start));
      const end = Math.max(...list.map((n) => n.start + n.len));
      pasteNotes(list, start + Math.max(grid, end - start));
      return;
    }
    if (mod) return;
    if ((key === 'ArrowUp' || key === 'ArrowDown') && sel.length) {
      done();
      const up = key === 'ArrowUp';
      if (rowStepping && !e.shiftKey) {
        // Step between visible rows: kit pieces, or scale degrees when folded.
        transform(sel, (n) => {
          const row = (rowOf.get(n.pitch) ?? 0) + (up ? -1 : 1);
          return row >= 0 && row < pitches.length ? { ...n, pitch: pitches[row] } : null;
        });
      } else {
        const d = (up ? 1 : -1) * (e.shiftKey ? 12 : 1);
        transform(sel, (n) => (n.pitch + d >= 0 && n.pitch + d <= 127 ? { ...n, pitch: n.pitch + d } : null));
      }
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && sel.length) {
      done();
      const d = (key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? perBar : grid);
      transform(sel, (n) => (n.start + d >= 0 ? { ...n, start: n.start + d } : null));
      return;
    }
  };

  const onNoteWheel = (e: React.WheelEvent, id: string) => {
    if (!editable || !e.shiftKey) return;
    e.preventDefault();
    const n = notes[id];
    if (!n) return;
    const vel = Math.max(0.05, Math.min(1, Math.round((n.vel + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100));
    edit([{ t: 'set', path: ['clips', clipId, 'notes', id, 'vel'], value: vel }], { undoable: true });
  };

  // ───────────── Velocity lane ─────────────

  const velOfY = (y: number) => Math.max(0.01, Math.min(1, 1 - (y - VEL_PAD) / (VEL_H - VEL_PAD * 2)));

  const onVelPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !editable) return;
    e.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const rect = velInnerRef.current!.getBoundingClientRect();
    const xOf = (cx: number) => cx - rect.left;
    const x0 = xOf(e.clientX);
    // Grab a stem: drag it (and the rest of the selection) relatively.
    let grabbed: string | null = null, best = 5;
    for (const [id, n] of Object.entries(notes)) {
      const d = Math.abs(n.start * pxPerBeat - x0);
      if (d < best || (d === best && selected.includes(id))) { best = d; grabbed = id; }
    }
    const origin = { ...notes };
    let out: Record<string, StudioNote> = {};
    let move: (ev: PointerEvent) => void;
    if (grabbed) {
      const ids = selected.includes(grabbed) ? selected.filter((s) => notes[s]) : [grabbed];
      if (!selected.includes(grabbed)) setSelected([grabbed]);
      const startY = e.clientY;
      move = (ev) => {
        const dv = -(ev.clientY - startY) / (VEL_H - VEL_PAD * 2);
        out = {};
        for (const id of ids) out[id] = { ...origin[id], vel: Math.round(Math.max(0.01, Math.min(1, origin[id].vel + dv)) * 100) / 100 };
        setPreview(out);
      };
    } else {
      // Paint: sweep across notes, setting each to the pointer height.
      let lastX = x0;
      move = (ev) => {
        const x = xOf(ev.clientX);
        const vel = Math.round(velOfY(ev.clientY - rect.top) * 100) / 100;
        const lo = Math.min(lastX, x) - 3, hi = Math.max(lastX, x) + 3;
        lastX = x;
        for (const [id, n] of Object.entries(origin)) {
          const nx = n.start * pxPerBeat;
          if (nx >= lo && nx <= hi) out[id] = { ...n, vel };
        }
        setPreview({ ...out });
      };
      move(e.nativeEvent);
    }
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPreview(null);
      const ops = noteOps(out, origin);
      if (ops.length) edit(ops);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Drag the clip-end marker to change clip length.
  const onEndPointerDown = (e: React.PointerEvent) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const origin = clip.length;
    let last = origin;
    const marker = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      last = Math.max(MIN_CLIP_BEATS, snapBeats(origin + (ev.clientX - startX) / pxPerBeat, grid));
      marker.style.left = `${last * pxPerBeat}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (last !== origin) edit([{ t: 'set', path: ['clips', clipId, 'length'], value: last }]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ───────────── Render ─────────────

  // Align bar lines with the song's bars, not the clip start.
  const barOffsetPx = -((clip.start % perBar) * pxPerBeat);
  const gridBg = {
    backgroundSize: `${pxPerBeat * perBar}px 100%, ${pxPerBeat}px 100%, ${pxPerBeat * grid}px 100%`,
    backgroundPosition: `${barOffsetPx}px 0, 0 0, 0 0`,
  };
  // Song bar numbers that fall within the visible range (clip-relative beats).
  const rulerBars: { bar: number; at: number }[] = [];
  for (let b = Math.ceil(clip.start / perBar - 1e-9); b * perBar < clip.start + viewBeats; b++) {
    rulerBars.push({ bar: b + 1, at: b * perBar - clip.start });
  }

  const keyLabel = (p: number) => {
    if (isDrums) return DRUM_MAP[p];
    if (fold !== 'off' || p % 12 === 0 || (scale && p % 12 === scale.root)) return noteName(p);
    return '';
  };
  const rowClass = (p: number) => {
    if (isDrums) return '';
    if (scale) return inScale(scale, p) ? (p % 12 === scale.root ? ' root' : ' in-scale') : ' off-scale';
    return BLACK.has(p % 12) ? ' black' : '';
  };
  const selectedSet = new Set(selected);
  const noteCount = Object.keys(notes).length;
  const help = editable
    ? 'Draw tool: click to add · Select tool: drag to select, double-click to add (B toggles)\n'
      + 'Drag to move · Ctrl/Cmd-drag copies · Alt ignores the grid · drag either edge to resize\n'
      + 'Right-click or double-click a note to delete · Shift+wheel for velocity · Ctrl+wheel to zoom\n'
      + 'Ctrl+U quantize · Ctrl+1 / Ctrl+2 finer / wider grid · ↑↓ transpose (Shift = octave) · click a key to select its notes'
    : 'View only';

  return (
    <div className="studio-piano-roll" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} style={{ ['--track-color' as string]: color }}>
      <div className="studio-panel-toolbar studio-roll-toolbar">
        <span className="studio-panel-title" title={help}>🎹 {clip.name || 'MIDI clip'}</span>
        <span className="studio-muted">{noteCount} note{noteCount === 1 ? '' : 's'}{selected.length ? ` · ${selected.length} selected` : ''}</span>

        <div className="studio-seg" title="Tool (B)">
          <button className={`studio-seg-btn${tool === 'draw' ? ' on' : ''}`} onClick={() => setTool('draw')} title="Draw: click to add notes">✏️</button>
          <button className={`studio-seg-btn${tool === 'select' ? ' on' : ''}`} onClick={() => setTool('select')} title="Select: drag a box, double-click to add">⬚</button>
        </div>

        <select className="studio-select" value={grid} onChange={(e) => setGrid(Number(e.target.value))} title="Grid (Ctrl+1 finer · Ctrl+2 wider · Alt-drag ignores it)">
          {GRID_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
        </select>

        {editable && (
          <div className="studio-roll-popwrap">
            <div className="studio-seg">
              <button className="studio-seg-btn" onClick={quantize} title={`Quantize ${selected.length ? 'selected notes' : 'all notes'} to ${GRID_OPTIONS.find((o) => o.value === grid)?.label} (Ctrl+U)`}>
                Quantize{qAmount < 100 ? ` ${qAmount}%` : ''}
              </button>
              <button className={`studio-seg-btn${popover === 'quantize' ? ' on' : ''}`} data-roll-pop onClick={() => setPopover((p) => (p === 'quantize' ? null : 'quantize'))} title="Quantize settings">▾</button>
            </div>
            {popover === 'quantize' && (
              <div className="studio-roll-pop" ref={popRef}>
                <div className="studio-roll-pop-label">Amount</div>
                <div className="studio-seg">
                  {QUANTIZE_AMOUNTS.map((a) => (
                    <button key={a} className={`studio-seg-btn${qAmount === a ? ' on' : ''}`} onClick={() => setQAmount(a)}>{a}%</button>
                  ))}
                </div>
                <label className="studio-check">
                  <input type="checkbox" checked={qEnds} onChange={(e) => setQEnds(e.target.checked)} />
                  Quantize note ends
                </label>
                <div className="studio-muted studio-roll-pop-hint">Uses the piano roll grid. Applies to the selection, or the whole clip when nothing is selected.</div>
              </div>
            )}
          </div>
        )}

        {!isDrums && (
          <div className="studio-roll-popwrap">
            <button className={`studio-btn small${scale ? ' on' : ''}`} data-roll-pop onClick={() => setPopover((p) => (p === 'scale' ? null : 'scale'))} title="Project scale (shared with everyone)">
              🎼 {scale ? scale.label : 'Scale'}
            </button>
            {popover === 'scale' && (
              <div className="studio-roll-pop studio-roll-scale-pop" ref={popRef}>
                <div className="studio-roll-pop-label">Root</div>
                <div className="studio-roll-roots">
                  {PITCH_CLASSES.map((n, i) => (
                    <button key={n} className={`studio-seg-btn${(meta.scaleRoot ?? 0) === i ? ' on' : ''}`} disabled={!editable}
                      onClick={() => setScale({ scaleRoot: i, ...(scale ? {} : { scaleMode: 'major' }) })}>
                      {n}
                    </button>
                  ))}
                </div>
                <div className="studio-roll-pop-label">Scale</div>
                <div className="studio-roll-modes">
                  <button className={`studio-seg-btn${!scale ? ' on' : ''}`} disabled={!editable} onClick={() => setScale({ scaleMode: 'none' })}>None</button>
                  {SCALES.map((s) => (
                    <button key={s.id} className={`studio-seg-btn${scale?.id === s.id ? ' on' : ''}`} disabled={!editable} onClick={() => setScale({ scaleMode: s.id })}>
                      {s.label}
                    </button>
                  ))}
                </div>
                {editable && scale && (
                  <button className="studio-btn small" onClick={fitToScale} title="Move out-of-scale notes to the nearest scale note">
                    Snap {selected.length ? 'selection' : 'all notes'} to scale
                  </button>
                )}
                {!editable && <div className="studio-muted studio-roll-pop-hint">Only editors can change the project scale.</div>}
              </div>
            )}
          </div>
        )}

        <select className="studio-select" value={fold} onChange={(e) => setFold(e.target.value as Fold)} title="Which rows to show">
          <option value="off">All keys</option>
          {!isDrums && <option value="scale" disabled={!scale}>Scale only</option>}
          <option value="notes">Used only</option>
        </select>

        <button className={`studio-btn small${showVel ? ' on' : ''}`} onClick={() => setShowVel((v) => !v)} title="Velocity lane">Velocity</button>
        {editable && selected.length > 0 && (
          <button className="studio-btn small" onClick={() => deleteNotes(selected)} title="Delete selected notes (Delete)">🗑 {selected.length}</button>
        )}

        <div className="studio-spacer" />
        <button className="studio-btn small" onClick={() => setPxPerBeat((z) => Math.max(16, z / 1.25))} title="Zoom out (Ctrl+wheel)">−</button>
        <button className="studio-btn small" onClick={() => setPxPerBeat((z) => Math.min(256, z * 1.25))} title="Zoom in (Ctrl+wheel)">+</button>
        <button className="studio-btn small" onClick={onClose} title="Close editor">✕</button>
      </div>

      <div className="studio-roll-scroll" ref={scrollRef} onScroll={syncVelScroll}>
        <div className="studio-roll-inner" style={{ width: KEY_W + width, height: RULER_H + pitches.length * ROW_H }}>
          <div className="studio-roll-ruler" style={{ height: RULER_H, width: KEY_W + width }}>
            <div className="studio-roll-ruler-corner" style={{ width: KEY_W }} />
            <div className="studio-roll-ruler-clip" style={{ left: KEY_W, width: clip.length * pxPerBeat }}>
              {clip.name || 'Clip'}
            </div>
            {rulerBars.map(({ bar, at }) => (
              <div key={bar} className="studio-roll-ruler-bar" style={{ left: KEY_W + at * pxPerBeat }}>{bar}</div>
            ))}
          </div>
          <div className="studio-roll-keys" style={{ width: KEY_W }}>
            {pitches.map((p) => (
              <div
                key={p}
                className={`studio-roll-key${!isDrums && BLACK.has(p % 12) ? ' black' : ''}${!isDrums && p % 12 === 0 ? ' c' : ''}${scale ? rowClass(p) : ''}${hoverPitch === p ? ' hover' : ''}`}
                style={{ height: ROW_H }}
                onPointerDown={(e) => onKeyPointerDown(e, p)}
              >
                {keyLabel(p)}
              </div>
            ))}
          </div>
          <div
            className={`studio-roll-grid${tool === 'select' || !editable ? ' select-tool' : ''}`}
            ref={gridRef}
            style={{ left: KEY_W, top: RULER_H, width, height: pitches.length * ROW_H, ...gridBg }}
            onPointerDown={onGridPointerDown}
            onPointerMove={onGridPointerMove}
            onPointerLeave={() => setHoverPitch(null)}
            onDoubleClick={onGridDoubleClick}
            onContextMenu={(e) => e.preventDefault()}
          >
            {pitches.map((p, i) => {
              const cls = rowClass(p);
              return cls ? <div key={p} className={`studio-roll-row${cls}`} style={{ top: i * ROW_H, height: ROW_H }} /> : null;
            })}
            {hoverPitch != null && rowOf.has(hoverPitch) && (
              <div className="studio-roll-row-hover" style={{ top: rowOf.get(hoverPitch)! * ROW_H, height: ROW_H }} />
            )}
            <div className="studio-roll-inside" style={{ width: clip.length * pxPerBeat }} />
            <div className="studio-roll-outside" style={{ left: clip.length * pxPerBeat }} title="Outside the clip — notes here won't play" />
            {Object.entries(shown).map(([id, n]) => {
              const row = rowOf.get(n.pitch);
              if (row === undefined) return null;
              const w = Math.max(4, n.len * pxPerBeat - 1);
              const sel = selectedSet.has(id) || id.startsWith('copy:');
              const off = scale && !inScale(scale, n.pitch);
              return (
                <div
                  key={id}
                  className={`studio-note${sel ? ' selected' : ''}${n.start >= clip.length ? ' outside' : ''}${off ? ' off-scale' : ''}`}
                  style={{
                    left: n.start * pxPerBeat,
                    top: row * ROW_H + 1,
                    width: w,
                    height: ROW_H - 2,
                    opacity: 0.45 + n.vel * 0.55,
                  }}
                  title={`${isDrums ? DRUM_MAP[n.pitch] ?? noteName(n.pitch) : noteName(n.pitch)} · vel ${Math.round(n.vel * 127)}${off ? ' · not in scale' : ''}`}
                  onPointerDown={(e) => onNotePointerDown(e, id)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); deleteNotes([id]); }}
                  onDoubleClick={(e) => { e.stopPropagation(); deleteNotes([id]); }}
                  onWheel={(e) => onNoteWheel(e, id)}
                >
                  {!isDrums && w >= 30 && <span className="studio-note-label">{noteName(n.pitch)}</span>}
                </div>
              );
            })}
            {marquee && (
              <div className="studio-roll-marquee" style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }} />
            )}
            {playheadInClip != null && (
              <div className="studio-playhead" style={{ transform: `translateX(${playheadInClip * pxPerBeat}px)` }} />
            )}
            <div
              className="studio-roll-end"
              style={{ left: clip.length * pxPerBeat }}
              title={editable ? 'Drag to change clip length' : undefined}
              onPointerDown={onEndPointerDown}
            />
          </div>
        </div>
      </div>

      {showVel && (
        <div className="studio-roll-vel" style={{ height: VEL_H }}>
          <div className="studio-roll-vel-label" style={{ width: KEY_W }}>Velocity</div>
          <div className="studio-roll-vel-area" onPointerDown={onVelPointerDown}
            title={editable ? 'Drag a stem to change it (and the selection) · drag elsewhere to paint velocities' : undefined}>
            <div className="studio-roll-vel-inner" ref={velInnerRef} style={{ width, ...gridBg }}>
              {Object.entries(shown).filter(([id]) => !id.startsWith('copy:')).map(([id, n]) => {
                const h = n.vel * (VEL_H - VEL_PAD * 2);
                return (
                  <div key={id} className={`studio-vel-bar${selectedSet.has(id) ? ' selected' : ''}`}
                    style={{ left: n.start * pxPerBeat, height: h, bottom: VEL_PAD }}
                    title={`${Math.round(n.vel * 127)}`} />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
