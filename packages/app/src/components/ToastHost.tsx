import { View, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useToastStore } from '@abyss/shared';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  const insets = useSafeAreaInsets();

  if (toasts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={[styles.container, { top: insets.top + spacing.sm }]}>
      {toasts.map((t) => (
        <View
          key={t.id}
          style={[styles.toast, t.type === 'error' ? styles.error : t.type === 'success' ? styles.success : styles.info]}
        >
          <Text style={styles.toastText} onPress={() => removeToast(t.id)}>
            {t.message}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    gap: spacing.xs,
    zIndex: 999,
  } as ViewStyle,
  toast: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
  } as ViewStyle,
  toastText: {
    color: '#ffffff',
    fontSize: fontSize.sm,
  } as TextStyle,
  error: {
    backgroundColor: colors.danger,
  } as ViewStyle,
  success: {
    backgroundColor: colors.success,
  } as ViewStyle,
  info: {
    backgroundColor: colors.brandColor,
  } as ViewStyle,
});
