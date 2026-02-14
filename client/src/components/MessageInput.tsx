import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from "react";
import { useMessageStore, useServerStore, useDmStore, useAppConfigStore, useToastStore, uploadFile, getApiBase, getConnection, hasChannelPermission, Permission } from "@abyss/shared";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import GifPicker from "./GifPicker";

interface MentionOption {
  id: string;
  label: string;
  type: "user" | "everyone" | "here";
}

interface EmojiOption {
  id: string;
  name: string;
  imageUrl: string;
}

// Walk the contentEditable DOM and extract the raw message format
function extractRawContent(el: HTMLElement): string {
  let result = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
    } else if (node instanceof HTMLElement) {
      if (node.tagName === 'BR') {
        result += '\n';
      } else if (node.dataset.rawMention) {
        result += node.dataset.rawMention;
      } else if (node.dataset.rawEmoji) {
        result += node.dataset.rawEmoji;
      } else {
        result += extractRawContent(node);
      }
    }
  }
  return result;
}

// Get text content before the cursor in the current text node
function getTextBeforeCursor(): { text: string; node: Text; offset: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const node = range.startContainer as Text;
  const offset = range.startOffset;
  const text = node.textContent?.slice(0, offset) || '';
  return { text, node, offset };
}

export default function MessageInput({ channelId: channelIdOverride }: { channelId?: string } = {}) {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<Array<string | null>>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<number, number>>({});
  const [sending, setSending] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiPickerAnchor, setEmojiPickerAnchor] = useState<{ x: number; y: number } | null>(null);
  const [emojiPickerStyle, setEmojiPickerStyle] = useState<React.CSSProperties | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [gifPickerAnchor, setGifPickerAnchor] = useState<{ x: number; y: number } | null>(null);
  const [gifPickerStyle, setGifPickerStyle] = useState<React.CSSProperties | null>(null);
  const [contentLength, setContentLength] = useState(0);
  const [inputError, setInputError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const gifPickerRef = useRef<HTMLDivElement>(null);
  const gifButtonRef = useRef<HTMLButtonElement>(null);
  const savedSelectionRef = useRef<Range | null>(null);
  // Stores the trigger text node + start offset for autocomplete insertion
  const triggerRef = useRef<{ node: Text; startOffset: number } | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const sendMessage = useMessageStore((s) => s.sendMessage);
  const replyingTo = useMessageStore((s) => s.replyingTo);
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo);
  const activeServer = useServerStore((s) => s.activeServer);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);
  const maxMessageLength = useAppConfigStore((s) => s.maxMessageLength);
  const addToast = useToastStore((s) => s.addToast);

  const isVoiceChat = !!channelIdOverride;
  const effectiveChannelId = channelIdOverride || (isDmMode ? activeDmChannel?.id : activeChannel?.id);
  const isChannelActive = !!effectiveChannelId;
  const canSendMessages = isVoiceChat ? true : isDmMode ? true : hasChannelPermission(activeChannel?.permissions, Permission.SendMessages);
  const canAttachFiles = isVoiceChat ? true : isDmMode ? true : hasChannelPermission(activeChannel?.permissions, Permission.AttachFiles);
  const canMentionEveryone = (isVoiceChat || isDmMode) ? false : hasChannelPermission(activeChannel?.permissions, Permission.MentionEveryone);

  const customEmojiCategory = useMemo(() =>
    emojis.length > 0 ? [{
      id: 'custom',
      name: 'Server Emojis',
      emojis: emojis.map((e) => ({
        id: `custom-${e.id}`,
        name: e.name,
        keywords: [e.name],
        skins: [{ src: `${getApiBase()}${e.imageUrl}` }],
      })),
    }] : [],
  [emojis]);

  const formatFileSize = (size: number) => {
    if (!size && size !== 0) return "";
    if (size < 1024) return `${size} B`;
    const kb = size / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)} GB`;
  };

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const opts: MentionOption[] = [];
    if (!isDmMode) {
      if (canMentionEveryone && "everyone".startsWith(q))
        opts.push({ id: "everyone", label: "@everyone", type: "everyone" });
      if (canMentionEveryone && "here".startsWith(q))
        opts.push({ id: "here", label: "@here", type: "here" });
    }
    if (!isDmMode) {
      for (const m of members) {
        if (
          m.user.displayName.toLowerCase().includes(q) ||
          m.user.username.toLowerCase().includes(q)
        ) {
          opts.push({ id: m.userId, label: m.user.displayName, type: "user" });
        }
      }
    }
    return opts.slice(0, 10);
  }, [mentionQuery, members, isDmMode, canMentionEveryone]);

  const emojiOptions = useMemo<EmojiOption[]>(() => {
    if (emojiQuery === null) return [];
    const q = emojiQuery.toLowerCase();
    return emojis
      .filter((e) => e.name.toLowerCase().includes(q))
      .slice(0, 10)
      .map((e) => ({ id: e.id, name: e.name, imageUrl: e.imageUrl }));
  }, [emojiQuery, emojis]);

  useEffect(() => { setMentionIndex(0); }, [mentionOptions.length]);
  useEffect(() => { setEmojiIndex(0); }, [emojiOptions.length]);

  // Focus editor when replying
  useEffect(() => {
    if (replyingTo) editorRef.current?.focus();
  }, [replyingTo]);

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showEmojiPicker]);

  useEffect(() => {
    if (showEmojiPicker) return;
    setEmojiPickerStyle(null);
    setEmojiPickerAnchor(null);
  }, [showEmojiPicker]);

  useLayoutEffect(() => {
    if (!showEmojiPicker || !emojiPickerRef.current || !emojiPickerAnchor) return;
    const rect = emojiPickerRef.current.getBoundingClientRect();
    const margin = 8;
    let left = emojiPickerAnchor.x - rect.width;
    let top = emojiPickerAnchor.y;
    if (left < margin) left = margin;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    const aboveTop = emojiPickerAnchor.y - rect.height - margin;
    const belowTop = emojiPickerAnchor.y + margin;
    if (aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + rect.height <= window.innerHeight - margin) {
      top = belowTop;
    } else {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (!emojiPickerStyle || emojiPickerStyle.left !== left || emojiPickerStyle.top !== top) {
      setEmojiPickerStyle({ left, top });
    }
  }, [showEmojiPicker, emojiPickerAnchor, emojiPickerStyle]);

  // Close gif picker on outside click
  useEffect(() => {
    if (!showGifPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (gifPickerRef.current && !gifPickerRef.current.contains(e.target as Node) &&
          gifButtonRef.current && !gifButtonRef.current.contains(e.target as Node)) {
        setShowGifPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showGifPicker]);

  useEffect(() => {
    if (showGifPicker) return;
    setGifPickerStyle(null);
    setGifPickerAnchor(null);
  }, [showGifPicker]);

  useLayoutEffect(() => {
    if (!showGifPicker || !gifPickerRef.current || !gifPickerAnchor) return;
    const rect = gifPickerRef.current.getBoundingClientRect();
    const margin = 8;
    let left = gifPickerAnchor.x - rect.width;
    let top = gifPickerAnchor.y;
    if (left < margin) left = margin;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    const aboveTop = gifPickerAnchor.y - rect.height - margin;
    const belowTop = gifPickerAnchor.y + margin;
    if (aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + rect.height <= window.innerHeight - margin) {
      top = belowTop;
    } else {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (!gifPickerStyle || gifPickerStyle.left !== left || gifPickerStyle.top !== top) {
      setGifPickerStyle({ left, top });
    }
  }, [showGifPicker, gifPickerAnchor, gifPickerStyle]);

  useEffect(() => {
    if (!showGifPicker || !gifPickerRef.current) return;
    const updatePos = () => {
      if (!gifPickerRef.current || !gifPickerAnchor) return;
      const rect = gifPickerRef.current.getBoundingClientRect();
      const margin = 8;
      let left = gifPickerAnchor.x - rect.width;
      if (left < margin) left = margin;
      if (left + rect.width > window.innerWidth - margin) {
        left = window.innerWidth - rect.width - margin;
      }
      const aboveTop = gifPickerAnchor.y - rect.height - margin;
      const belowTop = gifPickerAnchor.y + margin;
      let top = gifPickerAnchor.y;
      if (aboveTop >= margin) {
        top = aboveTop;
      } else if (belowTop + rect.height <= window.innerHeight - margin) {
        top = belowTop;
      } else {
        top = Math.max(margin, window.innerHeight - rect.height - margin);
      }
      setGifPickerStyle((prev) =>
        prev && prev.left === left && prev.top === top ? prev : { left, top }
      );
    };
    const ro = new ResizeObserver(updatePos);
    ro.observe(gifPickerRef.current);
    window.addEventListener("resize", updatePos);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updatePos);
    };
  }, [showGifPicker, gifPickerAnchor]);

  useEffect(() => {
    if (!showEmojiPicker || !emojiPickerRef.current) return;
    const updatePos = () => {
      if (!emojiPickerRef.current || !emojiPickerAnchor) return;
      const rect = emojiPickerRef.current.getBoundingClientRect();
      const margin = 8;
      let left = emojiPickerAnchor.x - rect.width;
      if (left < margin) left = margin;
      if (left + rect.width > window.innerWidth - margin) {
        left = window.innerWidth - rect.width - margin;
      }
      const aboveTop = emojiPickerAnchor.y - rect.height - margin;
      const belowTop = emojiPickerAnchor.y + margin;
      let top = emojiPickerAnchor.y;
      if (aboveTop >= margin) {
        top = aboveTop;
      } else if (belowTop + rect.height <= window.innerHeight - margin) {
        top = belowTop;
      } else {
        top = Math.max(margin, window.innerHeight - rect.height - margin);
      }
      setEmojiPickerStyle((prev) =>
        prev && prev.left === left && prev.top === top ? prev : { left, top }
      );
    };
    const ro = new ResizeObserver(updatePos);
    ro.observe(emojiPickerRef.current);
    window.addEventListener("resize", updatePos);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updatePos);
    };
  }, [showEmojiPicker, emojiPickerAnchor]);

  useEffect(() => {
    if (contentLength > maxMessageLength) {
      setInputError(`Message must be 1-${maxMessageLength} characters.`);
    } else if (inputError) {
      setInputError(null);
    }
  }, [contentLength, maxMessageLength, inputError]);

  const handleTyping = () => {
    if (!effectiveChannelId || !canSendMessages) return;
    const conn = getConnection();
    conn.invoke("UserTyping", effectiveChannelId).catch(() => {});
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {}, 3000);
  };

  const detectTriggers = useCallback(() => {
    const cursor = getTextBeforeCursor();
    if (!cursor) {
      setMentionQuery(null);
      setEmojiQuery(null);
      triggerRef.current = null;
      return;
    }
    const { text, node } = cursor;

    // Check for @ mention trigger
    const atIndex = text.lastIndexOf('@');
    if (atIndex >= 0) {
      const charBefore = atIndex > 0 ? text[atIndex - 1] : ' ';
      if (charBefore === ' ' || charBefore === '\n' || atIndex === 0) {
        const query = text.slice(atIndex + 1);
        if (!query.includes(' ')) {
          setMentionQuery(query);
          setEmojiQuery(null);
          triggerRef.current = { node, startOffset: atIndex };
          return;
        }
      }
    }

    // Check for : emoji trigger
    const colonIndex = text.lastIndexOf(':');
    if (colonIndex >= 0) {
      const charBefore = colonIndex > 0 ? text[colonIndex - 1] : ' ';
      if (charBefore === ' ' || charBefore === '\n' || colonIndex === 0) {
        const query = text.slice(colonIndex + 1);
        if (!query.includes(' ') && query.length >= 1) {
          setEmojiQuery(query);
          setMentionQuery(null);
          triggerRef.current = { node, startOffset: colonIndex };
          return;
        }
      }
    }

    setMentionQuery(null);
    setEmojiQuery(null);
    triggerRef.current = null;
  }, []);

  const handleInput = () => {
    if (!editorRef.current) return;
    // Clean up browser artifacts (empty editor may have leftover <br>)
    if (editorRef.current.innerHTML === '<br>') {
      editorRef.current.innerHTML = '';
    }
    const raw = extractRawContent(editorRef.current);
    setContentLength(raw.length);
    if (raw.length > maxMessageLength) {
      setInputError(`Message must be 1-${maxMessageLength} characters.`);
    } else if (inputError) {
      setInputError(null);
    }
    setIsEmpty(!raw.trim());
    handleTyping();
    detectTriggers();
  };

  const insertMention = useCallback((option: MentionOption) => {
    if (!triggerRef.current || !editorRef.current) return;
    const { node, startOffset } = triggerRef.current;
    if (!editorRef.current.contains(node)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (sel.getRangeAt(0).startContainer !== node) return;
    const endOffset = sel.getRangeAt(0).startOffset;

    const span = document.createElement('span');
    span.contentEditable = 'false';
    span.className = 'input-mention';

    if (option.type === 'user') {
      span.dataset.rawMention = `<@${option.id}>`;
      span.textContent = `@${option.label}`;
    } else {
      span.dataset.rawMention = `@${option.id}`;
      span.textContent = `@${option.id}`;
    }

    const range = document.createRange();
    range.setStart(node, startOffset);
    range.setEnd(node, endOffset);
    range.deleteContents();
    range.insertNode(span);

    // Add trailing space and place cursor after it
    const space = document.createTextNode(' ');
    span.after(space);
    const newRange = document.createRange();
    newRange.setStartAfter(space);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);

    setMentionQuery(null);
    triggerRef.current = null;
    setIsEmpty(false);
  }, []);

  const insertEmoji = useCallback((option: EmojiOption) => {
    if (!triggerRef.current || !editorRef.current) return;
    const { node, startOffset } = triggerRef.current;
    if (!editorRef.current.contains(node)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (sel.getRangeAt(0).startContainer !== node) return;
    const endOffset = sel.getRangeAt(0).startOffset;

    const img = document.createElement('img');
    img.src = `${getApiBase()}${option.imageUrl}`;
    img.alt = `:${option.name}:`;
    img.title = `:${option.name}:`;
    img.className = 'input-custom-emoji';
    img.dataset.rawEmoji = `<:${option.name}:${option.id}>`;

    const range = document.createRange();
    range.setStart(node, startOffset);
    range.setEnd(node, endOffset);
    range.deleteContents();
    range.insertNode(img);

    const space = document.createTextNode(' ');
    img.after(space);
    const newRange = document.createRange();
    newRange.setStartAfter(space);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);

    setEmojiQuery(null);
    triggerRef.current = null;
    setIsEmpty(false);
  }, []);

  const handlePickerEmojiSelect = (emoji: { native?: string; id?: string }) => {
    if (!editorRef.current) return;
    editorRef.current.focus();

    const sel = window.getSelection();
    if (!sel) return;

    // Restore the saved selection from before the picker opened
    if (savedSelectionRef.current) {
      sel.removeAllRanges();
      sel.addRange(savedSelectionRef.current);
      savedSelectionRef.current = null;
    }

    if (sel.rangeCount === 0) {
      // Fallback: place cursor at end
      const range = document.createRange();
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const range = sel.getRangeAt(0);
    range.collapse(false);

    if (emoji.native) {
      const text = document.createTextNode(emoji.native);
      range.insertNode(text);
      range.setStartAfter(text);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (emoji.id?.startsWith('custom-')) {
      const emojiId = emoji.id.substring(7);
      const ce = emojis.find((e) => e.id === emojiId);
      if (ce) {
        const img = document.createElement('img');
        img.src = `${getApiBase()}${ce.imageUrl}`;
        img.alt = `:${ce.name}:`;
        img.title = `:${ce.name}:`;
        img.className = 'input-custom-emoji';
        img.dataset.rawEmoji = `<:${ce.name}:${ce.id}>`;
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    setShowEmojiPicker(false);
    setIsEmpty(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionQuery !== null && mentionOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionOptions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        insertMention(mentionOptions[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        triggerRef.current = null;
        return;
      }
    }
    if (emojiQuery !== null && emojiOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEmojiIndex((prev) => (prev + 1) % emojiOptions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEmojiIndex((prev) => (prev - 1 + emojiOptions.length) % emojiOptions.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        insertEmoji(emojiOptions[emojiIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEmojiQuery(null);
        triggerRef.current = null;
        return;
      }
    }
    // Escape dismisses reply bar
    if (e.key === 'Escape' && replyingTo) {
      e.preventDefault();
      setReplyingTo(null);
      return;
    }
    // Enter sends; Shift+Enter inserts newline
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertLineBreak');
        requestAnimationFrame(() => handleInput());
        return;
      }
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const clipboardFiles = Array.from(e.clipboardData.files);
    if (clipboardFiles.length > 0) {
      e.preventDefault();
      addFiles(clipboardFiles);
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  };

  const addFiles = (selected: File[]) => {
    if (selected.length === 0) return;
    if (!canAttachFiles) {
      addToast('You do not have permission to attach files in this channel.', 'error');
      return;
    }
    setFiles((prev) => [...prev, ...selected]);
    const newPreviews = selected.map((file) => (file.type.startsWith("image/") ? "" : null));
    setPreviews((prev) => {
      const start = prev.length;
      const next = [...prev, ...newPreviews];
      selected.forEach((file, i) => {
        if (file.type.startsWith("image/")) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            setPreviews((curr) => {
              const updated = [...curr];
              updated[start + i] = ev.target?.result as string;
              return updated;
            });
          };
          reader.readAsDataURL(file);
        }
      });
      return next;
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []));
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    setUploadProgress((prev) => {
      const next: Record<number, number> = {};
      Object.entries(prev).forEach(([key, value]) => {
        const idx = Number(key);
        if (idx === index) return;
        next[idx > index ? idx - 1 : idx] = value;
      });
      return next;
    });
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    addFiles(droppedFiles);
  };

  const handleSubmit = async () => {
    if (!editorRef.current || !effectiveChannelId || sending) return;
    if (!canSendMessages) {
      addToast('You do not have permission to send messages in this channel.', 'error');
      return;
    }
    if (files.length > 0 && !canAttachFiles) {
      addToast('You do not have permission to attach files in this channel.', 'error');
      return;
    }

    let content = extractRawContent(editorRef.current);
    // Auto-convert :emojiName: shortcodes to custom emoji format
    if (emojis.length > 0) {
      const emojiByName = new Map(emojis.map((e) => [e.name.toLowerCase(), e]));
      content = content.replace(
        /(?<!<):([a-zA-Z0-9_]{2,32}):(?![a-fA-F0-9-]{36}>)/g,
        (match, name) => {
          const emoji = emojiByName.get((name as string).toLowerCase());
          return emoji ? `<:${emoji.name}:${emoji.id}>` : match;
        },
      );
    }
    if (!content.trim() && files.length === 0) return;
    if (content.length > maxMessageLength) {
      setInputError(`Message must be 1-${maxMessageLength} characters.`);
      addToast(`Message must be 1-${maxMessageLength} characters.`, 'error');
      return;
    }

    setSending(true);
    try {
      const attachmentIds: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress((prev) => ({ ...prev, [i]: 0 }));
        const result = await uploadFile(
          file,
          {
            serverId: isDmMode ? undefined : activeServer?.id,
            channelId: effectiveChannelId ?? undefined,
          },
          (percent) => {
          setUploadProgress((prev) => ({ ...prev, [i]: percent }));
          },
        );
        attachmentIds.push(result.id);
      }
      await sendMessage(effectiveChannelId, content, attachmentIds, replyingTo?.id);
      editorRef.current.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      setIsEmpty(true);
      setContentLength(0);
      setFiles([]);
      setPreviews([]);
      setUploadProgress({});
      setMentionQuery(null);
      setEmojiQuery(null);
      triggerRef.current = null;
      setReplyingTo(null);
      setInputError(null);
    } catch (err) {
      console.error("Failed to send message:", err);
      addToast('Failed to send message.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleEmojiPickerToggle = () => {
    if (!showEmojiPicker) {
      // Save current selection so we can restore it when inserting
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        savedSelectionRef.current = sel.getRangeAt(0).cloneRange();
      }
      const rect = emojiButtonRef.current?.getBoundingClientRect();
      if (rect) {
        setEmojiPickerAnchor({ x: rect.right, y: rect.top });
      } else {
        setEmojiPickerAnchor({ x: 0, y: 0 });
      }
    }
    setShowEmojiPicker(!showEmojiPicker);
  };

  const handleGifPickerToggle = () => {
    if (!showGifPicker) {
      const rect = gifButtonRef.current?.getBoundingClientRect();
      if (rect) {
        setGifPickerAnchor({ x: rect.right, y: rect.top });
      } else {
        setGifPickerAnchor({ x: 0, y: 0 });
      }
    }
    setShowGifPicker(!showGifPicker);
  };

  const handleGifSelect = async (url: string) => {
    if (!effectiveChannelId || sending) return;
    if (!canSendMessages) {
      addToast('You do not have permission to send messages in this channel.', 'error');
      return;
    }
    setSending(true);
    try {
      await sendMessage(effectiveChannelId, url, [], replyingTo?.id);
      setReplyingTo(null);
    } catch (err) {
      console.error("Failed to send GIF:", err);
      addToast('Failed to send GIF.', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="message-input-container"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">Drop files to upload</div>
        </div>
      )}
      {replyingTo && (
        <div className="reply-bar">
          <span className="reply-bar-text">Replying to <strong>{replyingTo.author.displayName}</strong></span>
          <button className="reply-bar-close" onClick={() => setReplyingTo(null)}>&times;</button>
        </div>
      )}
      {files.length > 0 && (
        <div className="file-previews">
          {files.map((file, i) => {
            const preview = previews[i];
            const progress = uploadProgress[i];
            return (
              <div key={i} className="file-preview">
                {preview ? (
                  <img src={preview} alt={file.name} />
                ) : (
                  <div className="file-preview-generic">
                    <span className="file-preview-name">{file.name}</span>
                    <span className="file-preview-size">{formatFileSize(file.size)}</span>
                  </div>
                )}
                {typeof progress === "number" && sending && (
                  <div className="file-preview-progress">
                    <div className="file-preview-progress-bar" style={{ width: `${progress}%` }} />
                  </div>
                )}
                <button className="remove-file" onClick={() => removeFile(i)}>
                  x
                </button>
              </div>
            );
          })}
        </div>
      )}
      {emojiQuery !== null && emojiOptions.length > 0 && (
        <div className="mention-autocomplete">
          {emojiOptions.map((option, i) => (
            <div
              key={option.id}
              className={`mention-autocomplete-item${i === emojiIndex ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertEmoji(option);
              }}
              onMouseEnter={() => setEmojiIndex(i)}
            >
              <img src={`${getApiBase()}${option.imageUrl}`} alt={option.name} className="emoji-autocomplete-img" />
              <span className="mention-autocomplete-name">:{option.name}:</span>
            </div>
          ))}
        </div>
      )}
      {mentionQuery !== null && mentionOptions.length > 0 && (
        <div className="mention-autocomplete">
          {mentionOptions.map((option, i) => (
            <div
              key={option.id}
              className={`mention-autocomplete-item${i === mentionIndex ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(option);
              }}
              onMouseEnter={() => setMentionIndex(i)}
            >
              {option.type === "user" ? (
                <span className="mention-autocomplete-name">@{option.label}</span>
              ) : (
                <span className="mention-autocomplete-name">{option.label}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <form className="message-input-form" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        {canAttachFiles && (
          <>
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canSendMessages}
              title="Attach"
            >
              +
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="*/*"
              multiple
              hidden
              onChange={handleFileSelect}
            />
          </>
        )}
        <div
          ref={editorRef}
          className={`message-input${isEmpty ? ' empty' : ''}`}
          contentEditable={isChannelActive && canSendMessages}
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          data-placeholder={
            isVoiceChat
              ? "Message voice chat"
              : isDmMode && activeDmChannel
                ? `Message @${activeDmChannel.otherUser.displayName}`
                : activeChannel
                  ? (canSendMessages ? `Message #${activeChannel.name}` : `You do not have permission to send messages`)
                  : "Select a channel"
          }
          role="textbox"
        />
        <div className="emoji-picker-wrapper">
          <button
            type="button"
            className="emoji-btn"
            ref={emojiButtonRef}
            onClick={handleEmojiPickerToggle}
            title="Emoji"
          >
            &#128578;
          </button>
          {showEmojiPicker && (
            <div className="emoji-picker-input-container" ref={emojiPickerRef} style={emojiPickerStyle ? emojiPickerStyle : { visibility: "hidden" }}>
              <Picker data={data} custom={customEmojiCategory} onEmojiSelect={handlePickerEmojiSelect} theme="dark" previewPosition="none" skinTonePosition="none" />
            </div>
          )}
        </div>
        <div className="gif-picker-wrapper">
          <button
            type="button"
            className="gif-btn"
            ref={gifButtonRef}
            onClick={handleGifPickerToggle}
            title="GIF"
          >
            GIF
          </button>
          {showGifPicker && (
            <div className="gif-picker-container" ref={gifPickerRef} style={gifPickerStyle ? gifPickerStyle : { visibility: "hidden" }}>
              <GifPicker onSelect={handleGifSelect} onClose={() => setShowGifPicker(false)} />
            </div>
          )}
        </div>
        <button
          type="submit"
          className="send-btn"
          onMouseDown={(e) => e.preventDefault()}
          disabled={!canSendMessages || sending || (isEmpty && files.length === 0) || contentLength > maxMessageLength}
        >
          Send
        </button>
      </form>
      <div className="message-input-meta">
        <span className={`message-input-count${contentLength > maxMessageLength ? ' over' : ''}`}>
          {contentLength}/{maxMessageLength}
        </span>
        {inputError && <span className="message-input-error">{inputError}</span>}
      </div>
    </div>
  );
}
