import { View, Text, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { getApiBase, getDisplayColor, getHighestRole } from '@abyss/shared';
import type { ServerMember } from '@abyss/shared';
import Avatar from './Avatar';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

interface MemberItemProps {
  member: ServerMember;
  isOnline: boolean;
  onPress?: () => void;
}

export default function MemberItem({ member, isOnline, onPress }: MemberItemProps) {
  const displayColor = getDisplayColor(member);
  const highestRole = getHighestRole(member);
  const avatarUri = member.user.avatarUrl
    ? (member.user.avatarUrl.startsWith('http') ? member.user.avatarUrl : `${getApiBase()}${member.user.avatarUrl}`)
    : undefined;

  return (
    <Pressable
      style={[styles.container, !isOnline && styles.offline]}
      onPress={onPress}
    >
      <Avatar uri={avatarUri} name={member.user.displayName} size={32} online={isOnline} />
      <Text
        style={[styles.name, displayColor ? { color: displayColor } : undefined]}
        numberOfLines={1}
      >
        {member.user.displayName}
      </Text>
      {member.isOwner && (
        <View style={[styles.badge, { backgroundColor: '#faa61a' }]}>
          <Text style={[styles.badgeText, { color: '#000' }]}>Owner</Text>
        </View>
      )}
      {!member.isOwner && highestRole && (
        <View style={[styles.badge, { backgroundColor: highestRole.color }]}>
          <Text style={styles.badgeText}>{highestRole.name}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    gap: spacing.sm,
  } as ViewStyle,
  offline: {
    opacity: 0.4,
  } as ViewStyle,
  name: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    flex: 1,
  } as TextStyle,
  badge: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  } as ViewStyle,
  badgeText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
});
