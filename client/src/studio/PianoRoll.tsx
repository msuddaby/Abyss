import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore, studioId } from '@abyss/shared';
import type { StudioClip, StudioNote, StudioOp, StudioTrack, StudioMeta } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { DRUM_MAP } from './engine/instruments';
import { barBeats, snapBeats, floorBeats, MIN_CLIP_BEATS, isTypingTarget } from './studioUtils';

interface Props {
  clipId: string;
  clip: StudioClip;
  track: StudioTrack;
  trackId: string;
  meta: StudioMeta;
  engine: StudioEngine | null;
  editable: boolean;
  snapGrid: number;
  /** Clip-relative playhead in beats (null when outside the clip) */
  playheadInClip: number | null;
  onClose: () => void;
}

const ROW_H = 14;
const KEY_W = 64;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const EDGE_PX = 6;

function noteName(pitch: number) {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

type NoteDrag = {
  mode: 'move' | 'resize' | 'draw';
  ids: string[];
  startX: number;
  startY: number;
  origin: Record<string, StudioNote>;
  moved: boolean;
};

export default function PianoRoll({ clipId, clip, track, trackId, meta, engine, editable, snapGrid, playheadInClip, onClose }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const isDrums = track.instrument?.type === 'drums';
  const [pxPerBeat, setPxPerBeat] = useState(64);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreviewState] = useState<Record<string, StudioNote> | null>(null);
  const previewRef = useRef<Record<string, StudioNote> | null>(null);
  const setPreview = (p: Record<string, StudioNote> | null) => { previewRef.current = p; setPreviewState(p); };
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const grid = snapGrid > 0 ? snapGrid : 0.25;
  const lastLen = useRef(grid);

  const pitches = useMemo(() => {
    if (isDrums) {
      return Object.keys(DRUM_MAP).map(Number).sort((a, b) => b - a);
    }
    const list: number[] = [];
    for (let p = 108; p >= 24; p--) list.push(p);
    return list;
  }, [isDrums]);
  const rowOf = useMemo(() => new Map(pitches.map((p, i) => [p, i])), [pitches]);

  const notes = clip.notes ?? {};
  const shown = preview ? { ...notes, ...preview } : notes;
  const viewBeats = Math.max(clip.length + barBeats(meta) * 2, barBeats(meta) * 4);
  const width = viewBeats * pxPerBeat;

  // Scroll so existing notes (or middle C) are in view on open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isDrums) return;
    const ps = Object.values(clip.notes ?? {}).map((n) => n.pitch);
    const center = ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : 60;
    const row = rowOf.get(center) ?? 0;
    el.scrollTop = Math.max(0, row * ROW_H - el.clientHeight / 2);
    // only on clip change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, isDrums]);

  useEffect(() => setSelected([]), [clipId]);

  const posFromEvent = (clientX: number, clientY: number) => {
    const rect = gridRef.current!.getBoundingClientRect();
    const beats = Math.max(0, (clientX - rect.left) / pxPerBeat);
    const row = Math.floor((clientY - rect.top) / ROW_H);
    return { beats, pitch: pitches[Math.max(0, Math.min(pitches.length - 1, row))] };
  };

  const audition = (pitch: number) => { void engine?.previewNote(trackId, pitch); };

  const beginDrag = (e: React.PointerEvent, d: NoteDrag) => {
    const move = (ev: PointerEvent) => {
      if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 3) return;
      d.moved = true;
      const dxBeats = (ev.clientX - d.startX) / pxPerBeat;
      const dRows = Math.round((ev.clientY - d.startY) / ROW_H);
      const out: Record<string, StudioNote> = {};
      if (d.mode === 'move') {
        const prim = d.origin[d.ids[0]];
        let delta = snapBeats(prim.start + dxBeats, grid) - prim.start;
        delta = Math.max(delta, -Math.min(...d.ids.map((id) => d.origin[id].start)));
        for (const id of d.ids) {
          const o = d.origin[id];
          const row = (rowOf.get(o.pitch) ?? 0) + dRows;
          const pitch = pitches[Math.max(0, Math.min(pitches.length - 1, row))];
          out[id] = { ...o, start: o.start + delta, pitch };
        }
        if (dRows !== 0 && d.ids.length === 1 && out[d.ids[0]].pitch !== prim.pitch) audition(out[d.ids[0]].pitch);
      } else {
        for (const id of d.ids) {
          const o = d.origin[id];
          const len = Math.max(grid / 2, snapBeats(o.start + o.len + dxBeats, grid) - o.start);
          out[id] = { ...o, len: Math.max(1 / 64, len) };
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
      const ops: StudioOp[] = [];
      for (const [id, n] of Object.entries(result)) {
        const o = d.origin[id];
        for (const f of ['start', 'pitch', 'len'] as const) {
          if (n[f] !== o[f]) ops.push({ t: 'set', path: ['clips', clipId, 'notes', id, f], value: n[f] });
        }
        if (d.mode === 'resize') lastLen.current = n.len;
      }
      if (ops.length) edit(ops);
    };
    e.preventDefault();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onGridPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!editable) return;
    const { beats, pitch } = posFromEvent(e.clientX, e.clientY);
    const id = studioId();
    const note: StudioNote = { pitch, start: floorBeats(beats, grid), len: isDrums ? grid : lastLen.current, vel: 0.8 };
    setSelected([id]);
    setPreview({ [id]: note });
    audition(pitch);
    beginDrag(e, { mode: 'draw', ids: [id], startX: e.clientX, startY: e.clientY, origin: { [id]: note }, moved: false });
  };

  const onNotePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
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
    const resize = e.clientX >= rect.right - EDGE_PX;
    const ids = resize ? [id] : sel.filter((s) => notes[s]);
    const origin: Record<string, StudioNote> = {};
    for (const s of ids) origin[s] = notes[s];
    beginDrag(e, { mode: resize ? 'resize' : 'move', ids, startX: e.clientX, startY: e.clientY, origin, moved: false });
  };

  const deleteNotes = (ids: string[]) => {
    if (!editable || !ids.length) return;
    edit(ids.filter((id) => notes[id]).map((id) => ({ t: 'del' as const, path: ['clips', clipId, 'notes', id] })));
    setSelected((s) => s.filter((x) => !ids.includes(x)));
  };

  // Delete / select-all / velocity nudges while the roll has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
      e.preventDefault();
      e.stopPropagation();
      deleteNotes(selected);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      setSelected(Object.keys(notes));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (selected.length) setSelected([]);
      else onClose();
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

  const perBar = barBeats(meta);
  const gridBg = {
    backgroundSize: `${pxPerBeat * perBar}px 100%, ${pxPerBeat}px 100%, ${pxPerBeat * grid}px 100%`,
  };

  return (
    <div className="studio-piano-roll" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="studio-panel-toolbar">
        <span className="studio-panel-title">🎹 {clip.name || 'MIDI clip'}</span>
        <span className="studio-muted">{Object.keys(notes).length} notes</span>
        <span className="studio-muted studio-hint">
          {editable ? 'Click to draw · drag to move · drag right edge to resize · right-click to delete · Shift+wheel for velocity' : 'View only'}
        </span>
        <div className="studio-spacer" />
        <button className="studio-btn small" onClick={() => setPxPerBeat((z) => Math.max(16, z / 1.25))} title="Zoom out">−</button>
        <button className="studio-btn small" onClick={() => setPxPerBeat((z) => Math.min(256, z * 1.25))} title="Zoom in">+</button>
        <button className="studio-btn small" onClick={onClose} title="Close editor">✕</button>
      </div>
      <div className="studio-roll-scroll" ref={scrollRef}>
        <div className="studio-roll-inner" style={{ width: KEY_W + width, height: pitches.length * ROW_H }}>
          <div className="studio-roll-keys" style={{ width: KEY_W }}>
            {pitches.map((p) => (
              <div
                key={p}
                className={`studio-roll-key${!isDrums && BLACK.has(p % 12) ? ' black' : ''}${!isDrums && p % 12 === 0 ? ' c' : ''}`}
                style={{ height: ROW_H }}
                onPointerDown={() => audition(p)}
              >
                {isDrums ? DRUM_MAP[p] : p % 12 === 0 ? noteName(p) : ''}
              </div>
            ))}
          </div>
          <div
            className="studio-roll-grid"
            ref={gridRef}
            style={{ left: KEY_W, width, height: pitches.length * ROW_H, ...gridBg }}
            onPointerDown={onGridPointerDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            {!isDrums && pitches.map((p, i) => BLACK.has(p % 12) && (
              <div key={p} className="studio-roll-row-black" style={{ top: i * ROW_H, height: ROW_H }} />
            ))}
            <div className="studio-roll-outside" style={{ left: clip.length * pxPerBeat }} />
            {Object.entries(shown).map(([id, n]) => {
              const row = rowOf.get(n.pitch);
              if (row === undefined) return null;
              return (
                <div
                  key={id}
                  className={`studio-note${selected.includes(id) ? ' selected' : ''}${n.start >= clip.length ? ' outside' : ''}`}
                  style={{
                    left: n.start * pxPerBeat,
                    top: row * ROW_H + 1,
                    width: Math.max(4, n.len * pxPerBeat - 1),
                    height: ROW_H - 2,
                    opacity: 0.45 + n.vel * 0.55,
                    ['--track-color' as string]: track.color ?? '#5865f2',
                  }}
                  title={`${isDrums ? DRUM_MAP[n.pitch] ?? noteName(n.pitch) : noteName(n.pitch)} · vel ${Math.round(n.vel * 127)}`}
                  onPointerDown={(e) => onNotePointerDown(e, id)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); deleteNotes([id]); }}
                  onDoubleClick={(e) => { e.stopPropagation(); deleteNotes([id]); }}
                  onWheel={(e) => onNoteWheel(e, id)}
                />
              );
            })}
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
    </div>
  );
}
