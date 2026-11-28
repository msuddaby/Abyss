import * as Tone from 'tone';
import { arrangementEnd, tempoMap, beatToSec } from '@abyss/shared';
import type { StudioDoc, StudioAsset, StudioTrack } from '@abyss/shared';
import { StudioEngine } from './StudioEngine';
import { loadAsset } from './assetCache';
import { usedAssetIds } from './instruments';
import { ensureSynthWorklet } from './wavetable/synthNode';
import { ancestors } from './routing';
import { zipStore } from './zip';

/** Renders `doc` offline from beat 0 to `endBeats` (+ tail) and returns the buffer. */
export async function renderDoc(doc: StudioDoc, assets: StudioAsset[], opts: { endBeats?: number; tailSec?: number; sampleRate?: number } = {}): Promise<AudioBuffer> {
  // Make sure every referenced asset is decoded before entering the offline context.
  const used = usedAssetIds(doc);
  await Promise.all(assets.filter((a) => used.has(a.id)).map((a) => loadAsset(a.id, a.url).catch(() => null)));

  const endBeats = opts.endBeats ?? arrangementEnd(doc, 1);
  const duration = beatToSec(tempoMap(doc), endBeats) + (opts.tailSec ?? 2);
  // Export renders straight through; looping is a playback convenience.
  const exportDoc: StudioDoc = { ...doc, meta: { ...doc.meta, loopEnabled: false } };

  const sampleRate = opts.sampleRate ?? 44100;
  const offlineCtx = new Tone.OfflineContext(2, duration, sampleRate);
  // Load worklets onto the offline context *before* swapping Tone's global context
  // so concurrent live edits never accidentally build nodes on the offline context.
  await ensureSynthWorklet(offlineCtx).catch(() => {});

  const prev = Tone.getContext();
  let engine: StudioEngine | null = null;
  Tone.setContext(offlineCtx);
  try {
    engine = new StudioEngine({ meters: false });
    engine.sync(exportDoc);
  } finally {
    Tone.setContext(prev);
  }

  try {
    await engine.ready();
    let bufferPromise: Promise<Tone.ToneAudioBuffer>;
    Tone.setContext(offlineCtx);
    try {
      offlineCtx.transport.start(0);
      bufferPromise = offlineCtx.render();
    } finally {
      Tone.setContext(prev);
    }
    const rendered = await bufferPromise;
    const buffer = rendered.get();
    if (!buffer) throw new Error('Render produced no audio');
    return buffer;
  } finally {
    Tone.setContext(offlineCtx);
    try { engine.dispose(); } finally { Tone.setContext(prev); }
  }
}

/** Renders the whole arrangement offline and returns a 16-bit WAV blob. */
export async function renderProjectToWav(doc: StudioDoc, assets: StudioAsset[], tailSec = 2): Promise<Blob> {
  return encodeWav(await renderDoc(doc, assets, { tailSec }));
}

const STEM_KINDS = new Set<StudioTrack['kind']>(['audio', 'instrument']);

/**
 * One WAV per audio/instrument track, each rendered solo-in-place (through its
 * groups, its sends' returns and the master chain), so the stems sum back to
 * the mix. Returns a zip.
 */
export async function renderStemsZip(doc: StudioDoc, assets: StudioAsset[], onProgress?: (done: number, total: number, name: string) => void): Promise<Blob> {
  const ids = Object.keys(doc.tracks)
    .filter((id) => STEM_KINDS.has(doc.tracks[id].kind)
      && !doc.tracks[id].mute
      && !ancestors(doc, id).some((a) => doc.tracks[a]?.mute))
    .sort((a, b) => doc.tracks[a].order - doc.tracks[b].order);
  const endBeats = arrangementEnd(doc, 1);
  const files: { name: string; data: Uint8Array }[] = [];
  const used = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const t = doc.tracks[id];
    onProgress?.(i, ids.length, t.name);
    const tracks = Object.fromEntries(Object.entries(doc.tracks).map(([k, v]) => [k, { ...v, solo: k === id }]));
    const buf = await renderDoc({ ...doc, tracks }, assets, { endBeats });
    let base = `${String(i + 1).padStart(2, '0')} ${t.name}`.replace(/[\\/:*?"<>|]+/g, '_').trim();
    while (used.has(base)) base += '_';
    used.add(base);
    files.push({ name: `${base}.wav`, data: new Uint8Array(await encodeWav(buf).arrayBuffer()) });
  }
  onProgress?.(ids.length, ids.length, '');
  return zipStore(files);
}

/**
 * A track rendered on its own through its own devices: pre-fader (unity
 * volume, centre pan), no sends, no groups, no master chain. Keeps any
 * sidechain key tracks muted at master so sidechain ducking is preserved.
 */
export async function renderTrackDry(doc: StudioDoc, trackId: string, assets: StudioAsset[]): Promise<{ buffer: AudioBuffer; endBeats: number }> {
  const t = doc.tracks[trackId];
  const automation = t.automation ? Object.fromEntries(Object.entries(t.automation).filter(([k]) => k !== 'vol' && k !== 'pan' && !k.startsWith('send:'))) : undefined;
  const track: StudioTrack = { ...t, volume: 0, pan: 0, mute: false, solo: false, output: '', sends: {}, automation };

  // Include any sidechain key tracks (muted at master; sidechain taps pre-fader `post`).
  const keyIds = new Set<string>();
  for (const fx of t.effects ?? []) {
    if (fx.type === 'compressor' && !fx.bypass && typeof fx.params?.sidechain === 'string' && fx.params.sidechain && fx.params.sidechain !== trackId && doc.tracks[fx.params.sidechain]) {
      keyIds.add(fx.params.sidechain);
    }
  }
  const tracks: Record<string, StudioTrack> = { [trackId]: track };
  for (const kid of keyIds) {
    const kt = doc.tracks[kid];
    tracks[kid] = { ...kt, mute: true, solo: false, output: '', sends: {} };
  }
  const clips = Object.fromEntries(Object.entries(doc.clips).filter(([, c]) => c.trackId === trackId || keyIds.has(c.trackId)));
  const activeTrackClips = Object.values(clips).filter((c) => c.trackId === trackId && !c.mute);
  const endBeats = Math.max(1, ...activeTrackClips.map((c) => c.start + c.length));
  const solo: StudioDoc = { ...doc, meta: { ...doc.meta, masterEffects: [], masterVolume: 0 }, tracks, clips };
  return { buffer: await renderDoc(solo, assets, { endBeats, tailSec: 3 }), endBeats };
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const bytesPerSample = 2;
  const dataSize = length * channels * bytesPerSample;
  const view = new DataView(new ArrayBuffer(44 + dataSize));

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}
