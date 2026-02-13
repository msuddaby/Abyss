import { View, Text, Pressable, Switch, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useNotificationSettingsStore, useServerStore } from '@abyss/shared';
import Modal from './Modal';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, fontSize } from '../theme/tokens';

const NOTIFICATION_LEVELS: { label: string; value: number | null }[] = [
  { label: 'Default (inherit from server)', value: null },
  { label: 'All Messages', value: 0 },
  { label: 'Only Mentions', value: 1 },
  { label: 'Nothing', value: 2 },
];

export default function ChannelNotificationModal() {
  const modalProps = useUiStore((s) => s.modalProps);
  const activeServer = useServerStore((s) => s.activeServer);
  const channelSettings = useNotificationSettingsStore((s) => s.channelSettings);
  const updateChannelSettings = useNotificationSettingsStore((s) => s.updateChannelSettings);
  const isChannelMuted = useNotificationSettingsStore((s) => s.isChannelMuted);

  const channelId: string = modalProps?.channelId ?? '';
  const channelName: string = modalProps?.channelName ?? 'Channel';
  const serverId = activeServer?.id ?? '';

  const settings = channelSettings.get(channelId);
  const currentLevel = settings?.notificationLevel ?? null;
  const muted = channelId ? isChannelMuted(channelId) : false;

  const handleLevelChange = (value: number | null) => {
    if (!serverId || !channelId) return;
    updateChannelSettings(serverId, channelId, { notificationLevel: value });
  };

  const handleMuteToggle = (value: boolean) => {
    if (!serverId || !channelId) return;
    const muteUntil = value
      ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    updateChannelSettings(serverId, channelId, { muteUntil });
  };

  return (
    <Modal title={`Notifications - #${channelName}`}>
      <Text style={styles.sectionLabel}>Notification Level</Text>
      {NOTIFICATION_LEVELS.map((level) => {
        const isSelected = currentLevel === level.value;
        return (
          <Pressable
            key={String(level.value)}
            style={styles.radioRow}
            onPress={() => handleLevelChange(level.value)}
          >
            <View style={styles.radioOuter}>
              {isSelected && <View style={styles.radioInner} />}
            </View>
            <Text style={styles.radioLabel}>{level.label}</Text>
          </Pressable>
        );
      })}

      <View style={styles.divider} />

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Mute Channel</Text>
        <Switch
          value={muted}
          onValueChange={handleMuteToggle}
          trackColor={{ false: colors.bgTertiary, true: colors.bgAccent }}
          thumbColor={muted ? '#ffffff' : colors.textMuted}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  } as TextStyle,
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.bgAccent,
  } as ViewStyle,
  radioLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
  } as TextStyle,
  divider: {
    height: 1,
    backgroundColor: colors.bgTertiary,
    marginVertical: spacing.lg,
  } as ViewStyle,
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  } as ViewStyle,
  switchLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
});
