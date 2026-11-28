import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudioStore, studioId, tempoMap, spanBeats } from '@abyss/shared';
import type { StudioEngine } from './engine/StudioEngine';
import { decodeBlob, putBuffer } from './engine/assetCache';
import { muteRangeOps } from './studioUtils';

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
  const mountedRef = useRef(true);
  const recRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    ownsStream: boolean;
    channelId: string;
    trackId: string;
    startBeats: number;
    chunks: Blob[];
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const rec = recRef.current;
      if (!rec) return;
      recRef.current = null;
      rec.recorder.onstop = null;
      rec.recorder.ondataavailable = null;
      try { if (rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch { /* ignore */ }
      if (rec.ownsStream) rec.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /** `input`: an already-open live input (preferred); otherwise the default mic is opened. */
  const start = useCallback(async (trackId: string, fromBeats: number, input?: MediaStream): Promise<boolean> => {
    const channelId = useStudioStore.getState().channelId;
    if (!engine || !channelId || recRef.current) return false;
    setError(null);
    let ownedStream: MediaStream | null = null;
    try {
      const stream = input ?? await navigator.mediaDevices.getUserMedia({
        // Raw signal — voice-chat processing ruins instruments.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (!input) ownedStream = stream;
      if (!mountedRef.current || useStudioStore.getState().channelId !== channelId) {
        if (ownedStream) ownedStream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 256_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recRef.current = { recorder, stream, ownsStream: !input, channelId, trackId, startBeats: fromBeats, chunks };
      recorder.start(250);
      const started = await engine.play(fromBeats);
      if (!started || !mountedRef.current || recRef.current?.recorder !== recorder) {
        if (recRef.current?.recorder === recorder) recRef.current = null;
        recorder.onstop = null;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
        if (ownedStream) ownedStream.getTracks().forEach((t) => t.stop());
        if (mountedRef.current) setState('idle');
        return false;
      }
      setState('recording');
      return true;
    } catch (e) {
      console.error('[studio] record start failed', e);
      if (ownedStream) ownedStream.getTracks().forEach((t) => t.stop());
      if (recRef.current?.ownsStream) recRef.current.stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      if (mountedRef.current) {
        setError('Microphone unavailable. Check permissions.');
        setState('idle');
      }
      return false;
    }
  }, [engine]);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    engine?.stop();

    const stopped = new Promise<void>((resolve) => { rec.recorder.onstop = () => resolve(); });
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
    else rec.recorder.onstop?.(new Event('stop'));
    await stopped;
    if (rec.ownsStream) rec.stream.getTracks().forEach((t) => t.stop());

    if (!mountedRef.current || useStudioStore.getState().channelId !== rec.channelId) return;

    const mime = rec.recorder.mimeType || 'audio/webm';
    const blob = new Blob(rec.chunks, { type: mime });
    if (blob.size === 0) { setState('idle'); return; }

    setState('uploading');
    try {
      const buffer = await decodeBlob(await blob.arrayBuffer());
      const store = useStudioStore.getState();
      if (!mountedRef.current || store.channelId !== rec.channelId) return;
      const takeNo = Object.values(store.doc?.clips ?? {}).filter((c) => c.trackId === rec.trackId).length + 1;
      const asset = await store.uploadAsset(blob, `Take ${takeNo}.${extFor(mime)}`, buffer.duration);
      putBuffer(asset.id, buffer);

      const latest = useStudioStore.getState();
      if (!mountedRef.current || latest.channelId !== rec.channelId) return;
      const doc = latest.doc;
      if (!doc?.tracks[rec.trackId]) return;
      const latency = getRecordLatencyMs() / 1000;
      const usable = Math.max(0.05, buffer.duration - latency);
      const length = spanBeats(tempoMap(doc), rec.startBeats, usable);
      const offset = Math.max(0, Math.min(latency, Math.max(0, buffer.duration - 0.05)));
      // Earlier takes under the new one are muted, not deleted, so they can be comped (T on the track).
      latest.edit([...muteRangeOps(doc, rec.trackId, rec.startBeats, rec.startBeats + length), {
        t: 'set',
        path: ['clips', studioId()],
        value: {
          trackId: rec.trackId,
          kind: 'audio',
          start: rec.startBeats,
          length,
          assetId: asset.id,
          offset,
          gain: 0,
          fadeIn: 0.005,
          fadeOut: 0.01,
          name: asset.name,
        },
      }]);
    } catch (e) {
      console.error('[studio] saving take failed', e);
      if (mountedRef.current) setError('Could not save the recording.');
    } finally {
      if (mountedRef.current) setState('idle');
    }
  }, [engine]);

  return { state, error, start, stop, clearError: () => setError(null) };
}
