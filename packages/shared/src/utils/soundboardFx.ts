// Soundboard speed/pitch: shared limits plus the DSP that applies them.
//
// The person who plays a clip picks a global speed and pitch; those values ride
// along on the SoundboardClipPlayed broadcast and every listener applies them
// locally. Three playback paths, cheapest first:
//   1. Unaltered (speed 1, pitch 0)        → plain playback, no processing.
//   2. "Tape" (pitch == 12·log2(speed))    → AudioBufferSourceNode.playbackRate.
//   3. Independent speed and pitch          → resample for pitch, then a WSOLA
//      time-stretch to fix the duration. Clips are short, so this runs offline
//      on the decoded buffer and the result is cached per (url, speed, pitch).

export const SOUNDBOARD_SPEED_MIN = 0.5;
export const SOUNDBOARD_SPEED_MAX = 2;
export const SOUNDBOARD_PITCH_MIN = -12;
export const SOUNDBOARD_PITCH_MAX = 12;
/** Slider snap points for speed. */
export const SOUNDBOARD_SPEED_DETENTS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface SoundboardFx {
  speed: number;
  /** Semitones. May be fractional in tape mode (12·log2(speed)). */
  pitch: number;
  /** Pitch follows speed, like a record. */
  tape: boolean;
}

export const DEFAULT_SOUNDBOARD_FX: SoundboardFx = { speed: 1, pitch: 0, tape: false };

export interface SoundboardFxPreset {
  name: string;
  speed: number;
  pitch: number;
}

export const SOUNDBOARD_FX_PRESETS: SoundboardFxPreset[] = [
  { name: 'Normal', speed: 1, pitch: 0 },
  { name: 'Chipmunk', speed: 1.25, pitch: 7 },
  { name: 'Slow-mo', speed: 0.6, pitch: -5 },
  { name: 'Deep', speed: 1, pitch: -8 },
  { name: 'Hyper', speed: 1.8, pitch: 0 },
];

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(SOUNDBOARD_SPEED_MAX, Math.max(SOUNDBOARD_SPEED_MIN, speed));
}

export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  return Math.min(SOUNDBOARD_PITCH_MAX, Math.max(SOUNDBOARD_PITCH_MIN, pitch));
}

/** Pitch shift (semitones) produced by playing a sound at `speed` like a tape. */
export function tapePitch(speed: number): number {
  return 12 * Math.log2(speed);
}

export function isFxNeutral(speed: number, pitch: number): boolean {
  return Math.abs(speed - 1) < 1e-3 && Math.abs(pitch) < 1e-2;
}

export function isTapeFx(speed: number, pitch: number): boolean {
  return Math.abs(pitch - tapePitch(speed)) < 0.05;
}

/** The values actually sent to the hub for a given UI state. */
export function effectiveFx(fx: SoundboardFx): { speed: number; pitch: number } {
  const speed = clampSpeed(fx.speed);
  return { speed, pitch: fx.tape ? tapePitch(speed) : clampPitch(fx.pitch) };
}

export function formatSpeed(speed: number): string {
  return `${speed.toFixed(2)}×`;
}

export function formatPitch(pitch: number): string {
  const r = Math.round(pitch);
  if (r === 0) return '0 st';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)} st`;
}

// ── DSP ──────────────────────────────────────────────────────────────────────

/** Linear-interpolation resample: reads the input `ratio` samples per output sample. */
function resample(input: Float32Array, ratio: number): Float32Array {
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[Math.min(idx, last)];
    const b = input[Math.min(idx + 1, last)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * WSOLA time-stretch. `tempo` > 1 plays faster (shorter), < 1 slower. Pitch is
 * preserved. Frame offsets are chosen once from a mono mix and applied to every
 * channel so the stereo image stays coherent.
 */
function wsola(channels: Float32Array[], sampleRate: number, tempo: number): Float32Array[] {
  const inLen = channels[0].length;
  const N = Math.max(256, Math.round(sampleRate * 0.03)) & ~1; // ~30ms frame, even
  const Hs = N / 2; // 50% overlap: a periodic Hann window sums to 1
  const delta = Math.round(sampleRate * 0.008); // ±8ms search
  const outLen = Math.max(1, Math.round(inLen / tempo));

  if (inLen < N * 2) {
    // Too short to stretch meaningfully: fall back to plain resampling.
    return channels.map((ch) => resample(ch, tempo));
  }

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const mono = new Float32Array(inLen);
  for (const ch of channels) for (let i = 0; i < inLen; i++) mono[i] += ch[i];

  const outs = channels.map(() => new Float32Array(outLen + N));
  const maxPos = inLen - N;
  const corrLen = Hs; // compare the overlapping half only
  const stride = 4;
  let prevPos = 0;

  for (let k = 0, outPos = 0; outPos < outLen; k++, outPos += Hs) {
    let pos: number;
    if (k === 0) {
      pos = 0;
    } else {
      // Find the frame near the nominal input position that best continues
      // the waveform from where the previous frame left off.
      const nominal = Math.round(outPos * tempo);
      const target = Math.min(prevPos + Hs, maxPos);
      const lo = Math.max(0, nominal - delta);
      const hi = Math.min(maxPos, nominal + delta);
      pos = Math.min(Math.max(nominal, 0), maxPos);
      let best = -Infinity;
      for (let p = lo; p <= hi; p++) {
        let c = 0;
        for (let j = 0; j < corrLen; j += stride) c += mono[p + j] * mono[target + j];
        if (c > best) {
          best = c;
          pos = p;
        }
      }
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = outs[c];
      for (let i = 0; i < N; i++) dst[outPos + i] += src[pos + i] * win[i];
    }
    prevPos = pos;
  }

  // Fade the first half-frame back up (it only received one window half).
  for (const out of outs) {
    for (let i = 0; i < Hs; i++) out[i] /= Math.max(win[i], 1e-3);
  }
  return outs.map((o) => o.subarray(0, outLen));
}

/**
 * Returns a new AudioBuffer with speed and pitch applied independently.
 * pitch is in semitones; speed is a tempo multiplier.
 */
export function renderFxBuffer(ctx: BaseAudioContext, buffer: AudioBuffer, speed: number, pitch: number): AudioBuffer {
  const ratio = Math.pow(2, pitch / 12);
  const input = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  // Resampling by `ratio` raises pitch by `ratio` and shortens by `ratio`;
  // the stretch then corrects the duration so the overall tempo is `speed`.
  const pitched = Math.abs(ratio - 1) < 1e-4 ? input : input.map((ch) => resample(ch, ratio));
  const tempo = speed / ratio;
  const stretched = Math.abs(tempo - 1) < 1e-4 ? pitched : wsola(pitched, buffer.sampleRate, tempo);
  const out = ctx.createBuffer(buffer.numberOfChannels, stretched[0].length, buffer.sampleRate);
  stretched.forEach((data, i) => out.copyToChannel(new Float32Array(data), i));
  return out;
}
