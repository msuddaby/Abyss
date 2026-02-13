import { useState, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useVoiceStore } from '@abyss/shared';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function VolumeControlSheet() {
  const closeModal = useUiStore((s) => s.closeModal);
  const modalProps = useUiStore((s) => s.modalProps);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);

  const userId = modalProps.userId as string;
  const displayName = modalProps.displayName as string;

  const [volume, setVolume] = useState(() => userVolumes.get(userId) ?? 100);

  useEffect(() => {
    setVolume(userVolumes.get(userId) ?? 100);
  }, [userId, userVolumes]);

  const applyVolume = (next: number) => {
    const clamped = Math.max(0, Math.min(200, next));
    setVolume(clamped);
    setUserVolume(userId, clamped);
  };

  const decrease = () => applyVolume(volume - 10);
  const increase = () => applyVolume(volume + 10);
  const reset = () => applyVolume(100);

  return (
    <Modal transparent animationType="slide" onRequestClose={closeModal}>
      <Pressable style={styles.overlay} onPress={closeModal}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {displayName}
            </Text>
            <Pressable onPress={closeModal} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>User Volume</Text>

          <View style={styles.controlRow}>
            <Pressable
              style={[styles.stepBtn, volume <= 0 && styles.stepBtnDisabled]}
              onPress={decrease}
              disabled={volume <= 0}
            >
              <Text style={styles.stepBtnText}>-</Text>
            </Pressable>

            <View style={styles.barOuter}>
              <View style={[styles.barFill, { width: `${Math.min(volume, 200) / 2}%` }]} />
            </View>

            <Pressable
              style={[styles.stepBtn, volume >= 200 && styles.stepBtnDisabled]}
              onPress={increase}
              disabled={volume >= 200}
            >
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>

          <Text style={styles.percentage}>{volume}%</Text>

          <Pressable
            style={[styles.resetBtn, volume === 100 && styles.resetBtnDisabled]}
            onPress={reset}
            disabled={volume === 100}
          >
            <Text style={[styles.resetBtnText, volume === 100 && styles.resetBtnTextDisabled]}>
              Reset to 100%
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  } as ViewStyle,
  card: {
    backgroundColor: colors.bgPrimary,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  } as ViewStyle,
  title: {
    color: colors.headerPrimary,
    fontSize: fontSize.xl,
    fontWeight: '700',
    flex: 1,
    marginRight: spacing.sm,
  } as TextStyle,
  closeBtn: {
    padding: spacing.xs,
  } as ViewStyle,
  closeBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.xl,
  } as TextStyle,
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  } as TextStyle,
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  } as ViewStyle,
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  stepBtnDisabled: {
    opacity: 0.4,
  } as ViewStyle,
  stepBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.xl,
    fontWeight: '700',
  } as TextStyle,
  barOuter: {
    flex: 1,
    height: 8,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgTertiary,
    overflow: 'hidden',
  } as ViewStyle,
  barFill: {
    height: '100%',
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgAccent,
  } as ViewStyle,
  percentage: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: spacing.md,
  } as TextStyle,
  resetBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  } as ViewStyle,
  resetBtnDisabled: {
    opacity: 0.4,
  } as ViewStyle,
  resetBtnText: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  resetBtnTextDisabled: {
    color: colors.textMuted,
  } as TextStyle,
});
