import { useState } from 'react';
import {
  View,
  Text,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { Link } from 'expo-router';
import { useAuthStore } from '@abyss/shared';
import TextInput from '../../src/components/TextInput';
import Button from '../../src/components/Button';
import { colors, fontSize, spacing } from '../../src/theme/tokens';

export default function RegisterScreen() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const register = useAuthStore((s) => s.register);

  const handleRegister = async () => {
    if (!email.trim() || !displayName.trim() || !username.trim() || !password) return;
    setError('');
    setLoading(true);
    try {
      await register(username.trim(), email.trim(), password, displayName.trim());
    } catch (e: any) {
      const data = e?.response?.data;
      if (typeof data === 'object' && data?.errors) {
        const msgs = Object.values(data.errors).flat();
        setError(msgs.join(', '));
      } else {
        setError(data?.message || data || 'Registration failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.form}>
          <Text style={styles.title}>Create an account</Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TextInput
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <TextInput
            label="Display Name"
            value={displayName}
            onChangeText={setDisplayName}
          />
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
            onSubmitEditing={handleRegister}
          />

          <Button title="Register" onPress={handleRegister} loading={loading} />

          <View style={styles.footer}>
            <Link href="/(auth)/login">
              <Text style={styles.link}>Already have an account?</Text>
            </Link>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  } as ViewStyle,
  scroll: {
    flexGrow: 1,
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
    justifyContent: 'center',
  } as ViewStyle,
  link: {
    color: colors.textLink,
    fontSize: fontSize.sm,
  } as TextStyle,
});
