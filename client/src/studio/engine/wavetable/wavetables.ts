// Built-in wavetables. Each table is a time-domain generator gen(phase, morph)
// sampled into FRAMES frames; the worklet turns every frame into band-limited
// mip levels (one per octave) via FFT so high notes don't alias. Pure module:
// imported by both the audio worklet and the UI (for drawing).

export const TABLE_SIZE = 2048;
export const FRAMES = 16;
/** Mip k keeps harmonics 1..(TABLE_SIZE/2 >> k) */
export const MIP_LEVELS = 10;

type Gen = (phase: number, morph: number) => number;

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);

const tri = (p: number) => 1 - 4 * Math.abs(frac(p + 0.25) - 0.5);
const saw = (p: number) => 2 * frac(p + 0.5) - 1;
const square = (p: number) => (frac(p) < 0.5 ? 1 : -1);

// Vowel formants (Hz-ish positions mapped to harmonic numbers at ~110 Hz).
const VOWELS = [
  [730, 1090, 2440], // A
  [530, 1840, 2480], // E
  [270, 2290, 3010], // I
  [570, 840, 2410],  // O
  [300, 870, 2240],  // U
];

function vowelGen(phase: number, morph: number): number {
  const pos = morph * (VOWELS.length - 1);
  const i = Math.min(VOWELS.length - 2, Math.floor(pos));
  const t = pos - i;
  const f = VOWELS[i].map((v, k) => v + (VOWELS[i + 1][k] - v) * t);
  let s = 0;
  for (let h = 1; h <= 40; h++) {
    const hz = h * 110;
    let a = 0;
    for (const fc of f) a += Math.exp(-(((hz - fc) / 120) ** 2));
    s += (a + 0.02 / h) * Math.sin(TAU * h * phase);
  }
  return s;
}

function harmonicGen(phase: number, morph: number): number {
  const n = 1 + morph * 31;
  let s = 0;
  for (let h = 1; h <= Math.ceil(n); h++) {
    const w = Math.min(1, n - h + 1);
    s += (w / h) * Math.sin(TAU * h * phase);
  }
  return s;
}

export interface TableDef {
  id: string;
  label: string;
  gen: Gen;
}

export const TABLES: TableDef[] = [
  {
    id: 'basic', label: 'Basic Shapes',
    gen: (p, m) => {
      const shapes = [Math.sin(TAU * p), tri(p), saw(p), square(p)];
      const pos = m * 3;
      const i = Math.min(2, Math.floor(pos));
      const t = pos - i;
      return shapes[i] * (1 - t) + shapes[i + 1] * t;
    },
  },
  { id: 'pwm', label: 'Pulse Width', gen: (p, m) => (frac(p) < 0.5 - m * 0.47 ? 1 : -1) },
  { id: 'sync', label: 'Hard Sync', gen: (p, m) => saw(frac(p) * (1 + m * 7)) * (1 - frac(p) * 0.15) },
  { id: 'fm', label: 'FM Bell', gen: (p, m) => Math.sin(TAU * p + m * 6 * Math.sin(TAU * p * 2)) },
  { id: 'vowel', label: 'Vowel', gen: vowelGen },
  { id: 'harmonic', label: 'Harmonic Sweep', gen: harmonicGen },
  { id: 'fold', label: 'Wave Fold', gen: (p, m) => Math.sin(Math.PI * (0.5 + m * 4) * Math.sin(TAU * p)) },
  {
    id: 'digital', label: 'Digital',
    gen: (p, m) => {
      const steps = Math.round(2 + (1 - m) * 30);
      return Math.round(Math.sin(TAU * p) * steps) / steps + (m > 0.5 ? 0.3 * square(p * 4) * (m - 0.5) : 0);
    },
  },
  { id: 'growl', label: 'Growl', gen: (p, m) => Math.sin(TAU * p) * (0.6 + 0.4 * Math.sin(TAU * p * (1 + Math.round(m * 7)))) + 0.3 * m * saw(p * 2) },
];

export const TABLE_IDS = TABLES.map((t) => t.id);

export function tableIndex(id: string): number {
  const i = TABLE_IDS.indexOf(id);
  return i < 0 ? 0 : i;
}

/** Raw samples at a continuous morph position (0..1), normalized — for drawing. */
export function morphSamples(tableId: string, morph: number, size: number): Float32Array {
  const gen = TABLES[tableIndex(tableId)].gen;
  const out = new Float32Array(size);
  let peak = 1e-9;
  for (let i = 0; i < size; i++) { out[i] = gen(i / size, morph); peak = Math.max(peak, Math.abs(out[i])); }
  for (let i = 0; i < size; i++) out[i] /= peak;
  return out;
}

/** Raw (non-band-limited) frame samples, normalized to ±1 — for drawing. */
export function frameSamples(tableId: string, frame: number, size: number): Float32Array {
  const gen = TABLES[tableIndex(tableId)].gen;
  const morph = frame / (FRAMES - 1);
  const out = new Float32Array(size);
  let peak = 1e-9;
  for (let i = 0; i < size; i++) { out[i] = gen(i / size, morph); peak = Math.max(peak, Math.abs(out[i])); }
  for (let i = 0; i < size; i++) out[i] /= peak;
  return out;
}

// ───────────────────────── FFT (radix-2, in place) ─────────────────────────

function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (TAU / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Band-limited mips for a whole table: result[frame][mip] = Float32Array(TABLE_SIZE + 1)
 * (one guard sample for interpolation). Normalized per frame so morphing keeps level.
 */
export function buildTable(tableId: string): Float32Array[][] {
  const gen = TABLES[tableIndex(tableId)].gen;
  const n = TABLE_SIZE;
  const frames: Float32Array[][] = [];
  for (let f = 0; f < FRAMES; f++) {
    const morph = f / (FRAMES - 1);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = gen(i / n, morph);
    fft(re, im, false);
    re[0] = 0; im[0] = 0; // remove DC
    const mips: Float32Array[] = [];
    let norm = 0;
    for (let k = 0; k < MIP_LEVELS; k++) {
      const limit = (n / 2) >> k;
      const r = new Float64Array(n), q = new Float64Array(n);
      for (let b = 1; b <= Math.min(limit, n / 2 - 1); b++) {
        r[b] = re[b]; q[b] = im[b];
        r[n - b] = re[n - b]; q[n - b] = im[n - b];
      }
      fft(r, q, true);
      const out = new Float32Array(n + 1);
      for (let i = 0; i < n; i++) out[i] = r[i];
      out[n] = out[0];
      if (k === 0) { for (let i = 0; i < n; i++) norm = Math.max(norm, Math.abs(out[i])); norm = norm || 1; }
      for (let i = 0; i <= n; i++) out[i] /= norm;
      mips.push(out);
    }
    frames.push(mips);
  }
  return frames;
}
