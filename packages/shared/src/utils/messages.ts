import type { Message, Reaction } from '../types/index.js';

const GROUP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Determine if a message should be grouped with the previous one
 * (same author, within 5 minutes, not deleted, not a reply).
 */
export function shouldGroupMessage(msg: Message, prev: Message | undefined): boolean {
  return (
    !!prev &&
    !msg.isSystem &&
    !prev.isSystem &&
    !prev.isDeleted &&
    !msg.replyTo &&
    prev.authorId === msg.authorId &&
    new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_THRESHOLD_MS
  );
}

export interface ReactionGroup {
  emoji: string;
  userIds: string[];
  /** The full reaction rows, in the order they arrived — used to name the reactors. */
  reactors: Reaction[];
  count: number;
}

/**
 * Group reactions by emoji, collecting user IDs.
 */
export function groupReactions(reactions: Reaction[]): ReactionGroup[] {
  const groups: ReactionGroup[] = [];
  for (const r of reactions ?? []) {
    const existing = groups.find((g) => g.emoji === r.emoji);
    if (existing) {
      existing.userIds.push(r.userId);
      existing.reactors.push(r);
      existing.count++;
    } else {
      groups.push({ emoji: r.emoji, userIds: [r.userId], reactors: [r], count: 1 });
    }
  }
  return groups;
}
