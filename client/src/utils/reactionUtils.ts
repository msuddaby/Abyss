import { getApiBase } from "@abyss/shared";
import type { Reaction, ServerMember } from "@abyss/shared";

/**
 * Resolve a reactor's display name. The server denormalises the reactor's identity onto
 * the reaction (so this works in DMs and for users who left the server), but messages
 * cached before that shipped won't have it — fall back to the member store, then to a
 * placeholder.
 */
export function reactorName(r: Reaction, members: ServerMember[]): string {
  if (r.displayName) return r.displayName;
  if (r.username) return r.username;
  const member = members.find((m) => m.userId === r.userId);
  return member?.user.displayName || member?.user.username || "Unknown User";
}

/** Resolve a reactor's `@username`, or null when it isn't known. */
export function reactorUsername(r: Reaction, members: ServerMember[]): string | null {
  if (r.username) return r.username;
  return members.find((m) => m.userId === r.userId)?.user.username ?? null;
}

/** Resolve a reactor's avatar to an absolute URL, or null when they have none. */
export function reactorAvatarUrl(r: Reaction, members: ServerMember[]): string | null {
  const raw =
    r.avatarUrl ?? members.find((m) => m.userId === r.userId)?.user.avatarUrl ?? null;
  if (!raw) return null;
  return raw.startsWith("http") ? raw : `${getApiBase()}${raw}`;
}

/**
 * "Alice, Bob and Carol" for up to `max` names, "Alice, Bob, Carol and 4 others" beyond.
 */
export function formatReactorNames(names: string[], max = 3): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}
