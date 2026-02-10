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

export function formatFileSize(size: number) {
  if (!size && size !== 0) return "";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}
