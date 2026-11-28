import { useStudioStore, studioId, tempoMap, spanBeats } from '@abyss/shared';
import type { StudioOp } from '@abyss/shared';
import { renderTrackDry, encodeWav } from './engine/exportWav';
import { putBuffer } from './engine/assetCache';

/**
 * Freeze / bounce in place: renders a track through its own devices to a new
 * audio file, adds it as an audio track right below (same fader, pan, routing
 * and sends) and mutes the original, which stays editable — unmute it and
 * delete the bounce to go back.
 */
export async function bounceTrack(trackId: string): Promise<string> {
  const store = useStudioStore.getState();
  const doc = store.doc;
  const t = doc?.tracks[trackId];
  if (!doc || !t) throw new Error('Track not found');
  const { buffer } = await renderTrackDry(doc, trackId, store.assets);
  // Trim trailing silence (beyond a short tail) so the file stays small.
  const end = lastSound(buffer);
  const trimmed = end < buffer.length ? sliceBuffer(buffer, end) : buffer;
  const blob = encodeWav(trimmed);
  const name = `${t.name} (bounce)`.slice(0, 100);
  const asset = await store.uploadAsset(blob, `${name}.wav`, trimmed.duration);
  putBuffer(asset.id, trimmed);

  const latest = useStudioStore.getState().doc ?? doc;
  const src = latest.tracks[trackId] ?? t;
  const orders = Object.values(latest.tracks).map((x) => x.order).filter((o) => o > src.order).sort((a, b) => a - b);
  const order = orders.length ? (src.order + orders[0]) / 2 : src.order + 1;
  const id = studioId();
  const length = spanBeats(tempoMap(latest), 0, trimmed.duration);
  const ops: StudioOp[] = [
    {
      t: 'set', path: ['tracks', id], value: {
        name: name.slice(0, 40), kind: 'audio', order, color: src.color ?? '#5865f2',
        volume: src.volume, pan: src.pan, mute: false, solo: false,
        ...(src.output ? { output: src.output } : {}),
        ...(src.sends && Object.keys(src.sends).length ? { sends: src.sends } : {}),
      },
    },
    {
      t: 'set', path: ['clips', studioId()], value: {
        trackId: id, kind: 'audio', start: 0, length, assetId: asset.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0.01, name,
      },
    },
    { t: 'set', path: ['tracks', trackId, 'mute'], value: true },
  ];
  useStudioStore.getState().edit(ops);
  return id;
}

function lastSound(buf: AudioBuffer): number {
  const thresh = 1e-4;
  let last = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > thresh) { last = i; break; }
  }
  return Math.min(buf.length, last + Math.round(buf.sampleRate * 0.25));
}

function sliceBuffer(buf: AudioBuffer, length: number): AudioBuffer {
  const out = new AudioBuffer({ length: Math.max(1, length), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(0, length), c);
  return out;
}
