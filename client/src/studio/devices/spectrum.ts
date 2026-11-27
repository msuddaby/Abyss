import { useEffect, useRef } from 'react';

// Log-frequency spectrum drawing shared by every device display.

export const F_MIN = 20;
export const F_MAX = 20000;
const DECADES = Math.log10(F_MAX / F_MIN);

export function freqToX(f: number, w: number): number {
  return (Math.log10(Math.max(F_MIN, f) / F_MIN) / DECADES) * w;
}

export function xToFreq(x: number, w: number): number {
  return F_MIN * Math.pow(10, (x / w) * DECADES);
}

/** Log-spaced frequencies across the display width (for response curves). */
export function displayFreqs(w: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.max(2, Math.floor(w)));
  for (let i = 0; i < out.length; i++) out[i] = xToFreq((i / (out.length - 1)) * w, w);
  return out;
}

const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

export function drawFreqGrid(ctx: CanvasRenderingContext2D, w: number, h: number, labels = true) {
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (const f of GRID_FREQS) {
    const x = Math.round(freqToX(f, w)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (labels) ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 3);
  }
}

/**
 * Filled spectrum from Tone.Analyser('fft') output (dB per bin, 0..nyquist).
 * Uses the max over the bins each pixel covers so high-frequency detail
 * doesn't vanish on a log axis.
 */
export function drawSpectrum(
  ctx: CanvasRenderingContext2D, bins: Float32Array, sampleRate: number, w: number, h: number,
  color: string, minDb = -96, maxDb = 0,
) {
  const nyquist = sampleRate / 2;
  const n = bins.length;
  const yOf = (db: number) => h - ((Math.max(minDb, Math.min(maxDb, db)) - minDb) / (maxDb - minDb)) * h;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x++) {
    const f0 = xToFreq(x, w), f1 = xToFreq(x + 1, w);
    const b0 = Math.max(1, Math.floor((f0 / nyquist) * n));
    const b1 = Math.min(n - 1, Math.max(b0, Math.ceil((f1 / nyquist) * n)));
    let db = -Infinity;
    for (let b = b0; b <= b1; b++) if (bins[b] > db) db = bins[b];
    ctx.lineTo(x, yOf(Number.isFinite(db) ? db : minDb));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `${color}cc`);
  grad.addColorStop(1, `${color}22`);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * Runs `draw` every animation frame on a DPR-correct canvas sized to its
 * CSS box. `draw` reads live data (analysers, refs) itself.
 */
export function useCanvasLoop(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const canvas = ref.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (ctx && w > 0 && h > 0) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);
          drawRef.current(ctx, w, h);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return ref;
}
