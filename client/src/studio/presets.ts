import { useEffect, useState } from 'react';
import { api } from '@abyss/shared';
import type { StudioParams } from '@abyss/shared';

// Device presets: a few built-in ("factory") settings per device, plus a
// library everyone in the server shares (stored on the server per device type).

export type PresetKind = 'instrument' | 'effect';

export interface SavedPreset {
  id: string;
  name: string;
  createdById: string;
  createdAt: string;
  params: StudioParams;
}

export interface FactoryPreset { name: string; params: StudioParams }

export const FACTORY_PRESETS: Record<string, FactoryPreset[]> = {
  'effect:reverb': [
    { name: 'Small Room', params: { decay: 0.8, predelay: 5, lowcut: 200, highcut: 7000, mix: 20 } },
    { name: 'Vocal Plate', params: { decay: 2.2, predelay: 30, lowcut: 250, highcut: 9000, mix: 25 } },
    { name: 'Big Hall', params: { decay: 6, predelay: 40, lowcut: 150, highcut: 6000, mix: 35 } },
    { name: 'Return (100% wet)', params: { decay: 3, predelay: 20, lowcut: 200, highcut: 8000, mix: 100 } },
  ],
  'effect:delay': [
    { name: 'Slapback', params: { link: true, lSync: false, rSync: false, lMs: 110, rMs: 110, feedback: 10, mix: 25, filterOn: true, fFreq: 2500, fWidth: 4 } },
    { name: 'Dotted 8th', params: { link: true, lSync: true, rSync: true, lDiv: 3, rDiv: 3, feedback: 40, mix: 25 } },
    { name: 'Ping Pong 1/8', params: { mode: 'pingpong', link: true, lSync: true, lDiv: 2, feedback: 45, mix: 30 } },
    { name: 'Wide Stereo', params: { link: false, lSync: true, rSync: true, lDiv: 3, rDiv: 4, feedback: 30, mix: 30 } },
  ],
  'effect:compressor': [
    { name: 'Gentle Glue', params: { threshold: -14, ratio: 2, attack: 30, release: 200, knee: 10, makeup: 2, mix: 100 } },
    { name: 'Punchy Drums', params: { threshold: -20, ratio: 4, attack: 15, release: 80, knee: 4, makeup: 4, mix: 100 } },
    { name: 'Vocal Leveler', params: { threshold: -22, ratio: 3, attack: 5, release: 150, knee: 8, makeup: 5, mix: 100 } },
    { name: 'Sidechain Pump', params: { threshold: -30, ratio: 8, attack: 1, release: 180, knee: 2, makeup: 0, mix: 100 } },
    { name: 'Parallel Crush', params: { threshold: -35, ratio: 12, attack: 2, release: 60, knee: 0, makeup: 10, mix: 35 } },
  ],
  'effect:limiter': [
    { name: 'Safety', params: { gain: 0, ceiling: -0.3, release: 100 } },
    { name: 'Loud Master', params: { gain: 6, ceiling: -0.5, release: 60 } },
  ],
  'effect:tape': [
    { name: 'Subtle Warmth', params: { drive: 4, bump: 2, age: 10, wow: 5, flutter: 5, hiss: 0, crackle: 0, mix: 100 } },
    { name: 'Cassette', params: { drive: 9, bump: 3, age: 45, wow: 35, flutter: 30, hiss: 25, crackle: 0, mix: 100 } },
    { name: 'Old Vinyl', params: { drive: 6, bump: 4, age: 60, wow: 15, flutter: 10, hiss: 10, crackle: 45, mix: 100 } },
  ],
  'effect:distortion': [
    { name: 'Warm Saturation', params: { curve: 'soft', drive: 6, tone: 14000, output: -3, mix: 100 } },
    { name: 'Fuzz', params: { curve: 'hard', drive: 30, tone: 6000, output: -14, mix: 100 } },
    { name: 'Lo-Fi Crush', params: { curve: 'crush', drive: 6, bits: 6, tone: 8000, output: -6, mix: 100 } },
  ],
  'effect:chorus': [
    { name: 'Classic Chorus', params: { rate: 0.8, depth: 50, delay: 5, spread: 180, feedback: 5, mix: 50 } },
    { name: 'Wide Doubler', params: { rate: 0.3, depth: 25, delay: 12, spread: 180, feedback: 0, mix: 40 } },
  ],
  'effect:filter': [
    { name: 'Telephone', params: { mode: 'bandpass', slope: '-24', freq: 1500, res: 1.5, mix: 100 } },
    { name: 'Slow Sweep', params: { mode: 'lowpass', slope: '-24', freq: 900, res: 4, lfoAmt: 60, lfoRate: 0.15, mix: 100 } },
    { name: 'High-pass Clean-up', params: { mode: 'highpass', slope: '-24', freq: 120, res: 0.7, mix: 100 } },
  ],
  'instrument:fm': [
    { name: 'E-Piano', params: { oscillator: 'sine', modWave: 'sine', harmonicity: 3, modulationIndex: 6, attack: 0.005, decay: 1.2, sustain: 0.2, release: 0.8 } },
    { name: 'Bell', params: { oscillator: 'sine', modWave: 'sine', harmonicity: 3.5, modulationIndex: 18, attack: 0.001, decay: 2.5, sustain: 0, release: 2 } },
    { name: 'Metallic Lead', params: { oscillator: 'square', modWave: 'sawtooth', harmonicity: 1.5, modulationIndex: 12, attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.3 } },
  ],
  'instrument:am': [
    { name: 'Soft Pad', params: { oscillator: 'sine', modWave: 'triangle', harmonicity: 2, attack: 0.8, decay: 0.5, sustain: 0.8, release: 2.5, tone: 6000 } },
    { name: 'Organ', params: { oscillator: 'sine', modWave: 'square', harmonicity: 2, attack: 0.01, decay: 0.1, sustain: 1, release: 0.1 } },
  ],
  'instrument:mono': [
    { name: 'Acid', params: { oscillator: 'sawtooth', cutoff: 200, res: 8, envAmt: 5, fAttack: 0.001, fDecay: 0.18, fSustain: 0.1, glide: 0.05 } },
    { name: 'Smooth Lead', params: { oscillator: 'square', cutoff: 900, res: 1, envAmt: 2, attack: 0.03, release: 0.4, glide: 0.08 } },
  ],
  'instrument:pluck': [
    { name: 'Marimba-ish', params: { oscillator: 'sine', attack: 0.001, decay: 0.5, sustain: 0, release: 0.4, tone: 6000 } },
    { name: 'Bright Pluck', params: { oscillator: 'sawtooth', attack: 0.001, decay: 0.25, sustain: 0, release: 0.2, tone: 9000 } },
  ],
  'instrument:bass': [
    { name: 'Sub', params: { oscillator: 'sine', cutoff: 400, res: 0.5, envAmt: 0, sustain: 1 } },
    { name: 'Pluck Bass', params: { oscillator: 'sawtooth', cutoff: 150, res: 3, envAmt: 4, fDecay: 0.15, fSustain: 0.05, sustain: 0.4 } },
    { name: 'Square Bass', params: { oscillator: 'square', cutoff: 300, res: 1.5, envAmt: 2.5 } },
  ],
};

const cache = new Map<string, SavedPreset[]>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function presetKey(kind: PresetKind, type: string) { return `${kind}:${type}`; }

export async function loadPresets(channelId: string, kind: PresetKind, type: string): Promise<SavedPreset[]> {
  const res = await api.get<SavedPreset[]>(`/channels/${channelId}/studio/presets`, { params: { kind, type } });
  cache.set(presetKey(kind, type), res.data);
  notify();
  return res.data;
}

export async function savePreset(channelId: string, kind: PresetKind, type: string, name: string, params: StudioParams): Promise<SavedPreset> {
  const res = await api.post<SavedPreset>(`/channels/${channelId}/studio/presets`, { kind, type, name, params });
  const key = presetKey(kind, type);
  cache.set(key, [...(cache.get(key) ?? []), res.data].sort((a, b) => a.name.localeCompare(b.name)));
  notify();
  return res.data;
}

export async function deletePreset(channelId: string, kind: PresetKind, type: string, id: string) {
  await api.delete(`/channels/${channelId}/studio/presets/${id}`);
  const key = presetKey(kind, type);
  cache.set(key, (cache.get(key) ?? []).filter((p) => p.id !== id));
  notify();
}

/** Saved presets for a device type (fetched when first needed). */
export function useSavedPresets(channelId: string | null, kind: PresetKind, type: string, enabled: boolean): SavedPreset[] {
  const key = presetKey(kind, type);
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    if (enabled && channelId) loadPresets(channelId, kind, type).catch(() => {});
  }, [enabled, channelId, kind, type]);
  return cache.get(key) ?? [];
}
