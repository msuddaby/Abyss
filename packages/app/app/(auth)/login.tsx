import { useState } from 'react';
import {
  View,
  Text,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { Link } from 'expo-router';
import { useAuthStore } from '@abyss/shared';
import TextInput from '../../src/components/TextInput';
import Button from '../../src/components/Button';
import { colors, fontSize, spacing } from '../../src/theme/tokens';

export default function LoginScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);

  const handleLogin = async () => {
    if (!username.trim() || !password) return;
    setError('');
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.response?.data || e?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.form}>
        <Text style={styles.title}>Welcome back!</Text>
        <Text style={styles.subtitle}>We're so excited to see you again!</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TextInput
          label="Username"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          onSubmitEditing={handleLogin}
        />

        <Button title="Log In" onPress={handleLogin} loading={loading} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>Need an account? </Text>
          <Link href="/(auth)/register">
            <Text style={styles.link}>Register</Text>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  } as ViewStyle,
  form: {
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
  } as ViewStyle,
  title: {
    color: colors.headerPrimary,
    fontSize: fontSize.xxl,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.sm,
  } as TextStyle,
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginBottom: spacing.xl,
  } as TextStyle,
  error: {
    color: colors.danger,
    fontSize: fontSize.sm,
    textAlign: 'center',
    marginBottom: spacing.lg,
  } as TextStyle,
  footer: {
    flexDirection: 'row',
    marginTop: spacing.lg,
  } as ViewStyle,
  footerText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  } as TextStyle,
  link: {
    color: colors.textLink,
    fontSize: fontSize.sm,
  } as TextStyle,
});
