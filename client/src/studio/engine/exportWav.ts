import * as Tone from 'tone';
import { arrangementEnd, beatsToSeconds } from '@abyss/shared';
import type { StudioDoc, StudioAsset } from '@abyss/shared';
import { StudioEngine } from './StudioEngine';
import { loadAsset } from './assetCache';

/** Renders the whole arrangement offline and returns a 16-bit WAV blob. */
export async function renderProjectToWav(doc: StudioDoc, assets: StudioAsset[], tailSec = 2): Promise<Blob> {
  // Make sure every referenced asset is decoded before entering the offline context.
  const used = new Set(Object.values(doc.clips).map((c) => c.assetId).filter(Boolean) as string[]);
  await Promise.all(assets.filter((a) => used.has(a.id)).map((a) => loadAsset(a.id, a.url)));

  const endBeats = arrangementEnd(doc, 1);
  const duration = beatsToSeconds(endBeats, doc.meta.bpm) + tailSec;
  // Export renders straight through; looping is a playback convenience.
  const exportDoc: StudioDoc = { ...doc, meta: { ...doc.meta, loopEnabled: false } };

  const rendered = await Tone.Offline(async ({ transport }) => {
    const engine = new StudioEngine({ meters: false });
    engine.sync(exportDoc);
    await engine.ready();
    transport.start(0);
  }, duration, 2, 44100);

  const buffer = rendered.get();
  if (!buffer) throw new Error('Render produced no audio');
  return encodeWav(buffer);
}

function encodeWav(buffer: AudioBuffer): Blob {
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
