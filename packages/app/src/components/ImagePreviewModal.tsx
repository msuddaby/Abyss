import { Modal, View, Pressable, Image, StyleSheet, type ViewStyle, type ImageStyle } from 'react-native';
import { useUiStore } from '../stores/uiStore';

export default function ImagePreviewModal() {
  const modalProps = useUiStore((s) => s.modalProps);
  const closeModal = useUiStore((s) => s.closeModal);

  const imageUri: string | undefined = modalProps?.imageUri;

  if (!imageUri) return null;

  return (
    <Modal transparent animationType="fade" onRequestClose={closeModal}>
      <Pressable style={styles.overlay} onPress={closeModal}>
        <View style={styles.imageContainer}>
          <Image
            source={{ uri: imageUri }}
            style={styles.image}
            resizeMode="contain"
          />
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  } as ViewStyle,
  imageContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  } as ViewStyle,
  image: {
    width: '100%',
    height: '100%',
  } as ImageStyle,
});
