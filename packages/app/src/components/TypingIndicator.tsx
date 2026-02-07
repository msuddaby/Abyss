import { View, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { usePresenceStore } from '@abyss/shared';
import { colors, spacing, fontSize } from '../theme/tokens';

export default function TypingIndicator() {
  const typingUsers = usePresenceStore((s) => s.typingUsers);

  if (typingUsers.size === 0) {
    return <View style={styles.container} />;
  }

  const names = Array.from(typingUsers.values()).map((u) => u.displayName);
  let text: string;
  if (names.length === 1) {
    text = `${names[0]} is typing...`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing...`;
  } else {
    text = `${names[0]} and ${names.length - 1} others are typing...`;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 24,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  } as ViewStyle,
  text: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontStyle: 'italic',
  } as TextStyle,
});
