import { View, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore, useDmStore } from '@abyss/shared';
import { colors, spacing, fontSize } from '../theme/tokens';

export default function ContentPlaceholder() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);

  // DM mode with active channel
  if (isDmMode && activeDmChannel) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerIcon}>@</Text>
          <Text style={styles.headerName}>{activeDmChannel.otherUser.displayName}</Text>
        </View>
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>Messages coming in Phase 4</Text>
        </View>
      </View>
    );
  }

  // Server channel selected
  if (activeChannel) {
    const isVoice = activeChannel.type === 'Voice';
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerIcon}>{isVoice ? '🔊' : '#'}</Text>
          <Text style={styles.headerName}>{activeChannel.name}</Text>
        </View>
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>
            {isVoice ? 'Voice view coming in Phase 6' : 'Messages coming in Phase 4'}
          </Text>
        </View>
      </View>
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
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  placeholderText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
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
