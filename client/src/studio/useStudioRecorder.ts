import { useCallback, useRef, useState } from 'react';
import { useStudioStore, studioId, secondsToBeats } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { decodeBlob, putBuffer } from './engine/assetCache';

const LATENCY_KEY = 'studio.recordLatencyMs';

export function getRecordLatencyMs(): number {
  try {
    const v = Number(localStorage.getItem(LATENCY_KEY));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch { return 0; }
}

export function setRecordLatencyMs(ms: number) {
  try { localStorage.setItem(LATENCY_KEY, String(Math.max(0, Math.round(ms)))); } catch { /* ignore */ }
}

function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
}

function extFor(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

export type RecorderState = 'idle' | 'recording' | 'uploading';

/**
 * Records the microphone onto an armed audio track while the transport plays.
 * The take is uploaded as a project asset and dropped in as a clip at the
 * position recording started, shifted earlier by the latency setting.
 */
export function useStudioRecorder(engine: StudioEngine | null) {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; trackId: string; startBeats: number; chunks: Blob[] } | null>(null);

  const start = useCallback(async (trackId: string, fromBeats: number) => {
    if (!engine || recRef.current) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Raw signal — voice-chat processing ruins instruments.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recRef.current = { recorder, stream, trackId, startBeats: fromBeats, chunks };
      recorder.start(250);
      await engine.play(fromBeats);
      setState('recording');
    } catch (e) {
      console.error('[studio] record start failed', e);
      setError('Microphone unavailable. Check permissions.');
      recRef.current?.stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setState('idle');
    }
  }, [engine]);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    engine?.stop();

    const stopped = new Promise<void>((resolve) => { rec.recorder.onstop = () => resolve(); });
    rec.recorder.stop();
    await stopped;
    rec.stream.getTracks().forEach((t) => t.stop());

    const mime = rec.recorder.mimeType || 'audio/webm';
    const blob = new Blob(rec.chunks, { type: mime });
    if (blob.size === 0) { setState('idle'); return; }

    setState('uploading');
    try {
      const buffer = await decodeBlob(await blob.arrayBuffer());
      const store = useStudioStore.getState();
      const takeNo = Object.values(store.doc?.clips ?? {}).filter((c) => c.trackId === rec.trackId).length + 1;
      const asset = await store.uploadAsset(blob, `Take ${takeNo}.${extFor(mime)}`, buffer.duration);
      putBuffer(asset.id, buffer);

      const doc = useStudioStore.getState().doc;
      if (!doc?.tracks[rec.trackId]) return;
      const latency = getRecordLatencyMs() / 1000;
      const usable = Math.max(0.05, buffer.duration - latency);
      useStudioStore.getState().edit([{
        t: 'set',
        path: ['clips', studioId()],
        value: {
          trackId: rec.trackId,
          kind: 'audio',
          start: rec.startBeats,
          length: secondsToBeats(usable, doc.meta.bpm),
          assetId: asset.id,
          offset: Math.min(latency, buffer.duration - 0.05),
          gain: 0,
          fadeIn: 0.005,
          fadeOut: 0.01,
          name: asset.name,
        },
      }]);
    } catch (e) {
      console.error('[studio] saving take failed', e);
      setError('Could not save the recording.');
    } finally {
      setState('idle');
    }
  }, [engine]);

  return { state, error, start, stop, clearError: () => setError(null) };
}
