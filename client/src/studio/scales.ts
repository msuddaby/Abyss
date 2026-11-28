import type { StudioMeta } from '@abyss/shared';

// Project scale. Ids must match ScaleModes in StudioSessionService.cs.

export const SCALES: { id: string; label: string; steps: number[] }[] = [
  { id: 'major', label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'dorian', label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', label: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonicMinor', label: 'Harmonic Minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodicMinor', label: 'Melodic Minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'majorPentatonic', label: 'Major Pentatonic', steps: [0, 2, 4, 7, 9] },
  { id: 'minorPentatonic', label: 'Minor Pentatonic', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
];

export const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface ProjectScale {
  root: number;
  id: string;
  label: string;
  /** In-scale pitch classes */
  classes: Set<number>;
}

/** The project's scale, or null when none is set. */
export function projectScale(meta: StudioMeta): ProjectScale | null {
  const def = SCALES.find((s) => s.id === meta.scaleMode);
  if (!def) return null;
  const root = Number.isInteger(meta.scaleRoot) ? (meta.scaleRoot as number) : 0;
  return { root, id: def.id, label: `${PITCH_CLASSES[root]} ${def.label}`, classes: new Set(def.steps.map((s) => (s + root) % 12)) };
}

export function inScale(scale: ProjectScale, pitch: number): boolean {
  return scale.classes.has(((pitch % 12) + 12) % 12);
}

/** Closest in-scale pitch in 0..127 (ties resolve downward). */
export function nearestInScale(scale: ProjectScale, pitch: number): number {
  const clamped = Math.max(0, Math.min(127, Math.round(pitch)));
  for (let d = 0; d < 12; d++) {
    if (clamped - d >= 0 && inScale(scale, clamped - d)) return clamped - d;
    if (clamped + d <= 127 && inScale(scale, clamped + d)) return clamped + d;
  }
  return clamped;
}
