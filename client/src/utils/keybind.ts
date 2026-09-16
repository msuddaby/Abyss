// Shared keybind capture/format/match logic used by both the voice
// shortcuts (mute/deafen/disconnect) and soundboard clip keybinds, so both
// follow identical rules for what can be bound and how it's displayed.

export function matchesKeybind(e: KeyboardEvent, bind: string): boolean {
  const parts = bind.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const mod = e.ctrlKey || e.metaKey;
  if (mods.has('mod') && !mod) return false;
  if (mods.has('shift') && !e.shiftKey) return false;
  if (mods.has('alt') && !e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function formatKeybind(bind: string): string {
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
  return bind
    .split('+')
    .map((p) => {
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      return p.toUpperCase();
    })
    .join('+');
}

/**
 * Turns a keydown event into a bind string ("mod+shift+m", "f9",
 * "launchapplication7", ...), or null if the event shouldn't be captured
 * (a bare modifier press, or a printable character pressed without any
 * modifier — reserved so typeable keys can't be bound without a modifier
 * and collide with normal typing elsewhere in the app).
 *
 * Non-printable/special keys (F-keys, arrows, media/macro keys like
 * "LaunchApplication7") always report a multi-character e.key, unlike any
 * character that could actually be typed — safe to allow bare, since they
 * never collide with normal typing.
 */
export function captureKeybindFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null;
  const isSpecialKey = e.key.length > 1;
  const hasMod = e.ctrlKey || e.metaKey;
  if (!isSpecialKey && !hasMod && !e.altKey && !e.shiftKey) return null;
  const parts: string[] = [];
  if (hasMod) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}
