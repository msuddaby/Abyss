import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore } from '@abyss/shared';
import Modal from './Modal';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function CreateChannelModal() {
  const [name, setName] = useState('');
  const [type, setType] = useState<'Text' | 'Voice'>('Text');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const createChannel = useServerStore((s) => s.createChannel);
  const activeServer = useServerStore((s) => s.activeServer);
  const closeModal = useUiStore((s) => s.closeModal);

  const handleCreate = async () => {
    if (!name.trim() || !activeServer || loading) return;
    setLoading(true);
    try {
      await createChannel(activeServer.id, name, type);
      closeModal();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to create channel');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Create Channel">
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.label}>Channel Type</Text>
      <View style={styles.typeRow}>
        <Pressable
          style={[styles.typeBtn, type === 'Text' && styles.typeBtnActive]}
          onPress={() => setType('Text')}
        >
          <Text style={[styles.typeBtnText, type === 'Text' && styles.typeBtnTextActive]}># Text</Text>
        </Pressable>
        <Pressable
          style={[styles.typeBtn, type === 'Voice' && styles.typeBtnActive]}
          onPress={() => setType('Voice')}
        >
          <Text style={[styles.typeBtnText, type === 'Voice' && styles.typeBtnTextActive]}>{'🔊'} Voice</Text>
        </Pressable>
      </View>
      <Text style={styles.label}>Channel Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="new-channel"
        placeholderTextColor={colors.textMuted}
        autoFocus
      />
      <View style={styles.actions}>
        <Pressable style={styles.btnSecondary} onPress={closeModal}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btnPrimary, (!name.trim() || loading) && styles.btnDisabled]}
          onPress={handleCreate}
          disabled={!name.trim() || loading}
        >
          <Text style={styles.btnPrimaryText}>{loading ? 'Creating...' : 'Create'}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  input: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
    marginBottom: spacing.lg,
  } as TextStyle,
  typeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  } as ViewStyle,
  typeBtn: {
    flex: 1,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  } as ViewStyle,
  typeBtnActive: {
    borderColor: colors.bgAccent,
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  typeBtnText: {
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  typeBtnTextActive: {
    color: colors.headerPrimary,
  } as TextStyle,
  error: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  } as ViewStyle,
  btnPrimary: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,
  btnPrimaryText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
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
