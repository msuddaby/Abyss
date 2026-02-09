import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, Pressable, Image, ScrollView, Keyboard,
  StyleSheet, type ViewStyle, type TextStyle, type ImageStyle,
  type NativeSyntheticEvent, type TextInputSelectionChangeEventData,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  useMessageStore, useServerStore, useDmStore, useAppConfigStore, useToastStore,
  api, getApiBase, getConnection, hasChannelPermission, Permission,
} from '@abyss/shared';
import EmojiPicker, { type EmojiSelection } from './EmojiPicker';
import { colors, spacing, fontSize, borderRadius } from '../theme/tokens';

interface MentionOption {
  id: string;
  label: string;
  type: 'user' | 'everyone' | 'here';
}

interface EmojiAutocompleteOption {
  id: string;
  name: string;
  imageUrl: string;
}

export default function MessageInput() {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ uri: string; name: string; type: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const inputRef = useRef<TextInput>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const addToast = useToastStore((s) => s.addToast);

  const sendMessage = useMessageStore((s) => s.sendMessage);
  const replyingTo = useMessageStore((s) => s.replyingTo);
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);
  const maxMessageLength = useAppConfigStore((s) => s.maxMessageLength);

  const effectiveChannelId = isDmMode ? activeDmChannel?.id : activeChannel?.id;
  const canSendMessages = isDmMode ? true : hasChannelPermission(activeChannel?.permissions, Permission.SendMessages);
  const canAttachFiles = isDmMode ? true : hasChannelPermission(activeChannel?.permissions, Permission.AttachFiles);
  const canMentionEveryone = isDmMode ? false : hasChannelPermission(activeChannel?.permissions, Permission.MentionEveryone);

  // Focus input when replying
  useEffect(() => {
    if (replyingTo) inputRef.current?.focus();
  }, [replyingTo]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Mention autocomplete
  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const opts: MentionOption[] = [];
    if (!isDmMode) {
      if (canMentionEveryone && 'everyone'.startsWith(q))
        opts.push({ id: 'everyone', label: '@everyone', type: 'everyone' });
      if (canMentionEveryone && 'here'.startsWith(q))
        opts.push({ id: 'here', label: '@here', type: 'here' });
      for (const m of members) {
        if (
          m.user.displayName.toLowerCase().includes(q) ||
          m.user.username.toLowerCase().includes(q)
        ) {
          opts.push({ id: m.userId, label: m.user.displayName, type: 'user' });
        }
      }
    }
    return opts.slice(0, 10);
  }, [mentionQuery, members, isDmMode, canMentionEveryone]);

  // Custom emoji autocomplete
  const emojiOptions = useMemo<EmojiAutocompleteOption[]>(() => {
    if (emojiQuery === null) return [];
    const q = emojiQuery.toLowerCase();
    return emojis
      .filter((e) => e.name.toLowerCase().includes(q))
      .slice(0, 10)
      .map((e) => ({ id: e.id, name: e.name, imageUrl: e.imageUrl }));
  }, [emojiQuery, emojis]);

  const detectTriggers = useCallback((value: string, cursor: number) => {
    const textBefore = value.slice(0, cursor);

    // Check for @ mention trigger
    const atIndex = textBefore.lastIndexOf('@');
    if (atIndex >= 0) {
      const charBefore = atIndex > 0 ? textBefore[atIndex - 1] : ' ';
      if (charBefore === ' ' || charBefore === '\n' || atIndex === 0) {
        const query = textBefore.slice(atIndex + 1);
        if (!query.includes(' ')) {
          setMentionQuery(query);
          setEmojiQuery(null);
          return;
        }
      }
    }

    // Check for : emoji trigger
    const colonIndex = textBefore.lastIndexOf(':');
    if (colonIndex >= 0) {
      const charBefore = colonIndex > 0 ? textBefore[colonIndex - 1] : ' ';
      if (charBefore === ' ' || charBefore === '\n' || colonIndex === 0) {
        const query = textBefore.slice(colonIndex + 1);
        if (!query.includes(' ') && query.length >= 1) {
          setEmojiQuery(query);
          setMentionQuery(null);
          return;
        }
      }
    }

    setMentionQuery(null);
    setEmojiQuery(null);
  }, []);

  const handleChangeText = useCallback((value: string) => {
    setText(value);
    detectTriggers(value, cursorPos + (value.length - text.length));
    if (value.length > maxMessageLength) {
      setInputError(`Message must be 1-${maxMessageLength} characters.`);
    } else if (inputError) {
      setInputError(null);
    }

    // Typing indicator
    if (effectiveChannelId && canSendMessages) {
      const conn = getConnection();
      conn.invoke('UserTyping', effectiveChannelId).catch(() => {});
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => {}, 3000);
    }
  }, [effectiveChannelId, detectTriggers, cursorPos, text.length, maxMessageLength, inputError, canSendMessages]);

  const handleSelectionChange = useCallback((e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    const pos = e.nativeEvent.selection.end;
    setCursorPos(pos);
    detectTriggers(text, pos);
  }, [text, detectTriggers]);

  useEffect(() => {
    if (text.length > maxMessageLength) {
      setInputError(`Message must be 1-${maxMessageLength} characters.`);
    } else if (inputError) {
      setInputError(null);
    }
  }, [text.length, maxMessageLength, inputError]);

  const insertMention = useCallback((option: MentionOption) => {
    const textBefore = text.slice(0, cursorPos);
    const atIndex = textBefore.lastIndexOf('@');
    if (atIndex === -1) return;

    let insert: string;
    if (option.type === 'user') {
      insert = `<@${option.id}> `;
    } else {
      insert = `@${option.id} `;
    }

    const newText = text.slice(0, atIndex) + insert + text.slice(cursorPos);
    setText(newText);
    setMentionQuery(null);
    const newCursor = atIndex + insert.length;
    setCursorPos(newCursor);
  }, [text, cursorPos]);

  const insertCustomEmoji = useCallback((option: EmojiAutocompleteOption) => {
    const textBefore = text.slice(0, cursorPos);
    const colonIndex = textBefore.lastIndexOf(':');
    if (colonIndex === -1) return;

    const insert = `<:${option.name}:${option.id}> `;
    const newText = text.slice(0, colonIndex) + insert + text.slice(cursorPos);
    setText(newText);
    setEmojiQuery(null);
    const newCursor = colonIndex + insert.length;
    setCursorPos(newCursor);
  }, [text, cursorPos]);

  const handleEmojiSelected = useCallback((emoji: EmojiSelection) => {
    const before = text.slice(0, cursorPos);
    const after = text.slice(cursorPos);
    const insert = emoji.type === 'custom'
      ? `<:${emoji.name}:${emoji.id}> `
      : emoji.emoji;
    const newText = before + insert + after;
    setText(newText);
    setCursorPos(cursorPos + insert.length);
  }, [text, cursorPos]);

  const handlePickImage = useCallback(async () => {
    if (!canAttachFiles) {
      addToast('You do not have permission to attach files in this channel.', 'error');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.8,
    });
    if (result.canceled) return;
    const newFiles = result.assets.map((a) => ({
      uri: a.uri,
      name: a.fileName || 'image.jpg',
      type: a.mimeType || 'image/jpeg',
    }));
    setFiles((prev) => [...prev, ...newFiles]);
  }, [addToast, canAttachFiles]);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!effectiveChannelId || sending) return;
    if (!canSendMessages) {
      addToast('You do not have permission to send messages in this channel.', 'error');
      return;
    }
    if (files.length > 0 && !canAttachFiles) {
      addToast('You do not have permission to attach files in this channel.', 'error');
      return;
    }
    if (!text.trim() && files.length === 0) return;
    if (text.length > maxMessageLength) {
      setInputError(`Message must be 1-${maxMessageLength} characters.`);
      addToast(`Message must be 1-${maxMessageLength} characters.`, 'error');
      return;
    }

    setSending(true);
    try {
      const attachmentIds: string[] = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', {
          uri: file.uri,
          name: file.name,
          type: file.type,
        } as unknown as Blob);
        const res = await api.post('/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        attachmentIds.push(res.data.id);
      }
      await sendMessage(effectiveChannelId, text, attachmentIds, replyingTo?.id);
      setText('');
      setFiles([]);
      setMentionQuery(null);
      setEmojiQuery(null);
      setReplyingTo(null);
      setInputError(null);
    } catch (err) {
      console.error('Failed to send message:', err);
      addToast('Failed to send message.', 'error');
    } finally {
      setSending(false);
    }
  }, [effectiveChannelId, sending, text, files, sendMessage, replyingTo, setReplyingTo, maxMessageLength, addToast, canSendMessages, canAttachFiles]);

  const placeholder = isDmMode && activeDmChannel
    ? `Message @${activeDmChannel.otherUser.displayName}`
    : activeChannel
      ? (canSendMessages ? `Message #${activeChannel.name}` : 'You do not have permission to send messages')
      : 'Select a channel';

  const canSend = canSendMessages && (text.trim().length > 0 || files.length > 0) && !sending;

  return (
    <View style={styles.container}>
      {/* Reply bar */}
      {replyingTo && (
        <View style={styles.replyBar}>
          <Text style={styles.replyBarText} numberOfLines={1}>
            Replying to <Text style={styles.replyBarName}>{replyingTo.author.displayName}</Text>
          </Text>
          <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
            <Text style={styles.replyBarClose}>✕</Text>
          </Pressable>
        </View>
      )}

      {/* File previews */}
      {files.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filePreviews}>
          {files.map((file, i) => (
            <View key={i} style={styles.filePreview}>
              <Image source={{ uri: file.uri }} style={styles.filePreviewImage} />
              <Pressable style={styles.fileRemoveBtn} onPress={() => removeFile(i)}>
                <Text style={styles.fileRemoveText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Custom emoji autocomplete */}
      {emojiQuery !== null && emojiOptions.length > 0 && (
        <View style={styles.autocomplete}>
          {emojiOptions.map((option) => (
            <Pressable
              key={option.id}
              style={styles.autocompleteItem}
              onPress={() => insertCustomEmoji(option)}
            >
              <Image
                source={{ uri: `${getApiBase()}${option.imageUrl}` }}
                style={styles.autocompleteEmojiImg}
              />
              <Text style={styles.autocompleteText}>:{option.name}:</Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Mention autocomplete */}
      {mentionQuery !== null && mentionOptions.length > 0 && (
        <View style={styles.autocomplete}>
          {mentionOptions.map((option) => (
            <Pressable
              key={option.id}
              style={styles.autocompleteItem}
              onPress={() => insertMention(option)}
            >
              <Text style={styles.autocompleteText}>
                {option.type === 'user' ? `@${option.label}` : option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Input row */}
      <View style={styles.inputRow}>
        <Pressable style={[styles.attachBtn, !canAttachFiles && styles.attachBtnDisabled]} onPress={handlePickImage} disabled={!canAttachFiles || !canSendMessages}>
          <Text style={styles.attachBtnText}>+</Text>
        </Pressable>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={handleChangeText}
          onSelectionChange={handleSelectionChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={maxMessageLength}
          editable={!!effectiveChannelId && canSendMessages}
        />
        <Pressable style={styles.emojiBtn} onPress={() => setShowEmojiPicker(true)}>
          <Text style={styles.emojiBtnText}>😊</Text>
        </Pressable>
        {keyboardVisible && (
          <Pressable style={styles.keyboardBtn} onPress={() => Keyboard.dismiss()}>
            <Text style={styles.keyboardBtnText}>Hide</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          onPress={handleSubmit}
          disabled={!canSend}
        >
          <Text style={[styles.sendBtnText, !canSend && styles.sendBtnTextDisabled]}>Send</Text>
        </Pressable>
      </View>
      {inputError && (
        <Text style={styles.inputError}>{inputError}</Text>
      )}

      {/* Emoji picker modal */}
      <EmojiPicker
        open={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onSelect={handleEmojiSelected}
        title="Emoji"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
    backgroundColor: colors.bgPrimary,
  } as ViewStyle,
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgSecondary,
  } as ViewStyle,
  replyBarText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
  } as TextStyle,
  replyBarName: {
    color: colors.headerPrimary,
    fontWeight: '600',
  } as TextStyle,
  replyBarClose: {
    color: colors.textMuted,
    fontSize: fontSize.lg,
    paddingLeft: spacing.sm,
  } as TextStyle,
  filePreviews: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  filePreview: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.sm,
    marginRight: spacing.sm,
    position: 'relative',
  } as ViewStyle,
  filePreviewImage: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.sm,
  } as ImageStyle,
  fileRemoveBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  fileRemoveText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  } as TextStyle,
  autocomplete: {
    maxHeight: 200,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
  } as ViewStyle,
  autocompleteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  } as ViewStyle,
  autocompleteText: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
  } as TextStyle,
  autocompleteEmojiImg: {
    width: 24,
    height: 24,
  } as ImageStyle,
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  } as ViewStyle,
  attachBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgModifierHover,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  attachBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  attachBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.xl,
    lineHeight: 24,
  } as TextStyle,
  input: {
    flex: 1,
    backgroundColor: colors.channelTextArea,
    color: colors.textPrimary,
    fontSize: fontSize.md,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 120,
    minHeight: 36,
  } as TextStyle,
  inputError: {
    color: colors.danger,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  } as TextStyle,
  emojiBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  emojiBtnText: {
    fontSize: 20,
  } as TextStyle,
  keyboardBtn: {
    height: 36,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgModifierHover,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  keyboardBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  sendBtn: {
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.brandColor,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  sendBtnDisabled: {
    backgroundColor: colors.bgModifierHover,
  } as ViewStyle,
  sendBtnText: {
    color: '#ffffff',
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  sendBtnTextDisabled: {
    color: colors.textMuted,
  } as TextStyle,
});
