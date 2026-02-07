import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore } from '@abyss/shared';
import Modal from './Modal';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function CreateServerModal() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const createServer = useServerStore((s) => s.createServer);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const closeModal = useUiStore((s) => s.closeModal);

  const handleCreate = async () => {
    if (!name.trim() || loading) return;
    setLoading(true);
    try {
      const server = await createServer(name);
      await setActiveServer(server);
      closeModal();
    } catch (err: any) {
      setError(err.response?.data || 'Failed to create server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Create a Server">
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.label}>Server Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="My Server"
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
