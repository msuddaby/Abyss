import React from 'react';
import { View, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { useVoiceStore } from '@abyss/shared';
import Avatar from './Avatar';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export interface VideoTileProps {
  userId: string;
  displayName: string;
  stream: MediaStream | null;
  avatarUri?: string;
}

export default function VideoTile({ userId, displayName, stream, avatarUri }: VideoTileProps) {
  const activeCameras = useVoiceStore((s) => s.activeCameras);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);

  const isSpeaking = speakingUsers.has(userId);
  const streamURL = stream ? (stream as any).toURL() : null;

  return (
    <View
      style={[
        styles.container,
        isSpeaking && styles.containerSpeaking,
      ]}
    >
      {streamURL ? (
        <RTCView
          streamURL={streamURL}
          style={styles.video}
          objectFit="cover"
          zOrder={0}
        />
      ) : (
        <View style={styles.placeholder}>
          <Avatar uri={avatarUri} name={displayName} size={64} />
          <Text style={styles.placeholderText}>Camera off</Text>
        </View>
      )}

      {/* Display name label */}
      <View style={styles.labelContainer}>
        <View style={styles.labelBg}>
          {isSpeaking && <View style={styles.speakingDot} />}
          <Text style={styles.labelText} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
      </View>
    </View>
  );
}

const ASPECT_RATIO = 4 / 3;

const styles = StyleSheet.create({
  container: {
    aspectRatio: ASPECT_RATIO,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: colors.bgTertiary,
    borderWidth: 2,
    borderColor: 'transparent',
  } as ViewStyle,
  containerSpeaking: {
    borderColor: colors.success,
  } as ViewStyle,
  video: {
    flex: 1,
  } as ViewStyle,
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgSecondary,
  } as ViewStyle,
  placeholderText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  } as TextStyle,
  labelContainer: {
    position: 'absolute',
    bottom: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
  } as ViewStyle,
  labelBg: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
    maxWidth: '100%',
  } as ViewStyle,
  speakingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  } as ViewStyle,
  labelText: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '500',
    flexShrink: 1,
  } as TextStyle,
});
