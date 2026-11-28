import { useEffect, useRef, useState } from 'react';
import { useInputPrefs, setInputPrefs, useInputDevices, type LiveInput, type InputChannels } from './audioInput';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  live: LiveInput | null;
  error: string | null;
  /** Name of the armed audio track, if any */
  armedLabel: string | null;
  latencyMs: number;
  onLatency: (ms: number) => void;
}

const CHANNELS: { value: InputChannels; label: string; title: string }[] = [
  { value: 'stereo', label: 'Stereo', title: 'Record both channels (or a mono mic as-is)' },
  { value: 'left', label: 'In 1', title: 'Only the first input of an interface, as mono' },
  { value: 'right', label: 'In 2', title: 'Only the second input of an interface, as mono' },
];

/** Horizontal peak meter fed by the live input (with a short peak hold). */
function InputMeter({ live }: { live: LiveInput | null }) {
  const bar = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0, held = -Infinity, heldAt = 0;
    const tick = () => {
      const db = live?.level() ?? -Infinity;
      const pct = (d: number) => (Number.isFinite(d) ? Math.max(0, Math.min(100, ((d + 60) / 60) * 100)) : 0);
      const now = performance.now();
      if (db >= held || now - heldAt > 1200) { held = db; heldAt = now; }
      if (bar.current) { bar.current.style.width = `${pct(db)}%`; bar.current.classList.toggle('clip', db > -1); }
      if (hold.current) hold.current.style.left = `${pct(held)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live]);
  return (
    <div className="studio-input-meter" title="Input level (−60 to 0 dBFS). Red means clipping: turn the input gain down on your interface.">
      <div className="studio-input-meter-bar" ref={bar} />
      <div className="studio-input-meter-hold" ref={hold} />
    </div>
  );
}

/** Toolbar audio input button: device, channels, monitoring, level and latency. */
export default function StudioInputMenu({ open, onOpenChange, live, error, armedLabel, latencyMs, onLatency }: Props) {
  const prefs = useInputPrefs();
  const ref = useRef<HTMLDivElement>(null);
  // Re-list devices once access is granted (labels appear then).
  const devices = useInputDevices(live);
  const [latencyDraft, setLatencyDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onOpenChange(false); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, onOpenChange]);

  const unsupported = typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia;

  return (
    <div className="studio-midi" ref={ref}>
      <button className={`studio-btn${live ? ' midi-ready' : ''}`} onClick={() => onOpenChange(!open)} title="Audio input for recording: device, channels, monitoring">
        <span className={`studio-midi-light${live ? ' on' : ''}`} />
        🎙 Input
      </button>
      {open && (
        <div className="studio-midi-pop studio-input-pop">
          <div className="studio-midi-title">Audio input</div>
          {unsupported ? (
            <p className="studio-muted">This browser can't record audio.</p>
          ) : (
            <>
              <label className="studio-input-row">
                <span>Device</span>
                <select className="studio-select" value={prefs.deviceId} onChange={(e) => setInputPrefs({ deviceId: e.target.value })}>
                  <option value="">System default</option>
                  {devices.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Input ${i + 1}`}</option>
                  ))}
                </select>
              </label>
              <div className="studio-input-row">
                <span>Channels</span>
                <div className="studio-seg">
                  {CHANNELS.map((c) => (
                    <button key={c.value} className={`studio-seg-btn${prefs.channels === c.value ? ' on' : ''}`} title={c.title} onClick={() => setInputPrefs({ channels: c.value })}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <InputMeter live={live} />
              {error && <p className="studio-input-error">{error}</p>}
              {live && <p className="studio-muted studio-input-note">{live.label} · {live.channelCount === 1 ? 'mono' : 'stereo'}</p>}
              <label className="studio-check" title="Play the input through the armed track's effects as you record. Use headphones, or you'll get feedback.">
                <input type="checkbox" checked={prefs.monitor} onChange={(e) => setInputPrefs({ monitor: e.target.checked })} />
                Monitor through the armed track (headphones!)
              </label>
              <label className="studio-input-row" title="Shifts recorded takes earlier to make up for input latency">
                <span>Latency</span>
                <input
                  className="studio-input-latency" type="number" min={0} max={1000} step={5}
                  value={latencyDraft ?? latencyMs}
                  onChange={(e) => setLatencyDraft(e.target.value)}
                  onBlur={() => { if (latencyDraft != null) { const v = Number(latencyDraft); if (Number.isFinite(v)) onLatency(Math.max(0, Math.min(1000, v))); setLatencyDraft(null); } }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
                <span>ms</span>
              </label>
              <p className="studio-muted studio-input-note">
                {armedLabel ? <>Records onto <strong>{armedLabel}</strong>.</> : 'Arm an audio track (●) to record onto it.'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
