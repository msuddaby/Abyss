import { View, Text, Pressable, ScrollView, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useVoiceStore, useVoiceChatStore, useAuthStore, useServerStore, getApiBase, hasChannelPermission, Permission } from '@abyss/shared';
import Avatar from './Avatar';
import ScreenShareView from './ScreenShareView';
import Badge from './Badge';
import { useWebRTC } from '../hooks/useWebRTC';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function VoiceView() {
  const participants = useVoiceStore((s) => s.participants);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const isPttActive = useVoiceStore((s) => s.isPttActive);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const speakerOn = useVoiceStore((s) => s.speakerOn);
  const toggleSpeaker = useVoiceStore((s) => s.toggleSpeaker);
  const setPttActive = useVoiceStore((s) => s.setPttActive);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const activeSharers = useVoiceStore((s) => s.activeSharers);
  const watchingUserId = useVoiceStore((s) => s.watchingUserId);
  const unreadCount = useVoiceChatStore((s) => s.unreadCount);
  const user = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const voiceChannelUsers = useServerStore((s) => s.voiceChannelUsers);
  const voiceChannelSharers = useServerStore((s) => s.voiceChannelSharers);
  const { joinVoice, leaveVoice } = useWebRTC();
  const openModal = useUiStore((s) => s.openModal);

  const isConnected = !!activeChannel && currentChannelId === activeChannel.id;
  const isWatching = isConnected && watchingUserId !== null;

  const isPtt = voiceMode === 'push-to-talk';
  const channelUsers = activeChannel ? voiceChannelUsers.get(activeChannel.id) : undefined;
  const channelSharers = activeChannel ? voiceChannelSharers.get(activeChannel.id) : undefined;
  const canConnect = activeChannel ? hasChannelPermission(activeChannel.permissions, Permission.Connect) : false;
  const selfState = user?.id ? channelUsers?.get(user.id) : undefined;
  const isServerMuted = !!selfState?.isServerMuted;
  const isServerDeafened = !!selfState?.isServerDeafened;
  const participantEntries = isConnected
    ? Array.from(participants.entries()).map(([userId, displayName]) => {
        const state = channelUsers?.get(userId) ?? { displayName, isMuted: false, isDeafened: false };
        return [userId, state] as const;
      })
    : Array.from((channelUsers || new Map()).entries());

  const getMemberAvatar = (userId: string): string | undefined => {
    const member = members.find((m) => m.userId === userId);
    if (!member?.user?.avatarUrl) return undefined;
    return member.user.avatarUrl.startsWith('http') ? member.user.avatarUrl : `${getApiBase()}${member.user.avatarUrl}`;
  };

  const handleParticipantLongPress = (userId: string, displayName: string) => {
    if (userId === user?.id) return;
    openModal('volumeControl', { userId, displayName });
  };

  return (
    <View style={styles.container}>
      {isWatching ? (
        <ScreenShareView />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {isConnected && activeSharers.size > 0 && <ScreenShareView />}

          {!isConnected && (
            <View style={styles.notConnectedRow}>
              <Text style={styles.notConnectedText}>Not connected</Text>
            </View>
          )}
          <View style={styles.grid}>
            {participantEntries.map(([userId, state]) => {
              const isSpeaking = isConnected && speakingUsers.has(userId);
              const isSelf = userId === user?.id;
              const memberIsMuted = isSelf ? isMuted : state.isMuted;
              const memberIsDeafened = isSelf ? isDeafened : state.isDeafened;
              const isSharer = isConnected
                ? activeSharers.has(userId)
                : !!channelSharers?.has(userId);

              return (
                <Pressable
                  key={userId}
                  style={styles.card}
                  onLongPress={() => handleParticipantLongPress(userId, state.displayName)}
                >
                  <View style={[styles.avatarRing, isSpeaking && styles.avatarRingSpeaking]}>
                    <Avatar uri={getMemberAvatar(userId)} name={state.displayName} size={64} />
                  </View>
                  {(memberIsMuted || memberIsDeafened) && (
                    <View style={styles.muteOverlay}>
                      {memberIsMuted && <Text style={styles.muteIcon}>🔇</Text>}
                      {memberIsDeafened && <Text style={styles.muteIcon}>🎧</Text>}
                    </View>
                  )}
                  {isSharer && (
                    <View style={styles.liveBadge}>
                      <Text style={styles.liveBadgeText}>LIVE</Text>
                    </View>
                  )}
                  <Text style={styles.participantName} numberOfLines={1}>{state.displayName}</Text>
                </Pressable>
              );
            })}
            {participantEntries.length === 0 && (
              <Text style={styles.emptyText}>No one in voice yet</Text>
            )}
          </View>
        </ScrollView>
      )}

      {isConnected && isPtt && (
        <View style={styles.pttContainer}>
          <Pressable
            style={[styles.pttButton, isPttActive && styles.pttButtonActive]}
            onPressIn={() => setPttActive(true)}
            onPressOut={() => setPttActive(false)}
          >
            <Text style={styles.pttButtonText}>
              {isPttActive ? '🎤 Speaking...' : 'Hold to Talk'}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Secondary action bar: voice chat, soundboard */}
      {isConnected && (
        <View style={styles.secondaryBar}>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => openModal('voiceChat')}
          >
            <Text style={styles.secondaryBtnText}>💬</Text>
            <Text style={styles.secondaryLabel}>Chat</Text>
            {unreadCount > 0 && (
              <View style={styles.unreadBadge}>
                <Badge count={unreadCount} />
              </View>
            )}
          </Pressable>

          <Pressable
            style={styles.secondaryBtn}
            onPress={() => openModal('soundboard')}
          >
            <Text style={styles.secondaryBtnText}>🎵</Text>
            <Text style={styles.secondaryLabel}>Sounds</Text>
          </Pressable>
        </View>
      )}

      {isConnected ? (
        <View style={styles.actionBar}>
          <Pressable
            style={[styles.actionBtn, isMuted && styles.actionBtnActive, isServerMuted && styles.actionBtnDisabled]}
            onPress={toggleMute}
            disabled={isServerMuted}
          >
            <Text style={styles.actionBtnText}>{isMuted ? '🔇' : '🎤'}</Text>
            <Text style={styles.actionLabel}>{isMuted ? 'Unmute' : 'Mute'}</Text>
          </Pressable>

          <Pressable
            style={[styles.actionBtn, isDeafened && styles.actionBtnActive, isServerDeafened && styles.actionBtnDisabled]}
            onPress={toggleDeafen}
            disabled={isServerDeafened}
          >
            <Text style={styles.actionBtnText}>{isDeafened ? '🔈' : '🔊'}</Text>
            <Text style={styles.actionLabel}>{isDeafened ? 'Undeafen' : 'Deafen'}</Text>
          </Pressable>

          <Pressable
            style={[styles.actionBtn, speakerOn && styles.actionBtnActive]}
            onPress={toggleSpeaker}
          >
            <Text style={styles.actionBtnText}>{speakerOn ? '📢' : '📱'}</Text>
            <Text style={styles.actionLabel}>{speakerOn ? 'Speaker' : 'Earpiece'}</Text>
          </Pressable>

          <Pressable
            style={[styles.actionBtn, styles.disconnectBtn]}
            onPress={leaveVoice}
          >
            <Text style={styles.actionBtnText}>📞</Text>
            <Text style={styles.actionLabel}>Leave</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.connectBar}>
          <Pressable
            style={[styles.connectButton, !canConnect && styles.connectButtonDisabled]}
            onPress={() => activeChannel && joinVoice(activeChannel.id)}
            disabled={!canConnect}
          >
            <Text style={styles.connectButtonText}>Connect</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  } as ViewStyle,
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.xl,
    paddingBottom: spacing.xxl,
  } as ViewStyle,
  card: {
    alignItems: 'center',
    width: 96,
    gap: spacing.xs,
  } as ViewStyle,
  avatarRing: {
    borderRadius: 36,
    borderWidth: 3,
    borderColor: 'transparent',
    padding: 2,
  } as ViewStyle,
  avatarRingSpeaking: {
    borderColor: colors.success,
  } as ViewStyle,
  muteOverlay: {
    position: 'absolute',
    top: 46,
    right: 10,
    backgroundColor: colors.bgTertiary,
    borderRadius: 10,
    width: 28,
    height: 20,
    flexDirection: 'row',
    gap: 2,
    paddingHorizontal: 2,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  muteIcon: {
    fontSize: 10,
  } as TextStyle,
  participantName: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '500',
    textAlign: 'center',
  } as TextStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: spacing.xxl,
  } as TextStyle,
  notConnectedRow: {
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  } as ViewStyle,
  notConnectedText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  } as TextStyle,
  liveBadge: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.danger,
  } as ViewStyle,
  liveBadgeText: {
    color: colors.headerPrimary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  } as TextStyle,
  pttContainer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  } as ViewStyle,
  pttButton: {
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.textMuted,
  } as ViewStyle,
  pttButtonActive: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  } as ViewStyle,
  pttButtonText: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '700',
  } as TextStyle,
  secondaryBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xl,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
    backgroundColor: colors.bgSecondary,
  } as ViewStyle,
  secondaryBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    position: 'relative',
  } as ViewStyle,
  secondaryBtnActive: {
    backgroundColor: colors.bgModifierActive,
    borderRadius: borderRadius.md,
  } as ViewStyle,
  secondaryBtnText: {
    fontSize: 18,
  } as TextStyle,
  secondaryLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '500',
    marginTop: 2,
  } as TextStyle,
  unreadBadge: {
    position: 'absolute',
    top: -2,
    right: 0,
  } as ViewStyle,
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
    backgroundColor: colors.bgSecondary,
  } as ViewStyle,
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.bgTertiary,
    gap: 2,
  } as ViewStyle,
  actionBtnActive: {
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  actionBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  disconnectBtn: {
    backgroundColor: colors.danger,
  } as ViewStyle,
  actionBtnText: {
    fontSize: 20,
  } as TextStyle,
  actionLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '500',
  } as TextStyle,
  connectBar: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
    backgroundColor: colors.bgSecondary,
  } as ViewStyle,
  connectButton: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  connectButtonDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  connectButtonText: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '700',
  } as TextStyle,
});
