import { useMemo, useRef, useState } from 'react';
import {
  EQ_BANDS, EQ_BAND_TYPES, EQ_BAND_COLORS, bandKey, eqBand, eqResponse, bandHasGain, bandHasQ,
  type EqBandType, type Resolved,
} from '../engine/effects';
import type { StudioEngine } from '../engine/StudioEngine';
import Knob from './Knob';
import { useCanvasLoop, drawFreqGrid, drawSpectrum, freqToX, xToFreq, displayFreqs } from './spectrum';

interface Props {
  params: Resolved;
  editable: boolean;
  engine: StudioEngine | null;
  trackId: string;
  fxId: string;
  onPreview: (p: Resolved) => void;
  onCommit: (p: Resolved) => void;
}

const RANGE_DB = 15;
const NODE_R = 7;

export default function EqEightDevice({ params, editable, engine, trackId, fxId, onPreview, onCommit }: Props) {
  const [selected, setSelected] = useState(() => {
    for (let i = 0; i < EQ_BANDS; i++) if (params[bandKey(i, 'on')] === true) return i;
    return 4;
  });
  // Local copy while dragging so the curve follows the pointer.
  const [draft, setDraft] = useState<Resolved | null>(null);
  const p = draft ?? params;
  const freqCache = useRef<{ w: number; f: Float32Array<ArrayBuffer> } | null>(null);

  const yOfDb = (db: number, h: number) => h / 2 - (db / RANGE_DB) * (h / 2 - 8);
  const dbOfY = (y: number, h: number) => ((h / 2 - y) / (h / 2 - 8)) * RANGE_DB;

  const nodePos = (i: number, w: number, h: number) => {
    const b = eqBand(p, i);
    return { x: freqToX(b.f, w), y: bandHasGain(b.type) ? yOfDb(b.gScaled, h) : h / 2 };
  };

  const canvasRef = useCanvasLoop((ctx, w, h) => {
    drawFreqGrid(ctx, w, h);
    // dB grid
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = Math.round(yOfDb(db, h)) + 0.5;
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      if (db !== 0) ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 2);
    }

    const analyser = engine?.getEffectAnalyser(trackId, fxId);
    if (analyser && engine) drawSpectrum(ctx, analyser.getValue() as Float32Array, engine.sampleRate, w, h, '#8b93a6', -96, 0);

    if (!freqCache.current || freqCache.current.w !== w) freqCache.current = { w, f: displayFreqs(w) };
    const freqs = freqCache.current.f;
    const cur = p;

    // Selected band's own curve, filled
    const sel = eqBand(cur, selected);
    if (sel.on) {
      const resp = eqResponse(cur, freqs, selected);
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      for (let i = 0; i < freqs.length; i++) ctx.lineTo((i / (freqs.length - 1)) * w, yOfDb(resp[i], h));
      ctx.lineTo(w, h / 2);
      ctx.closePath();
      ctx.fillStyle = `${EQ_BAND_COLORS[selected]}33`;
      ctx.fill();
    }

    // Combined curve
    const total = eqResponse(cur, freqs);
    ctx.beginPath();
    for (let i = 0; i < freqs.length; i++) {
      const x = (i / (freqs.length - 1)) * w, y = Math.max(-2, Math.min(h + 2, yOfDb(total[i], h)));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;

    // Band nodes
    for (let i = 0; i < EQ_BANDS; i++) {
      const b = eqBand(cur, i);
      const { x, y } = nodePos(i, w, h);
      ctx.beginPath();
      ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = b.on ? EQ_BAND_COLORS[i] : 'rgba(120,120,130,0.5)';
      ctx.fill();
      if (i === selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1; }
      ctx.fillStyle = b.on ? '#111' : '#ddd';
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  });

  const hitNode = (x: number, y: number, w: number, h: number) => {
    let best = -1, bestD = NODE_R + 5;
    for (let i = 0; i < EQ_BANDS; i++) {
      const pos = nodePos(i, w, h);
      const d = Math.hypot(pos.x - x, pos.y - y);
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y, w, h } = local(e);
    const i = hitNode(x, y, w, h);
    if (i < 0) return;
    setSelected(i);
    if (!editable) return;
    e.preventDefault();
    const start = { ...params };
    const type = eqBand(start, i).type;
    const scale = Number(start.scale ?? 100) / 100 || 1;
    let moved = false;
    let last = start;
    const move = (ev: PointerEvent) => {
      const pt = local(ev);
      moved = true;
      last = {
        ...start,
        [bandKey(i, 'on')]: true,
        [bandKey(i, 'f')]: Math.round(Math.min(20000, Math.max(20, xToFreq(Math.min(w, Math.max(0, pt.x)), w)))),
        ...(bandHasGain(type) ? { [bandKey(i, 'g')]: Math.round(Math.max(-RANGE_DB, Math.min(RANGE_DB, dbOfY(pt.y, h) / scale)) * 10) / 10 } : {}),
      };
      setDraft(last);
      onPreview(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraft(null);
      if (moved) onCommit(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWheel = (e: React.WheelEvent) => {
    if (!editable) return;
    const { x, y, w, h } = local(e);
    const i = hitNode(x, y, w, h);
    if (i < 0 || !bandHasQ(eqBand(p, i).type)) return;
    e.preventDefault();
    setSelected(i);
    const q = eqBand(p, i).q;
    const next = { ...p, [bandKey(i, 'q')]: Math.round(Math.min(18, Math.max(0.1, q * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) * 100) / 100 };
    setDraft(next);
    onPreview(next);
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => { setDraft(null); onCommit(next); }, 350);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!editable) return;
    const { x, y, w, h } = local(e);
    const i = hitNode(x, y, w, h);
    if (i >= 0) onCommit({ ...params, [bandKey(i, 'on')]: !eqBand(params, i).on });
  };

  const setBand = (k: 'on' | 'type' | 'f' | 'g' | 'q', v: number | string | boolean, commit = true) => {
    const next = { ...params, [bandKey(selected, k)]: v };
    if (commit) { setDraft(null); onCommit(next); }
    else { setDraft(next); onPreview(next); }
  };

  const b = eqBand(p, selected);
  const color = EQ_BAND_COLORS[selected];
  const typeInfo = useMemo(() => EQ_BAND_TYPES.find((t) => t.value === b.type), [b.type]);

  return (
    <div className="studio-eq8">
      <canvas
        ref={canvasRef}
        className="studio-eq8-display"
        onPointerDown={onPointerDown}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
      />
      <div className="studio-eq8-controls">
        <div className="studio-eq8-bands">
          {Array.from({ length: EQ_BANDS }, (_, i) => {
            const on = p[bandKey(i, 'on')] === true;
            return (
              <button
                key={i}
                className={`studio-eq8-band${i === selected ? ' selected' : ''}${on ? ' on' : ''}`}
                style={{ ['--band-color' as string]: EQ_BAND_COLORS[i] }}
                onClick={() => setSelected(i)}
                onDoubleClick={() => { if (editable) onCommit({ ...params, [bandKey(i, 'on')]: !on }); }}
                title={`Band ${i + 1} — double-click to toggle`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        <div className="studio-eq8-band-edit">
          <button
            className={`studio-toggle${b.on ? ' on' : ''}`}
            style={b.on ? { background: color, borderColor: color } : undefined}
            disabled={!editable}
            onClick={() => setBand('on', !b.on)}
            title={b.on ? 'Turn band off' : 'Turn band on'}
          >⏻</button>
          <div className="studio-eq8-types" title={typeInfo?.label}>
            {EQ_BAND_TYPES.map((t) => (
              <button
                key={t.value}
                className={`studio-eq8-type${b.type === t.value ? ' on' : ''}`}
                disabled={!editable}
                title={t.label}
                onClick={() => onCommit({ ...params, [bandKey(selected, 'type')]: t.value as EqBandType, [bandKey(selected, 'on')]: true })}
              >
                <EqTypeIcon type={t.value} />
              </button>
            ))}
          </div>
          <Knob label="Freq" value={b.f} min={20} max={20000} def={1000} unit="Hz" log color={color} disabled={!editable}
            onPreview={(v) => setBand('f', v, false)} onCommit={(v) => setBand('f', v)} />
          <Knob label="Gain" value={b.g} min={-RANGE_DB} max={RANGE_DB} def={0} unit="dB" color={color} disabled={!editable || !bandHasGain(b.type)}
            onPreview={(v) => setBand('g', v, false)} onCommit={(v) => setBand('g', v)} />
          <Knob label="Q" value={b.q} min={0.1} max={18} def={0.71} unit="" log color={color} disabled={!editable || !bandHasQ(b.type)}
            onPreview={(v) => setBand('q', v, false)} onCommit={(v) => setBand('q', v)} />
          <div className="studio-eq8-sep" />
          <Knob label="Scale" value={Number(p.scale)} min={-200} max={200} def={100} unit="%" disabled={!editable}
            onPreview={(v) => { const next = { ...params, scale: v }; setDraft(next); onPreview(next); }}
            onCommit={(v) => { setDraft(null); onCommit({ ...params, scale: v }); }} />
          <Knob label="Output" value={Number(p.out)} min={-24} max={24} def={0} unit="dB" disabled={!editable}
            onPreview={(v) => { const next = { ...params, out: v }; setDraft(next); onPreview(next); }}
            onCommit={(v) => { setDraft(null); onCommit({ ...params, out: v }); }} />
        </div>
      </div>
    </div>
  );
}

/** Small filter-shape glyphs like Ableton's band type selector. */
function EqTypeIcon({ type }: { type: EqBandType }) {
  const paths: Record<EqBandType, string> = {
    lowcut48: 'M2 13 C5 13 6 3 9 3 L18 3',
    lowcut12: 'M2 11 C6 11 7 3 11 3 L18 3',
    lowshelf: 'M2 4 C6 4 8 10 11 10 L18 10',
    bell: 'M2 10 L6 10 C8 10 8 3 10 3 C12 3 12 10 14 10 L18 10',
    notch: 'M2 5 L7 5 C9 5 9 13 10 13 C11 13 11 5 13 5 L18 5',
    highshelf: 'M2 10 L9 10 C12 10 14 4 18 4',
    highcut12: 'M2 3 L9 3 C13 3 14 11 18 11',
    highcut48: 'M2 3 L11 3 C14 3 15 13 18 13',
  };
  return (
    <svg width="20" height="16" viewBox="0 0 20 16"><path d={paths[type]} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
  );
}
