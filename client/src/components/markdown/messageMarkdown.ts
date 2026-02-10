import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

export type MarkdownEnv = {
  membersById: Record<string, string>;
  emojisById: Record<string, { name: string; imageUrl: string }>;
  apiBase: string;
};

// Infer types from markdown-it's internal structure
interface Token {
  meta: Record<string, unknown>;
  attrIndex(name: string): number;
  attrPush(attr: [string, string]): void;
  attrs: Array<[string, string]> | null;
}

type StateInline = {
  pos: number;
  src: string;
  push(type: string, tag: string, nesting: number): Token;
};

type RenderRule = NonNullable<MarkdownIt["renderer"]["rules"][string]>;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

markdown.validateLink = (url: string) => {
  try {
    const parsed = new URL(url, "http://localhost");
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
};

markdown.inline.ruler.after(
  "backticks",
  "mentions",
  (state: StateInline, silent: boolean) => {
    const start = state.pos;
    const src = state.src;
    const ch = src.charAt(start);

    if (ch === "<") {
      const mentionMatch = src.slice(start).match(/^<@([a-zA-Z0-9-]+)>/);
      if (mentionMatch) {
        if (!silent) {
          const token = state.push("mention_user", "", 0);
          token.meta = { userId: mentionMatch[1] };
        }
        state.pos += mentionMatch[0].length;
        return true;
      }
      const emojiMatch = src
        .slice(start)
        .match(/^<:([a-zA-Z0-9_]{2,32}):([a-fA-F0-9-]{36})>/);
      if (emojiMatch) {
        if (!silent) {
          const token = state.push("custom_emoji", "", 0);
          token.meta = { name: emojiMatch[1], id: emojiMatch[2] };
        }
        state.pos += emojiMatch[0].length;
        return true;
      }
    }

    if (ch === "@") {
      const special = src.startsWith("@everyone", start)
        ? "@everyone"
        : src.startsWith("@here", start)
          ? "@here"
          : null;
      if (special) {
        const end = start + special.length;
        const next = src.charAt(end);
        if (!next || !/[A-Za-z0-9_]/.test(next)) {
          if (!silent) {
            const token = state.push("mention_special", "", 0);
            token.meta = { label: special };
          }
          state.pos = end;
          return true;
        }
      }
    }

    return false;
  },
);

markdown.renderer.rules.mention_user = ((
  tokens,
  idx,
  _options,
  env: MarkdownEnv,
) => {
  const userId = tokens[idx].meta.userId as string;
  const displayName = env.membersById[userId] ?? "Unknown";
  return `<span class="mention mention-user">@${markdown.utils.escapeHtml(displayName)}</span>`;
}) as RenderRule;

markdown.renderer.rules.mention_special = ((
  tokens,
  idx,
  _options,
  _env: MarkdownEnv,
) => {
  const label = tokens[idx].meta.label as string;
  const cls = label === "@everyone" ? "mention-everyone" : "mention-here";
  return `<span class="mention ${cls}">${label}</span>`;
}) as RenderRule;

markdown.renderer.rules.custom_emoji = ((
  tokens,
  idx,
  _options,
  env: MarkdownEnv,
) => {
  const { name, id } = tokens[idx].meta as { name: string; id: string };
  const emoji = env.emojisById[id];
  if (!emoji) {
    return markdown.utils.escapeHtml(`:${name}:`);
  }
  const src = `${env.apiBase}${emoji.imageUrl}`;
  const safeName = markdown.utils.escapeHtml(emoji.name);
  return `<img class="custom-emoji" src="${src}" alt=":${safeName}:" title=":${safeName}:" />`;
}) as RenderRule;

markdown.renderer.rules.link_open = ((
  tokens,
  idx,
  options,
  _env: MarkdownEnv,
  self,
) => {
  const token = tokens[idx];
  const targetIndex = token.attrIndex("target");
  if (targetIndex < 0) {
    token.attrPush(["target", "_blank"]);
  } else {
    token.attrs![targetIndex][1] = "_blank";
  }
  const relIndex = token.attrIndex("rel");
  if (relIndex < 0) {
    token.attrPush(["rel", "noopener noreferrer"]);
  } else {
    token.attrs![relIndex][1] = "noopener noreferrer";
  }
  return self.renderToken(tokens, idx, options);
}) as RenderRule;

export function renderMarkdownSafe(content: string, env: MarkdownEnv) {
  const raw = markdown.render(content, env);
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "del",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "blockquote",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "a",
      "span",
      "img",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "class", "src", "alt"],
    ADD_ATTR: ["target", "rel"],
    FORBID_TAGS: [
      "style",
      "script",
      "iframe",
      "object",
      "embed",
      "link",
      "meta",
    ],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick", "onmouseover"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|\/)/i,
  });
}
