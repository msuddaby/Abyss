import { View, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { colors, fontSize } from '../theme/tokens';

interface BadgeProps {
  count?: number;
  dot?: boolean;
  style?: ViewStyle;
}

export default function Badge({ count, dot, style }: BadgeProps) {
  if (dot) {
    return <View style={[styles.dot, style]} />;
  }
  if (!count || count <= 0) return null;
  const label = count > 99 ? '99+' : String(count);
  return (
    <View style={[styles.pill, style]}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.headerPrimary,
  } as ViewStyle,
  pill: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  } as ViewStyle,
  pillText: {
    color: '#ffffff',
    fontSize: fontSize.xs,
    fontWeight: '700',
  } as TextStyle,
});
