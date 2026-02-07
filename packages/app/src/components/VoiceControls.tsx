import { View, Text, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useVoiceStore, useServerStore } from '@abyss/shared';
import { useWebRTC } from '../hooks/useWebRTC';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function VoiceControls() {
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const channels = useServerStore((s) => s.channels);

  const { leaveVoice } = useWebRTC();
  const channel = channels.find((c) => c.id === currentChannelId);
  const isPtt = voiceMode === 'push-to-talk';

  if (!currentChannelId) return null;

  return (
    <View style={styles.container}>
      <View style={styles.info}>
        <Text style={styles.label}>Voice Connected</Text>
        {channel && <Text style={styles.channelName}>{'🔊'} {channel.name}</Text>}
      </View>
      <View style={styles.buttons}>
        <Pressable
          style={styles.btn}
          onPress={() => setVoiceMode(isPtt ? 'voice-activity' : 'push-to-talk')}
        >
          <Text style={styles.btnText}>{isPtt ? 'PTT' : 'VA'}</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.disconnectBtn]} onPress={leaveVoice}>
          <Text style={styles.btnText}>{'📞'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xs,
  } as ViewStyle,
  info: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  label: {
    color: colors.success,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  channelName: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  } as TextStyle,
  buttons: {
    flexDirection: 'row',
    gap: spacing.xs,
  } as ViewStyle,
  btn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  disconnectBtn: {
    backgroundColor: colors.danger,
  } as ViewStyle,
  btnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,
});
