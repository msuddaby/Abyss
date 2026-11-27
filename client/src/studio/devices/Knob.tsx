import { useEffect, useRef, useState } from 'react';
import { formatParam, type ParamUnit } from '../engine/effects';

// Ableton-style rotary knob. Drag vertically (Shift = fine), scroll to nudge,
// double-click to reset. Previews continuously; commits once on release so a
// drag is a single collaborative edit.

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  def: number;
  unit: ParamUnit;
  log?: boolean;
  disabled?: boolean;
  color?: string;
  size?: number;
  /** Snap to whole numbers (voices, octaves, semitones) */
  integer?: boolean;
  onPreview?: (v: number) => void;
  onCommit: (v: number) => void;
}

const START = -135;
const SWEEP = 270;

export default function Knob({ label, value, min, max, def, unit, log, disabled, color = 'var(--brand-color)', size = 40, integer, onPreview, onCommit }: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wheelVal, setWheelVal] = useState<number | null>(null);

  useEffect(() => () => { if (wheelTimer.current) clearTimeout(wheelTimer.current); }, []);

  const toNorm = (v: number) => {
    const c = Math.min(max, Math.max(min, v));
    return log && min > 0 ? Math.log(c / min) / Math.log(max / min) : (c - min) / (max - min);
  };
  const fromNorm = (n: number) => {
    const c = Math.min(1, Math.max(0, n));
    const v = log && min > 0 ? min * Math.pow(max / min, c) : min + c * (max - min);
    if (integer) return Math.round(v);
    // Keep stored values tidy
    const mag = Math.abs(v);
    const step = mag >= 1000 ? 1 : mag >= 100 ? 0.1 : mag >= 10 ? 0.01 : 0.001;
    return Math.round(v / step) * step;
  };

  const shown = drag ?? wheelVal ?? value;
  const n = toNorm(shown);
  const bipolar = min < 0 && max > 0;
  const zeroN = bipolar ? toNorm(0) : 0;
  const r = size / 2 - 4;
  const cx = size / 2, cy = size / 2;
  const pt = (frac: number) => {
    const a = ((START + frac * SWEEP) - 90) * (Math.PI / 180);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (from: number, to: number) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const [x0, y0] = pt(a);
    const [x1, y1] = pt(b);
    const large = (b - a) * SWEEP > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };
  const [px, py] = pt(n);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startN = toNorm(value);
    let last = value;
    const move = (ev: PointerEvent) => {
      const range = ev.shiftKey ? 800 : 160;
      last = fromNorm(startN + (startY - ev.clientY) / range);
      setDrag(last);
      onPreview?.(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (last !== value) onCommit(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (disabled) return;
    e.preventDefault();
    const cur = wheelVal ?? value;
    const next = fromNorm(toNorm(cur) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02));
    setWheelVal(next);
    setDrag(null);
    onPreview?.(next);
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => {
      setWheelVal(null);
      if (next !== value) onCommit(next);
    }, 350);
  };

  return (
    <div className={`studio-knob${disabled ? ' disabled' : ''}${drag !== null ? ' active' : ''}${size < 40 ? ' small' : ''}`} title={`${label}: ${formatParam(shown, unit)} — drag, Shift for fine, double-click to reset`}>
      <div className="studio-knob-label">{label}</div>
      <svg
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onWheel={onWheel}
        onDoubleClick={() => { if (!disabled) { onPreview?.(def); onCommit(def); } }}
      >
        <path d={arc(0, 1)} className="studio-knob-track" />
        <path d={arc(zeroN, n)} className="studio-knob-value" style={{ stroke: color }} />
        <line x1={cx} y1={cy} x2={px} y2={py} className="studio-knob-pointer" />
      </svg>
      <div className="studio-knob-value-text">{formatParam(shown, unit)}</div>
    </div>
  );
}
