import { useState, useCallback } from 'react';
import {
  View, Text, Image, Pressable, TextInput, ScrollView, Alert,
  StyleSheet, type ViewStyle, type TextStyle, type ImageStyle,
} from 'react-native';
import {
  getApiBase, useAuthStore, useServerStore, useMessageStore,
  hasPermission, Permission, getDisplayColor, canActOn,
  parseMentions, resolveMentionName, resolveCustomEmoji,
  groupReactions, formatTime, formatDate,
} from '@abyss/shared';
import type { Message } from '@abyss/shared';
import Avatar from './Avatar';
import { colors, spacing, fontSize, borderRadius } from '../theme/tokens';

interface Props {
  message: Message;
  grouped?: boolean;
  onScrollToMessage?: (id: string) => void;
  onPickReactionEmoji?: (messageId: string) => void;
}

export default function MessageItem({ message, grouped, onScrollToMessage, onPickReactionEmoji }: Props) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);

  const currentUser = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const emojis = useServerStore((s) => s.emojis);
  const activeServer = useServerStore((s) => s.activeServer);
  const kickMember = useServerStore((s) => s.kickMember);
  const banMember = useServerStore((s) => s.banMember);
  const editMessage = useMessageStore((s) => s.editMessage);
  const deleteMessage = useMessageStore((s) => s.deleteMessage);
  const toggleReaction = useMessageStore((s) => s.toggleReaction);
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo);

  const isOwn = currentUser?.id === message.authorId;
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canManageMessages = currentMember ? hasPermission(currentMember, Permission.ManageMessages) : false;
  const canDelete = isOwn || canManageMessages;
  const authorMember = members.find((m) => m.userId === message.authorId);
  const authorColor = authorMember ? getDisplayColor(authorMember) : undefined;
  const authorDisplayName = authorMember?.user.displayName ?? message.author.displayName;
  const authorAvatarUrl = authorMember?.user.avatarUrl ?? message.author.avatarUrl;

  const canKickPerm = currentMember ? hasPermission(currentMember, Permission.KickMembers) : false;
  const canBanPerm = currentMember ? hasPermission(currentMember, Permission.BanMembers) : false;
  const showAdminActions = !isOwn && authorMember && currentMember;
  const canKickAuthor = canKickPerm && showAdminActions && canActOn(currentMember!, authorMember!);
  const canBanAuthor = canBanPerm && showAdminActions && canActOn(currentMember!, authorMember!);

  const avatarUri = authorAvatarUrl
    ? (authorAvatarUrl.startsWith('http') ? authorAvatarUrl : `${getApiBase()}${authorAvatarUrl}`)
    : undefined;

  const handleEditSave = useCallback(async () => {
    const trimmed = editContent.trim();
    if (trimmed && trimmed !== message.content) {
      await editMessage(message.id, trimmed);
    }
    setEditing(false);
  }, [editContent, message.content, message.id, editMessage]);

  const handleLongPress = useCallback(() => {
    const options: string[] = ['Reply'];
    const actions: (() => void)[] = [() => setReplyingTo(message)];

    if (onPickReactionEmoji) {
      options.push('Add Reaction');
      actions.push(() => onPickReactionEmoji(message.id));
    }

    options.push('Copy Text');
    actions.push(() => {
      // Clipboard not critical, skip import for now
    });

    if (isOwn && !editing) {
      options.push('Edit');
      actions.push(() => { setEditContent(message.content); setEditing(true); });
    }
    if (canDelete && !editing) {
      options.push('Delete');
      actions.push(() => {
        Alert.alert('Delete Message', 'Are you sure?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => deleteMessage(message.id) },
        ]);
      });
    }
    if (canKickAuthor) {
      options.push('Kick');
      actions.push(() => {
        Alert.alert('Kick Member', `Kick ${authorDisplayName}?`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Kick', style: 'destructive', onPress: () => activeServer && kickMember(activeServer.id, message.authorId) },
        ]);
      });
    }
    if (canBanAuthor) {
      options.push('Ban');
      actions.push(() => {
        Alert.alert('Ban Member', `Ban ${authorDisplayName}?`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Ban', style: 'destructive', onPress: () => activeServer && banMember(activeServer.id, message.authorId) },
        ]);
      });
    }

    options.push('Cancel');

    Alert.alert(
      undefined as unknown as string,
      undefined,
      options.map((label, i) =>
        label === 'Cancel'
          ? { text: 'Cancel', style: 'cancel' as const }
          : label === 'Delete' || label === 'Kick' || label === 'Ban'
            ? { text: label, style: 'destructive' as const, onPress: actions[i] }
            : { text: label, onPress: actions[i] }
      ),
    );
  }, [message, isOwn, editing, canDelete, canKickAuthor, canBanAuthor, activeServer, authorDisplayName,
      setReplyingTo, deleteMessage, kickMember, banMember, editMessage, onPickReactionEmoji]);

  if (message.isSystem) {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemDot}>•</Text>
        <Text style={styles.systemText}>
          <Text style={styles.systemAuthor}>{authorDisplayName}</Text> {message.content}
        </Text>
        <Text style={styles.systemTime}>{formatDate(message.createdAt)} {formatTime(message.createdAt)}</Text>
      </View>
    );
  }

  const isMentioned = currentUser && (
    message.content.includes(`<@${currentUser.id}>`) ||
    message.content.includes('@everyone') ||
    message.content.includes('@here')
  );

  const renderContent = useCallback(() => {
    if (!message.content) return null;
    const segments = parseMentions(message.content);
    return (
      <Text style={styles.contentText}>
        {segments.map((seg, i) => {
          switch (seg.type) {
            case 'text':
              return <Text key={i}>{seg.value}</Text>;
            case 'mention': {
              const name = resolveMentionName(seg.userId, members);
              return <Text key={i} style={styles.mention}>@{name}</Text>;
            }
            case 'emoji': {
              const ce = resolveCustomEmoji(seg.id, emojis);
              if (ce) {
                return (
                  <Image
                    key={i}
                    source={{ uri: `${getApiBase()}${ce.imageUrl}` }}
                    style={styles.customEmoji}
                  />
                );
              }
              return <Text key={i}>:{seg.name}:</Text>;
            }
            case 'everyone':
              return <Text key={i} style={styles.mention}>@everyone</Text>;
            case 'here':
              return <Text key={i} style={styles.mention}>@here</Text>;
          }
        })}
      </Text>
    );
  }, [message.content, members, emojis]);

  const reactionGroups = groupReactions(message.reactions);

  // ── Deleted ──
  if (message.isDeleted) {
    return (
      <View style={styles.row}>
        <View style={styles.avatarCol}>
          <Avatar uri={avatarUri} name={authorDisplayName} size={36} />
        </View>
        <View style={styles.body}>
          <View style={styles.header}>
            <Text style={[styles.author, authorColor ? { color: authorColor } : undefined]}>{authorDisplayName}</Text>
            <Text style={styles.time}>{formatDate(message.createdAt)} {formatTime(message.createdAt)}</Text>
          </View>
          <Text style={styles.deletedText}>This message has been deleted</Text>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      onLongPress={handleLongPress}
      style={[
        styles.wrapper,
        grouped && styles.wrapperGrouped,
        isMentioned && styles.rowMentioned,
      ]}
    >
      {/* Reply reference — above the message row */}
      {message.replyTo && (
        <Pressable
          style={styles.replyRef}
          onPress={() => !message.replyTo!.isDeleted && onScrollToMessage?.(message.replyTo!.id)}
        >
          <View style={styles.replyLine} />
          <Avatar
            uri={message.replyTo.author.avatarUrl
              ? (message.replyTo.author.avatarUrl.startsWith('http')
                ? message.replyTo.author.avatarUrl
                : `${getApiBase()}${message.replyTo.author.avatarUrl}`)
              : undefined}
            name={message.replyTo.author.displayName}
            size={16}
          />
          <Text style={styles.replyAuthor}>{message.replyTo.author.displayName}</Text>
          {message.replyTo.isDeleted ? (
            <Text style={styles.replyDeleted}>Original message was deleted</Text>
          ) : (
            <Text style={styles.replyContent} numberOfLines={1}>
              {message.replyTo.content.length > 80
                ? message.replyTo.content.slice(0, 80) + '...'
                : message.replyTo.content}
            </Text>
          )}
        </Pressable>
      )}

      {/* Message row: avatar + body */}
      <View style={[styles.row, grouped && styles.rowGrouped]}>
      {/* Avatar or spacer */}
      {grouped ? (
        <View style={styles.gutterCol} />
      ) : (
        <View style={styles.avatarCol}>
          <Avatar uri={avatarUri} name={authorDisplayName} size={36} />
        </View>
      )}

      {/* Message body */}
      <View style={styles.body}>
        {!grouped && (
          <View style={styles.header}>
            <Text style={[styles.author, authorColor ? { color: authorColor } : undefined]}>
              {authorDisplayName}
            </Text>
            <Text style={styles.time}>
              {formatDate(message.createdAt)} {formatTime(message.createdAt)}
            </Text>
            {message.editedAt && <Text style={styles.edited}>(edited)</Text>}
          </View>
        )}
        {grouped && message.editedAt && <Text style={styles.edited}>(edited)</Text>}

        {/* Content or edit input */}
        {editing ? (
          <View style={styles.editRow}>
            <TextInput
              style={styles.editInput}
              value={editContent}
              onChangeText={setEditContent}
              onSubmitEditing={handleEditSave}
              multiline
              autoFocus
            />
            <View style={styles.editActions}>
              <Pressable onPress={handleEditSave}>
                <Text style={styles.editSave}>Save</Text>
              </Pressable>
              <Pressable onPress={() => { setEditContent(message.content); setEditing(false); }}>
                <Text style={styles.editCancel}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          renderContent()
        )}

        {/* Attachments */}
        {message.attachments?.length > 0 && (
          <View style={styles.attachments}>
            {message.attachments.map((att) => (
              att.contentType.startsWith('image/') ? (
                <Image
                  key={att.id}
                  source={{ uri: `${getApiBase()}${att.filePath}` }}
                  style={styles.attachmentImage}
                  resizeMode="contain"
                />
              ) : (
                <Text key={att.id} style={styles.attachmentFile}>{att.fileName}</Text>
              )
            ))}
          </View>
        )}

        {/* Reactions */}
        {reactionGroups.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.reactions}>
            {reactionGroups.map((g) => {
              const isReacted = currentUser && g.userIds.includes(currentUser.id);
              const isCustom = g.emoji.startsWith('custom:');
              return (
                <Pressable
                  key={g.emoji}
                  style={[styles.reactionChip, isReacted && styles.reactionChipActive]}
                  onPress={() => toggleReaction(message.id, g.emoji)}
                >
                  {isCustom ? (() => {
                    const eid = g.emoji.substring(7);
                    const ce = emojis.find((e) => e.id === eid);
                    return ce
                      ? <Image source={{ uri: `${getApiBase()}${ce.imageUrl}` }} style={styles.reactionCustomEmoji} />
                      : <Text>?</Text>;
                  })() : (
                    <Text style={styles.reactionEmoji}>{g.emoji}</Text>
                  )}
                  <Text style={[styles.reactionCount, isReacted && styles.reactionCountActive]}>
                    {g.count}
                  </Text>
                </Pressable>
              );
            })}
            {onPickReactionEmoji && (
              <Pressable
                style={styles.reactionChip}
                onPress={() => onPickReactionEmoji(message.id)}
              >
                <Text style={styles.reactionEmoji}>+</Text>
              </Pressable>
            )}
          </ScrollView>
        )}
      </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingVertical: spacing.sm,
  } as ViewStyle,
  wrapperGrouped: {
    paddingVertical: 2,
  } as ViewStyle,
  row: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
  } as ViewStyle,
  rowGrouped: {
    paddingTop: 0,
    paddingBottom: 0,
  } as ViewStyle,
  rowMentioned: {
    backgroundColor: 'rgba(250, 166, 26, 0.08)',
    borderLeftWidth: 2,
    borderLeftColor: '#faa61a',
  } as ViewStyle,
  avatarCol: {
    width: 56,
    paddingTop: 2,
  } as ViewStyle,
  gutterCol: {
    width: 56,
  } as ViewStyle,
  body: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: 2,
  } as ViewStyle,
  author: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  time: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
  edited: {
    color: colors.textMuted,
    fontSize: 10,
  } as TextStyle,
  contentText: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    lineHeight: 22,
  } as TextStyle,
  mention: {
    color: '#7289da',
    backgroundColor: 'rgba(114, 137, 218, 0.1)',
    borderRadius: 3,
    fontWeight: '500',
  } as TextStyle,
  customEmoji: {
    width: 20,
    height: 20,
  } as ImageStyle,
  deletedText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    fontStyle: 'italic',
  } as TextStyle,
  // Reply reference
  replyRef: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.lg + 56,
    paddingRight: spacing.lg,
    marginBottom: 2,
  } as ViewStyle,
  replyLine: {
    width: 2,
    height: 12,
    backgroundColor: colors.textMuted,
    borderRadius: 1,
    marginRight: 2,
  } as ViewStyle,
  replyAuthor: {
    color: colors.headerPrimary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
  replyContent: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    flex: 1,
  } as TextStyle,
  replyDeleted: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontStyle: 'italic',
  } as TextStyle,
  // Edit mode
  editRow: {
    marginTop: spacing.xs,
  } as ViewStyle,
  editInput: {
    backgroundColor: colors.channelTextArea,
    color: colors.textPrimary,
    fontSize: fontSize.md,
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
    maxHeight: 120,
  } as TextStyle,
  editActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  } as ViewStyle,
  editSave: {
    color: colors.brandColor,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  editCancel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  } as TextStyle,
  // Attachments
  attachments: {
    marginTop: spacing.xs,
  } as ViewStyle,
  attachmentImage: {
    width: 300,
    height: 200,
    borderRadius: borderRadius.sm,
    marginTop: spacing.xs,
  } as ImageStyle,
  attachmentFile: {
    color: colors.textLink,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  } as TextStyle,
  // Reactions
  reactions: {
    marginTop: spacing.xs,
    flexDirection: 'row',
  } as ViewStyle,
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgModifierHover,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginRight: spacing.xs,
    gap: 4,
  } as ViewStyle,
  reactionChipActive: {
    backgroundColor: 'rgba(88, 101, 242, 0.3)',
    borderWidth: 1,
    borderColor: colors.brandColor,
  } as ViewStyle,
  reactionEmoji: {
    fontSize: 16,
  } as TextStyle,
  reactionCustomEmoji: {
    width: 16,
    height: 16,
  } as ImageStyle,
  reactionCount: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
  reactionCountActive: {
    color: colors.brandColor,
  } as TextStyle,
  systemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  systemDot: {
    color: colors.textMuted,
    fontSize: 12,
  } as TextStyle,
  systemText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    flexShrink: 1,
  } as TextStyle,
  systemAuthor: {
    color: colors.headerPrimary,
    fontWeight: '600',
  } as TextStyle,
  systemTime: {
    marginLeft: 'auto',
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
});
