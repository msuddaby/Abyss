import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
} from "react";
import {
  getApiBase,
  useAuthStore,
  useServerStore,
  useMessageStore,
  useAppConfigStore,
  useToastStore,
  hasPermission,
  hasChannelPermission,
  Permission,
  getDisplayColor,
  canActOn,
  useDmStore,
} from "@abyss/shared";
import type { Message, Attachment } from "@abyss/shared";
import UserProfileCard from "./UserProfileCard";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

type MarkdownEnv = {
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

function renderMarkdownSafe(content: string, env: MarkdownEnv) {
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

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString();
}

function groupReactions(message: Message) {
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

function formatFileSize(size: number) {
  if (!size && size !== 0) return "";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function AttachmentMedia({ att }: { att: Attachment }) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoShellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const src = active ? `${getApiBase()}${att.filePath}` : undefined;
  const poster = att.posterPath ? `${getApiBase()}${att.posterPath}` : undefined;
  const sizeLabel = formatFileSize(att.size);
  const isVideo = att.contentType.startsWith("video/");
  const isAudio = att.contentType.startsWith("audio/");

  const formatPlaybackTime = (timeSeconds: number) => {
    if (!Number.isFinite(timeSeconds)) return "0:00";
    const total = Math.max(0, Math.floor(timeSeconds));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!isVideo || !videoRef.current) return;
    const video = videoRef.current;

    const handleLoaded = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setCurrentTime(video.currentTime || 0);
    };
    const handleTime = () => setCurrentTime(video.currentTime || 0);
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    const handleVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("timeupdate", handleTime);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("volumechange", handleVolume);

    return () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("timeupdate", handleTime);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("volumechange", handleVolume);
    };
  }, [isVideo]);

  useEffect(() => {
    if (!isAudio || !audioRef.current) return;
    const audio = audioRef.current;

    const handleLoaded = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setCurrentTime(audio.currentTime || 0);
    };
    const handleTime = () => setCurrentTime(audio.currentTime || 0);
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    const handleVolume = () => {
      setVolume(audio.volume);
      setMuted(audio.muted);
    };

    audio.addEventListener("loadedmetadata", handleLoaded);
    audio.addEventListener("timeupdate", handleTime);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("volumechange", handleVolume);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoaded);
      audio.removeEventListener("timeupdate", handleTime);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("volumechange", handleVolume);
    };
  }, [isAudio]);

  useEffect(() => {
    if (!isVideo) return;
    const handleFullscreen = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => document.removeEventListener("fullscreenchange", handleFullscreen);
  }, [isVideo]);

  const togglePlay = () => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
      return;
    }
    if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    }
  };

  const handleSeek = (value: number) => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = value;
    } else if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = value;
    }
    setCurrentTime(value);
  };

  const handleVolumeChange = (value: number) => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      video.volume = value;
      video.muted = value === 0;
      setVolume(value);
      setMuted(video.muted);
    } else if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.volume = value;
      audio.muted = value === 0;
      setVolume(value);
      setMuted(audio.muted);
    }
  };

  const toggleMute = () => {
    if (isVideo) {
      const video = videoRef.current;
      if (!video) return;
      video.muted = !video.muted;
      setMuted(video.muted);
      if (!video.muted && video.volume === 0) {
        video.volume = 0.5;
        setVolume(0.5);
      }
      return;
    }
    if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.muted = !audio.muted;
      setMuted(audio.muted);
      if (!audio.muted && audio.volume === 0) {
        audio.volume = 0.5;
        setVolume(0.5);
      }
    }
  };

  const toggleFullscreen = () => {
    const container = videoShellRef.current ?? containerRef.current;
    const video = videoRef.current;
    if (!document.fullscreenElement) {
      if (container?.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
        return;
      }
      if (video && (video as HTMLVideoElement).webkitEnterFullscreen) {
        (video as HTMLVideoElement).webkitEnterFullscreen();
      }
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  if (isVideo) {
    return (
      <div className="attachment-media" ref={containerRef}>
        <div className="attachment-video-shell" ref={videoShellRef}>
          <video
          className="attachment-video"
          ref={videoRef}
          preload="metadata"
          playsInline
          poster={poster}
          src={src}
          onClick={togglePlay}
          />
          {!playing && (
            <button className="attachment-play-overlay" onClick={togglePlay}>
              Play
            </button>
          )}
          {playing && (
            <>
              <div className="attachment-video-topbar">
                <button className="attachment-control-btn" onClick={toggleFullscreen}>
                  {isFullscreen ? "Exit" : "Full"}
                </button>
                <a
                  className="attachment-download"
                  href={`${getApiBase()}${att.filePath}`}
                  download={att.fileName}
                >
                  Download
                </a>
              </div>
              <div className="attachment-video-bottombar">
                <button className="attachment-control-btn" onClick={togglePlay}>
                  Pause
                </button>
                <span className="attachment-time">
                  {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
                </span>
                <input
                  className="attachment-seek"
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={Math.min(currentTime, duration || 0)}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                />
                <button className="attachment-control-btn" onClick={toggleMute}>
                  {muted || volume === 0 ? "Muted" : "Mute"}
                </button>
                <input
                  className="attachment-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                />
              </div>
            </>
          )}
        </div>
        <div className="attachment-meta">
          <div className="attachment-meta-left">
            <span className="attachment-name">{att.fileName}</span>
            {sizeLabel && <span className="attachment-size">{sizeLabel}</span>}
          </div>
        </div>
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className="attachment-media" ref={containerRef}>
        <div className="attachment-audio-shell">
          <audio
            className="attachment-audio"
            ref={audioRef}
            preload="metadata"
            src={src}
            onClick={togglePlay}
          />
          <div className="attachment-audio-controls">
            <button className="attachment-control-btn" onClick={togglePlay}>
              {playing ? "Pause" : "Play"}
            </button>
            <span className="attachment-time">
              {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
            </span>
            <input
              className="attachment-seek"
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onChange={(e) => handleSeek(Number(e.target.value))}
            />
            <button className="attachment-control-btn" onClick={toggleMute}>
              {muted || volume === 0 ? "Muted" : "Mute"}
            </button>
            <input
              className="attachment-volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
            />
            <a
              className="attachment-download"
              href={`${getApiBase()}${att.filePath}`}
              download={att.fileName}
            >
              Download
            </a>
          </div>
        </div>
        <div className="attachment-meta">
          <span className="attachment-name">{att.fileName}</span>
          {sizeLabel && <span className="attachment-size">{sizeLabel}</span>}
        </div>
      </div>
    );
  }

  return (
    <a
      className="attachment-file"
      href={`${getApiBase()}${att.filePath}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {att.fileName}
      {sizeLabel && <span className="attachment-size"> · {sizeLabel}</span>}
    </a>
  );
}

export default function MessageItem({
  message,
  grouped,
  contextMenuOpen,
  setContextMenuMessageId,
  onScrollToMessage,
}: {
  message: Message;
  grouped?: boolean;
  contextMenuOpen: boolean;
  setContextMenuMessageId: (id: string | null) => void;
  onScrollToMessage?: (id: string) => void;
}) {
  const [profileCard, setProfileCard] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [editError, setEditError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [pickerStyle, setPickerStyle] = useState<React.CSSProperties | null>(
    null,
  );
  const [contextMenuPos, setContextMenuPos] = useState<{
    x: number;
    y: number;
  }>({ x: 0, y: 0 });
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(
    null,
  );
  const editInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const activeServer = useServerStore((s) => s.activeServer);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const maxMessageLength = useAppConfigStore((s) => s.maxMessageLength);
  const addToast = useToastStore((s) => s.addToast);
  const { kickMember, banMember } = useServerStore();
  const {
    editMessage,
    deleteMessage,
    toggleReaction,
    setReplyingTo,
    pinMessage,
    unpinMessage,
    isPinned,
  } = useMessageStore();
  const isDmMode = useDmStore((s) => s.isDmMode);

  const isOwn = currentUser?.id === message.authorId;
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canManageMessages = currentMember
    ? hasPermission(currentMember, Permission.ManageMessages)
    : false;
  const canDelete = isOwn || canManageMessages;
  const canPin = isDmMode || canManageMessages;
  const canAddReactions = isDmMode
    ? true
    : hasChannelPermission(activeChannel?.permissions, Permission.AddReactions);
  const authorMember = members.find((m) => m.userId === message.authorId);
  const authorColor = authorMember ? getDisplayColor(authorMember) : undefined;
  const membersById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of members) {
      map[m.userId] = m.user.displayName;
    }
    return map;
  }, [members]);
  const emojisById = useMemo(() => {
    const map: Record<string, { name: string; imageUrl: string }> = {};
    for (const e of emojis) {
      map[e.id] = { name: e.name, imageUrl: e.imageUrl };
    }
    return map;
  }, [emojis]);
  const markdownEnv = useMemo(
    () => ({
      membersById,
      emojisById,
      apiBase: getApiBase(),
    }),
    [membersById, emojisById],
  );
  const renderedContent = useMemo(
    () =>
      message.content ? renderMarkdownSafe(message.content, markdownEnv) : "",
    [message.content, markdownEnv],
  );

  // Use live member data when available, fall back to stale message snapshot
  const authorDisplayName =
    authorMember?.user.displayName ?? message.author.displayName;
  const authorAvatarUrl =
    authorMember?.user.avatarUrl ?? message.author.avatarUrl;

  const canKickPerm = currentMember
    ? hasPermission(currentMember, Permission.KickMembers)
    : false;
  const canBanPerm = currentMember
    ? hasPermission(currentMember, Permission.BanMembers)
    : false;

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (!showPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPicker]);

  const updatePickerPosition = useCallback(() => {
    if (!showPicker || !pickerRef.current || !pickerAnchor) return;
    const rect = pickerRef.current.getBoundingClientRect();
    const margin = 8;
    let left = pickerAnchor.x;
    let top = pickerAnchor.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    if (left < margin) left = margin;
    const aboveTop = pickerAnchor.y - rect.height - margin;
    const belowTop = pickerAnchor.y + margin;
    if (aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + rect.height <= window.innerHeight - margin) {
      top = belowTop;
    } else {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPickerStyle((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [showPicker, pickerAnchor]);

  useLayoutEffect(() => {
    updatePickerPosition();
  }, [updatePickerPosition]);

  useEffect(() => {
    if (!showPicker || !pickerRef.current) return;
    const ro = new ResizeObserver(() => updatePickerPosition());
    ro.observe(pickerRef.current);
    window.addEventListener("resize", updatePickerPosition);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updatePickerPosition);
    };
  }, [showPicker, updatePickerPosition]);

  useEffect(() => {
    if (!contextMenuOpen) return;
    const handleClick = () => setContextMenuMessageId(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [contextMenuOpen, setContextMenuMessageId]);

  useLayoutEffect(() => {
    if (!contextMenuOpen || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const margin = 8;
    let left = contextMenuPos.x;
    let top = contextMenuPos.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - rect.height - margin;
    }
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    if (left !== contextMenuPos.x || top !== contextMenuPos.y) {
      setContextMenuPos({ x: left, y: top });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenuOpen]);

  useEffect(() => {
    if (!previewAttachment) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreviewAttachment(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [previewAttachment]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenuMessageId(message.id);
  };

  // Admin action conditions for context menu
  const showAdminActions = !isOwn && authorMember && currentMember;
  const canKickAuthor =
    canKickPerm && showAdminActions && canActOn(currentMember!, authorMember!);
  const canBanAuthor =
    canBanPerm && showAdminActions && canActOn(currentMember!, authorMember!);

  const handleKick = async () => {
    if (!activeServer) return;
    await kickMember(activeServer.id, message.authorId);
    setContextMenuMessageId(null);
  };

  const handleBan = async () => {
    if (!activeServer) return;
    await banMember(activeServer.id, message.authorId);
    setContextMenuMessageId(null);
  };

  const handleAuthorClick = (e: React.MouseEvent) => {
    setProfileCard({ x: e.clientX, y: e.clientY });
  };

  const handleImagePreview = (att: Attachment) => {
    setPreviewAttachment(att);
  };

  const handleClosePreview = () => {
    setPreviewAttachment(null);
  };

  const handleEditSave = async () => {
    const trimmed = editContent.trim();
    if (trimmed.length > maxMessageLength) {
      setEditError(`Message must be 1-${maxMessageLength} characters.`);
      addToast(`Message must be 1-${maxMessageLength} characters.`, "error");
      return;
    }
    try {
      if (trimmed && trimmed !== message.content) {
        await editMessage(message.id, trimmed);
      }
      setEditing(false);
      setEditError(null);
    } catch {
      addToast("Failed to edit message.", "error");
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleEditSave();
    } else if (e.key === "Escape") {
      setEditContent(message.content);
      setEditError(null);
      setEditing(false);
    }
  };

  const handleDelete = () => {
    deleteMessage(message.id);
  };

  const handlePinToggle = () => {
    if (isPinned(message.channelId, message.id)) {
      unpinMessage(message.id);
    } else {
      pinMessage(message.id);
    }
  };

  const openPicker = (e?: React.MouseEvent<HTMLElement>) => {
    if (!canAddReactions) return;
    const target = e?.currentTarget as HTMLElement | null;
    const rect =
      target?.getBoundingClientRect() ??
      messageRef.current?.getBoundingClientRect();
    if (rect) {
      setPickerAnchor({ x: rect.right, y: rect.top });
    } else {
      setPickerAnchor({ x: 0, y: 0 });
    }
    setShowPicker(true);
  };

  const customEmojiCategory =
    emojis.length > 0
      ? [
          {
            id: "custom",
            name: "Server Emojis",
            emojis: emojis.map((e) => ({
              id: `custom-${e.id}`,
              name: e.name,
              keywords: [e.name],
              skins: [{ src: `${getApiBase()}${e.imageUrl}` }],
            })),
          },
        ]
      : [];

  const handleEmojiSelect = (emoji: { native?: string; id?: string }) => {
    if (!canAddReactions) return;
    if (emoji.native) {
      toggleReaction(message.id, emoji.native);
    } else if (emoji.id?.startsWith("custom-")) {
      const emojiId = emoji.id.substring(7);
      toggleReaction(message.id, `custom:${emojiId}`);
    }
    setShowPicker(false);
  };

  const handleReactionClick = (emoji: string) => {
    if (!canAddReactions) return;
    toggleReaction(message.id, emoji);
  };

  if (message.isSystem) {
    return (
      <div className="message-item system-message">
        <div className="system-message-content">
          <span className="system-message-icon">●</span>
          <span className="system-message-text">
            <strong>{authorDisplayName}</strong> {message.content}
          </span>
          <span className="system-message-time">
            {formatDate(message.createdAt)} at {formatTime(message.createdAt)}
          </span>
        </div>
      </div>
    );
  }

  if (message.isDeleted) {
    return (
      <div className="message-item message-deleted">
        <div className="message-avatar" onClick={handleAuthorClick}>
          {authorAvatarUrl ? (
            <img
              src={
                authorAvatarUrl.startsWith("http")
                  ? authorAvatarUrl
                  : `${getApiBase()}${authorAvatarUrl}`
              }
              alt={authorDisplayName}
            />
          ) : (
            <span>{authorDisplayName.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="message-body">
          <div className="message-header">
            <span
              className="message-author clickable"
              onClick={handleAuthorClick}
              style={authorColor ? { color: authorColor } : undefined}
            >
              {authorDisplayName}
            </span>
            <span className="message-time">
              {formatDate(message.createdAt)} at {formatTime(message.createdAt)}
            </span>
          </div>
          <div className="message-content message-deleted-text">
            This message has been deleted
          </div>
        </div>
        {profileCard && (
          <UserProfileCard
            userId={message.authorId}
            position={profileCard}
            onClose={() => setProfileCard(null)}
          />
        )}
      </div>
    );
  }

  const reactionGroups = groupReactions(message);

  const isMentioned =
    currentUser &&
    (message.content.includes(`<@${currentUser.id}>`) ||
      message.content.includes("@everyone") ||
      message.content.includes("@here"));

  return (
    <div
      ref={messageRef}
      className={`message-item${grouped ? " message-grouped" : ""}${isMentioned ? " message-mentioned" : ""}${message.replyTo ? " message-has-reply" : ""}`}
      onContextMenu={handleContextMenu}
    >
      {message.replyTo && (
        <div
          className="reply-reference"
          onClick={() =>
            !message.replyTo!.isDeleted &&
            onScrollToMessage?.(message.replyTo!.id)
          }
        >
          <div className="reply-reference-line" />
          <div className="reply-reference-avatar">
            {message.replyTo.author.avatarUrl ? (
              <img
                src={
                  message.replyTo.author.avatarUrl.startsWith("http")
                    ? message.replyTo.author.avatarUrl
                    : `${getApiBase()}${message.replyTo.author.avatarUrl}`
                }
                alt={message.replyTo.author.displayName}
              />
            ) : (
              <span>
                {message.replyTo.author.displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <span
            className="reply-reference-author"
            style={(() => {
              const m = members.find(
                (m) => m.userId === message.replyTo!.authorId,
              );
              return m ? { color: getDisplayColor(m) } : undefined;
            })()}
          >
            {message.replyTo.author.displayName}
          </span>
          {message.replyTo.isDeleted ? (
            <span className="reply-reference-content reply-deleted">
              Original message was deleted
            </span>
          ) : (
            <span className="reply-reference-content">
              {message.replyTo.content.length > 100
                ? message.replyTo.content.slice(0, 100) + "..."
                : message.replyTo.content}
            </span>
          )}
        </div>
      )}
      {grouped ? (
        <div className="message-avatar-gutter">
          <span className="message-time-inline">
            {formatTime(message.createdAt)}
          </span>
        </div>
      ) : (
        <div className="message-avatar clickable" onClick={handleAuthorClick}>
          {message.author.avatarUrl ? (
            <img
              src={
                message.author.avatarUrl.startsWith("http")
                  ? message.author.avatarUrl
                  : `${getApiBase()}${message.author.avatarUrl}`
              }
              alt={message.author.displayName}
            />
          ) : (
            <span>{message.author.displayName.charAt(0).toUpperCase()}</span>
          )}
        </div>
      )}
      <div className="message-body">
        {!grouped && (
          <div className="message-header">
            <span
              className="message-author clickable"
              onClick={handleAuthorClick}
              style={authorColor ? { color: authorColor } : undefined}
            >
              {message.author.displayName}
            </span>
            <span className="message-time">
              {formatDate(message.createdAt)} at {formatTime(message.createdAt)}
            </span>
            {message.editedAt && (
              <span className="message-edited-label">(edited)</span>
            )}
          </div>
        )}
        {grouped && message.editedAt && (
          <span className="message-edited-label">(edited)</span>
        )}
        {editing ? (
          <div className="message-edit-wrapper">
            <input
              ref={editInputRef}
              className="message-edit-input"
              value={editContent}
              onChange={(e) => {
                setEditContent(e.target.value);
                if (
                  editError &&
                  e.target.value.trim().length <= maxMessageLength
                ) {
                  setEditError(null);
                }
              }}
              onKeyDown={handleEditKeyDown}
              onBlur={handleEditSave}
            />
            {editError && <div className="message-edit-error">{editError}</div>}
          </div>
        ) : (
          <>
            {message.content && (
              <div
                className="message-content message-markdown"
                dangerouslySetInnerHTML={{ __html: renderedContent }}
              />
            )}
          </>
        )}
        {message.attachments?.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="attachment">
                {att.contentType.startsWith("image/") ? (
                  <img
                    src={`${getApiBase()}${att.filePath}`}
                    alt={att.fileName}
                    className="attachment-image"
                    onClick={() => handleImagePreview(att)}
                  />
                ) : (
                  <AttachmentMedia att={att} />
                )}
              </div>
            ))}
          </div>
        )}
        {reactionGroups.length > 0 && (
          <div className="message-reactions">
            {reactionGroups.map((g) => (
              <button
                key={g.emoji}
                className={`reaction-button${currentUser && g.userIds.includes(currentUser.id) ? " reacted" : ""}`}
                onClick={() => handleReactionClick(g.emoji)}
                disabled={!canAddReactions}
                title={
                  !canAddReactions
                    ? "No permission to add reactions"
                    : undefined
                }
              >
                <span className="reaction-emoji">
                  {g.emoji.startsWith("custom:")
                    ? (() => {
                        const eid = g.emoji.substring(7);
                        const ce = emojis.find((e) => e.id === eid);
                        return ce ? (
                          <img
                            src={`${getApiBase()}${ce.imageUrl}`}
                            alt={`:${ce.name}:`}
                            className="custom-emoji-reaction"
                          />
                        ) : (
                          "?"
                        );
                      })()
                    : g.emoji}
                </span>
                <span className="reaction-count">{g.count}</span>
              </button>
            ))}
            {canAddReactions && (
              <button
                className="reaction-button reaction-add"
                onClick={(e) => openPicker(e)}
              >
                +
              </button>
            )}
          </div>
        )}
      </div>
      <div className="message-actions">
        <button onClick={() => setReplyingTo(message)} title="Reply">
          &#8617;
        </button>
        {canAddReactions && (
          <button onClick={(e) => openPicker(e)} title="Add Reaction">
            &#128578;
          </button>
        )}
        {isOwn && !editing && (
          <button
            onClick={() => {
              setEditContent(message.content);
              setEditing(true);
            }}
            title="Edit"
          >
            &#9998;
          </button>
        )}
        {canDelete && !editing && (
          <button onClick={handleDelete} title="Delete">
            &#128465;
          </button>
        )}
      </div>
      {showPicker && (
        <div
          className="emoji-picker-container"
          ref={pickerRef}
          style={pickerStyle ?? undefined}
        >
          <Picker
            data={data}
            custom={customEmojiCategory}
            onEmojiSelect={handleEmojiSelect}
            theme="dark"
            previewPosition="none"
            skinTonePosition="none"
          />
        </div>
      )}
      {profileCard && (
        <UserProfileCard
          userId={message.authorId}
          position={profileCard}
          onClose={() => setProfileCard(null)}
        />
      )}
      {contextMenuOpen && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              setReplyingTo(message);
              setContextMenuMessageId(null);
            }}
          >
            Reply
          </button>
          {canAddReactions && (
            <button
              className="context-menu-item"
              onClick={(e) => {
                openPicker(e);
                setContextMenuMessageId(null);
              }}
            >
              Add Reaction
            </button>
          )}
          {canPin && (
            <button
              className="context-menu-item"
              onClick={() => {
                handlePinToggle();
                setContextMenuMessageId(null);
              }}
            >
              {isPinned(message.channelId, message.id)
                ? "Unpin Message"
                : "Pin Message"}
            </button>
          )}
          {isOwn && !editing && (
            <button
              className="context-menu-item"
              onClick={() => {
                setEditContent(message.content);
                setEditing(true);
                setContextMenuMessageId(null);
              }}
            >
              Edit Message
            </button>
          )}
          {canDelete && !editing && (
            <button
              className="context-menu-item danger"
              onClick={() => {
                handleDelete();
                setContextMenuMessageId(null);
              }}
            >
              Delete Message
            </button>
          )}
          {(canKickAuthor || canBanAuthor) && (
            <div className="context-menu-separator" />
          )}
          {canKickAuthor && (
            <button className="context-menu-item danger" onClick={handleKick}>
              Kick
            </button>
          )}
          {canBanAuthor && (
            <button className="context-menu-item danger" onClick={handleBan}>
              Ban
            </button>
          )}
        </div>
      )}
      {previewAttachment && (
        <div
          className="modal-overlay image-preview-overlay"
          onClick={handleClosePreview}
        >
          <div
            className="image-preview-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={`${getApiBase()}${previewAttachment.filePath}`}
              alt={previewAttachment.fileName}
              className="image-preview-img"
            />
            <div className="image-preview-actions">
              <a
                className="image-download-btn"
                href={`${getApiBase()}${previewAttachment.filePath}`}
                download={previewAttachment.fileName}
              >
                Download
              </a>
              <button className="btn-secondary" onClick={handleClosePreview}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
