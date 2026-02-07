import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput as RNTextInput,
  StyleSheet,
  type TextInputProps as RNTextInputProps,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { colors, fontSize, spacing, borderRadius } from '../theme/tokens';

interface TextInputProps extends Omit<RNTextInputProps, 'style'> {
  label?: string;
  error?: string;
  style?: ViewStyle;
}

export default function TextInput({ label, error, style, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={[styles.container, style]}>
      {label && <Text style={styles.label}>{label}</Text>}
      <RNTextInput
        placeholderTextColor={colors.textMuted}
        style={[
          styles.input,
          focused && styles.inputFocused,
          error && styles.inputError,
        ]}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        {...props}
      />
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.lg,
  } as ViewStyle,
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  input: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    fontSize: fontSize.md,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    height: 44,
    borderWidth: 1,
    borderColor: 'transparent',
  } as TextStyle,
  inputFocused: {
    borderColor: colors.bgAccent,
  } as ViewStyle,
  inputError: {
    borderColor: colors.danger,
  } as ViewStyle,
  error: {
    color: colors.danger,
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
  } as TextStyle,
});
