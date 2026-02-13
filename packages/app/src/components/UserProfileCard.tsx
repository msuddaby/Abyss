import { useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert, Image, StyleSheet, type ViewStyle, type TextStyle, type ImageStyle } from 'react-native';
import { api, getApiBase, useServerStore, useFriendStore, useAuthStore, usePresenceStore, getNameplateStyle } from '@abyss/shared';
import type { User } from '@abyss/shared';
import Modal from './Modal';
import Avatar from './Avatar';
import { cssToRNTextStyle } from '../utils/cssToRNStyle';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

interface Props {
  userId: string;
}

export default function UserProfileCard({ userId }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [friendStatus, setFriendStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const members = useServerStore((s) => s.members);
  const member = members.find((m) => m.userId === userId);
  const currentUser = useAuthStore((s) => s.user);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const friends = useFriendStore((s) => s.friends);
  const requests = useFriendStore((s) => s.requests);
  const sendRequest = useFriendStore((s) => s.sendRequest);
  const acceptRequest = useFriendStore((s) => s.acceptRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);

  const isSelf = currentUser?.id === userId;
  const isOnline = onlineUsers.has(userId);

  useEffect(() => {
    api.get(`/auth/profile/${userId}`).then((res) => setUser(res.data)).catch(console.error);
  }, [userId]);

  // Determine friend status
  useEffect(() => {
    const friendship = friends.find((f) => f.user.id === userId);
    if (friendship) {
      setFriendStatus('friends');
      return;
    }
    const outgoing = requests.find((r) => r.user.id === userId && r.isOutgoing);
    if (outgoing) {
      setFriendStatus('outgoing');
      return;
    }
    const incoming = requests.find((r) => r.user.id === userId && !r.isOutgoing);
    if (incoming) {
      setFriendStatus('incoming');
      return;
    }
    setFriendStatus(null);
  }, [friends, requests, userId]);

  const handleSendRequest = async () => {
    setLoading(true);
    try {
      await sendRequest(userId);
      setFriendStatus('outgoing');
    } catch {}
    setLoading(false);
  };

  const handleAcceptRequest = async () => {
    const req = requests.find((r) => r.user.id === userId && !r.isOutgoing);
    if (!req) return;
    setLoading(true);
    try {
      await acceptRequest(req.id);
      setFriendStatus('friends');
    } catch {}
    setLoading(false);
  };

  const handleRemoveFriend = () => {
    const friendship = friends.find((f) => f.user.id === userId);
    if (!friendship) return;
    Alert.alert('Remove Friend', `Remove ${user?.displayName ?? 'this user'} as a friend?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          setLoading(true);
          try {
            await removeFriend(friendship.id);
            setFriendStatus(null);
          } catch {}
          setLoading(false);
        }
      },
    ]);
  };

  const avatarUri = user?.avatarUrl
    ? (user.avatarUrl.startsWith('http') ? user.avatarUrl : `${getApiBase()}${user.avatarUrl}`)
    : undefined;

  const nonDefaultRoles = [...(member?.roles ?? [])]
    .filter((r) => !r.isDefault)
    .sort((a, b) => b.position - a.position);

  // Cosmetics
  const nameplateCSS = user ? getNameplateStyle(user) : undefined;
  const nameplateRN = cssToRNTextStyle(nameplateCSS as Record<string, any> | undefined);

  // Avatar decoration
  const avatarDecoration = (user as any)?.cosmetics?.avatarDecoration;
  const decorationUri = avatarDecoration?.imageUrl
    ? (avatarDecoration.imageUrl.startsWith('http') ? avatarDecoration.imageUrl : `${getApiBase()}${avatarDecoration.imageUrl}`)
    : undefined;

  return (
    <Modal title="" maxWidth={340}>
      {!user ? (
        <ActivityIndicator color={colors.bgAccent} size="large" style={{ paddingVertical: spacing.xxl }} />
      ) : (
        <View>
          {/* Banner */}
          <View style={styles.banner} />

          {/* Avatar with decoration */}
          <View style={styles.avatarWrap}>
            <View style={styles.avatarContainer}>
              <Avatar uri={avatarUri} name={user.displayName} size={72} online={isOnline} />
              {decorationUri && (
                <Image source={{ uri: decorationUri }} style={styles.avatarDecoration} />
              )}
            </View>
          </View>

          {/* Name */}
          <Text style={[styles.displayName, nameplateRN]}>{user.displayName}</Text>
          <Text style={styles.username}>@{user.username}</Text>

          {/* Friend actions */}
          {!isSelf && (
            <View style={styles.friendActions}>
              {friendStatus === null && (
                <Pressable style={styles.friendBtn} onPress={handleSendRequest} disabled={loading}>
                  <Text style={styles.friendBtnText}>Add Friend</Text>
                </Pressable>
              )}
              {friendStatus === 'outgoing' && (
                <View style={styles.friendPending}>
                  <Text style={styles.friendPendingText}>Request Sent</Text>
                </View>
              )}
              {friendStatus === 'incoming' && (
                <Pressable style={styles.friendBtn} onPress={handleAcceptRequest} disabled={loading}>
                  <Text style={styles.friendBtnText}>Accept Request</Text>
                </Pressable>
              )}
              {friendStatus === 'friends' && (
                <Pressable style={styles.friendRemoveBtn} onPress={handleRemoveFriend} disabled={loading}>
                  <Text style={styles.friendRemoveBtnText}>Remove Friend</Text>
                </Pressable>
              )}
            </View>
          )}

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

          {/* Equipped cosmetics */}
          {(user as any)?.cosmetics && (
            <View style={styles.cosmeticsSection}>
              {(user as any).cosmetics.nameplate && (
                <View style={styles.cosmeticItem}>
                  <Text style={styles.cosmeticLabel}>Nameplate</Text>
                  <Text style={styles.cosmeticName}>{(user as any).cosmetics.nameplate.name}</Text>
                </View>
              )}
              {(user as any).cosmetics.messageStyle && (
                <View style={styles.cosmeticItem}>
                  <Text style={styles.cosmeticLabel}>Message Style</Text>
                  <Text style={styles.cosmeticName}>{(user as any).cosmetics.messageStyle.name}</Text>
                </View>
              )}
              {avatarDecoration && (
                <View style={styles.cosmeticItem}>
                  <Text style={styles.cosmeticLabel}>Avatar Decoration</Text>
                  <Text style={styles.cosmeticName}>{avatarDecoration.name}</Text>
                </View>
              )}
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
  avatarContainer: {
    position: 'relative',
  } as ViewStyle,
  avatarDecoration: {
    position: 'absolute',
    top: -8,
    left: -8,
    width: 88,
    height: 88,
  } as ImageStyle,
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
  friendActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: spacing.md,
  } as ViewStyle,
  friendBtn: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  friendBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  friendPending: {
    backgroundColor: colors.bgModifierHover,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  friendPendingText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  friendRemoveBtn: {
    backgroundColor: colors.danger,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  friendRemoveBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
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
  cosmeticsSection: {
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    marginBottom: spacing.sm,
  } as ViewStyle,
  cosmeticItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  } as ViewStyle,
  cosmeticLabel: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
  cosmeticName: {
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    fontWeight: '500',
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
