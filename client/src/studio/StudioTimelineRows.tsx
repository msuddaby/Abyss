import { useState } from 'react';
import { useStudioStore, studioId, tempoMap, bpmAt, sigAt } from '@abyss/shared';
import type { StudioDoc, StudioTempoEvent } from '@abyss/shared';
import { HEADER_WIDTH, snapBeats } from './studioUtils';

// Two thin rows under the ruler: arrangement markers (Verse, Chorus…) and the
// tempo / time-signature map. Double-click an empty spot to add, drag to move,
// click a marker to jump to it, double-click it to rename.

export const MARKER_ROW_H = 20;
export const TEMPO_ROW_H = 20;

const MARKER_COLORS = ['#f59e0b', '#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#f87171'];
const SIGS: [number, number][] = [[4, 4], [3, 4], [2, 4], [5, 4], [6, 8], [7, 8], [9, 8], [12, 8]];

interface Props {
  doc: StudioDoc;
  width: number;
  pxPerBeat: number;
  snapGrid: number;
  editable: boolean;
  onSeek: (beats: number) => void;
}

function dragX(e: React.PointerEvent, onMove: (dx: number) => void, onEnd: (moved: boolean, dx: number) => void) {
  const startX = e.clientX;
  let moved = false, dx = 0;
  const move = (ev: PointerEvent) => {
    dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    onMove(dx);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd(moved, dx);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

export default function StudioTimelineRows({ doc, width, pxPerBeat, snapGrid, editable, onSeek }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const [drag, setDrag] = useState<{ kind: 'marker' | 'tempo'; id: string; beat: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [tempoEdit, setTempoEdit] = useState<string | null>(null);
  const markers = Object.entries(doc.markers ?? {}).sort((a, b) => a[1].beat - b[1].beat);
  const tempo = Object.entries(doc.tempo ?? {}).sort((a, b) => a[1].beat - b[1].beat);
  const map = tempoMap(doc);
  const grid = snapGrid || 0.25;
  const beatAt = (e: React.MouseEvent) => Math.max(0, (e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left) / pxPerBeat);

  const addMarker = (beat: number) => {
    const id = studioId();
    const name = `Marker ${markers.length + 1}`;
    edit([{ t: 'set', path: ['markers', id], value: { beat, name, color: MARKER_COLORS[markers.length % MARKER_COLORS.length] } }]);
    setRenaming({ id, name });
  };

  const addTempo = (beat: number) => {
    if (beat <= 0) return;
    const id = studioId();
    edit([{ t: 'set', path: ['tempo', id], value: { beat, bpm: bpmAt(map, beat) } }]);
    setTempoEdit(id);
  };

  const commitRename = () => {
    if (!renaming) return;
    const m = doc.markers?.[renaming.id];
    const name = renaming.name.trim().slice(0, 40);
    if (m && name !== m.name) edit([{ t: 'set', path: ['markers', renaming.id, 'name'], value: name }]);
    setRenaming(null);
  };

  const editing = tempoEdit ? doc.tempo?.[tempoEdit] : undefined;

  return (
    <>
      <div className="studio-meta-row markers" style={{ height: MARKER_ROW_H }}>
        <div className="studio-corner meta" style={{ width: HEADER_WIDTH }}>Markers</div>
        <div
          className="studio-meta-lane"
          style={{ width }}
          title={editable ? 'Double-click to add a marker' : undefined}
          onDoubleClick={(e) => { if (editable) addMarker(snapBeats(beatAt(e), grid)); }}
        >
          {markers.map(([id, m]) => {
            const beat = drag?.kind === 'marker' && drag.id === id ? drag.beat : m.beat;
            return (
              <div
                key={id}
                className="studio-marker"
                style={{ left: beat * pxPerBeat, ['--marker-color' as string]: m.color ?? MARKER_COLORS[0] }}
                title={`${m.name} — click to jump${editable ? ', drag to move, double-click to rename' : ''}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  dragX(e,
                    (dx) => { if (editable) setDrag({ kind: 'marker', id, beat: Math.max(0, snapBeats(m.beat + dx / pxPerBeat, grid)) }); },
                    (moved, dx) => {
                      setDrag(null);
                      if (!moved) { onSeek(m.beat); return; }
                      if (!editable) return;
                      const nb = Math.max(0, snapBeats(m.beat + dx / pxPerBeat, grid));
                      if (nb !== m.beat) edit([{ t: 'set', path: ['markers', id, 'beat'], value: nb }]);
                    });
                }}
                onDoubleClick={(e) => { e.stopPropagation(); if (editable) setRenaming({ id, name: m.name }); }}
              >
                {renaming?.id === id ? (
                  <input
                    className="studio-marker-input"
                    autoFocus
                    value={renaming.name}
                    maxLength={40}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ id, name: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
                  />
                ) : <span>{m.name || '·'}</span>}
                {editable && renaming?.id !== id && (
                  <button
                    className="studio-marker-del"
                    title="Delete marker"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); edit([{ t: 'del', path: ['markers', id] }]); }}
                  >×</button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="studio-meta-row tempo" style={{ height: TEMPO_ROW_H }}>
        <div className="studio-corner meta" style={{ width: HEADER_WIDTH }}>Tempo</div>
        <div
          className="studio-meta-lane"
          style={{ width }}
          title={editable ? 'Double-click to add a tempo or time signature change' : undefined}
          onDoubleClick={(e) => { if (editable) addTempo(snapBeats(beatAt(e), grid)); }}
        >
          <div className="studio-tempo-pill base" style={{ left: 0 }} title="Project start tempo and signature (toolbar)">
            ♩{doc.meta.bpm} · {doc.meta.timeSigNum}/{doc.meta.timeSigDen}
          </div>
          {tempo.map(([id, ev]) => {
            const beat = drag?.kind === 'tempo' && drag.id === id ? drag.beat : ev.beat;
            return (
              <div
                key={id}
                className={`studio-tempo-pill${tempoEdit === id ? ' active' : ''}`}
                style={{ left: beat * pxPerBeat }}
                title={editable ? 'Click to edit · drag to move' : undefined}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  dragX(e,
                    (dx) => { if (editable) setDrag({ kind: 'tempo', id, beat: Math.max(grid, snapBeats(ev.beat + dx / pxPerBeat, grid)) }); },
                    (moved, dx) => {
                      setDrag(null);
                      if (!moved) { if (editable) setTempoEdit(tempoEdit === id ? null : id); else onSeek(ev.beat); return; }
                      if (!editable) return;
                      const nb = Math.max(grid, snapBeats(ev.beat + dx / pxPerBeat, grid));
                      if (nb !== ev.beat) edit([{ t: 'set', path: ['tempo', id, 'beat'], value: nb }]);
                    });
                }}
              >
                {ev.bpm ? `♩${Math.round(ev.bpm * 10) / 10}` : ''}{ev.bpm && ev.num ? ' · ' : ''}{ev.num ? `${ev.num}/${ev.den}` : ''}
              </div>
            );
          })}
          {editing && tempoEdit && (
            <TempoEditor
              key={tempoEdit}
              id={tempoEdit}
              ev={editing}
              left={editing.beat * pxPerBeat}
              currentSig={sigAt(map, Math.max(0, editing.beat - 1e-3))}
              onClose={() => setTempoEdit(null)}
            />
          )}
        </div>
      </div>
    </>
  );
}

function TempoEditor({ id, ev, left, currentSig, onClose }: { id: string; ev: StudioTempoEvent; left: number; currentSig: { num: number; den: number }; onClose: () => void }) {
  const edit = useStudioStore((s) => s.edit);
  const [bpm, setBpm] = useState(ev.bpm ? String(ev.bpm) : '');
  const commitBpm = () => {
    const v = Math.round(Number(bpm) * 10) / 10;
    if (!bpm.trim()) {
      if (ev.bpm && ev.num) edit([{ t: 'del', path: ['tempo', id, 'bpm'] }]);
      return;
    }
    if (Number.isFinite(v) && v >= 20 && v <= 400 && v !== ev.bpm) edit([{ t: 'set', path: ['tempo', id, 'bpm'], value: v }]);
  };
  return (
    <div className="studio-tempo-editor" style={{ left }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <label>
        Tempo
        <input
          type="number" min={20} max={400} step={0.1} value={bpm} placeholder="—"
          onChange={(e) => setBpm(e.target.value)}
          onBlur={commitBpm}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
      <label>
        Signature
        <select
          value={ev.num ? `${ev.num}/${ev.den}` : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              if (ev.bpm) edit([{ t: 'del', path: ['tempo', id, 'num'] }, { t: 'del', path: ['tempo', id, 'den'] }]);
              return;
            }
            const [n, d] = v.split('/').map(Number);
            edit([{ t: 'set', path: ['tempo', id, 'num'], value: n }, { t: 'set', path: ['tempo', id, 'den'], value: d }]);
          }}
        >
          <option value="">No change ({currentSig.num}/{currentSig.den})</option>
          {SIGS.map(([n, d]) => <option key={`${n}/${d}`} value={`${n}/${d}`}>{n}/{d}</option>)}
        </select>
      </label>
      <div className="studio-tempo-editor-row">
        <button className="studio-btn small danger" onClick={() => { edit([{ t: 'del', path: ['tempo', id] }]); onClose(); }}>Delete</button>
        <button className="studio-btn small" onClick={onClose}>Done</button>
      </div>
      <div className="studio-tempo-editor-hint">Signature changes start on the next bar line.</div>
    </div>
  );
}
