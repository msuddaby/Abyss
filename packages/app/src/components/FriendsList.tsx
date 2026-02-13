import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  ActivityIndicator,
  SectionList,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  useFriendStore,
  usePresenceStore,
  useDmStore,
  getApiBase,
} from '@abyss/shared';
import type { Friendship, FriendRequest } from '@abyss/shared';
import Modal from './Modal';
import Avatar from './Avatar';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

type SectionItem =
  | { kind: 'incoming'; data: FriendRequest }
  | { kind: 'outgoing'; data: FriendRequest }
  | { kind: 'friend'; data: Friendship };

export default function FriendsList() {
  const friends = useFriendStore((s) => s.friends);
  const requests = useFriendStore((s) => s.requests);
  const fetchFriends = useFriendStore((s) => s.fetchFriends);
  const fetchRequests = useFriendStore((s) => s.fetchRequests);
  const acceptRequest = useFriendStore((s) => s.acceptRequest);
  const declineRequest = useFriendStore((s) => s.declineRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const closeModal = useUiStore((s) => s.closeModal);

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchFriends(), fetchRequests()])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchFriends, fetchRequests]);

  const incoming = requests.filter((r) => !r.isOutgoing);
  const outgoing = requests.filter((r) => r.isOutgoing);

  const lowerSearch = search.toLowerCase();
  const filteredFriends = friends.filter(
    (f) =>
      f.user.displayName.toLowerCase().includes(lowerSearch) ||
      f.user.username.toLowerCase().includes(lowerSearch),
  );

  const sections: { title: string; data: SectionItem[] }[] = [];

  if (incoming.length > 0) {
    sections.push({
      title: `INCOMING REQUESTS \u2014 ${incoming.length}`,
      data: incoming.map((r) => ({ kind: 'incoming' as const, data: r })),
    });
  }
  if (outgoing.length > 0) {
    sections.push({
      title: `OUTGOING REQUESTS \u2014 ${outgoing.length}`,
      data: outgoing.map((r) => ({ kind: 'outgoing' as const, data: r })),
    });
  }
  sections.push({
    title: `FRIENDS \u2014 ${filteredFriends.length}`,
    data: filteredFriends.map((f) => ({ kind: 'friend' as const, data: f })),
  });

  const getAvatarUri = (avatarUrl?: string): string | undefined => {
    if (!avatarUrl) return undefined;
    return avatarUrl.startsWith('http') ? avatarUrl : `${getApiBase()}${avatarUrl}`;
  };

  const handleOpenDm = async (userId: string) => {
    try {
      const dm = await useDmStore.getState().createOrGetDm(userId);
      useDmStore.getState().enterDmMode();
      useDmStore.getState().setActiveDmChannel(dm);
      closeModal();
    } catch {
      Alert.alert('Error', 'Could not open DM.');
    }
  };

  const handleRemoveFriend = (friendship: Friendship) => {
    Alert.alert(
      'Remove Friend',
      `Are you sure you want to remove ${friendship.user.displayName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeFriend(friendship.id).catch(() => {}),
        },
      ],
    );
  };

  const handleDecline = (id: string) => {
    declineRequest(id).catch(() => {});
  };

  const handleAccept = (id: string) => {
    acceptRequest(id).catch(() => {});
  };

  const renderItem = ({ item }: { item: SectionItem }) => {
    if (item.kind === 'incoming') {
      const req = item.data;
      return (
        <View style={styles.row}>
          <Avatar
            uri={getAvatarUri(req.user.avatarUrl)}
            name={req.user.displayName}
            size={40}
          />
          <View style={styles.rowInfo}>
            <Text style={styles.displayName} numberOfLines={1}>{req.user.displayName}</Text>
            <Text style={styles.username} numberOfLines={1}>{req.user.username}</Text>
          </View>
          <Pressable style={styles.acceptBtn} onPress={() => handleAccept(req.id)}>
            <Text style={styles.acceptBtnText}>Accept</Text>
          </Pressable>
          <Pressable style={styles.declineBtn} onPress={() => handleDecline(req.id)}>
            <Text style={styles.declineBtnText}>Decline</Text>
          </Pressable>
        </View>
      );
    }

    if (item.kind === 'outgoing') {
      const req = item.data;
      return (
        <View style={styles.row}>
          <Avatar
            uri={getAvatarUri(req.user.avatarUrl)}
            name={req.user.displayName}
            size={40}
          />
          <View style={styles.rowInfo}>
            <Text style={styles.displayName} numberOfLines={1}>{req.user.displayName}</Text>
            <Text style={styles.username} numberOfLines={1}>{req.user.username}</Text>
          </View>
          <Pressable style={styles.declineBtn} onPress={() => handleDecline(req.id)}>
            <Text style={styles.declineBtnText}>Cancel</Text>
          </Pressable>
        </View>
      );
    }

    const friendship = item.data;
    const isOnline = onlineUsers.has(friendship.user.id);
    return (
      <View style={styles.row}>
        <Avatar
          uri={getAvatarUri(friendship.user.avatarUrl)}
          name={friendship.user.displayName}
          size={40}
          online={isOnline}
        />
        <View style={styles.rowInfo}>
          <Text style={styles.displayName} numberOfLines={1}>{friendship.user.displayName}</Text>
          <Text style={styles.username} numberOfLines={1}>{friendship.user.username}</Text>
        </View>
        <Pressable style={styles.messageBtn} onPress={() => handleOpenDm(friendship.user.id)}>
          <Text style={styles.messageBtnText}>Message</Text>
        </Pressable>
        <Pressable style={styles.removeBtn} onPress={() => handleRemoveFriend(friendship)}>
          <Text style={styles.removeBtnText}>Remove</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <Modal title="Friends">
      {/* Search */}
      <View style={styles.searchWrapper}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search friends..."
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => `${item.kind}-${item.data.id}`}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No friends yet. Add some!</Text>
          }
          contentContainerStyle={styles.listContent}
        />
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  searchWrapper: {
    marginBottom: spacing.md,
  } as ViewStyle,
  searchInput: {
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    color: colors.textPrimary,
  } as TextStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  } as ViewStyle,
  loadingText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  } as TextStyle,
  listContent: {
    paddingBottom: spacing.lg,
  } as ViewStyle,
  sectionHeader: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  } as TextStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  } as ViewStyle,
  rowInfo: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  displayName: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  username: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  } as TextStyle,
  acceptBtn: {
    backgroundColor: colors.success,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  acceptBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  declineBtn: {
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  declineBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  messageBtn: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  messageBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  removeBtn: {
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  removeBtnText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  } as TextStyle,
});
