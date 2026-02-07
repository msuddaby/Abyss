import type { ServerMember, CustomEmoji } from '../types/index.js';

// Matches <@userId> mentions and <:name:id> custom emojis in a single pass
export const MENTION_EMOJI_REGEX = /<@([a-zA-Z0-9-]+)>|<:([a-zA-Z0-9_]{2,32}):([a-fA-F0-9-]{36})>/g;

export type MentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; userId: string }
  | { type: 'emoji'; name: string; id: string }
  | { type: 'everyone' }
  | { type: 'here' };

/**
 * Parse message content into segments of text, mentions, custom emojis, @everyone, and @here.
 * Platform-agnostic — returns data segments that the UI layer renders into React/RN elements.
 */
export function parseMentions(content: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;

  type RawSegment = { type: 'text'; value: string } | { type: 'mention'; userId: string } | { type: 'emoji'; name: string; id: string };
  const intermediate: RawSegment[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(MENTION_EMOJI_REGEX);

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      intermediate.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      intermediate.push({ type: 'mention', userId: match[1] });
    } else if (match[2] && match[3]) {
      intermediate.push({ type: 'emoji', name: match[2], id: match[3] });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) {
    intermediate.push({ type: 'text', value: content.slice(lastIndex) });
  }

  for (const seg of intermediate) {
    if (seg.type === 'mention' || seg.type === 'emoji') {
      segments.push(seg);
    } else {
      // Split text on @everyone and @here
      const textParts = seg.value.split(/(@everyone|@here)/g);
      for (const tp of textParts) {
        if (tp === '@everyone') {
          segments.push({ type: 'everyone' });
        } else if (tp === '@here') {
          segments.push({ type: 'here' });
        } else if (tp) {
          segments.push({ type: 'text', value: tp });
        }
      }
    }
  }

  return segments;
}

/**
 * Resolve a mention userId to a display name from the member list.
 */
export function resolveMentionName(userId: string, members: ServerMember[]): string {
  const member = members.find((m) => m.userId === userId);
  return member?.user.displayName ?? 'Unknown';
}

/**
 * Resolve a custom emoji id to its data from the emoji list.
 */
export function resolveCustomEmoji(emojiId: string, emojis: CustomEmoji[]): CustomEmoji | undefined {
  return emojis.find((e) => e.id === emojiId);
}
