import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getApiBase, groupReactions, useMessageStore, useServerStore } from '@abyss/shared';
import type { CustomEmoji, Reaction } from '@abyss/shared';
import { useReactionDetailsStore } from '../stores/reactionDetailsStore';
import { reactorAvatarUrl, reactorName, reactorUsername } from '../utils/reactionUtils';

/** Renders a reaction emoji — the native glyph, or the server's custom emoji image. */
function EmojiGlyph({ emoji, emojis }: { emoji: string; emojis: CustomEmoji[] }) {
  if (!emoji.startsWith('custom:')) return <span className="reaction-details-glyph">{emoji}</span>;
  const ce = emojis.find((e) => e.id === emoji.substring(7));
  if (!ce) return <span className="reaction-details-glyph">?</span>;
  return (
    <img
      className="reaction-details-glyph-img"
      src={`${getApiBase()}${ce.imageUrl}`}
      alt={`:${ce.name}:`}
    />
  );
}

export default function ReactionDetailsModal() {
  const target = useReactionDetailsStore((s) => s.target);
  if (!target) return null;
  // Keyed so the selected tab is seeded from the target on open, without an effect.
  return (
    <ReactionDetailsContent
      key={`${target.messageId}:${target.emoji ?? ''}`}
      messageId={target.messageId}
      initialEmoji={target.emoji}
    />
  );
}

function ReactionDetailsContent({
  messageId,
  initialEmoji,
}: {
  messageId: string;
  initialEmoji: string | null;
}) {
  const close = useReactionDetailsStore((s) => s.close);
  const messages = useMessageStore((s) => s.messages);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);

  const [activeEmoji, setActiveEmoji] = useState<string | null>(initialEmoji);

  const message = messages.find((m) => m.id === messageId);
  const groups = useMemo(
    () => groupReactions(message?.reactions ?? []),
    [message?.reactions],
  );

  // The message can scroll out of the loaded window, get deleted, or lose its last
  // reaction while the modal is open — there is nothing left to show in any of those.
  useEffect(() => {
    if (groups.length === 0) close();
  }, [groups.length, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  if (groups.length === 0) return null;

  // An emoji tab whose reactions were all removed falls back to All.
  const active = groups.find((g) => g.emoji === activeEmoji) ?? null;
  const shown: Reaction[] = active ? active.reactors : groups.flatMap((g) => g.reactors);
  const total = groups.reduce((sum, g) => sum + g.count, 0);

  return createPortal(
    <div className="modal-overlay" onClick={close}>
      <div className="modal reaction-details-modal" onClick={(e) => e.stopPropagation()}>
        <div className="reaction-details-header">
          <span className="reaction-details-title">Reactions</span>
          <button className="reaction-details-close" onClick={close}>&times;</button>
        </div>

        <div className="reaction-details-tabs">
          <button
            className={`reaction-details-tab${active === null ? ' active' : ''}`}
            onClick={() => setActiveEmoji(null)}
          >
            <span className="reaction-details-tab-label">All</span>
            <span className="reaction-details-tab-count">{total}</span>
          </button>
          {groups.map((g) => (
            <button
              key={g.emoji}
              className={`reaction-details-tab${active?.emoji === g.emoji ? ' active' : ''}`}
              onClick={() => setActiveEmoji(g.emoji)}
            >
              <EmojiGlyph emoji={g.emoji} emojis={emojis} />
              <span className="reaction-details-tab-count">{g.count}</span>
            </button>
          ))}
        </div>

        <div className="reaction-details-list">
          {shown.map((r) => {
            const avatar = reactorAvatarUrl(r, members);
            const name = reactorName(r, members);
            const username = reactorUsername(r, members);
            return (
              <div key={r.id} className="reaction-details-row">
                <div className="reaction-details-avatar">
                  {avatar ? (
                    <img src={avatar} alt="" />
                  ) : (
                    <span>{name.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <div className="reaction-details-identity">
                  <span className="reaction-details-name">{name}</span>
                  {username && <span className="reaction-details-username">@{username}</span>}
                </div>
                {/* On the All tab, say which emoji each person used. */}
                {active === null && <EmojiGlyph emoji={r.emoji} emojis={emojis} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
