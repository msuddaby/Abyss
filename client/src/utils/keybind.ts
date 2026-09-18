// Shared keybind capture/format/match logic used by both the voice
// shortcuts (mute/deafen/disconnect) and soundboard clip keybinds, so both
// follow identical rules for what can be bound and how it's displayed.

/**
 * Numpad keys are identified by e.code, not e.key: with NumLock on e.key is a
 * bare "1" — indistinguishable from the top row — and with NumLock off it's
 * "End"/"ArrowDown"/etc. e.code stays "Numpad1" either way, so a numpad bind
 * survives the NumLock state it was recorded under.
 */
function numpadToken(e: KeyboardEvent): string | null {
  if (!e.code || !e.code.startsWith('Numpad')) return null;
  return e.code.toLowerCase();
}

export function matchesKeybind(e: KeyboardEvent, bind: string): boolean {
  const parts = bind.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const mod = e.ctrlKey || e.metaKey;
  if (mods.has('mod') && !mod) return false;
  if (mods.has('shift') && !e.shiftKey) return false;
  if (mods.has('alt') && !e.altKey) return false;
  if (key.startsWith('numpad')) return numpadToken(e) === key;
  return e.key.toLowerCase() === key;
}

const NUMPAD_LABELS: Record<string, string> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  decimal: '.',
  enter: 'Enter',
};

export function formatKeybind(bind: string): string {
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
  return bind
    .split('+')
    .map((p) => {
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      if (p.startsWith('numpad')) return `Num ${NUMPAD_LABELS[p.slice(6)] ?? p.slice(6).toUpperCase()}`;
      return p.toUpperCase();
    })
    .join('+');
}

/**
 * Keys the app itself relies on, so they can never be stolen by a bind:
 * Escape dismisses modals and cancels bind capture, Tab moves focus, Enter
 * activates the focused control.
 */
const RESERVED_KEYS = ['Escape', 'Tab', 'Enter'];

/**
 * Turns a keydown event into a bind string ("mod+shift+m", "f9",
 * "launchapplication7", ...), or null if the event shouldn't be captured
 * (a bare modifier press, a reserved key, or a printable character pressed
 * without any modifier — reserved so typeable keys can't be bound without a
 * modifier and collide with normal typing elsewhere in the app).
 *
 * Non-printable/special keys (F-keys, arrows, media/macro keys like
 * "LaunchApplication7") always report a multi-character e.key, unlike any
 * character that could actually be typed — safe to allow bare, since they
 * never collide with normal typing.
 */
export function captureKeybindFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null;

  // Numpad is resolved first: NumpadEnter must not be swallowed by the Enter
  // reservation (that's the main Enter's job), and a numpad digit is bindable
  // bare even though its e.key is a lone typeable "1".
  const numpad = numpadToken(e);
  if (!numpad && RESERVED_KEYS.includes(e.key)) return null;

  const isSpecialKey = numpad !== null || e.key.length > 1;
  const hasMod = e.ctrlKey || e.metaKey;
  if (!isSpecialKey && !hasMod && !e.altKey && !e.shiftKey) return null;
  const parts: string[] = [];
  if (hasMod) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(numpad ?? e.key.toLowerCase());
  return parts.join('+');
}
