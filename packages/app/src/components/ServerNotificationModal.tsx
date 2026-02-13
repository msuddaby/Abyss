import { useEffect } from 'react';
import { View, Text, Pressable, Switch, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useNotificationSettingsStore, useServerStore } from '@abyss/shared';
import Modal from './Modal';
import { colors, spacing, fontSize } from '../theme/tokens';

const NOTIFICATION_LEVELS: { label: string; value: number }[] = [
  { label: 'All Messages', value: 0 },
  { label: 'Only Mentions', value: 1 },
  { label: 'Nothing', value: 2 },
];

export default function ServerNotificationModal() {
  const activeServer = useServerStore((s) => s.activeServer);
  const serverSettings = useNotificationSettingsStore((s) => s.serverSettings);
  const fetchSettings = useNotificationSettingsStore((s) => s.fetchSettings);
  const updateServerSettings = useNotificationSettingsStore((s) => s.updateServerSettings);
  const isServerMuted = useNotificationSettingsStore((s) => s.isServerMuted);

  const serverId = activeServer?.id ?? '';
  const settings = serverSettings.get(serverId);
  const currentLevel = settings?.notificationLevel ?? 0;
  const muted = serverId ? isServerMuted(serverId) : false;
  const suppressEveryone = settings?.suppressEveryone ?? false;

  useEffect(() => {
    if (serverId) {
      fetchSettings(serverId);
    }
  }, [serverId, fetchSettings]);

  const handleLevelChange = (value: number) => {
    if (!serverId) return;
    updateServerSettings(serverId, { notificationLevel: value });
  };

  const handleMuteToggle = (value: boolean) => {
    if (!serverId) return;
    // Mute for 100 years if toggling on, null to unmute
    const muteUntil = value
      ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    updateServerSettings(serverId, { muteUntil });
  };

  const handleSuppressEveryoneToggle = (value: boolean) => {
    if (!serverId) return;
    updateServerSettings(serverId, { suppressEveryone: value });
  };

  return (
    <Modal title="Notification Settings">
      <Text style={styles.sectionLabel}>Notification Level</Text>
      {NOTIFICATION_LEVELS.map((level) => (
        <Pressable
          key={level.value}
          style={styles.radioRow}
          onPress={() => handleLevelChange(level.value)}
        >
          <View style={styles.radioOuter}>
            {currentLevel === level.value && <View style={styles.radioInner} />}
          </View>
          <Text style={styles.radioLabel}>{level.label}</Text>
        </Pressable>
      ))}

      <View style={styles.divider} />

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Mute Server</Text>
        <Switch
          value={muted}
          onValueChange={handleMuteToggle}
          trackColor={{ false: colors.bgTertiary, true: colors.bgAccent }}
          thumbColor={muted ? '#ffffff' : colors.textMuted}
        />
      </View>

      <View style={styles.switchRow}>
        <View style={styles.switchTextWrap}>
          <Text style={styles.switchLabel}>Suppress @everyone</Text>
          <Text style={styles.switchHint}>Prevents @everyone and @here from sending notifications</Text>
        </View>
        <Switch
          value={suppressEveryone}
          onValueChange={handleSuppressEveryoneToggle}
          trackColor={{ false: colors.bgTertiary, true: colors.bgAccent }}
          thumbColor={suppressEveryone ? '#ffffff' : colors.textMuted}
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
  switchTextWrap: {
    flex: 1,
    marginRight: spacing.md,
  } as ViewStyle,
  switchLabel: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  switchHint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  } as TextStyle,
});
