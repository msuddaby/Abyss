import { View, Text, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useVoiceStore, useAuthStore, getApiBase } from '@abyss/shared';
import Avatar from './Avatar';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function UserBar() {
  const user = useAuthStore((s) => s.user);
  const isSysadmin = useAuthStore((s) => s.isSysadmin);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const openModal = useUiStore((s) => s.openModal);

  if (!user) return null;

  const avatarUri = user.avatarUrl
    ? (user.avatarUrl.startsWith('http') ? user.avatarUrl : `${getApiBase()}${user.avatarUrl}`)
    : undefined;

  return (
    <View style={styles.container}>
      <Avatar uri={avatarUri} name={user.displayName} size={32} />
      <View style={styles.info}>
        <Text style={styles.displayName} numberOfLines={1}>{user.displayName}</Text>
        <Text style={styles.username} numberOfLines={1}>{user.username}</Text>
      </View>
      <Pressable
        style={[styles.btn, isMuted && styles.btnActive]}
        onPress={toggleMute}
      >
        <Text style={styles.btnText}>{isMuted ? '🔇' : '🎤'}</Text>
      </Pressable>
      <Pressable
        style={[styles.btn, isDeafened && styles.btnActive]}
        onPress={toggleDeafen}
      >
        <Text style={styles.btnText}>{isDeafened ? '🔇' : '🎧'}</Text>
      </Pressable>
      {isSysadmin && (
        <Pressable
          style={styles.btn}
          onPress={() => openModal('admin')}
        >
          <Text style={styles.btnText}>{'🛡'}</Text>
        </Pressable>
      )}
      <Pressable
        style={styles.btn}
        onPress={() => openModal('userSettings')}
      >
        <Text style={styles.btnText}>{'⚙'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgTertiary,
    gap: spacing.xs,
  } as ViewStyle,
  info: {
    flex: 1,
    marginLeft: spacing.xs,
  } as ViewStyle,
  displayName: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  username: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  } as TextStyle,
  btn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  btnActive: {
    backgroundColor: colors.bgModifierActive,
    borderRadius: borderRadius.sm,
  } as ViewStyle,
  btnText: {
    fontSize: 16,
  } as TextStyle,
});
