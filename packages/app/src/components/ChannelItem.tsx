import { View, Text, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import Badge from './Badge';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

interface ChannelItemProps {
  name: string;
  isActive: boolean;
  hasUnread: boolean;
  mentionCount: number;
  onPress: () => void;
}

export default function ChannelItem({ name, isActive, hasUnread, mentionCount, onPress }: ChannelItemProps) {
  return (
    <View style={styles.wrapper}>
      {hasUnread && <Badge dot style={styles.unreadDot} />}
      <Pressable
        style={[styles.item, isActive && styles.itemActive]}
        onPress={onPress}
      >
        <Text style={styles.hash}>#</Text>
        <Text style={[styles.name, hasUnread && styles.nameUnread]} numberOfLines={1}>
          {name}
        </Text>
        {mentionCount > 0 && !isActive && (
          <Badge count={mentionCount} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
  } as ViewStyle,
  unreadDot: {
    position: 'absolute',
    left: 0,
    zIndex: 1,
  } as ViewStyle,
  item: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    marginHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    gap: spacing.xs,
  } as ViewStyle,
  itemActive: {
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  hash: {
    color: colors.textMuted,
    fontSize: fontSize.lg,
    fontWeight: '500',
    width: 20,
  } as TextStyle,
  name: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    flex: 1,
  } as TextStyle,
  nameUnread: {
    color: colors.headerPrimary,
    fontWeight: '600',
  } as TextStyle,
});
