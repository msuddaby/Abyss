import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useMessageStore } from "../stores/messageStore";
import { useServerStore } from "../stores/serverStore";
import { useDmStore } from "../stores/dmStore";
import { uploadFile, API_BASE } from "../services/api";
import { getConnection } from "../services/signalr";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";

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

export default function MessageInput() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const savedSelectionRef = useRef<Range | null>(null);
  // Stores the trigger text node + start offset for autocomplete insertion
  const triggerRef = useRef<{ node: Text; startOffset: number } | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const sendMessage = useMessageStore((s) => s.sendMessage);
  const replyingTo = useMessageStore((s) => s.replyingTo);
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);

  const effectiveChannelId = isDmMode ? activeDmChannel?.id : activeChannel?.id;
  const isChannelActive = !!effectiveChannelId;

  const customEmojiCategory = useMemo(() =>
    emojis.length > 0 ? [{
      id: 'custom',
      name: 'Server Emojis',
      emojis: emojis.map((e) => ({
        id: `custom-${e.id}`,
        name: e.name,
        keywords: [e.name],
        skins: [{ src: `${API_BASE}${e.imageUrl}` }],
      })),
    }] : [],
  [emojis]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const opts: MentionOption[] = [];
    if (!isDmMode) {
      if ("everyone".startsWith(q))
        opts.push({ id: "everyone", label: "@everyone", type: "everyone" });
      if ("here".startsWith(q))
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
  }, [mentionQuery, members, isDmMode]);

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

  const handleTyping = () => {
    if (!effectiveChannelId) return;
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
    img.src = `${API_BASE}${option.imageUrl}`;
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
        img.src = `${API_BASE}${ce.imageUrl}`;
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
      if (e.key === "Enter" || e.key === "Tab") {
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
      if (e.key === "Enter" || e.key === "Tab") {
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
    // Enter sends the message (prevent newline in contentEditable)
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    setFiles((prev) => [...prev, ...selected]);
    selected.forEach((file) => {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          setPreviews((prev) => [...prev, ev.target?.result as string]);
        };
        reader.readAsDataURL(file);
      }
    });
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!editorRef.current || !effectiveChannelId || sending) return;

    const content = extractRawContent(editorRef.current);
    if (!content.trim() && files.length === 0) return;

    setSending(true);
    try {
      const attachmentIds: string[] = [];
      for (const file of files) {
        const result = await uploadFile(file);
        attachmentIds.push(result.id);
      }
      await sendMessage(effectiveChannelId, content, attachmentIds, replyingTo?.id);
      editorRef.current.innerHTML = '';
      setIsEmpty(true);
      setFiles([]);
      setPreviews([]);
      setMentionQuery(null);
      setEmojiQuery(null);
      triggerRef.current = null;
      setReplyingTo(null);
    } catch (err) {
      console.error("Failed to send message:", err);
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
    }
    setShowEmojiPicker(!showEmojiPicker);
  };

  return (
    <div className="message-input-container">
      {replyingTo && (
        <div className="reply-bar">
          <span className="reply-bar-text">Replying to <strong>{replyingTo.author.displayName}</strong></span>
          <button className="reply-bar-close" onClick={() => setReplyingTo(null)}>&times;</button>
        </div>
      )}
      {previews.length > 0 && (
        <div className="file-previews">
          {previews.map((preview, i) => (
            <div key={i} className="file-preview">
              <img src={preview} alt="preview" />
              <button className="remove-file" onClick={() => removeFile(i)}>
                x
              </button>
            </div>
          ))}
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
              <img src={`${API_BASE}${option.imageUrl}`} alt={option.name} className="emoji-autocomplete-img" />
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
        <button
          type="button"
          className="attach-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={handleFileSelect}
        />
        <div
          ref={editorRef}
          className={`message-input${isEmpty ? ' empty' : ''}`}
          contentEditable={isChannelActive}
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          data-placeholder={
            isDmMode && activeDmChannel
              ? `Message @${activeDmChannel.otherUser.displayName}`
              : activeChannel
                ? `Message #${activeChannel.name}`
                : "Select a channel"
          }
          role="textbox"
        />
        <div className="emoji-picker-wrapper">
          <button
            type="button"
            className="emoji-btn"
            onClick={handleEmojiPickerToggle}
            title="Emoji"
          >
            &#128578;
          </button>
          {showEmojiPicker && (
            <div className="emoji-picker-input-container" ref={emojiPickerRef}>
              <Picker data={data} custom={customEmojiCategory} onEmojiSelect={handlePickerEmojiSelect} theme="dark" previewPosition="none" skinTonePosition="none" />
            </div>
          )}
        </div>
        <button
          type="submit"
          className="send-btn"
          disabled={sending || (isEmpty && files.length === 0)}
        >
          Send
        </button>
      </form>
    </div>
  );
}
