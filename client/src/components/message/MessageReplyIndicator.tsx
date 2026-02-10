import { getApiBase, useServerStore, getDisplayColor } from "@abyss/shared";
import type { ReplyReference } from "@abyss/shared";

export default function MessageReplyIndicator({
  replyTo,
  onScrollToMessage,
}: {
  replyTo: ReplyReference;
  onScrollToMessage?: (id: string) => void;
}) {
  const members = useServerStore((s) => s.members);

  return (
    <div
      className="reply-reference"
      onClick={() => !replyTo.isDeleted && onScrollToMessage?.(replyTo.id)}
    >
      <div className="reply-reference-line" />
      <div className="reply-reference-avatar">
        {replyTo.author.avatarUrl ? (
          <img
            src={
              replyTo.author.avatarUrl.startsWith("http")
                ? replyTo.author.avatarUrl
                : `${getApiBase()}${replyTo.author.avatarUrl}`
            }
            alt={replyTo.author.displayName}
          />
        ) : (
          <span>{replyTo.author.displayName.charAt(0).toUpperCase()}</span>
        )}
      </div>
      <span
        className="reply-reference-author"
        style={(() => {
          const m = members.find((m) => m.userId === replyTo.authorId);
          return m ? { color: getDisplayColor(m) } : undefined;
        })()}
      >
        {replyTo.author.displayName}
      </span>
      {replyTo.isDeleted ? (
        <span className="reply-reference-content reply-deleted">
          Original message was deleted
        </span>
      ) : (
        <span className="reply-reference-content">
          {replyTo.content.length > 100
            ? replyTo.content.slice(0, 100) + "..."
            : replyTo.content}
        </span>
      )}
    </div>
  );
}
