import { useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  Modal,
  Alert,
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  useSoundboardStore,
  getConnection,
  useServerStore,
  useVoiceStore,
  useAuthStore,
  hasPermission,
  Permission,
} from '@abyss/shared';
import type { SoundboardClip } from '@abyss/shared';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const NUM_COLUMNS = 3;

export default function SoundboardPanel() {
  const clips = useSoundboardStore((s) => s.clips);
  const loading = useSoundboardStore((s) => s.loading);
  const fetchClips = useSoundboardStore((s) => s.fetchClips);
  const deleteClip = useSoundboardStore((s) => s.deleteClip);
  const renameClip = useSoundboardStore((s) => s.renameClip);
  const activeServer = useServerStore((s) => s.activeServer);
  const members = useServerStore((s) => s.members);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const closeModal = useUiStore((s) => s.closeModal);

  const currentMember = members.find((m) => m.userId === currentUserId);
  const canManageServer = currentMember ? hasPermission(currentMember, Permission.ManageServer) : false;

  useEffect(() => {
    if (activeServer) {
      fetchClips(activeServer.id).catch(() => {});
    }
  }, [activeServer, fetchClips]);

  const handleClose = () => {
    closeModal();
  };

  const playClip = (clipId: string) => {
    if (!currentChannelId) return;
    const conn = getConnection();
    if (conn) {
      conn.invoke('PlaySoundboardClip', currentChannelId, clipId).catch(() => {});
    }
  };

  const canManageClip = (clip: SoundboardClip): boolean => {
    return clip.uploadedById === currentUserId || canManageServer;
  };

  const handleLongPress = (clip: SoundboardClip) => {
    if (!canManageClip(clip) || !activeServer) return;

    Alert.alert(clip.name, 'What would you like to do?', [
      {
        text: 'Rename',
        onPress: () => {
          Alert.prompt?.(
            'Rename Clip',
            'Enter a new name:',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Rename',
                onPress: (newName?: string) => {
                  if (newName?.trim()) {
                    renameClip(activeServer.id, clip.id, newName.trim()).catch(() => {});
                  }
                },
              },
            ],
            'plain-text',
            clip.name,
          ) ??
            // Alert.prompt is iOS-only; on Android fall back to a simple confirm
            renameAlert(clip);
        },
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          Alert.alert('Delete Clip', `Delete "${clip.name}"?`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => deleteClip(activeServer.id, clip.id).catch(() => {}),
            },
          ]);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const renameAlert = (clip: SoundboardClip) => {
    // Fallback rename for Android (no Alert.prompt)
    Alert.alert('Rename', 'Rename is not supported on this platform yet.', [
      { text: 'OK' },
    ]);
  };

  const formatDuration = (seconds: number): string => {
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, '0')}`;
  };

  const renderClip = ({ item }: { item: SoundboardClip }) => (
    <Pressable
      style={({ pressed }) => [styles.clipBtn, pressed && styles.clipBtnPressed]}
      onPress={() => playClip(item.id)}
      onLongPress={() => handleLongPress(item)}
    >
      <Text style={styles.clipName} numberOfLines={2}>
        {item.name}
      </Text>
      <Text style={styles.clipDuration}>{formatDuration(item.duration)}</Text>
    </Pressable>
  );

  return (
    <Modal transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={styles.panel} onPress={() => {}}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.handleBar} />
            <View style={styles.headerRow}>
              <Text style={styles.headerTitle}>Soundboard</Text>
              <Pressable onPress={handleClose} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>✕</Text>
              </Pressable>
            </View>
          </View>

          {/* Content */}
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text style={styles.loadingText}>Loading clips...</Text>
            </View>
          ) : (
            <FlatList
              data={clips}
              renderItem={renderClip}
              keyExtractor={(item) => item.id}
              numColumns={NUM_COLUMNS}
              contentContainerStyle={styles.gridContent}
              columnWrapperStyle={styles.gridRow}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>No sound clips yet.</Text>
                </View>
              }
            />
          )}

          {/* Upload placeholder */}
          <View style={styles.footer}>
            <Pressable style={styles.uploadBtn} onPress={() => Alert.alert('Upload', 'Upload coming soon')}>
              <Text style={styles.uploadBtnText}>Upload Sound</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  } as ViewStyle,
  panel: {
    height: SCREEN_HEIGHT * 0.55,
    backgroundColor: colors.bgPrimary,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
  } as ViewStyle,
  header: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textMuted,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  } as ViewStyle,
  headerTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '700',
  } as TextStyle,
  closeBtn: {
    padding: spacing.xs,
  } as ViewStyle,
  closeBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.xl,
  } as TextStyle,
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  loadingText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  } as TextStyle,
  gridContent: {
    padding: spacing.md,
    gap: spacing.sm,
  } as ViewStyle,
  gridRow: {
    gap: spacing.sm,
  } as ViewStyle,
  clipBtn: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 72,
  } as ViewStyle,
  clipBtnPressed: {
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  clipName: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    textAlign: 'center',
  } as TextStyle,
  clipDuration: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
  } as TextStyle,
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  } as ViewStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  } as TextStyle,
  footer: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.bgTertiary,
  } as ViewStyle,
  uploadBtn: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  } as ViewStyle,
  uploadBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
});
