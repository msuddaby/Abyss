import React from 'react';
import { View, Image, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { colors, fontSize } from '../theme/tokens';

interface AvatarProps {
  uri?: string | null;
  name?: string;
  size?: number;
  online?: boolean;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

const fallbackColors = ['#5865f2', '#3ba55d', '#ed4245', '#faa61a', '#9b59b6', '#e67e22'];

function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return fallbackColors[Math.abs(hash) % fallbackColors.length];
}

export default function Avatar({ uri, name = '?', size = 40, online }: AvatarProps) {
  const half = size / 2;

  return (
    <View style={[styles.wrapper, { width: size, height: size }]}>
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size, borderRadius: half }} />
      ) : (
        <View
          style={[
            styles.fallback,
            { width: size, height: size, borderRadius: half, backgroundColor: colorForName(name) },
          ]}
        >
          <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{getInitials(name)}</Text>
        </View>
      )}
      {online !== undefined && (
        <View
          style={[
            styles.dot,
            {
              width: size * 0.3,
              height: size * 0.3,
              borderRadius: size * 0.15,
              borderWidth: size * 0.06,
              backgroundColor: online ? colors.success : colors.textMuted,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
  } as ViewStyle,
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  initials: {
    color: '#ffffff',
    fontWeight: '600',
  } as TextStyle,
  dot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    borderColor: colors.bgSecondary,
  } as ViewStyle,
});
