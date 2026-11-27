// Single source of truth for the Studio shortcut reference (help modal).
// Handlers live in StudioView (arrange) and PianoRoll (note editor).

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
export const ALT = IS_MAC ? '⌥' : 'Alt';

export interface Shortcut {
  keys: string[][]; // alternatives, each a key combo
  action: string;
}

export interface ShortcutGroup {
  title: string;
  note?: string;
  items: Shortcut[];
}

const k = (...combos: string[]) => combos.map((c) => c.split('+'));

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Transport',
    items: [
      { keys: k('Space'), action: 'Play / stop' },
      { keys: k('Enter'), action: 'Return to start' },
      { keys: k('F9'), action: 'Record: MIDI onto armed instrument tracks, audio onto an armed audio track' },
      { keys: k('Shift+F9'), action: 'Arm automation recording' },
      { keys: k('L'), action: 'Toggle loop' },
      { keys: k('C'), action: 'Toggle metronome' },
      { keys: k('←', '→'), action: 'Move playhead by grid (no clips selected)' },
      { keys: k('Shift+←', 'Shift+→'), action: 'Move playhead by bar' },
    ],
  },
  {
    title: 'Clips',
    note: 'Act on the selected clips. Click a clip to select it, Shift+click to add.',
    items: [
      { keys: k(`${MOD}+D`), action: 'Duplicate (placed after the selection)' },
      { keys: k(`${MOD}+C`), action: 'Copy' },
      { keys: k(`${MOD}+X`), action: 'Cut' },
      { keys: k(`${MOD}+V`), action: 'Paste at playhead' },
      { keys: k('Delete', 'Backspace'), action: 'Delete' },
      { keys: k('S', `${MOD}+E`), action: 'Split at playhead' },
      { keys: k(`${MOD}+A`), action: 'Select all clips (on the selected track, or everywhere)' },
      { keys: k('←', '→'), action: 'Nudge by grid' },
      { keys: k('Shift+←', 'Shift+→'), action: 'Nudge by bar' },
      { keys: k('E'), action: 'Open MIDI clip in piano roll' },
      { keys: k(`${ALT}+Drag`), action: 'Drag a copy' },
      { keys: k('Esc'), action: 'Deselect' },
    ],
  },
  {
    title: 'Tracks',
    note: 'Act on the selected track when no clips are selected. Click a track header to select it.',
    items: [
      { keys: k('↑', '↓'), action: 'Select previous / next track' },
      { keys: k(`${MOD}+D`), action: 'Duplicate track (with its clips and devices)' },
      { keys: k('Delete'), action: 'Delete track' },
      { keys: k('M'), action: 'Mute' },
      { keys: k('Shift+S'), action: 'Solo' },
      { keys: k('R'), action: 'Arm the selected track for recording (Ctrl/⌘-click ● to arm several)' },
      { keys: k(`${ALT}+A`), action: 'New audio track' },
      { keys: k(`${ALT}+I`), action: 'New instrument track' },
    ],
  },
  {
    title: 'Computer MIDI keyboard',
    note: 'Plays the armed instrument tracks, or the selected one when nothing is armed. Hardware MIDI keyboards work the same way (MIDI button in the toolbar).',
    items: [
      { keys: k('Ctrl+M'), action: 'Turn computer keyboard on / off (Esc also turns it off)' },
      { keys: k('A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'), action: 'White keys (C D E F G A B C D)' },
      { keys: k('W', 'E', 'T', 'Y', 'U', 'O', 'P'), action: 'Black keys' },
      { keys: k('Z', 'X'), action: 'Octave down / up' },
      { keys: k('C', 'V'), action: 'Velocity down / up' },
    ],
  },
  {
    title: 'Edit & view',
    items: [
      { keys: k(`${MOD}+Z`), action: 'Undo your last edit' },
      { keys: k(`${MOD}+Shift+Z`, `${MOD}+Y`), action: 'Redo' },
      { keys: k('=', '-'), action: 'Zoom in / out' },
      { keys: k('Shift+Tab'), action: 'Show / hide bottom panel' },
      { keys: k('?', 'F1'), action: 'Show this help' },
    ],
  },
  {
    title: 'Piano roll',
    note: 'When the piano roll has focus (click inside it).',
    items: [
      { keys: k('Click'), action: 'Draw a note (drag to set its length)' },
      { keys: k('Delete', 'Right-click'), action: 'Delete notes' },
      { keys: k(`${MOD}+A`), action: 'Select all notes' },
      { keys: k(`${MOD}+D`), action: 'Duplicate selected notes' },
      { keys: k(`${MOD}+C`, `${MOD}+V`), action: 'Copy / paste notes at playhead' },
      { keys: k('↑', '↓'), action: 'Transpose by semitone' },
      { keys: k('Shift+↑', 'Shift+↓'), action: 'Transpose by octave' },
      { keys: k('←', '→'), action: 'Move by grid (Shift: by bar)' },
      { keys: k('Shift+Wheel'), action: 'Change velocity' },
      { keys: k('Esc'), action: 'Deselect, then close' },
    ],
  },
];
