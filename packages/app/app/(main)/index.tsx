import { View, Text, Platform, KeyboardAvoidingView, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore, useDmStore } from '@abyss/shared';
import MessageList from '../../src/components/MessageList';
import MessageInput from '../../src/components/MessageInput';
import TypingIndicator from '../../src/components/TypingIndicator';
import VoiceView from '../../src/components/VoiceView';
import { colors, spacing, fontSize } from '../../src/theme/tokens';

export default function HomeScreen() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);

  // DM mode with active channel
  if (isDmMode && activeDmChannel) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={styles.header}>
          <Text style={styles.headerIcon}>@</Text>
          <Text style={styles.headerName}>{activeDmChannel.otherUser.displayName}</Text>
        </View>
        <MessageList />
        <TypingIndicator />
        <MessageInput />
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
            <Text style={styles.headerIcon}>🔊</Text>
            <Text style={styles.headerName}>{activeChannel.name}</Text>
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
          <Text style={styles.headerIcon}>#</Text>
          <Text style={styles.headerName}>{activeChannel.name}</Text>
        </View>
        <MessageList />
        <TypingIndicator />
        <MessageInput />
      </KeyboardAvoidingView>
    );
  }

  // No channel selected
  return (
    <View style={styles.container}>
      <View style={styles.welcome}>
        <Text style={styles.welcomeTitle}>Welcome to Abyss</Text>
        <Text style={styles.welcomeSub}>Select a channel to start chatting</Text>
      </View>
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
    gap: spacing.xs,
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
