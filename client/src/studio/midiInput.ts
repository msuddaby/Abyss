import { useSyncExternalStore } from 'react';

// Hardware MIDI via the Web MIDI API (Chromium, Electron, Firefox). Parses
// note on/off, sustain, mod wheel and pitch bend and hands them to whoever is
// listening (the studio's input router). Device choice persists locally.

export type MidiEvent =
  | { type: 'on'; pitch: number; vel: number }
  | { type: 'off'; pitch: number }
  | { type: 'sustain'; down: boolean }
  | { type: 'modwheel'; value: number }
  | { type: 'bend'; semis: number };

export type MidiStatus = 'unsupported' | 'idle' | 'requesting' | 'enabled' | 'denied';

export interface MidiDevice { id: string; name: string; manufacturer: string }

interface State {
  status: MidiStatus;
  devices: MidiDevice[];
  /** 'all' or specific input ids */
  selected: 'all' | string[];
  /** Bumps on every incoming note (activity light) */
  activity: number;
}

const SELECT_KEY = 'studio.midiInputs';
const BEND_RANGE = 2; // semitones

function loadSelected(): 'all' | string[] {
  try {
    const v = localStorage.getItem(SELECT_KEY);
    if (!v || v === 'all') return 'all';
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : 'all';
  } catch { return 'all'; }
}

let state: State = {
  status: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? 'idle' : 'unsupported',
  devices: [],
  selected: loadSelected(),
  activity: 0,
};
const subscribers = new Set<() => void>();
let access: MIDIAccess | null = null;
let handler: ((e: MidiEvent) => void) | null = null;

function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const s of subscribers) s();
}

export function useMidiState(): State {
  return useSyncExternalStore((cb) => { subscribers.add(cb); return () => subscribers.delete(cb); }, () => state);
}

/** The studio sets this to route events; null detaches. */
export function setMidiHandler(h: ((e: MidiEvent) => void) | null) {
  handler = h;
}

function isListening(id: string) {
  return state.selected === 'all' || state.selected.includes(id);
}

function onMessage(this: MIDIInput, ev: MIDIMessageEvent) {
  if (!isListening(this.id) || !ev.data || ev.data.length < 2) return;
  const [status, d1, d2 = 0] = ev.data;
  const cmd = status & 0xf0;
  let e: MidiEvent | null = null;
  if (cmd === 0x90 && d2 > 0) e = { type: 'on', pitch: d1, vel: d2 / 127 };
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) e = { type: 'off', pitch: d1 };
  else if (cmd === 0xb0 && d1 === 64) e = { type: 'sustain', down: d2 >= 64 };
  else if (cmd === 0xb0 && d1 === 1) e = { type: 'modwheel', value: d2 / 127 };
  else if (cmd === 0xb0 && (d1 === 123 || d1 === 120)) e = { type: 'sustain', down: false }; // all notes off
  else if (cmd === 0xe0) e = { type: 'bend', semis: (((d2 << 7) | d1) - 8192) / 8192 * BEND_RANGE };
  if (!e) return;
  if (e.type === 'on') setState({ activity: state.activity + 1 });
  handler?.(e);
}

function refreshDevices() {
  if (!access) return;
  const devices: MidiDevice[] = [];
  access.inputs.forEach((input) => {
    devices.push({ id: input.id, name: input.name ?? 'MIDI input', manufacturer: input.manufacturer ?? '' });
    input.onmidimessage = onMessage;
  });
  setState({ devices });
}

/** Ask for MIDI access (prompts in browsers). Safe to call repeatedly. */
export async function enableMidi(): Promise<void> {
  if (state.status === 'unsupported' || state.status === 'enabled' || state.status === 'requesting') return;
  setState({ status: 'requesting' });
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    access.onstatechange = () => refreshDevices();
    refreshDevices();
    setState({ status: 'enabled' });
  } catch (e) {
    console.warn('[studio] MIDI access denied', e);
    setState({ status: 'denied' });
  }
}

/** Re-enable silently on load if the user already granted access before. */
export async function restoreMidi(): Promise<void> {
  if (state.status !== 'idle') return;
  try {
    const perm = await navigator.permissions?.query({ name: 'midi' as PermissionName });
    if (perm?.state === 'granted') await enableMidi();
  } catch {
    // Electron / browsers without the 'midi' permission name: enabling needs a click.
  }
}

export function setMidiSelection(sel: 'all' | string[]) {
  setState({ selected: sel });
  try { localStorage.setItem(SELECT_KEY, sel === 'all' ? 'all' : JSON.stringify(sel)); } catch { /* ignore */ }
}
