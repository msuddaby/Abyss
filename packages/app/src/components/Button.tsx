import React from 'react';
import {
  Pressable,
  Text,
  ActivityIndicator,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { colors, fontSize, spacing, borderRadius } from '../theme/tokens';

type Variant = 'primary' | 'secondary' | 'danger';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

const variantStyles: Record<Variant, { bg: string; bgPressed: string; text: string }> = {
  primary: { bg: colors.bgAccent, bgPressed: colors.bgAccentHover, text: '#ffffff' },
  secondary: { bg: colors.channelTextArea, bgPressed: colors.bgModifierActive, text: colors.textPrimary },
  danger: { bg: colors.danger, bgPressed: '#c03537', text: '#ffffff' },
};

export default function Button({ title, onPress, variant = 'primary', loading, disabled, style }: ButtonProps) {
  const v = variantStyles[variant];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: pressed ? v.bgPressed : v.bg },
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.text} size="small" />
      ) : (
        <Text style={[styles.text, { color: v.text }]}>{title}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 44,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  } as ViewStyle,
  text: {
    fontSize: fontSize.md,
    fontWeight: '600',
  } as TextStyle,
  disabled: {
    opacity: 0.5,
  } as ViewStyle,
});
