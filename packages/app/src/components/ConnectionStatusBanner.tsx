import { View, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useSignalRStore } from '@abyss/shared';
import { colors, spacing, fontSize } from '../theme/tokens';

export default function ConnectionStatusBanner() {
  const status = useSignalRStore((s) => s.status);

  if (status === 'connected') return null;

  const isDisconnected = status === 'disconnected';
  const backgroundColor = isDisconnected ? colors.danger : '#faa61a';
  const message = isDisconnected
    ? 'Disconnected - check your connection'
    : 'Reconnecting...';

  return (
    <View style={[styles.banner, { backgroundColor }]}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  text: {
    color: '#ffffff',
    fontSize: fontSize.sm,
    fontWeight: '600',
    textAlign: 'center',
  } as TextStyle,
});
