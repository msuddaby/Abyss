import type { Message } from "@abyss/shared";

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

export function groupReactions(message: Message) {
  const groups: { emoji: string; userIds: string[]; count: number }[] = [];
  for (const r of message.reactions ?? []) {
    const existing = groups.find((g) => g.emoji === r.emoji);
    if (existing) {
      existing.userIds.push(r.userId);
      existing.count++;
    } else {
      groups.push({ emoji: r.emoji, userIds: [r.userId], count: 1 });
    }
  }
  return groups;
}

// Lives in @abyss/shared so upload validation can reuse it; re-exported here for
// the existing call sites.
export { formatFileSize } from "@abyss/shared";
