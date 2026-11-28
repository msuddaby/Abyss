import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Tone from 'tone';

// Audio input for recording (mic, line in, interface channels). The chosen
// device runs through a small Web Audio graph so we can pick a channel, meter
// it, monitor it through a track's effects, and record exactly what we meter.

export type InputChannels = 'stereo' | 'left' | 'right';

export interface InputPrefs {
  /** '' = system default */
  deviceId: string;
  channels: InputChannels;
  /** Hear the input through the armed track (headphones recommended) */
  monitor: boolean;
}

const PREFS_KEY = 'studio.audioInput';

function readPrefs(): InputPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<InputPrefs> | null;
    return {
      deviceId: typeof v?.deviceId === 'string' ? v.deviceId : '',
      channels: v?.channels === 'left' || v?.channels === 'right' ? v.channels : 'stereo',
      monitor: v?.monitor === true,
    };
  } catch { return { deviceId: '', channels: 'stereo', monitor: false }; }
}

let prefs = readPrefs();
const listeners = new Set<() => void>();

export function getInputPrefs(): InputPrefs { return prefs; }
export function setInputPrefs(patch: Partial<InputPrefs>) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}
export function useInputPrefs(): InputPrefs {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => prefs);
}

/** Audio input devices. Labels are blank until the user has granted access once. */
export function useInputDevices(refreshKey: unknown): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    const load = () => { md.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === 'audioinput'))).catch(() => {}); };
    load();
    md.addEventListener?.('devicechange', load);
    return () => md.removeEventListener?.('devicechange', load);
  }, [refreshKey]);
  return devices;
}

export class LiveInput {
  readonly stream: MediaStream;
  /** Processed input (chosen channels), for metering and monitoring */
  readonly output: GainNode;
  private readonly ctx: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly extra: AudioNode[] = [];
  private readonly buf: Float32Array<ArrayBuffer>;
  readonly label: string;
  readonly channelCount: number;
  private closed = false;

  private constructor(stream: MediaStream, channels: InputChannels) {
    this.stream = stream;
    this.ctx = Tone.getContext().rawContext as AudioContext;
    const track = stream.getAudioTracks()[0];
    this.label = track?.label ?? 'Input';
    const raw = track?.getSettings().channelCount ?? 2;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.output = this.ctx.createGain();
    const mono = channels !== 'stereo' || raw < 2;
    this.channelCount = mono ? 1 : 2;
    if (channels === 'stereo' || raw < 2) {
      this.source.connect(this.output);
    } else {
      // One channel of a multi-channel interface, as mono.
      const split = this.ctx.createChannelSplitter(Math.max(2, raw));
      this.source.connect(split);
      split.connect(this.output, channels === 'right' ? 1 : 0);
      this.extra.push(split);
    }
    if (mono) { this.output.channelCount = 1; this.output.channelCountMode = 'explicit'; }
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.output.connect(this.analyser);
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = this.channelCount;
    this.output.connect(this.dest);
  }

  static async open(p: InputPrefs): Promise<LiveInput> {
    // Opened from a click (arming / the menu): wake the audio context, or the
    // source delivers silence and the meter never moves.
    void Tone.start();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(p.deviceId ? { deviceId: { exact: p.deviceId } } : {}),
        channelCount: { ideal: 2 },
        // Raw signal — voice-chat processing ruins instruments.
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
    return new LiveInput(stream, p.channels);
  }

  /** What to record: the processed input, at the chosen channel count. */
  get recordStream(): MediaStream { return this.dest.stream; }

  /** Peak level in dBFS over the last ~20 ms. */
  level(): number {
    if (this.closed) return -Infinity;
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) { const a = Math.abs(this.buf[i]); if (a > peak) peak = a; }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.source.disconnect(); this.output.disconnect(); this.extra.forEach((n) => n.disconnect()); } catch { /* ignore */ }
    this.stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Keeps an input open while `want` is true (an audio track is armed, or the
 * input menu is showing its meter), reopening when the device or channels change.
 */
export function useLiveInput(want: boolean) {
  const p = useInputPrefs();
  const [live, setLive] = useState<LiveInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!want || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    let opened: LiveInput | null = null;
    LiveInput.open({ ...p, monitor: false })
      .then((li) => {
        if (cancelled) { li.close(); return; }
        opened = li;
        setLive(li);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const name = (e as { name?: string })?.name;
        setError(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for this site to record.'
          : name === 'OverconstrainedError' || name === 'NotFoundError' ? 'That input device is not available.'
            : 'Could not open the audio input.');
        if (name === 'OverconstrainedError' || name === 'NotFoundError') setInputPrefs({ deviceId: '' });
      });
    return () => {
      cancelled = true;
      opened?.close();
      setLive(null);
    };
  }, [want, p.deviceId, p.channels]); // eslint-disable-line react-hooks/exhaustive-deps
  return { live, error };
}
