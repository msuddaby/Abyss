import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { api, getApiBase, useServerStore } from '@abyss/shared';
import type { User } from '@abyss/shared';
import Modal from './Modal';
import Avatar from './Avatar';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

interface Props {
  userId: string;
}

export default function UserProfileCard({ userId }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const members = useServerStore((s) => s.members);
  const member = members.find((m) => m.userId === userId);

  useEffect(() => {
    api.get(`/auth/profile/${userId}`).then((res) => setUser(res.data)).catch(console.error);
  }, [userId]);

  const avatarUri = user?.avatarUrl
    ? (user.avatarUrl.startsWith('http') ? user.avatarUrl : `${getApiBase()}${user.avatarUrl}`)
    : undefined;

  const nonDefaultRoles = [...(member?.roles ?? [])]
    .filter((r) => !r.isDefault)
    .sort((a, b) => b.position - a.position);

  return (
    <Modal title="" maxWidth={340}>
      {!user ? (
        <ActivityIndicator color={colors.bgAccent} size="large" style={{ paddingVertical: spacing.xxl }} />
      ) : (
        <View>
          {/* Banner */}
          <View style={styles.banner} />

          {/* Avatar */}
          <View style={styles.avatarWrap}>
            <Avatar uri={avatarUri} name={user.displayName} size={72} />
          </View>

          {/* Name */}
          <Text style={styles.displayName}>{user.displayName}</Text>
          <Text style={styles.username}>@{user.username}</Text>

          {/* Owner badge */}
          {member?.isOwner && (
            <View style={styles.rolesRow}>
              <View style={[styles.rolePill, { backgroundColor: '#faa61a' }]}>
                <View style={[styles.roleDot, { backgroundColor: '#faa61a' }]} />
                <Text style={[styles.roleText, { color: '#000' }]}>Owner</Text>
              </View>
            </View>
          )}

          {/* Roles */}
          {nonDefaultRoles.length > 0 && (
            <View style={styles.rolesRow}>
              {nonDefaultRoles.map((role) => (
                <View key={role.id} style={[styles.rolePill, { backgroundColor: role.color + '33' }]}>
                  <View style={[styles.roleDot, { backgroundColor: role.color }]} />
                  <Text style={styles.roleText}>{role.name}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Bio */}
          {user.bio ? (
            <View style={styles.bioSection}>
              <Text style={styles.bioLabel}>ABOUT ME</Text>
              <Text style={styles.bioText}>{user.bio}</Text>
            </View>
          ) : null}
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  banner: {
    height: 60,
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.md,
    marginBottom: spacing.xxl,
    marginTop: -spacing.sm,
  } as ViewStyle,
  avatarWrap: {
    marginTop: -56,
    marginBottom: spacing.sm,
    alignItems: 'center',
  } as ViewStyle,
  displayName: {
    color: colors.headerPrimary,
    fontSize: fontSize.xl,
    fontWeight: '700',
    textAlign: 'center',
  } as TextStyle,
  username: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginBottom: spacing.md,
  } as TextStyle,
  rolesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    justifyContent: 'center',
    marginBottom: spacing.sm,
  } as ViewStyle,
  rolePill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    gap: 4,
  } as ViewStyle,
  roleDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  } as ViewStyle,
  roleText: {
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
  bioSection: {
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  } as ViewStyle,
  bioLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  } as TextStyle,
  bioText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  } as TextStyle,
});
