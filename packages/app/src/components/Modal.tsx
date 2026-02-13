import { Modal as RNModal, View, Text, Pressable, ScrollView, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';
import { useUiStore } from '../stores/uiStore';

interface ModalProps {
  title: string;
  children: React.ReactNode;
  onClose?: () => void;
  maxWidth?: number;
}

export default function Modal({ title, children, onClose, maxWidth = 440 }: ModalProps) {
  const closeModal = useUiStore((s) => s.closeModal);
  const handleClose = onClose ?? closeModal;

  return (
    <RNModal transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={[styles.card, { maxWidth }]} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  } as ViewStyle,
  card: {
    backgroundColor: colors.bgPrimary,
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
    width: '100%',
    maxHeight: '85%',
  } as ViewStyle,
  title: {
    color: colors.headerPrimary,
    fontSize: fontSize.xl,
    fontWeight: '700',
    marginBottom: spacing.lg,
  } as TextStyle,
  scroll: {
    flex: 1,
  } as ViewStyle,
});
