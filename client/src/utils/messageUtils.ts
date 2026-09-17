import { groupReactions as groupReactionsShared } from "@abyss/shared";
import type { Message, ReactionGroup } from "@abyss/shared";

export function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString();
}

// Message-shaped wrapper over the shared grouper, kept for the existing call sites.
export function groupReactions(message: Message): ReactionGroup[] {
  return groupReactionsShared(message.reactions ?? []);
}

// Lives in @abyss/shared so upload validation can reuse it; re-exported here for
// the existing call sites.
export { formatFileSize } from "@abyss/shared";
