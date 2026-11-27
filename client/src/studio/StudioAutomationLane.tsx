import { useMemo, useState } from 'react';
import { useStudioStore } from '@abyss/shared';
import type { StudioTrack } from '@abyss/shared';
import { laneDefs, toNorm, fromNorm, formatLaneValue } from './automation';
import { valueAt } from './engine/automationMath';
import { HEADER_WIDTH, snapBeats } from './studioUtils';

export const AUTO_HEIGHT = 64;
const PAD = 5;
const HIT_R = 7;

interface Props {
  trackId: string;
  track: StudioTrack;
  laneKey: string;
  width: number;
  pxPerBeat: number;
  snapGrid: number;
  editable: boolean;
  playheadBeats: number;
  onLaneChange: (key: string) => void;
  onClose: () => void;
}

export default function StudioAutomationLane({ trackId, track, laneKey, width, pxPerBeat, snapGrid, editable, playheadBeats, onLaneChange, onClose }: Props) {
  const edit = useStudioStore((s) => s.edit);
  const defs = useMemo(() => laneDefs(track), [track]);
  const def = defs.find((d) => d.key === laneKey) ?? defs[0];
  const stored = track.automation?.[def.key] ?? [];
  const [draft, setDraft] = useState<[number, number][] | null>(null);
  const points = draft ?? stored;
  const h = AUTO_HEIGHT;
  const color = track.color ?? '#5865f2';

  const yOf = (v: number) => PAD + (1 - toNorm(def, v)) * (h - PAD * 2);
  const vOf = (y: number) => fromNorm(def, 1 - (y - PAD) / (h - PAD * 2));
  const groups = useMemo(() => {
    const m = new Map<string, typeof defs>();
    for (const d of defs) { const g = m.get(d.group) ?? []; g.push(d); m.set(d.group, g); }
    return [...m];
  }, [defs]);

  const commit = (pts: [number, number][]) => {
    setDraft(null);
    edit([pts.length
      ? { t: 'set', path: ['tracks', trackId, 'automation', def.key], value: pts }
      : { t: 'del', path: ['tracks', trackId, 'automation', def.key] }]);
  };

  const local = (e: { clientX: number; clientY: number }, el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startDrag = (e: React.PointerEvent, pts: [number, number][], index: number, lane: Element) => {
    let moved = false;
    let cur = pts;
    const move = (ev: PointerEvent) => {
      moved = true;
      const { x, y } = local(ev, lane);
      const lo = index > 0 ? cur[index - 1][0] : 0;
      const hi = index < cur.length - 1 ? cur[index + 1][0] : Infinity;
      const beat = Math.min(hi, Math.max(lo, snapBeats(Math.max(0, x / pxPerBeat), snapGrid)));
      const v = vOf(Math.min(h, Math.max(0, y)));
      cur = cur.map((p, i) => (i === index ? [beat, v] : p));
      setDraft(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      commit(moved ? cur : pts);
    };
    e.preventDefault();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const hit = (x: number, y: number) => points.findIndex(([b, v]) => Math.hypot(b * pxPerBeat - x, yOf(v) - y) <= HIT_R);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    const lane = e.currentTarget;
    const { x, y } = local(e, lane);
    const i = hit(x, y);
    if (i >= 0) { startDrag(e, points, i, lane); return; }
    // Add a point (snapped), then keep dragging it.
    const beat = snapBeats(Math.max(0, x / pxPerBeat), snapGrid);
    const pts: [number, number][] = [...points.filter(([b]) => Math.abs(b - beat) > 1e-6), [beat, vOf(y)]];
    pts.sort((a, b) => a[0] - b[0]);
    setDraft(pts);
    startDrag(e, pts, pts.findIndex(([b]) => b === beat), lane);
  };

  const removeAt = (e: React.MouseEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = local(e, e.currentTarget);
    const i = hit(x, y);
    if (i >= 0) commit(points.filter((_, j) => j !== i));
  };

  // Line: hold first value from 0, connect points, hold last value to the end.
  const line = points.length
    ? [`0,${yOf(points[0][1])}`, ...points.map(([b, v]) => `${b * pxPerBeat},${yOf(v)}`), `${width},${yOf(points[points.length - 1][1])}`].join(' ')
    : '';
  const shownValue = points.length ? valueAt(points, playheadBeats) : def.base;
  const hasData = (key: string) => (track.automation?.[key]?.length ?? 0) > 0;

  return (
    <div className="studio-auto-row" style={{ height: h }}>
      <div className="studio-auto-header" style={{ width: HEADER_WIDTH, ['--track-color' as string]: color }}>
        <select className="studio-select small" value={def.key} onChange={(e) => onLaneChange(e.target.value)} title="Automated parameter">
          {groups.map(([g, list]) => (
            <optgroup key={g} label={g}>
              {list.map((d) => <option key={d.key} value={d.key}>{hasData(d.key) ? '● ' : ''}{d.label}</option>)}
            </optgroup>
          ))}
        </select>
        <div className="studio-auto-meta">
          <span className="studio-auto-value">{formatLaneValue(def, shownValue)}</span>
          {editable && stored.length > 0 && (
            <button className="studio-icon-btn danger" onClick={() => commit([])} title="Clear this lane">Clear</button>
          )}
          <button className="studio-icon-btn" onClick={onClose} title="Hide automation">▴</button>
        </div>
      </div>
      <div
        className={`studio-auto-lane${editable ? ' editable' : ''}`}
        style={{ width }}
        onPointerDown={onPointerDown}
        onDoubleClick={removeAt}
        onContextMenu={removeAt}
        title={editable ? 'Click to add a point · drag to move · double-click or right-click to delete' : undefined}
      >
        <svg width={width} height={h}>
          {!points.length && (
            <line x1={0} x2={width} y1={yOf(def.base)} y2={yOf(def.base)} className="studio-auto-base" />
          )}
          {points.length > 0 && (
            <>
              <polygon points={`0,${h} ${line} ${width},${h}`} fill={`${color}22`} />
              <polyline points={line} fill="none" stroke={color} strokeWidth={2} />
              {points.map(([b, v], i) => (
                <circle key={i} cx={b * pxPerBeat} cy={yOf(v)} r={4} fill="#fff" stroke={color} strokeWidth={2} />
              ))}
            </>
          )}
        </svg>
        {!points.length && editable && <div className="studio-lane-hint">Click to add automation points, or arm ● Auto and move the control while playing</div>}
      </div>
    </div>
  );
}
