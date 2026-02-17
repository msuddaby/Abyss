import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api, useServerStore } from '@abyss/shared';
import Modal from './Modal';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function InviteModal() {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [maxUses, setMaxUses] = useState('');
  const activeServer = useServerStore((s) => s.activeServer);
  const closeModal = useUiStore((s) => s.closeModal);

  const generateInvite = async () => {
    if (!activeServer || loading) return;
    setLoading(true);
    try {
      const payload: { maxUses?: number } = {};
      const parsedMax = Number(maxUses);
      if (!Number.isNaN(parsedMax) && parsedMax > 0) payload.maxUses = parsedMax;
      const res = await api.post(`/servers/${activeServer.id}/invites`, payload);
      setCode(res.data.code);
    } catch (err) {
      console.error('Failed to generate invite', err);
    } finally {
      setLoading(false);
    }
  };

  const copyCode = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal title="Invite People">
      {code ? (
        <View>
          <Text style={styles.subtitle}>Share this invite code:</Text>
          <View style={styles.codeRow}>
            <View style={styles.codeBox}>
              <Text style={styles.codeText} selectable>{code}</Text>
            </View>
            <Pressable style={styles.copyBtn} onPress={copyCode}>
              <Text style={styles.copyBtnText}>{copied ? 'Copied!' : 'Copy'}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View>
          <TextInput
            style={styles.optionInput}
            placeholder="Max uses (optional)"
            placeholderTextColor={colors.textMuted}
            value={maxUses}
            onChangeText={setMaxUses}
            keyboardType="numeric"
          />
          <Pressable
            style={[styles.generateBtn, loading && styles.btnDisabled]}
            onPress={generateInvite}
            disabled={loading}
          >
            <Text style={styles.generateBtnText}>{loading ? 'Generating...' : 'Generate Invite Link'}</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.actions}>
        <Pressable style={styles.btnSecondary} onPress={closeModal}>
          <Text style={styles.btnSecondaryText}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  } as TextStyle,
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  } as ViewStyle,
  codeBox: {
    flex: 1,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
  } as ViewStyle,
  codeText: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '600',
    fontFamily: 'monospace',
  } as TextStyle,
  copyBtn: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,
  copyBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  optionInput: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  } as TextStyle,
  generateBtn: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.lg,
  } as ViewStyle,
  generateBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm,
  } as ViewStyle,
  btnSecondary: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,
  btnSecondaryText: {
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  btnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
});
