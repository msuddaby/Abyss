import { useEffect } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore, useDmStore, useUnreadStore } from '@abyss/shared';
import Avatar from './Avatar';
import Badge from './Badge';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius } from '../theme/tokens';

export default function ServerSidebar() {
  const servers = useServerStore((s) => s.servers);
  const activeServer = useServerStore((s) => s.activeServer);
  const fetchServers = useServerStore((s) => s.fetchServers);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const enterDmMode = useDmStore((s) => s.enterDmMode);
  const exitDmMode = useDmStore((s) => s.exitDmMode);
  const fetchDmChannels = useDmStore((s) => s.fetchDmChannels);
  const serverUnreads = useUnreadStore((s) => s.serverUnreads);
  const dmUnreads = useUnreadStore((s) => s.dmUnreads);
  const closeLeftDrawer = useUiStore((s) => s.closeLeftDrawer);
  const openModal = useUiStore((s) => s.openModal);

  useEffect(() => {
    fetchServers();
  }, []);

  const dmUnread = (() => {
    let hasUnread = false;
    let mentionCount = 0;
    for (const [, val] of dmUnreads) {
      if (val.hasUnread) hasUnread = true;
      mentionCount += val.mentionCount;
    }
    return { hasUnread, mentionCount };
  })();

  const handleDmPress = () => {
    enterDmMode();
    useServerStore.getState().clearActiveServer();
    fetchDmChannels();
  };

  const handleServerPress = (server: typeof servers[0]) => {
    exitDmMode();
    setActiveServer(server);
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {/* DM button */}
        <View style={styles.iconWrapper}>
          {dmUnread.hasUnread && !isDmMode && (
            <Badge dot style={styles.unreadDot} />
          )}
          <Pressable
            style={[styles.icon, isDmMode && styles.iconActive]}
            onPress={handleDmPress}
          >
            <Text style={styles.iconText}>DM</Text>
          </Pressable>
          {dmUnread.mentionCount > 0 && (
            <Badge count={dmUnread.mentionCount} style={styles.mentionBadge} />
          )}
        </View>

        <View style={styles.separator} />

        {/* Server icons */}
        {servers.map((server) => {
          const unread = serverUnreads.get(server.id);
          const hasUnread = unread?.hasUnread && activeServer?.id !== server.id;
          const mentionCount = unread?.mentionCount || 0;
          const isActive = activeServer?.id === server.id;

          return (
            <View key={server.id} style={styles.iconWrapper}>
              {hasUnread && <Badge dot style={styles.unreadDot} />}
              <Pressable
                style={[styles.icon, isActive && styles.iconActive]}
                onPress={() => handleServerPress(server)}
              >
                <Avatar
                  uri={server.iconUrl}
                  name={server.name}
                  size={48}
                />
              </Pressable>
              {mentionCount > 0 && (
                <Badge count={mentionCount} style={styles.mentionBadge} />
              )}
            </View>
          );
        })}
      </ScrollView>

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable style={styles.actionIcon} onPress={() => openModal('createServer')}>
          <Text style={styles.actionText}>+</Text>
        </Pressable>
        <Pressable style={styles.actionIcon} onPress={() => openModal('joinServer')}>
          <Text style={styles.actionText}>{'↗'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 72,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  } as ViewStyle,
  list: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  } as ViewStyle,
  iconWrapper: {
    position: 'relative',
    alignItems: 'center',
  } as ViewStyle,
  icon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  } as ViewStyle,
  iconActive: {
    borderRadius: borderRadius.lg,
    backgroundColor: colors.bgAccent,
  } as ViewStyle,
  iconText: {
    color: colors.headerPrimary,
    fontWeight: '700',
    fontSize: 14,
  } as TextStyle,
  separator: {
    width: 32,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.bgPrimary,
  } as ViewStyle,
  unreadDot: {
    position: 'absolute',
    left: -2,
    top: '50%',
    zIndex: 1,
  } as ViewStyle,
  mentionBadge: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    zIndex: 1,
  } as ViewStyle,
  actions: {
    marginTop: 'auto',
    gap: spacing.sm,
    alignItems: 'center',
    paddingTop: spacing.sm,
  } as ViewStyle,
  actionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  actionText: {
    color: colors.success,
    fontSize: 24,
    fontWeight: '300',
  } as TextStyle,
});
