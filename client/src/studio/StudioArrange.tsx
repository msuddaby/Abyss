import { isMidiFile } from './midiImport';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore, useToastStore, studioId, tempoMap, barsIn } from '@abyss/shared';
import type { StudioDoc, StudioClip, StudioOp, StudioPresence } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import StudioTrackHeader from './StudioTrackHeader';
import StudioClipView, { type ClipDragMode } from './StudioClip';
import StudioAutomationLane from './StudioAutomationLane';
import StudioTimelineRows from './StudioTimelineRows';
import { displayOrder, clipSrcSeconds, clipBeatsForSrc, assetBeatsAt } from './engine/routing';
import {
  HEADER_WIDTH, TRACK_HEIGHT, RULER_HEIGHT, MIN_CLIP_BEATS,
  snapBeats, colorForUser, memberName, uploadAudioFiles, audioClipOp, barBeatsAt, barFloor,
  packLanes, compOps, clipFitsTrack, isDoubleTap,
} from './studioUtils';

export const ASSET_DRAG_TYPE = 'application/x-abyss-studio-asset';

/** Height of one take lane when a track shows its takes */
const TAKE_LANE_H = 44;

interface Props {
  doc: StudioDoc;
  trackIds: string[];
  pxPerBeat: number;
  totalBeats: number;
  snapGrid: number;
  editable: boolean;
  engine: StudioEngine | null;
  isPlaying: boolean;
  playheadBeats: number;
  selection: string[];
  onSelectionChange: (ids: string[]) => void;
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
  armedTrackIds: string[];
  onArmTrack: (id: string, additive: boolean) => void;
  /** In-progress MIDI takes, drawn as red clips */
  recordingTakes: { trackId: string; clip: StudioClip }[];
  levels: Record<string, number>;
  peaksVersion: number;
  presence: Record<string, StudioPresence>;
  /** Asset ids that still exist (clips pointing elsewhere are shown as missing) */
  assetIds: Set<string>;
  /** Collaborator whose view we follow (scroll position + playhead) */
  followUserId: string | null;
  onSeek: (beats: number) => void;
  onOpenClip: (id: string) => void;
  onDeleteTrack: (id: string) => void;
  onZoom?: (factor: number) => void;
}

interface DragState {
  mode: ClipDragMode;
  ids: string[];
  primary: string;
  startX: number;
  startY: number;
  origin: Record<string, StudioClip>;
  duplicate: boolean;
  moved: boolean;
}

const DRAG_THRESHOLD_PX = 3;

export default function StudioArrange(props: Props) {
  const {
    doc, trackIds, pxPerBeat, totalBeats, snapGrid, editable, engine, isPlaying, playheadBeats,
    selection, onSelectionChange, selectedTrackId, onSelectTrack, armedTrackIds, onArmTrack, recordingTakes,
    levels, peaksVersion, presence, assetIds, followUserId, onSeek, onOpenClip, onDeleteTrack, onZoom,
  } = props;
  const edit = useStudioStore((s) => s.edit);
  const assets = useStudioStore((s) => s.assets);
  const setLocalPresence = useStudioStore((s) => s.setLocalPresence);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<Record<string, StudioClip> | null>(null);
  const [loopDrag, setLoopDrag] = useState<{ a: number; b: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** trackId → automation lane shown under it */
  const [autoLanes, setAutoLanes] = useState<Record<string, string>>({});
  /** Tracks showing their takes stacked */
  const [takeTracks, setTakeTracks] = useState<string[]>([]);
  const toggleAutomation = (trackId: string) => setAutoLanes((m) => {
    const next = { ...m };
    if (next[trackId]) delete next[trackId];
    else next[trackId] = Object.keys(doc.tracks[trackId]?.automation ?? {}).find((k) => doc.tracks[trackId].automation![k].length) ?? 'vol';
    return next;
  });
  const toggleTakes = (trackId: string) => setTakeTracks((t) => (t.includes(trackId) ? t.filter((x) => x !== trackId) : [...t, trackId]));

  const assetDur = useMemo(() => new Map(assets.map((a) => [a.id, a.durationSec])), [assets]);
  const width = totalBeats * pxPerBeat;
  const map = tempoMap(doc);

  /** Visible rows: groups' children nested under them, collapsed ones hidden. */
  const rows = useMemo(() => displayOrder(doc, trackIds).filter((r) => !r.hidden), [doc, trackIds]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);

  /** Clips someone else is editing (piano roll open, or dragging): soft-locked for us. */
  const locks = useMemo(() => {
    const out: Record<string, { name: string; color: string }> = {};
    for (const [uid, p] of Object.entries(presence)) {
      const who = { name: memberName(uid), color: colorForUser(uid) };
      if (p.editingClipId) out[p.editingClipId] = who;
      if (p.drag?.clipId) out[p.drag.clipId] = who;
    }
    return out;
  }, [presence]);

  // Latest values for window-level drag handlers
  const live = useRef({ doc, rowIds, pxPerBeat, snapGrid, assetDur });
  live.current = { doc, rowIds, pxPerBeat, snapGrid, assetDur };

  // ───────────── Clip drag (move / trim / alt-duplicate) ─────────────

  const computePreview = useCallback((d: DragState, clientX: number, clientY: number): Record<string, StudioClip> => {
    const { doc, rowIds, pxPerBeat, snapGrid, assetDur } = live.current;
    const dx = (clientX - d.startX) / pxPerBeat;
    const out: Record<string, StudioClip> = {};
    const prim = d.origin[d.primary];

    if (d.mode === 'move') {
      let delta = snapBeats(prim.start + dx, snapGrid) - prim.start;
      const minStart = Math.min(...d.ids.map((id) => d.origin[id].start));
      delta = Math.max(delta, -minStart);
      // Target track = the lane under the pointer (rows vary in height with automation lanes).
      const hovered = (document.elementFromPoint(clientX, clientY)?.closest('[data-track-id]') as HTMLElement | null)?.dataset.trackId;
      const rows = hovered ? rowIds.indexOf(hovered) - rowIds.indexOf(prim.trackId) : 0;
      for (const id of d.ids) {
        const o = d.origin[id];
        let trackId = o.trackId;
        if (rows !== 0) {
          const target = rowIds[rowIds.indexOf(o.trackId) + rows];
          const t = target ? doc.tracks[target] : undefined;
          if (t && clipFitsTrack(o.kind, t.kind)) trackId = target;
        }
        out[id] = { ...o, start: o.start + delta, trackId };
      }
      return out;
    }

    const end = prim.start + prim.length;
    if (d.mode === 'trim-end') {
      let length = Math.max(MIN_CLIP_BEATS, snapBeats(end + dx, snapGrid) - prim.start);
      if (prim.kind === 'audio' && prim.assetId && !prim.reverse) {
        const dur = assetDur.get(prim.assetId);
        if (dur) length = Math.min(length, clipBeatsForSrc(doc, prim, 0, dur - (prim.offset ?? 0)));
      }
      out[d.primary] = { ...prim, length: Math.max(MIN_CLIP_BEATS, length) };
      return out;
    }

    // trim-start
    let start = snapBeats(prim.start + dx, snapGrid);
    start = Math.min(start, end - MIN_CLIP_BEATS);
    start = Math.max(0, start);
    if (prim.kind === 'audio') {
      if (!prim.reverse) {
        // Can't extend left past the start of the source.
        const maxLeft = clipBeatsForSrc(doc, prim, 0, prim.offset ?? 0);
        start = Math.max(start, prim.start - maxLeft);
        const shift = start - prim.start;
        const srcShift = shift >= 0 ? clipSrcSeconds(doc, prim, 0, shift) : -clipSrcSeconds(doc, { ...prim, start }, 0, -shift);
        out[d.primary] = { ...prim, start, length: end - start, offset: Math.max(0, (prim.offset ?? 0) + srcShift) };
      } else {
        // Reversed: the left edge reads the source's end; the offset stays put.
        out[d.primary] = { ...prim, start, length: end - start };
      }
    } else {
      const shift = start - prim.start;
      const notes: Record<string, NonNullable<StudioClip['notes']>[string]> = {};
      for (const [nid, n] of Object.entries(prim.notes ?? {})) {
        const ns = n.start - shift;
        if (ns >= 0) notes[nid] = { ...n, start: ns };
      }
      out[d.primary] = { ...prim, start, length: end - start, notes };
    }
    return out;
  }, []);

  const finishDrag = useCallback((d: DragState, result: Record<string, StudioClip> | null) => {
    setPreview(null);
    setLocalPresence({ drag: null });
    if (!d.moved || !result) return;
    const ops: StudioOp[] = [];
    if (d.duplicate && d.mode === 'move') {
      const newIds: string[] = [];
      for (const id of d.ids) {
        const nid = studioId();
        newIds.push(nid);
        ops.push({ t: 'set', path: ['clips', nid], value: result[id] });
      }
      edit(ops);
      onSelectionChange(newIds);
      return;
    }
    for (const id of Object.keys(result)) {
      const o = d.origin[id], n = result[id];
      if (o.kind === 'midi' && d.mode === 'trim-start') {
        ops.push({ t: 'set', path: ['clips', id], value: n });
        continue;
      }
      // Field-level ops so concurrent edits to other fields of the clip survive.
      for (const f of ['start', 'length', 'trackId', 'offset'] as const) {
        if (n[f] !== undefined && n[f] !== o[f]) ops.push({ t: 'set', path: ['clips', id, f], value: n[f] });
      }
    }
    if (ops.length) edit(ops);
  }, [edit, onSelectionChange, setLocalPresence]);

  const onClipPointerDown = useCallback((e: React.PointerEvent, id: string, mode: ClipDragMode) => {
    const { doc } = live.current;
    let sel = selection;
    if (e.shiftKey) {
      sel = selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
      onSelectionChange(sel);
      return;
    }
    if (!selection.includes(id)) {
      sel = [id];
      onSelectionChange(sel);
    }
    const clip = doc.clips[id];
    if (clip) onSelectTrack(clip.trackId);
    if (!editable) return;

    const ids = mode === 'move' ? sel.filter((s) => doc.clips[s] && !locks[s]) : [id];
    if (locks[id]) {
      useToastStore.getState().addToast(`${locks[id].name} is editing that clip right now.`, 'info');
      return;
    }
    const origin: Record<string, StudioClip> = {};
    for (const s of ids) origin[s] = doc.clips[s];
    const d: DragState = { mode, ids, primary: id, startX: e.clientX, startY: e.clientY, origin, duplicate: e.altKey, moved: false };
    dragRef.current = d;
    let last: Record<string, StudioClip> | null = null;

    const move = (ev: PointerEvent) => {
      if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      last = computePreview(d, ev.clientX, ev.clientY);
      setPreview(last);
      const p = last[d.primary];
      setLocalPresence({ drag: { clipId: d.primary, trackId: p.trackId, start: p.start, length: p.length } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragRef.current = null;
      finishDrag(d, last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, [selection, onSelectionChange, onSelectTrack, editable, computePreview, finishDrag, setLocalPresence, locks]);

  // ───────────── Lanes: create MIDI clips, drops ─────────────

  const beatsAtClientX = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerBeat);
  };

  const onLaneDoubleClick = (e: React.MouseEvent, trackId: string) => {
    const track = doc.tracks[trackId];
    if (!editable || track?.kind !== 'instrument') return;
    const at = barFloor(doc, beatsAtClientX(e.clientX, e.currentTarget as HTMLElement));
    const id = studioId();
    edit([{ t: 'set', path: ['clips', id], value: { trackId, kind: 'midi', start: at, length: barBeatsAt(doc, at), gain: 0, notes: {}, name: track.name } }]);
    onSelectionChange([id]);
    onOpenClip(id);
  };

  const onLaneDragOver = (e: React.DragEvent, trackId: string) => {
    if (!editable || doc.tracks[trackId]?.kind !== 'audio') return;
    if (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE) && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(trackId);
  };

  const onLaneDrop = async (e: React.DragEvent, trackId: string) => {
    setDropTarget(null);
    if (!editable || doc.tracks[trackId]?.kind !== 'audio') return;
    e.preventDefault();
    let at = snapBeats(beatsAtClientX(e.clientX, e.currentTarget as HTMLElement), snapGrid);
    const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (assetId) {
      const asset = assets.find((a) => a.id === assetId);
      if (asset) edit([audioClipOp(asset, trackId, at, doc)]);
      return;
    }
    // MIDI files bubble up to the studio view, which imports them.
    const files = Array.from(e.dataTransfer.files).filter((f) => !isMidiFile(f));
    if (!files.length) return;
    const created = await uploadAudioFiles(files);
    const latest = useStudioStore.getState().doc ?? doc;
    const ops: StudioOp[] = [];
    for (const asset of created) {
      ops.push(audioClipOp(asset, trackId, at, latest));
      at += assetBeatsAt(latest, at, asset.durationSec);
    }
    if (ops.length) useStudioStore.getState().edit(ops);
  };

  const onLanePointerDown = (e: React.PointerEvent, trackId: string) => {
    if (e.button !== 0) return;
    if (isDoubleTap(e, `lane:${trackId}`)) { onLaneDoubleClick(e, trackId); return; }
    onSelectTrack(trackId);
    if (!e.shiftKey) onSelectionChange([]);
  };

  // ───────────── Ruler: seek / loop drag ─────────────

  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const startBeats = beatsAtClientX(e.clientX, el);
    const startX = e.clientX;
    let dragging = false;
    let range: { a: number; b: number } | null = null;
    const move = (ev: PointerEvent) => {
      if (!editable) return;
      if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
      dragging = true;
      const cur = beatsAtClientX(ev.clientX, el);
      const grid = snapGrid || 1;
      range = { a: snapBeats(Math.min(startBeats, cur), grid), b: snapBeats(Math.max(startBeats, cur), grid) };
      setLoopDrag(range);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLoopDrag(null);
      if (dragging && range && range.b > range.a) {
        edit([
          { t: 'set', path: ['meta', 'loopStart'], value: range.a },
          { t: 'set', path: ['meta', 'loopEnd'], value: range.b },
          { t: 'set', path: ['meta', 'loopEnabled'], value: true },
        ]);
      } else if (!dragging) {
        onSeek(snapBeats(startBeats, snapGrid));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ───────────── Follow playhead / a collaborator's view ─────────────

  const followed = followUserId ? presence[followUserId] : undefined;
  useEffect(() => {
    if (dragRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // Following someone: show what they see (their scroll), or their playhead while they play.
    if (followed) {
      const target = followed.playheadBeats ?? followed.viewBeats;
      if (target == null) return;
      const x = target * pxPerBeat;
      if (followed.playheadBeats == null) { el.scrollLeft = Math.max(0, x); return; }
      const viewRight = el.scrollLeft + el.clientWidth - HEADER_WIDTH;
      if (x > viewRight - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 40);
      return;
    }
    if (!isPlaying) return;
    const x = HEADER_WIDTH + playheadBeats * pxPerBeat;
    const viewRight = el.scrollLeft + el.clientWidth;
    if (x > viewRight - 40 || x < el.scrollLeft + HEADER_WIDTH) {
      el.scrollLeft = Math.max(0, x - HEADER_WIDTH - 40);
    }
  }, [isPlaying, playheadBeats, pxPerBeat, followed]);

  // Share where we're looking (for others' "follow"), throttled.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let t = 0;
    const onScroll = () => {
      if (t) return;
      t = window.setTimeout(() => { t = 0; setLocalPresence({ viewBeats: Math.round((el.scrollLeft / pxPerBeat) * 4) / 4 }); }, 300);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (t) clearTimeout(t); };
  }, [pxPerBeat, setLocalPresence]);

  // Pinch / ctrl+wheel zoom (touchpads send ctrl+wheel for pinch).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onZoom) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      onZoom(Math.exp(-e.deltaY * 0.01));
    };
    const touches = new Map<number, number>();
    let lastDist = 0;
    const onDown = (e: PointerEvent) => { if (e.pointerType === 'touch') touches.set(e.pointerId, e.clientX); };
    const onMove = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, e.clientX);
      if (touches.size !== 2) return;
      const [a, b] = [...touches.values()];
      const dist = Math.abs(a - b);
      if (lastDist > 0 && dist > 0) onZoom(dist / lastDist);
      lastDist = dist;
    };
    const onUp = (e: PointerEvent) => { touches.delete(e.pointerId); if (touches.size < 2) lastDist = 0; };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [onZoom]);

  // ───────────── Derived render data ─────────────

  const remoteSelections = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [uid, p] of Object.entries(presence)) {
      for (const id of p.selection ?? []) (out[id] ??= []).push(colorForUser(uid));
    }
    return out;
  }, [presence]);

  const remoteGhosts = useMemo(() => {
    const out: { uid: string; clipId: string; clip: StudioClip }[] = [];
    for (const [uid, p] of Object.entries(presence)) {
      const d = p.drag;
      const base = d ? doc.clips[d.clipId] : undefined;
      if (d && base) out.push({ uid, clipId: d.clipId, clip: { ...base, trackId: d.trackId, start: d.start, length: d.length } });
    }
    return out;
  }, [presence, doc.clips]);

  const clipsByTrack = useMemo(() => {
    const out: Record<string, [string, StudioClip][]> = {};
    for (const [id, clip] of Object.entries(doc.clips)) {
      if (preview?.[id] && !(dragRef.current?.duplicate)) continue; // rendered from preview
      (out[clip.trackId] ??= []).push([id, clip]);
    }
    if (preview) {
      for (const [id, clip] of Object.entries(preview)) {
        (out[clip.trackId] ??= []).push([dragRef.current?.duplicate ? `dup-${id}` : id, clip]);
      }
    }
    return out;
  }, [doc.clips, preview]);

  /** Children of each group, for the group lane's overview. */
  const groupChildren = useMemo(() => {
    const out: Record<string, string[]> = {};
    const all = displayOrder(doc, trackIds);
    const stack: { id: string; depth: number }[] = [];
    for (const r of all) {
      while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop();
      for (const s of stack) (out[s.id] ??= []).push(r.id);
      if (doc.tracks[r.id]?.kind === 'group') stack.push(r);
    }
    return out;
  }, [doc, trackIds]);

  const bars = useMemo(() => {
    const list = barsIn(map, 0, totalBeats);
    const avg = totalBeats / Math.max(1, list.length);
    const step = pxPerBeat * avg < 40 ? Math.ceil(40 / (pxPerBeat * avg)) : 1;
    return { all: list, labels: list.filter((b) => b.bar % step === 0) };
  }, [map, pxPerBeat, totalBeats]);
  const irregular = map.sigs.length > 1;
  const perBar = bars.all[0]?.len ?? 4;

  // With signature changes the bar lines come from the map, not a repeating background.
  const gridStyle = irregular
    ? { backgroundImage: 'linear-gradient(90deg, var(--studio-grid-beat) 1px, transparent 1px)', backgroundSize: `${pxPerBeat}px 100%` }
    : { backgroundSize: `${pxPerBeat * perBar}px 100%, ${pxPerBeat}px 100%` };

  const loopShown = loopDrag ?? (doc.meta.loopEnabled ? { a: doc.meta.loopStart, b: doc.meta.loopEnd } : null);
  const markers = Object.values(doc.markers ?? {});
  const srcSecOf = (c: StudioClip) => (c.kind === 'audio' ? clipSrcSeconds(doc, c, 0, c.length) : 0);

  return (
    <div className="studio-arrange" ref={scrollRef}>
      <div className="studio-arrange-inner" style={{ width: HEADER_WIDTH + width }}>
        <div className="studio-timeline-head">
          <div className="studio-ruler-row" style={{ height: RULER_HEIGHT }}>
            <div className="studio-corner" style={{ width: HEADER_WIDTH }} />
            <div className="studio-ruler" style={{ width }} onPointerDown={onRulerPointerDown} title={editable ? 'Click to seek · drag to set loop' : 'Click to seek'}>
              {loopShown && (
                <div
                  className={`studio-loop-region${doc.meta.loopEnabled || loopDrag ? '' : ' off'}`}
                  style={{ left: loopShown.a * pxPerBeat, width: (loopShown.b - loopShown.a) * pxPerBeat }}
                />
              )}
              {bars.labels.map((b) => (
                <div key={b.bar} className="studio-ruler-bar" style={{ left: b.start * pxPerBeat }}>{b.bar + 1}</div>
              ))}
            </div>
          </div>
          <StudioTimelineRows doc={doc} width={width} pxPerBeat={pxPerBeat} snapGrid={snapGrid} editable={editable} onSeek={onSeek} />
        </div>

        {rows.map(({ id: trackId, depth }) => {
          const track = doc.tracks[trackId];
          const autoLane = autoLanes[trackId];
          const takes = takeTracks.includes(trackId) && (track.kind === 'audio' || track.kind === 'instrument');
          const trackClips = clipsByTrack[trackId] ?? [];
          const packed = takes ? packLanes(trackClips) : null;
          const rowH = packed ? Math.max(TRACK_HEIGHT, packed.count * TAKE_LANE_H + 4) : TRACK_HEIGHT;
          const kind = track.kind;
          const children = kind === 'group' ? groupChildren[trackId] ?? [] : [];
          return (
            <Fragment key={trackId}>
            <div className={`studio-track-row kind-${kind}`} style={{ height: rowH }}>
              <StudioTrackHeader
                autoOpen={!!autoLane}
                hasAutomation={Object.values(track.automation ?? {}).some((pts) => pts.length > 0)}
                onToggleAutomation={() => toggleAutomation(trackId)}
                trackId={trackId}
                track={track}
                depth={depth}
                engine={engine}
                editable={editable}
                selected={selectedTrackId === trackId}
                armed={armedTrackIds.includes(trackId)}
                levelDb={levels[trackId] ?? -Infinity}
                takesOpen={takes}
                hasTakes={trackClips.some(([, c]) => c.mute)}
                onToggleTakes={() => toggleTakes(trackId)}
                onSelect={() => { onSelectTrack(trackId); onSelectionChange([]); }}
                onArm={(additive) => onArmTrack(trackId, additive)}
                onDelete={() => onDeleteTrack(trackId)}
              />
              <div
                data-track-id={trackId}
                className={`studio-lane${dropTarget === trackId ? ' drop-target' : ''}${selectedTrackId === trackId ? ' selected' : ''}${takes ? ' takes' : ''}`}
                style={{ width, ...gridStyle }}
                onPointerDown={(e) => onLanePointerDown(e, trackId)}
                onDoubleClick={(e) => onLaneDoubleClick(e, trackId)}
                onDragOver={(e) => onLaneDragOver(e, trackId)}
                onDragLeave={() => setDropTarget((t) => (t === trackId ? null : t))}
                onDrop={(e) => void onLaneDrop(e, trackId)}
              >
                {trackClips.map(([id, clip]) => {
                  const realId = id.startsWith('dup-') ? id.slice(4) : id;
                  return (
                    <StudioClipView
                      key={id}
                      id={realId}
                      clip={clip}
                      pxPerBeat={pxPerBeat}
                      srcSec={srcSecOf(clip)}
                      color={clip.color ?? track.color ?? '#5865f2'}
                      selected={selection.includes(id)}
                      remoteColors={remoteSelections[id] ?? []}
                      peaksVersion={peaksVersion}
                      editable={editable}
                      lockedBy={locks[realId] ?? null}
                      missing={clip.kind === 'audio' && !!clip.assetId && assets.length > 0 && !assetIds.has(clip.assetId)}
                      top={packed ? 2 + (packed.lane[id] ?? 0) * TAKE_LANE_H : undefined}
                      height={packed ? TAKE_LANE_H - 4 : undefined}
                      onComp={packed && editable ? (cid) => edit(compOps(doc, cid)) : undefined}
                      onPointerDown={onClipPointerDown}
                      onDoubleClick={(cid) => { if (doc.clips[cid]?.kind === 'midi') onOpenClip(cid); }}
                    />
                  );
                })}
                {recordingTakes.filter((r) => r.trackId === trackId).map((r) => (
                  <StudioClipView
                    key="recording-take"
                    id="recording-take"
                    clip={r.clip}
                    pxPerBeat={pxPerBeat}
                    srcSec={0}
                    color="#ed4245"
                    selected={false}
                    remoteColors={[]}
                    ghost
                    ghostColor="#ed4245"
                    peaksVersion={peaksVersion}
                    editable={false}
                  />
                ))}
                {remoteGhosts.filter((g) => g.clip.trackId === trackId).map((g) => (
                  <StudioClipView
                    key={`ghost-${g.uid}`}
                    id={g.clipId}
                    clip={g.clip}
                    pxPerBeat={pxPerBeat}
                    srcSec={srcSecOf(g.clip)}
                    color={g.clip.color ?? track.color ?? '#5865f2'}
                    selected={false}
                    remoteColors={[]}
                    ghost
                    ghostColor={colorForUser(g.uid)}
                    peaksVersion={peaksVersion}
                    editable={false}
                  />
                ))}
                {kind === 'group' && children.map((cid) => (clipsByTrack[cid] ?? []).filter(([, c]) => !c.mute).map(([id, c]) => (
                  <div
                    key={`${cid}-${id}`}
                    className="studio-group-clip"
                    style={{ left: c.start * pxPerBeat, width: Math.max(2, c.length * pxPerBeat), background: doc.tracks[cid]?.color ?? '#5865f2' }}
                  />
                )))}
                {kind === 'group' && !children.length && (
                  <div className="studio-lane-hint">Group — route tracks here from their Track panel (Output), or drag them in with “Group”</div>
                )}
                {kind === 'return' && (
                  <div className="studio-lane-hint">Return — other tracks feed it with their Sends</div>
                )}
                {kind === 'instrument' && editable && !trackClips.length && (
                  <div className="studio-lane-hint">Double-click to add a MIDI clip</div>
                )}
                {kind === 'audio' && editable && !trackClips.length && (
                  <div className="studio-lane-hint">Drop audio here or record</div>
                )}
              </div>
            </div>
            {autoLane && (
              <StudioAutomationLane
                trackId={trackId}
                track={track}
                laneKey={autoLane}
                width={width}
                pxPerBeat={pxPerBeat}
                snapGrid={snapGrid}
                editable={editable}
                playheadBeats={playheadBeats}
                onLaneChange={(k) => setAutoLanes((m) => ({ ...m, [trackId]: k }))}
                onClose={() => toggleAutomation(trackId)}
              />
            )}
            </Fragment>
          );
        })}

        {trackIds.length === 0 && (
          <div className="studio-empty">
            No tracks yet{editable ? ' — add one from the toolbar.' : '.'}
          </div>
        )}

        <div className="studio-overlay" style={{ left: HEADER_WIDTH, width }}>
          {irregular && bars.all.map((b) => (
            <div key={b.bar} className="studio-bar-line" style={{ left: b.start * pxPerBeat }} />
          ))}
          {markers.map((m, i) => (
            <div key={i} className="studio-marker-line" style={{ left: m.beat * pxPerBeat, background: m.color ?? '#f59e0b' }} />
          ))}
          <div className="studio-playhead" style={{ transform: `translateX(${playheadBeats * pxPerBeat}px)` }} />
          {Object.entries(presence).map(([uid, p]) => p.playheadBeats != null && (
            <div
              key={uid}
              className="studio-playhead remote"
              title={`${memberName(uid)} is playing`}
              style={{ transform: `translateX(${p.playheadBeats * pxPerBeat}px)`, background: colorForUser(uid) }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
