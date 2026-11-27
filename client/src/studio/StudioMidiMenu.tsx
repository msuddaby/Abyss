import { useEffect, useRef, useState } from 'react';
import { useMidiState, enableMidi, setMidiSelection } from './midiInput';

const QUANTIZE = [
  { value: 0, label: 'None' },
  { value: 1, label: '1/4' },
  { value: 0.5, label: '1/8' },
  { value: 0.25, label: '1/16' },
  { value: 0.125, label: '1/32' },
];

interface Props {
  targetLabel: string | null;
  recQuantize: number;
  onRecQuantize: (q: number) => void;
}

/** Toolbar MIDI button: device selection, activity light and record quantize. */
export default function StudioMidiMenu({ targetLabel, recQuantize, onRecQuantize }: Props) {
  const midi = useMidiState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const all = midi.selected === 'all';
  const isOn = (id: string) => all || (midi.selected as string[]).includes(id);
  const toggleDevice = (id: string) => {
    const current = all ? midi.devices.map((d) => d.id) : (midi.selected as string[]);
    setMidiSelection(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };

  const connected = midi.status === 'enabled' && midi.devices.length > 0;

  return (
    <div className="studio-midi" ref={ref}>
      <button
        className={`studio-btn${connected ? ' midi-ready' : ''}`}
        onClick={() => { setOpen((o) => !o); if (midi.status === 'idle') void enableMidi(); }}
        title="MIDI input devices and record quantize"
      >
        <span key={midi.activity} className={`studio-midi-light${midi.activity ? ' blink' : ''}`} />
        MIDI
      </button>
      {open && (
        <div className="studio-midi-pop">
          <div className="studio-midi-title">MIDI input</div>
          {midi.status === 'unsupported' && (
            <p className="studio-muted">This browser can't use MIDI devices. Use the desktop app, Chrome, Edge or Firefox.</p>
          )}
          {midi.status === 'idle' && <button className="studio-btn small" onClick={() => void enableMidi()}>Enable MIDI devices</button>}
          {midi.status === 'requesting' && <p className="studio-muted">Waiting for permission…</p>}
          {midi.status === 'denied' && (
            <p className="studio-muted">MIDI access was blocked. Allow MIDI devices for this site in your browser settings, then reload.</p>
          )}
          {midi.status === 'enabled' && (
            midi.devices.length === 0 ? (
              <p className="studio-muted">No MIDI devices connected. Plug one in — it shows up here automatically.</p>
            ) : (
              <div className="studio-midi-devices">
                <label className="studio-check">
                  <input type="checkbox" checked={all} onChange={() => setMidiSelection(all ? [] : 'all')} />
                  All inputs
                </label>
                {midi.devices.map((d) => (
                  <label key={d.id} className="studio-check">
                    <input type="checkbox" checked={isOn(d.id)} onChange={() => toggleDevice(d.id)} />
                    {d.name}{d.manufacturer ? <span className="studio-muted"> · {d.manufacturer}</span> : null}
                  </label>
                ))}
              </div>
            )
          )}
          <div className="studio-midi-row">
            <span>Plays</span>
            <strong>{targetLabel ?? 'nothing — select or arm an instrument track'}</strong>
          </div>
          <label className="studio-midi-row">
            <span>Record quantize</span>
            <select className="studio-select small" value={recQuantize} onChange={(e) => onRecQuantize(Number(e.target.value))}>
              {QUANTIZE.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          </label>
          <p className="studio-muted studio-midi-hint">
            Arm tracks with ● (Ctrl/⌘-click to arm several). With nothing armed, the selected instrument track plays.
            Sustain pedal, pitch bend and mod wheel are supported.
          </p>
        </div>
      )}
    </div>
  );
}
