import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore, studioId, beatsToSeconds, secondsToBeats } from '@abyss/shared';
import type { StudioDoc, StudioClip, StudioOp, StudioPresence } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import StudioTrackHeader from './StudioTrackHeader';
import StudioClipView, { type ClipDragMode } from './StudioClip';
import {
  HEADER_WIDTH, TRACK_HEIGHT, RULER_HEIGHT, MIN_CLIP_BEATS,
  barBeats, snapBeats, floorBeats, colorForUser, memberName, uploadAudioFiles, audioClipOp,
} from './studioUtils';

export const ASSET_DRAG_TYPE = 'application/x-abyss-studio-asset';

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
  armedTrackId: string | null;
  onArmTrack: (id: string) => void;
  levels: Record<string, number>;
  peaksVersion: number;
  presence: Record<string, StudioPresence>;
  onSeek: (beats: number) => void;
  onOpenClip: (id: string) => void;
  onDeleteTrack: (id: string) => void;
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
    selection, onSelectionChange, selectedTrackId, onSelectTrack, armedTrackId, onArmTrack,
    levels, peaksVersion, presence, onSeek, onOpenClip, onDeleteTrack,
  } = props;
  const edit = useStudioStore((s) => s.edit);
  const assets = useStudioStore((s) => s.assets);
  const setLocalPresence = useStudioStore((s) => s.setLocalPresence);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<Record<string, StudioClip> | null>(null);
  const [loopDrag, setLoopDrag] = useState<{ a: number; b: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const assetDur = useMemo(() => new Map(assets.map((a) => [a.id, a.durationSec])), [assets]);
  const bpm = doc.meta.bpm;
  const perBar = barBeats(doc.meta);
  const width = totalBeats * pxPerBeat;

  // Latest values for window-level drag handlers
  const live = useRef({ doc, trackIds, pxPerBeat, snapGrid, assetDur, bpm });
  live.current = { doc, trackIds, pxPerBeat, snapGrid, assetDur, bpm };

  // ───────────── Clip drag (move / trim / alt-duplicate) ─────────────

  const computePreview = useCallback((d: DragState, clientX: number, clientY: number): Record<string, StudioClip> => {
    const { doc, trackIds, pxPerBeat, snapGrid, assetDur, bpm } = live.current;
    const dx = (clientX - d.startX) / pxPerBeat;
    const out: Record<string, StudioClip> = {};
    const prim = d.origin[d.primary];

    if (d.mode === 'move') {
      let delta = snapBeats(prim.start + dx, snapGrid) - prim.start;
      const minStart = Math.min(...d.ids.map((id) => d.origin[id].start));
      delta = Math.max(delta, -minStart);
      const rows = Math.round((clientY - d.startY) / TRACK_HEIGHT);
      for (const id of d.ids) {
        const o = d.origin[id];
        let trackId = o.trackId;
        if (rows !== 0) {
          const target = trackIds[trackIds.indexOf(o.trackId) + rows];
          const t = target ? doc.tracks[target] : undefined;
          if (t && (t.kind === 'audio') === (o.kind === 'audio')) trackId = target;
        }
        out[id] = { ...o, start: o.start + delta, trackId };
      }
      return out;
    }

    const end = prim.start + prim.length;
    if (d.mode === 'trim-end') {
      let length = Math.max(MIN_CLIP_BEATS, snapBeats(end + dx, snapGrid) - prim.start);
      if (prim.kind === 'audio' && prim.assetId) {
        const dur = assetDur.get(prim.assetId);
        if (dur) length = Math.min(length, secondsToBeats(dur - (prim.offset ?? 0), bpm));
      }
      out[d.primary] = { ...prim, length: Math.max(MIN_CLIP_BEATS, length) };
      return out;
    }

    // trim-start
    let start = snapBeats(prim.start + dx, snapGrid);
    start = Math.min(start, end - MIN_CLIP_BEATS);
    start = Math.max(0, start);
    if (prim.kind === 'audio') {
      start = Math.max(start, prim.start - secondsToBeats(prim.offset ?? 0, bpm));
      const shift = start - prim.start;
      out[d.primary] = { ...prim, start, length: end - start, offset: Math.max(0, (prim.offset ?? 0) + beatsToSeconds(shift, bpm)) };
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

    const ids = mode === 'move' ? sel.filter((s) => doc.clips[s]) : [id];
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
  }, [selection, onSelectionChange, onSelectTrack, editable, computePreview, finishDrag, setLocalPresence]);

  // ───────────── Lanes: create MIDI clips, drops ─────────────

  const beatsAtClientX = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerBeat);
  };

  const onLaneDoubleClick = (e: React.MouseEvent, trackId: string) => {
    const track = doc.tracks[trackId];
    if (!editable || track?.kind !== 'instrument') return;
    const at = floorBeats(beatsAtClientX(e.clientX, e.currentTarget as HTMLElement), perBar);
    const id = studioId();
    edit([{ t: 'set', path: ['clips', id], value: { trackId, kind: 'midi', start: at, length: perBar, gain: 0, notes: {}, name: track.name } }]);
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
      if (asset) edit([audioClipOp(asset, trackId, at, bpm)]);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const created = await uploadAudioFiles(files);
    const latestBpm = useStudioStore.getState().doc?.meta.bpm ?? bpm;
    const ops: StudioOp[] = [];
    for (const asset of created) {
      ops.push(audioClipOp(asset, trackId, at, latestBpm));
      at += secondsToBeats(asset.durationSec, latestBpm);
    }
    if (ops.length) useStudioStore.getState().edit(ops);
  };

  const onLanePointerDown = (e: React.PointerEvent, trackId: string) => {
    if (e.button !== 0) return;
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

  // ───────────── Follow playhead while playing ─────────────

  useEffect(() => {
    if (!isPlaying || dragRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = HEADER_WIDTH + playheadBeats * pxPerBeat;
    const viewRight = el.scrollLeft + el.clientWidth;
    if (x > viewRight - 40 || x < el.scrollLeft + HEADER_WIDTH) {
      el.scrollLeft = Math.max(0, x - HEADER_WIDTH - 40);
    }
  }, [isPlaying, playheadBeats, pxPerBeat]);

  // ───────────── Derived render data ─────────────

  const remoteSelections = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const [uid, p] of Object.entries(presence)) {
      for (const id of p.selection ?? []) (map[id] ??= []).push(colorForUser(uid));
    }
    return map;
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
    const map: Record<string, [string, StudioClip][]> = {};
    for (const [id, clip] of Object.entries(doc.clips)) {
      if (preview?.[id] && !(dragRef.current?.duplicate)) continue; // rendered from preview
      (map[clip.trackId] ??= []).push([id, clip]);
    }
    if (preview) {
      for (const [id, clip] of Object.entries(preview)) {
        (map[clip.trackId] ??= []).push([dragRef.current?.duplicate ? `dup-${id}` : id, clip]);
      }
    }
    return map;
  }, [doc.clips, preview]);

  const bars = useMemo(() => {
    const list: number[] = [];
    const step = pxPerBeat * perBar < 40 ? Math.ceil(40 / (pxPerBeat * perBar)) : 1;
    for (let b = 0; b * perBar < totalBeats; b += step) list.push(b);
    return list;
  }, [pxPerBeat, perBar, totalBeats]);

  const gridStyle = {
    backgroundSize: `${pxPerBeat * perBar}px 100%, ${pxPerBeat}px 100%`,
  };

  const loopShown = loopDrag ?? (doc.meta.loopEnabled ? { a: doc.meta.loopStart, b: doc.meta.loopEnd } : null);

  return (
    <div className="studio-arrange" ref={scrollRef}>
      <div className="studio-arrange-inner" style={{ width: HEADER_WIDTH + width }}>
        <div className="studio-ruler-row" style={{ height: RULER_HEIGHT }}>
          <div className="studio-corner" style={{ width: HEADER_WIDTH }} />
          <div className="studio-ruler" style={{ width }} onPointerDown={onRulerPointerDown} title={editable ? 'Click to seek · drag to set loop' : 'Click to seek'}>
            {loopShown && (
              <div
                className={`studio-loop-region${doc.meta.loopEnabled || loopDrag ? '' : ' off'}`}
                style={{ left: loopShown.a * pxPerBeat, width: (loopShown.b - loopShown.a) * pxPerBeat }}
              />
            )}
            {bars.map((b) => (
              <div key={b} className="studio-ruler-bar" style={{ left: b * perBar * pxPerBeat }}>{b + 1}</div>
            ))}
          </div>
        </div>

        {trackIds.map((trackId) => {
          const track = doc.tracks[trackId];
          return (
            <div key={trackId} className="studio-track-row" style={{ height: TRACK_HEIGHT }}>
              <StudioTrackHeader
                trackId={trackId}
                track={track}
                engine={engine}
                editable={editable}
                selected={selectedTrackId === trackId}
                armed={armedTrackId === trackId}
                levelDb={levels[trackId] ?? -Infinity}
                onSelect={() => onSelectTrack(trackId)}
                onArm={() => onArmTrack(trackId)}
                onDelete={() => onDeleteTrack(trackId)}
              />
              <div
                className={`studio-lane${dropTarget === trackId ? ' drop-target' : ''}${selectedTrackId === trackId ? ' selected' : ''}`}
                style={{ width, ...gridStyle }}
                onPointerDown={(e) => onLanePointerDown(e, trackId)}
                onDoubleClick={(e) => onLaneDoubleClick(e, trackId)}
                onDragOver={(e) => onLaneDragOver(e, trackId)}
                onDragLeave={() => setDropTarget((t) => (t === trackId ? null : t))}
                onDrop={(e) => void onLaneDrop(e, trackId)}
              >
                {(clipsByTrack[trackId] ?? []).map(([id, clip]) => (
                  <StudioClipView
                    key={id}
                    id={id.startsWith('dup-') ? id.slice(4) : id}
                    clip={clip}
                    pxPerBeat={pxPerBeat}
                    bpm={bpm}
                    color={clip.color ?? track.color ?? '#5865f2'}
                    selected={selection.includes(id)}
                    remoteColors={remoteSelections[id] ?? []}
                    peaksVersion={peaksVersion}
                    editable={editable}
                    onPointerDown={onClipPointerDown}
                    onDoubleClick={(cid) => { if (doc.clips[cid]?.kind === 'midi') onOpenClip(cid); }}
                  />
                ))}
                {remoteGhosts.filter((g) => g.clip.trackId === trackId).map((g) => (
                  <StudioClipView
                    key={`ghost-${g.uid}`}
                    id={g.clipId}
                    clip={g.clip}
                    pxPerBeat={pxPerBeat}
                    bpm={bpm}
                    color={g.clip.color ?? track.color ?? '#5865f2'}
                    selected={false}
                    remoteColors={[]}
                    ghost
                    ghostColor={colorForUser(g.uid)}
                    peaksVersion={peaksVersion}
                    editable={false}
                  />
                ))}
                {track.kind === 'instrument' && editable && !(clipsByTrack[trackId]?.length) && (
                  <div className="studio-lane-hint">Double-click to add a MIDI clip</div>
                )}
                {track.kind === 'audio' && editable && !(clipsByTrack[trackId]?.length) && (
                  <div className="studio-lane-hint">Drop audio here or record</div>
                )}
              </div>
            </div>
          );
        })}

        {trackIds.length === 0 && (
          <div className="studio-empty">
            No tracks yet{editable ? ' — add one from the toolbar.' : '.'}
          </div>
        )}

        <div className="studio-overlay" style={{ left: HEADER_WIDTH, width }}>
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

