import { useState, useCallback } from 'react';
import { View, Text, Pressable, Platform, KeyboardAvoidingView, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore, useDmStore, useMessageStore } from '@abyss/shared';
import MessageList from '../../src/components/MessageList';
import MessageInput from '../../src/components/MessageInput';
import TypingIndicator from '../../src/components/TypingIndicator';
import VoiceView from '../../src/components/VoiceView';
import EmojiPicker, { type EmojiSelection } from '../../src/components/EmojiPicker';
import { useUiStore } from '../../src/stores/uiStore';
import { colors, spacing, fontSize } from '../../src/theme/tokens';

export default function HomeScreen() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);
  const toggleReaction = useMessageStore((s) => s.toggleReaction);
  const activeServer = useServerStore((s) => s.activeServer);
  const toggleLeftDrawer = useUiStore((s) => s.toggleLeftDrawer);
  const toggleRightDrawer = useUiStore((s) => s.toggleRightDrawer);
  const openModal = useUiStore((s) => s.openModal);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [reactionTargetId, setReactionTargetId] = useState<string | null>(null);
  const showMembersButton = !!activeServer && !isDmMode;

  const handlePickReactionEmoji = useCallback((messageId: string) => {
    setReactionTargetId(messageId);
    setShowReactionPicker(true);
  }, []);

  const handleSelectReactionEmoji = useCallback((emoji: EmojiSelection) => {
    if (!reactionTargetId) return;
    const value = emoji.type === 'custom' ? `custom:${emoji.id}` : emoji.emoji;
    toggleReaction(reactionTargetId, value);
    setShowReactionPicker(false);
    setReactionTargetId(null);
  }, [reactionTargetId, toggleReaction]);

  // DM mode with active channel
  if (isDmMode && activeDmChannel) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={styles.header}>
          <Pressable style={styles.headerButton} onPress={toggleLeftDrawer}>
            <Text style={styles.headerButtonText}>{'☰'}</Text>
          </Pressable>
          <Text style={styles.headerIcon}>@</Text>
          <Text style={styles.headerName}>{activeDmChannel.otherUser.displayName}</Text>
          <View style={styles.headerActions}>
            <Pressable
              style={styles.headerActionButton}
              onPress={() => openModal('pins', { channelId: activeDmChannel.id })}
            >
              <Text style={styles.headerButtonText}>{'📌'}</Text>
            </Pressable>
          </View>
        </View>
        <MessageList onPickReactionEmoji={handlePickReactionEmoji} />
        <TypingIndicator />
        <MessageInput />
        <EmojiPicker
          open={showReactionPicker}
          onClose={() => setShowReactionPicker(false)}
          onSelect={handleSelectReactionEmoji}
          title="Add Reaction"
        />
      </KeyboardAvoidingView>
    );
  }

  // Server channel selected
  if (activeChannel) {
    const isVoice = activeChannel.type === 'Voice';

    if (isVoice) {
      return (
        <View style={styles.container}>
        <View style={styles.header}>
          <Pressable style={styles.headerButton} onPress={toggleLeftDrawer}>
            <Text style={styles.headerButtonText}>{'☰'}</Text>
          </Pressable>
          <Text style={styles.headerIcon}>🔊</Text>
          <Text style={styles.headerName}>{activeChannel.name}</Text>
          <View style={styles.headerActions}>
            {showMembersButton && (
              <Pressable style={styles.headerActionButton} onPress={toggleRightDrawer}>
                <Text style={styles.headerButtonText}>{'👥'}</Text>
              </Pressable>
            )}
          </View>
        </View>
          <VoiceView />
        </View>
      );
    }

    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={styles.header}>
          <Pressable style={styles.headerButton} onPress={toggleLeftDrawer}>
            <Text style={styles.headerButtonText}>{'☰'}</Text>
          </Pressable>
          <Text style={styles.headerIcon}>#</Text>
          <Text style={styles.headerName}>{activeChannel.name}</Text>
          <View style={styles.headerActions}>
            <Pressable
              style={styles.headerActionButton}
              onPress={() => openModal('pins', { channelId: activeChannel.id })}
            >
              <Text style={styles.headerButtonText}>{'📌'}</Text>
            </Pressable>
            {showMembersButton && (
              <Pressable style={styles.headerActionButton} onPress={toggleRightDrawer}>
                <Text style={styles.headerButtonText}>{'👥'}</Text>
              </Pressable>
            )}
          </View>
        </View>
        <MessageList onPickReactionEmoji={handlePickReactionEmoji} />
        <TypingIndicator />
        <MessageInput />
        <EmojiPicker
          open={showReactionPicker}
          onClose={() => setShowReactionPicker(false)}
          onSelect={handleSelectReactionEmoji}
          title="Add Reaction"
        />
      </KeyboardAvoidingView>
    );
  }

  // No channel selected
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.headerButton} onPress={toggleLeftDrawer}>
          <Text style={styles.headerButtonText}>{'☰'}</Text>
        </Pressable>
        <Text style={styles.headerName}>Abyss</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.welcome}>
        <Text style={styles.welcomeTitle}>Welcome to Abyss</Text>
        <Text style={styles.welcomeSub}>Select a channel to start chatting</Text>
      </View>
      <EmojiPicker
        open={showReactionPicker}
        onClose={() => setShowReactionPicker(false)}
        onSelect={handleSelectReactionEmoji}
        title="Add Reaction"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
    gap: spacing.xs,
  } as ViewStyle,
  headerButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  headerActions: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,
  headerActionButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  headerButtonText: {
    color: colors.textSecondary,
    fontSize: fontSize.lg,
  } as TextStyle,
  headerSpacer: {
    marginLeft: 'auto',
  } as ViewStyle,
  headerIcon: {
    color: colors.textMuted,
    fontSize: fontSize.lg,
    fontWeight: '500',
  } as TextStyle,
  headerName: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '700',
    flex: 1,
  } as TextStyle,
  welcome: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  welcomeTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.xl,
    fontWeight: '700',
    marginBottom: spacing.sm,
  } as TextStyle,
  welcomeSub: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  } as TextStyle,
});
