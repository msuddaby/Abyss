import { View, Text, Pressable, ScrollView, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { useVoiceStore, useAuthStore } from '@abyss/shared';
import { getScreenVideoStream, requestWatch, stopWatching } from '../hooks/useWebRTC';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function ScreenShareView() {
  const activeSharers = useVoiceStore((s) => s.activeSharers);
  const watchingUserId = useVoiceStore((s) => s.watchingUserId);
  const screenStreamVersion = useVoiceStore((s) => s.screenStreamVersion);
  const currentUser = useAuthStore((s) => s.user);

  const isWatching = watchingUserId !== null;

  // No active sharers — render nothing
  if (activeSharers.size === 0) return null;

  // Watching someone — fullscreen video view
  if (isWatching) {
    const watchingName = activeSharers.get(watchingUserId!) || 'Unknown';
    const otherSharers = Array.from(activeSharers.entries()).filter(([id]) => id !== watchingUserId);

    // Get the remote video stream URL for RTCView
    const stream = getScreenVideoStream(watchingUserId!);
    const streamURL = stream ? (stream as any).toURL() : null;

    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerText} numberOfLines={1}>
            {watchingUserId === currentUser?.id ? 'Your Screen' : `${watchingName}'s Screen`}
          </Text>
          <Pressable
            style={styles.stopBtn}
            onPress={() => {
              if (watchingUserId === currentUser?.id) {
                useVoiceStore.getState().setWatching(null);
              } else {
                stopWatching();
              }
            }}
          >
            <Text style={styles.stopBtnText}>Stop Watching</Text>
          </Pressable>
        </View>

        <View style={styles.videoWrapper}>
          {streamURL ? (
            <RTCView
              streamURL={streamURL}
              style={styles.video}
              objectFit="contain"
              key={`${watchingUserId}-${screenStreamVersion}`}
            />
          ) : (
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>Connecting to stream...</Text>
            </View>
          )}
        </View>

        {otherSharers.length > 0 && (
          <ScrollView horizontal style={styles.switcherBar} contentContainerStyle={styles.switcherContent}>
            {otherSharers.map(([userId, displayName]) => (
              <Pressable
                key={userId}
                style={styles.switcherChip}
                onPress={async () => {
                  if (watchingUserId !== currentUser?.id) {
                    await stopWatching();
                  } else {
                    useVoiceStore.getState().setWatching(null);
                  }
                  if (userId === currentUser?.id) {
                    useVoiceStore.getState().setWatching(userId);
                  } else {
                    await requestWatch(userId);
                  }
                }}
              >
                <Text style={styles.switcherChipText}>🖥️ {displayName}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    );
  }

  // Not watching — sharer picker cards
  const sharerEntries = Array.from(activeSharers.entries());

  return (
    <View style={styles.pickerContainer}>
      {sharerEntries.map(([userId, displayName]) => {
        const isSelf = userId === currentUser?.id;
        return (
          <View key={userId} style={styles.sharerCard}>
            <Text style={styles.sharerIcon}>🖥️</Text>
            <Text style={styles.sharerName}>{isSelf ? 'You' : displayName}</Text>
            <Text style={styles.sharerSubtitle}>is sharing their screen</Text>
            <Pressable
              style={styles.watchBtn}
              onPress={async () => {
                if (isSelf) {
                  useVoiceStore.getState().setWatching(userId);
                } else {
                  await requestWatch(userId);
                }
              }}
            >
              <Text style={styles.watchBtnText}>
                {isSelf ? 'View Your Stream' : 'Watch Stream'}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Watching state — fullscreen video
  container: {
    flex: 1,
    backgroundColor: '#000',
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgTertiary,
  } as ViewStyle,
  headerText: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '600',
    flex: 1,
  } as TextStyle,
  stopBtn: {
    backgroundColor: colors.danger,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.sm,
  } as ViewStyle,
  stopBtnText: {
    color: '#fff',
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  videoWrapper: {
    flex: 1,
    backgroundColor: '#000',
  } as ViewStyle,
  video: {
    flex: 1,
  } as ViewStyle,
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  loadingText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  } as TextStyle,
  switcherBar: {
    backgroundColor: colors.bgTertiary,
    maxHeight: 44,
  } as ViewStyle,
  switcherContent: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  } as ViewStyle,
  switcherChip: {
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  } as ViewStyle,
  switcherChipText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  } as TextStyle,

  // Picker state — sharer cards
  pickerContainer: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,
  sharerCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  sharerIcon: {
    fontSize: 40,
  } as TextStyle,
  sharerName: {
    color: colors.headerPrimary,
    fontSize: fontSize.lg,
    fontWeight: '600',
  } as TextStyle,
  sharerSubtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  } as TextStyle,
  watchBtn: {
    backgroundColor: colors.brandColor,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
    marginTop: spacing.sm,
  } as ViewStyle,
  watchBtnText: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
});
