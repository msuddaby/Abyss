import { View, Text, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore, useVoiceStore, getApiBase, hasChannelPermission, Permission } from '@abyss/shared';
import type { Channel } from '@abyss/shared';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';
import Avatar from './Avatar';

interface VoiceChannelItemProps {
  channel: Channel;
  isActive: boolean;
  isConnected: boolean;
  onSelect: () => void;
  onJoin: () => void;
  onLeave: () => void;
}

export default function VoiceChannelItem({ channel, isActive, isConnected, onSelect, onJoin, onLeave }: VoiceChannelItemProps) {
  const voiceChannelUsers = useServerStore((s) => s.voiceChannelUsers);
  const voiceChannelSharers = useServerStore((s) => s.voiceChannelSharers);
  const members = useServerStore((s) => s.members);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);

  const channelUsers = voiceChannelUsers.get(channel.id);
  const channelSharers = voiceChannelSharers.get(channel.id);
  const participants = channelUsers ? Array.from(channelUsers.entries()) : [];
  const canConnect = hasChannelPermission(channel.permissions, Permission.Connect);

  return (
    <View style={[styles.container, isActive && styles.containerActive]}>
      <View style={styles.header}>
        <Pressable style={styles.nameRow} onPress={onSelect}>
          <Text style={styles.voiceIcon}>{'🔊'}</Text>
          <Text style={styles.name} numberOfLines={1}>{channel.name}</Text>
        </Pressable>
        {isConnected ? (
          <Pressable style={styles.leaveBtn} onPress={onLeave}>
            <Text style={styles.leaveBtnText}>{'✕'}</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.joinBtn, !canConnect && styles.joinBtnDisabled]} onPress={onJoin} disabled={!canConnect}>
            <Text style={styles.joinBtnText}>{'→'}</Text>
          </Pressable>
        )}
      </View>
      {participants.length > 0 && (
        <View style={styles.participants}>
          {participants.map(([userId, state]) => {
            const isSpeaking = speakingUsers.has(userId);
            const isSharing = channelSharers?.has(userId);
            const targetMember = members.find((m) => m.userId === userId);
            const avatarUrl = targetMember?.user?.avatarUrl
              ? (targetMember.user.avatarUrl.startsWith('http') ? targetMember.user.avatarUrl : `${getApiBase()}${targetMember.user.avatarUrl}`)
              : undefined;
            return (
              <View key={userId} style={styles.participant}>
                <View style={[styles.avatarWrapper, isSpeaking && styles.avatarSpeaking]}>
                  <Avatar uri={avatarUrl} name={state.displayName} size={20} />
                </View>
                <Text style={styles.participantName} numberOfLines={1}>{state.displayName}</Text>
                {(state.isMuted || state.isDeafened) && (
                  <View style={styles.statusIcons}>
                    {state.isMuted && <Text style={styles.statusIcon}>🔇</Text>}
                    {state.isDeafened && <Text style={styles.statusIcon}>🎧</Text>}
                  </View>
                )}
                {isSharing && (
                  <View style={styles.liveBadge}>
                    <Text style={styles.liveBadgeText}>LIVE</Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    paddingVertical: 4,
  } as ViewStyle,
  containerActive: {
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
  } as ViewStyle,
  nameRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,
  voiceIcon: {
    fontSize: 14,
  } as TextStyle,
  name: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    flex: 1,
  } as TextStyle,
  joinBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  } as ViewStyle,
  joinBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  joinBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  } as TextStyle,
  leaveBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  } as ViewStyle,
  leaveBtnText: {
    color: colors.danger,
    fontSize: fontSize.md,
  } as TextStyle,
  participants: {
    paddingLeft: 32,
    paddingTop: 2,
    gap: 2,
  } as ViewStyle,
  participant: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 2,
  } as ViewStyle,
  avatarWrapper: {
    width: 20,
    height: 20,
    borderRadius: 10,
  } as ViewStyle,
  avatarSpeaking: {
    borderWidth: 2,
    borderColor: colors.success,
  } as ViewStyle,
  participantName: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
  } as TextStyle,
  statusIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,
  statusIcon: {
    fontSize: 12,
    color: colors.textMuted,
  } as TextStyle,
  liveBadge: {
    backgroundColor: colors.danger,
    borderRadius: borderRadius.sm,
    paddingHorizontal: 4,
    paddingVertical: 1,
  } as ViewStyle,
  liveBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  } as TextStyle,
});
