// Abyss Wavetable — polyphonic wavetable synth running on the audio thread.
// Main thread sends: { type: 'params', p, bpm } | { type: 'note', time, pitch, vel, dur } | { type: 'off' }
// Notes are scheduled sample-accurately from their context time.

import { buildTable, tableIndex, TABLE_SIZE, FRAMES, MIP_LEVELS } from './wavetables';
import { MOD_SLOTS, type SynthParams } from './synthParams';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

const MAX_VOICES = 16;
/** Held (live) notes use fixed ids so key-up finds them. */
const LIVE_ID = 1e9;
const MAX_UNI = 8;
const CTRL = 16; // control-rate interval in samples
const TARGETS = ['cutoff', 'res', 'drive', 'posA', 'posB', 'pitch', 'levelA', 'levelB', 'detA', 'detB', 'pan', 'sub', 'noise', 'amp'] as const;
type Target = (typeof TARGETS)[number];
const T: Record<Target, number> = Object.fromEntries(TARGETS.map((t, i) => [t, i])) as Record<Target, number>;
const SOURCES = ['env1', 'env2', 'env3', 'lfo1', 'lfo2', 'vel', 'note', 'rand', 'modwheel'];

const tables = new Map<number, Float32Array[][]>();
function getTable(id: string): Float32Array[][] {
  const i = tableIndex(id);
  let t = tables.get(i);
  if (!t) { t = buildTable(id); tables.set(i, t); }
  return t;
}

interface Env { stage: number; level: number }
interface Osc {
  on: boolean; table: Float32Array[][]; pos: number; oct: number; semi: number; fine: number;
  uni: number; det: number; blend: number; width: number; level: number; pan: number;
}

class Voice {
  active = false;
  id = -1;
  note = 60;
  vel = 1;
  rand = 0;
  started = 0;
  pitch = 60;
  target = 60;
  releaseFrame = Infinity;
  env: Env[] = [{ stage: 0, level: 0 }, { stage: 0, level: 0 }, { stage: 0, level: 0 }];
  lfoPh = [0, 0];
  lfoSH = [0, 0];
  phA = new Float64Array(MAX_UNI);
  phB = new Float64Array(MAX_UNI);
  phSub = 0;
  // control-rate state
  incA = new Float64Array(MAX_UNI); incB = new Float64Array(MAX_UNI);
  gLA = new Float64Array(MAX_UNI); gRA = new Float64Array(MAX_UNI);
  gLB = new Float64Array(MAX_UNI); gRB = new Float64Array(MAX_UNI);
  mipA = 0; mipB = 0; frA0 = 0; frA1 = 0; ftA = 0; frB0 = 0; frB1 = 0; ftB = 0;
  incSub = 0; subLevel = 0; noiseLevel = 0; amp = 1;
  // filter (TPT state-variable), 2 stages × 2 channels
  ic = new Float64Array(8);
  a1 = 0; a2 = 0; a3 = 0; k = 2; drive = 0;
}

/** Equal-power pan angle for p in -1..1 */
const panAngle = (p: number) => (Math.max(-1, Math.min(1, p)) + 1) * Math.PI / 4;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function lfoValue(shape: string, ph: number, held: number): number {
  switch (shape) {
    case 'tri': return 1 - 4 * Math.abs(ph - 0.5);
    case 'saw': return 1 - 2 * ph;
    case 'ramp': return 2 * ph - 1;
    case 'square': return ph < 0.5 ? 1 : -1;
    case 'sh': return held;
    default: return Math.sin(2 * Math.PI * ph);
  }
}

class WavetableProcessor extends AudioWorkletProcessor {
  private p: SynthParams = {};
  private bpm = 120;
  private voices = Array.from({ length: MAX_VOICES }, () => new Voice());
  private events: { frame: number; on: boolean; id: number; pitch: number; vel: number }[] = [];
  private paramEvents: { frame: number; key: string; value: number }[] = [];
  private nextId = 1;
  private lastPitch = -1;
  private globalLfo = [0, 0];
  private globalSH = [0, 0];
  private oscA!: Osc;
  private oscB!: Osc;
  // envelope coefficients [env][a,d,s,r]
  private envC = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
  private mods: { src: number; dst: number; amt: number }[] = [];
  private master = 0.5;
  private bend = 0;
  private modWheel = 0;
  // Scratch buffers — no allocation on the audio thread.
  private modBuf = new Float64Array(TARGETS.length);
  private srcBuf = new Float64Array(SOURCES.length);
  private uniW = new Float64Array(MAX_UNI);

  constructor() {
    super();
    this.setParams({});
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'params') { if (typeof m.bpm === 'number') this.bpm = m.bpm; this.setParams(m.p); }
      else if (m.type === 'bpm') {
        if (typeof m.time === 'number' && Math.round(m.time * sampleRate) > currentFrame) {
          this.insertParam({ frame: Math.round(m.time * sampleRate), key: '__bpm__', value: m.bpm });
        } else {
          this.bpm = m.bpm;
        }
      }
      else if (m.type === 'note') this.queueNote(m.time, m.pitch, m.vel, m.dur);
      else if (m.type === 'off') this.allOff();
      else if (m.type === 'liveOn') this.insert({ frame: currentFrame, on: true, id: LIVE_ID + m.pitch, pitch: m.pitch, vel: m.vel });
      else if (m.type === 'liveOff') this.insert({ frame: currentFrame, on: false, id: LIVE_ID + m.pitch, pitch: m.pitch, vel: 0 });
      else if (m.type === 'param') {
        if (typeof m.time === 'number' && Math.round(m.time * sampleRate) > currentFrame) {
          this.insertParam({ frame: Math.round(m.time * sampleRate), key: m.key, value: m.value });
        } else {
          this.applySingleParam(m.key, m.value);
        }
      }
      else if (m.type === 'bend') this.bend = m.semis;
      else if (m.type === 'modwheel') this.modWheel = m.value;
    };
  }

  private num(k: string, d: number) { const v = this.p[k]; return typeof v === 'number' ? v : d; }
  private str(k: string, d: string) { const v = this.p[k]; return typeof v === 'string' ? v : d; }

  private setParams(p: SynthParams) {
    this.p = p;
    const osc = (x: string): Osc => ({
      on: this.p[`${x}On`] === true,
      table: getTable(this.str(`${x}Wt`, 'basic')),
      pos: this.num(`${x}Pos`, 0), oct: this.num(`${x}Oct`, 0), semi: this.num(`${x}Semi`, 0), fine: this.num(`${x}Fine`, 0),
      uni: Math.max(1, Math.min(MAX_UNI, Math.round(this.num(`${x}Uni`, 1)))),
      det: this.num(`${x}Det`, 0.2), blend: this.num(`${x}Blend`, 0.75), width: this.num(`${x}Width`, 0.8),
      level: this.num(`${x}Level`, 0.75), pan: this.num(`${x}Pan`, 0),
    });
    this.oscA = osc('a');
    this.oscB = osc('b');
    for (let e = 0; e < 3; e++) {
      const a = Math.max(0.0005, this.num(`e${e + 1}a`, 0.01));
      const d = Math.max(0.001, this.num(`e${e + 1}d`, 0.3));
      const s = clamp01(this.num(`e${e + 1}s`, 0.7));
      const r = Math.max(0.001, this.num(`e${e + 1}r`, 0.3));
      const c = this.envC[e];
      c[0] = 1 / (a * sampleRate);
      c[1] = 1 - Math.exp(-4.6 / (d * sampleRate));
      c[2] = s;
      c[3] = 1 - Math.exp(-4.6 / (r * sampleRate));
    }
    this.mods = [];
    for (let i = 0; i < MOD_SLOTS; i++) {
      const src = SOURCES.indexOf(this.str(`m${i}src`, ''));
      const dst = TARGETS.indexOf(this.str(`m${i}dst`, '') as Target);
      const amt = this.num(`m${i}amt`, 0);
      if (src >= 0 && dst >= 0 && amt !== 0) this.mods.push({ src, dst, amt });
    }
    this.master = Math.pow(10, this.num('volume', -6) / 20);
  }

  private queueNote(time: number, pitch: number, vel: number, dur: number) {
    const id = this.nextId++;
    const start = Math.max(currentFrame, Math.round(time * sampleRate));
    const end = start + Math.max(1, Math.round(dur * sampleRate));
    this.insert({ frame: start, on: true, id, pitch, vel });
    this.insert({ frame: end, on: false, id, pitch, vel });
  }

  private insert(ev: { frame: number; on: boolean; id: number; pitch: number; vel: number }) {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].frame > ev.frame) i--;
    this.events.splice(i, 0, ev);
  }

  private insertParam(ev: { frame: number; key: string; value: number }) {
    let i = this.paramEvents.length;
    while (i > 0 && this.paramEvents[i - 1].frame > ev.frame) i--;
    this.paramEvents.splice(i, 0, ev);
  }

  private applySingleParam(key: string, value: number) {
    if (key === '__bpm__') { this.bpm = value; return; }
    this.p[key] = value;
    if (key === 'volume') { this.master = Math.pow(10, value / 20); return; }
    if (key === 'aPos') { this.oscA.pos = value; return; }
    if (key === 'bPos') { this.oscB.pos = value; return; }
    if (key === 'aLevel') { this.oscA.level = value; return; }
    if (key === 'bLevel') { this.oscB.level = value; return; }
    if (key === 'aDet') { this.oscA.det = value; return; }
    if (key === 'bDet') { this.oscB.det = value; return; }
    if (key === 'aPan') { this.oscA.pan = value; return; }
    if (key === 'bPan') { this.oscB.pan = value; return; }
    if (key === 'aSemi') { this.oscA.semi = value; return; }
    if (key === 'bSemi') { this.oscB.semi = value; return; }
    if (key === 'aFine') { this.oscA.fine = value; return; }
    if (key === 'bFine') { this.oscB.fine = value; return; }
    if (key === 'fCutoff' || key === 'fRes' || key === 'fDrive' || key === 'subLevel' || key === 'noiseLevel'
      || key === 'l1Rate' || key === 'l2Rate' || key === 'glide') return;
    this.setParams(this.p);
  }

  private allOff() {
    this.events = [];
    for (const v of this.voices) if (v.active) this.release(v);
  }

  private release(v: Voice) {
    for (const e of v.env) if (e.stage !== 0) e.stage = 4;
  }

  private noteOn(id: number, pitch: number, vel: number, frame: number) {
    const poly = Math.max(1, Math.min(MAX_VOICES, Math.round(this.num('poly', 8))));
    const glide = this.num('glide', 0);
    let v: Voice | undefined;
    if (poly === 1) {
      v = this.voices[0];
    } else {
      v = this.voices.slice(0, poly).find((x) => !x.active);
      if (!v) v = this.voices.slice(0, poly).reduce((a, b) => (a.started <= b.started ? a : b));
    }
    const legato = poly === 1 && v.active && v.env[0].stage !== 4;
    v.id = id;
    v.note = pitch;
    v.vel = vel;
    v.started = frame;
    v.target = pitch;
    v.pitch = glide > 0 && this.lastPitch >= 0 ? (legato ? v.pitch : this.lastPitch) : pitch;
    this.lastPitch = pitch;
    if (!legato) {
      v.rand = Math.random() * 2 - 1;
      for (const e of v.env) e.stage = 1; // attack from current level (no clicks on steal)
      for (let u = 0; u < MAX_UNI; u++) { v.phA[u] = Math.random(); v.phB[u] = Math.random(); }
      v.phSub = 0;
      if (this.p.l1Retrig === true) v.lfoPh[0] = 0;
      if (this.p.l2Retrig === true) v.lfoPh[1] = 0;
      if (!v.active) v.ic.fill(0);
    }
    v.active = true;
    // Populate pitch, osc increments/gains, and filter coefficients before sample 0.
    this.control(v);
  }

  private noteOff(id: number) {
    for (const v of this.voices) if (v.active && v.id === id) this.release(v);
  }

  private lfoRate(i: number) {
    const n = i + 1;
    return this.p[`l${n}Sync`] === true ? (this.bpm / 60) / Math.max(0.03, this.num(`l${n}Div`, 1)) : this.num(`l${n}Rate`, 1);
  }

  /** Control-rate update: modulation, pitch, unison gains, filter coefficients. */
  private control(v: Voice) {
    const src = this.srcBuf;
    src[0] = v.env[0].level; src[1] = v.env[1].level; src[2] = v.env[2].level; src[3] = 0; src[4] = 0;
    src[5] = v.vel; src[6] = Math.max(-1, Math.min(1, (v.note - 60) / 24)); src[7] = v.rand; src[8] = this.modWheel;
    for (let l = 0; l < 2; l++) {
      const retrig = this.p[`l${l + 1}Retrig`] === true;
      const ph = retrig ? v.lfoPh[l] : this.globalLfo[l];
      src[3 + l] = lfoValue(this.str(`l${l + 1}Shape`, 'sine'), ph, retrig ? v.lfoSH[l] : this.globalSH[l]);
      if (retrig) {
        const next = ph + (this.lfoRate(l) * CTRL) / sampleRate;
        if (next >= 1) v.lfoSH[l] = Math.random() * 2 - 1;
        v.lfoPh[l] = next % 1;
      }
    }
    const m = this.modBuf;
    m.fill(0);
    for (const s of this.mods) m[s.dst] += src[s.src] * s.amt;

    const glide = this.num('glide', 0);
    v.pitch = glide > 0 ? v.pitch + (v.target - v.pitch) * (1 - Math.exp(-CTRL / (glide * sampleRate * 0.3))) : v.target;
    const basePitch = v.pitch + m[T.pitch] * 24 + this.bend;

    const setupOsc = (o: Osc, a: boolean) => {
      const level = clamp01(o.level + m[a ? T.levelA : T.levelB]);
      if (!o.on || level <= 0) { (a ? v.gLA : v.gLB).fill(0); (a ? v.gRA : v.gRB).fill(0); return; }
      const st = basePitch + o.oct * 12 + o.semi + o.fine / 100;
      const f = 440 * Math.pow(2, (st - 69) / 12);
      const det = clamp01(o.det + m[a ? T.detA : T.detB]);
      const pos = clamp01(o.pos + m[a ? T.posA : T.posB]) * (FRAMES - 1);
      const f0 = Math.min(FRAMES - 2, Math.floor(pos));
      const maxH = sampleRate / 2 / Math.max(1, f * (1 + det * 0.06));
      const mip = Math.max(0, Math.min(MIP_LEVELS - 1, Math.ceil(Math.log2(TABLE_SIZE / 2 / Math.max(1, maxH)))));
      if (a) { v.frA0 = f0; v.frA1 = f0 + 1; v.ftA = pos - f0; v.mipA = mip; } else { v.frB0 = f0; v.frB1 = f0 + 1; v.ftB = pos - f0; v.mipB = mip; }
      const inc = a ? v.incA : v.incB, gL = a ? v.gLA : v.gLB, gR = a ? v.gRA : v.gRB;
      let norm = 0;
      const w = this.uniW;
      for (let u = 0; u < o.uni; u++) {
        const off = o.uni > 1 ? (u / (o.uni - 1)) * 2 - 1 : 0;
        inc[u] = Math.min(0.4999, Math.max(0, (f * Math.pow(2, (off * det * 100) / 1200)) / sampleRate));
        w[u] = o.uni === 1 ? 1 : Math.abs(off) < 0.34 ? 1 - o.blend * 0.6 : o.blend;
        norm += w[u] * w[u];
      }
      norm = level / Math.sqrt(norm || 1);
      for (let u = 0; u < o.uni; u++) {
        const off = o.uni > 1 ? (u / (o.uni - 1)) * 2 - 1 : 0;
        const ang = panAngle(o.pan + off * o.width + m[T.pan]);
        gL[u] = w[u] * norm * Math.cos(ang);
        gR[u] = w[u] * norm * Math.sin(ang);
      }
      for (let u = o.uni; u < MAX_UNI; u++) { gL[u] = 0; gR[u] = 0; }
    };
    setupOsc(this.oscA, true);
    setupOsc(this.oscB, false);

    v.subLevel = clamp01(this.num('subLevel', 0) + m[T.sub]);
    v.incSub = Math.min(0.4999, Math.max(0, (440 * Math.pow(2, (basePitch + this.num('subOct', -1) * 12 - 69) / 12)) / sampleRate));
    v.noiseLevel = clamp01(this.num('noiseLevel', 0) + m[T.noise]);
    v.amp = Math.max(0, (0.35 + 0.65 * v.vel) * (1 + m[T.amp]));

    if (this.p.fOn === true) {
      const key = this.num('fKey', 0) * (v.note - 60) / 12;
      const cutoff = Math.min(sampleRate * 0.45, Math.max(20, this.num('fCutoff', 9000) * Math.pow(2, m[T.cutoff] * 6 + key)));
      const res = clamp01(this.num('fRes', 0.1) + m[T.res]);
      const g = Math.tan((Math.PI * cutoff) / sampleRate);
      v.k = 2 - 1.96 * res;
      v.a1 = 1 / (1 + g * (g + v.k));
      v.a2 = g * v.a1;
      v.a3 = g * v.a2;
      v.drive = clamp01(this.num('fDrive', 0) + m[T.drive]);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    const n = L.length;
    L.fill(0);
    if (R !== L) R.fill(0);

    const A = this.oscA, B = this.oscB;
    const filterOn = this.p.fOn === true;
    const fType = this.str('fType', 'lp24');
    const stages = fType === 'lp24' || fType === 'hp24' ? 2 : 1;
    const subShape = this.str('subShape', 'sine');
    const ec = this.envC;

    for (let s = 0; s < n; s++) {
      const frame = currentFrame + s;
      while (this.paramEvents.length && this.paramEvents[0].frame <= frame) {
        const pe = this.paramEvents.shift()!;
        this.applySingleParam(pe.key, pe.value);
      }
      while (this.events.length && this.events[0].frame <= frame) {
        const ev = this.events.shift()!;
        if (ev.on) this.noteOn(ev.id, ev.pitch, ev.vel, frame); else this.noteOff(ev.id);
      }
      const ctrl = s % CTRL === 0;
      if (ctrl) {
        for (let l = 0; l < 2; l++) {
          const next = this.globalLfo[l] + (this.lfoRate(l) * CTRL) / sampleRate;
          if (next >= 1) this.globalSH[l] = Math.random() * 2 - 1;
          this.globalLfo[l] = next % 1;
        }
      }

      for (const v of this.voices) {
        if (!v.active) continue;
        // Envelopes (per sample)
        for (let e = 0; e < 3; e++) {
          const env = v.env[e], c = ec[e];
          switch (env.stage) {
            case 1: env.level += c[0]; if (env.level >= 1) { env.level = 1; env.stage = 2; } break;
            case 2: env.level += (c[2] - env.level) * c[1]; break;
            case 4: env.level -= env.level * c[3]; if (env.level < 1e-5) { env.level = 0; env.stage = 0; } break;
          }
        }
        if (v.env[0].stage === 0) { v.active = false; continue; }
        if (ctrl) this.control(v);

        let l = 0, r = 0;
        if (A.on) {
          const t0 = A.table[v.frA0][v.mipA], t1 = A.table[v.frA1][v.mipA], ft = v.ftA;
          for (let u = 0; u < A.uni; u++) {
            const idx = v.phA[u] * TABLE_SIZE, i = idx | 0, fr = idx - i;
            const s0 = t0[i] + (t0[i + 1] - t0[i]) * fr, s1 = t1[i] + (t1[i + 1] - t1[i]) * fr;
            const x = s0 + (s1 - s0) * ft;
            l += x * v.gLA[u]; r += x * v.gRA[u];
            v.phA[u] += v.incA[u]; if (v.phA[u] >= 1) v.phA[u] -= Math.floor(v.phA[u]);
          }
        }
        if (B.on) {
          const t0 = B.table[v.frB0][v.mipB], t1 = B.table[v.frB1][v.mipB], ft = v.ftB;
          for (let u = 0; u < B.uni; u++) {
            const idx = v.phB[u] * TABLE_SIZE, i = idx | 0, fr = idx - i;
            const s0 = t0[i] + (t0[i + 1] - t0[i]) * fr, s1 = t1[i] + (t1[i + 1] - t1[i]) * fr;
            const x = s0 + (s1 - s0) * ft;
            l += x * v.gLB[u]; r += x * v.gRB[u];
            v.phB[u] += v.incB[u]; if (v.phB[u] >= 1) v.phB[u] -= Math.floor(v.phB[u]);
          }
        }
        if (v.subLevel > 0) {
          const p = v.phSub;
          const x = subShape === 'square' ? (p < 0.5 ? 0.7 : -0.7) : subShape === 'tri' ? 1 - 4 * Math.abs(p - 0.5) : Math.sin(2 * Math.PI * p);
          l += x * v.subLevel * 0.7; r += x * v.subLevel * 0.7;
          v.phSub += v.incSub; if (v.phSub >= 1) v.phSub -= Math.floor(v.phSub);
        }
        if (v.noiseLevel > 0) { const x = (Math.random() * 2 - 1) * v.noiseLevel * 0.5; l += x; r += x; }

        if (filterOn) {
          if (v.drive > 0) {
            const g = 1 + v.drive * 8, comp = 1 / Math.tanh(g);
            l = Math.tanh(l * g) * comp; r = Math.tanh(r * g) * comp;
          }
          const ic = v.ic, a1 = v.a1, a2 = v.a2, a3 = v.a3, k = v.k;
          for (let st = 0; st < stages; st++) {
            for (let ch = 0; ch < 2; ch++) {
              const o = st * 4 + ch * 2;
              const x = ch === 0 ? l : r;
              const v3 = x - ic[o + 1];
              const v1 = a1 * ic[o] + a2 * v3;
              const v2 = ic[o + 1] + a2 * ic[o] + a3 * v3;
              ic[o] = 2 * v1 - ic[o];
              ic[o + 1] = 2 * v2 - ic[o + 1];
              let y: number;
              switch (fType) {
                case 'hp12': case 'hp24': y = x - k * v1 - v2; break;
                case 'bp': y = v1 * k; break;
                case 'notch': y = x - k * v1; break;
                default: y = v2;
              }
              if (ch === 0) l = y; else r = y;
            }
          }
        }

        const amp = v.env[0].level * v.amp * this.master;
        L[s] += l * amp;
        if (R !== L) R[s] += r * amp;
      }
    }
    return true;
  }
}

registerProcessor('abyss-wavetable', WavetableProcessor);

// ───────────────────────── Sidechain compressor ─────────────────────────
// Input 0 is the signal to compress, input 1 the key (e.g. a kick track).
// Feed-forward, peak-detecting, soft knee; gain reduction is smoothed with
// separate attack / release and reported to the main thread for the meter.
// Main thread sends: { type: 'params', threshold, ratio, attack, release, knee, makeup } (dB / ms)

class SidechainCompressor extends AudioWorkletProcessor {
  private thr = -18;
  private ratio = 4;
  private atk = 0.01;
  private rel = 0.15;
  private knee = 6;
  private makeup = 1;
  private env = 0;
  private minEnv = 0;
  private sinceReport = 0;
  private paramEvents: { frame: number; threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }[] = [];

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; time?: number; threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number };
      if (m.type !== 'params') return;
      if (typeof m.time === 'number' && Math.round(m.time * sampleRate) > currentFrame) {
        const ev = { frame: Math.round(m.time * sampleRate), threshold: m.threshold, ratio: m.ratio, attack: m.attack, release: m.release, knee: m.knee, makeup: m.makeup };
        let i = this.paramEvents.length;
        while (i > 0 && this.paramEvents[i - 1].frame > ev.frame) i--;
        this.paramEvents.splice(i, 0, ev);
      } else {
        this.applyParams(m);
      }
    };
  }

  private applyParams(m: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }) {
    this.thr = m.threshold;
    this.ratio = Math.max(1, m.ratio);
    this.atk = Math.max(0.0001, m.attack / 1000);
    this.rel = Math.max(0.001, m.release / 1000);
    this.knee = Math.max(0, m.knee);
    this.makeup = Math.pow(10, m.makeup / 20);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const main = inputs[0] ?? [];
    const key = inputs[1] ?? [];
    const out = outputs[0];
    const n = out[0]?.length ?? 128;
    let aA = Math.exp(-1 / (this.atk * sampleRate));
    let aR = Math.exp(-1 / (this.rel * sampleRate));
    let slope = 1 / this.ratio - 1;
    let knee = this.knee;
    for (let i = 0; i < n; i++) {
      const frame = currentFrame + i;
      if (this.paramEvents.length && this.paramEvents[0].frame <= frame) {
        while (this.paramEvents.length && this.paramEvents[0].frame <= frame) {
          this.applyParams(this.paramEvents.shift()!);
        }
        aA = Math.exp(-1 / (this.atk * sampleRate));
        aR = Math.exp(-1 / (this.rel * sampleRate));
        slope = 1 / this.ratio - 1;
        knee = this.knee;
      }
      let k = 0;
      for (let c = 0; c < key.length; c++) { const a = Math.abs(key[c][i]); if (a > k) k = a; }
      const db = k > 1e-6 ? 20 * Math.log10(k) : -120;
      const over = db - this.thr;
      let gr: number;
      if (2 * over < -knee) gr = 0;
      else if (knee > 0 && 2 * Math.abs(over) <= knee) gr = (slope * (over + knee / 2) ** 2) / (2 * knee);
      else gr = slope * over;
      this.env = gr < this.env ? aA * this.env + (1 - aA) * gr : aR * this.env + (1 - aR) * gr;
      if (this.env < this.minEnv) this.minEnv = this.env;
      const g = Math.pow(10, this.env / 20) * this.makeup;
      for (let c = 0; c < out.length; c++) {
        const src = main[c] ?? main[0];
        out[c][i] = src ? src[i] * g : 0;
      }
    }
    this.sinceReport += n;
    if (this.sinceReport >= 2048) {
      this.port.postMessage(this.minEnv);
      this.minEnv = 0;
      this.sinceReport = 0;
    }
    return true;
  }
}

registerProcessor('abyss-sidechain', SidechainCompressor);
