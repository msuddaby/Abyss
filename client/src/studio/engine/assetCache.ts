import * as Tone from 'tone';
import { getApiBase } from '@abyss/shared';

// Decoded audio + waveform peaks per studio asset. AudioBuffers are
// context-independent, so the same buffer feeds live playback and offline
// (export) rendering.

export interface Peaks {
  /** Interleaved [min, max] per bucket, mixed down across channels. */
  data: Float32Array;
  /** Source samples per bucket */
  samplesPerBucket: number;
  sampleRate: number;
}

const SAMPLES_PER_BUCKET = 256;

const buffers = new Map<string, AudioBuffer>();
const peaks = new Map<string, Peaks>();
const inflight = new Map<string, Promise<AudioBuffer>>();
const listeners = new Set<(assetId: string) => void>();

export function assetUrl(url: string): string {
  return url.startsWith('http') || url.startsWith('blob:') ? url : `${getApiBase()}${url}`;
}

export function getBuffer(assetId: string): AudioBuffer | undefined {
  return buffers.get(assetId);
}

export function getPeaks(assetId: string): Peaks | undefined {
  return peaks.get(assetId);
}

/** Fires when an asset finishes decoding. Returns an unsubscribe fn. */
export function onAssetLoaded(cb: (assetId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function decodeBlob(data: ArrayBuffer): Promise<AudioBuffer> {
  return Tone.getContext().rawContext.decodeAudioData(data);
}

export function loadAsset(assetId: string, url: string): Promise<AudioBuffer> {
  const cached = buffers.get(assetId);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(assetId);
  if (pending) return pending;

  const promise = (async () => {
    const res = await fetch(assetUrl(url));
    if (!res.ok) throw new Error(`Failed to fetch asset (${res.status})`);
    const buffer = await decodeBlob(await res.arrayBuffer());
    putBuffer(assetId, buffer);
    return buffer;
  })().finally(() => inflight.delete(assetId));
  inflight.set(assetId, promise);
  return promise;
}

/** Seed the cache with a buffer we already decoded (e.g. a fresh recording). */
export function putBuffer(assetId: string, buffer: AudioBuffer) {
  buffers.set(assetId, buffer);
  peaks.set(assetId, computePeaks(buffer));
  for (const cb of listeners) cb(assetId);
}

function computePeaks(buffer: AudioBuffer): Peaks {
  const buckets = Math.ceil(buffer.length / SAMPLES_PER_BUCKET);
  const data = new Float32Array(buckets * 2);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let b = 0; b < buckets; b++) {
    let min = 1, max = -1;
    const end = Math.min(buffer.length, (b + 1) * SAMPLES_PER_BUCKET);
    for (let i = b * SAMPLES_PER_BUCKET; i < end; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v /= channels.length;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    data[b * 2] = min;
    data[b * 2 + 1] = max;
  }
  return { data, samplesPerBucket: SAMPLES_PER_BUCKET, sampleRate: buffer.sampleRate };
}
