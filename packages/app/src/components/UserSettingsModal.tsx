import { useState } from 'react';
import { View, Text, TextInput, Pressable, Image, Switch, StyleSheet, type ViewStyle, type TextStyle, type ImageStyle } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useAuthStore, useVoiceStore, api, getApiBase } from '@abyss/shared';
import Modal from './Modal';
import Avatar from './Avatar';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

export default function UserSettingsModal() {
  const user = useAuthStore((s) => s.user)!;
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const closeModal = useUiStore((s) => s.closeModal);

  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio || '');
  const [status, setStatus] = useState(user.status || '');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const setNoiseSuppression = useVoiceStore((s) => s.setNoiseSuppression);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const setEchoCancellation = useVoiceStore((s) => s.setEchoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const setAutoGainControl = useVoiceStore((s) => s.setAutoGainControl);

  const currentAvatar = avatarUri
    || (user.avatarUrl ? (user.avatarUrl.startsWith('http') ? user.avatarUrl : `${getApiBase()}${user.avatarUrl}`) : null);

  const pickAvatar = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setAvatarUri(result.assets[0].uri);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (avatarUri) {
        const formData = new FormData();
        formData.append('file', {
          uri: avatarUri,
          name: 'avatar.jpg',
          type: 'image/jpeg',
        } as unknown as Blob);
        const res = await api.post('/auth/avatar', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        // Update auth store with new user data
        useAuthStore.setState({ user: res.data });
      }
      await updateProfile({ displayName, bio, status });
      closeModal();
    } catch (err) {
      console.error('Failed to update profile', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="User Settings">
      {/* Avatar */}
      <Pressable style={styles.avatarSection} onPress={pickAvatar}>
        {currentAvatar ? (
          <Image source={{ uri: currentAvatar }} style={styles.avatarImage} />
        ) : (
          <Avatar name={user.displayName} size={80} />
        )}
        <Text style={styles.avatarHint}>Tap to change</Text>
      </Pressable>

      {/* Display Name */}
      <Text style={styles.label}>Display Name</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={32}
        placeholderTextColor={colors.textMuted}
      />

      {/* Bio */}
      <Text style={styles.label}>Bio</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        value={bio}
        onChangeText={setBio}
        maxLength={190}
        multiline
        numberOfLines={3}
        placeholder="Tell us about yourself"
        placeholderTextColor={colors.textMuted}
      />

      {/* Status */}
      <Text style={styles.label}>Status</Text>
      <TextInput
        style={styles.input}
        value={status}
        onChangeText={setStatus}
        maxLength={32}
        placeholderTextColor={colors.textMuted}
      />

      {/* Voice Mode */}
      <Text style={styles.label}>Voice Mode</Text>
      <View style={styles.typeRow}>
        <Pressable
          style={[styles.typeBtn, voiceMode === 'voice-activity' && styles.typeBtnActive]}
          onPress={() => setVoiceMode('voice-activity')}
        >
          <Text style={[styles.typeBtnText, voiceMode === 'voice-activity' && styles.typeBtnTextActive]}>Voice Activity</Text>
        </Pressable>
        <Pressable
          style={[styles.typeBtn, voiceMode === 'push-to-talk' && styles.typeBtnActive]}
          onPress={() => setVoiceMode('push-to-talk')}
        >
          <Text style={[styles.typeBtnText, voiceMode === 'push-to-talk' && styles.typeBtnTextActive]}>Push to Talk</Text>
        </Pressable>
      </View>

      {/* Voice & Audio */}
      <Text style={styles.label}>Voice & Audio</Text>
      <View style={styles.settingRow}>
        <Text style={styles.settingText}>Noise Suppression</Text>
        <Switch
          value={noiseSuppression}
          onValueChange={setNoiseSuppression}
          trackColor={{ false: colors.bgTertiary, true: colors.bgAccent }}
          thumbColor={colors.headerPrimary}
        />
      </View>
      <View style={styles.settingRow}>
        <Text style={styles.settingText}>Echo Cancellation</Text>
        <Switch
          value={echoCancellation}
          onValueChange={setEchoCancellation}
          trackColor={{ false: colors.bgTertiary, true: colors.bgAccent }}
          thumbColor={colors.headerPrimary}
        />
      </View>
      <View style={styles.settingRow}>
        <Text style={styles.settingText}>Auto Gain Control</Text>
        <Switch
          value={autoGainControl}
          onValueChange={setAutoGainControl}
          trackColor={{ false: colors.bgTertiary, true: colors.bgAccent }}
          thumbColor={colors.headerPrimary}
        />
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable style={styles.btnSecondary} onPress={closeModal}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btnPrimary, saving && styles.btnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          <Text style={styles.btnPrimaryText}>{saving ? 'Saving...' : 'Save'}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  avatarSection: {
    alignItems: 'center',
    marginBottom: spacing.lg,
  } as ViewStyle,
  avatarImage: {
    width: 80,
    height: 80,
    borderRadius: 40,
  } as ImageStyle,
  avatarHint: {
    color: colors.textLink,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  } as TextStyle,
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  input: {
    backgroundColor: colors.bgTertiary,
    color: colors.textPrimary,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
    marginBottom: spacing.lg,
  } as TextStyle,
  textArea: {
    minHeight: 70,
    textAlignVertical: 'top',
  } as TextStyle,
  typeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  } as ViewStyle,
  typeBtn: {
    flex: 1,
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  } as ViewStyle,
  typeBtnActive: {
    borderColor: colors.bgAccent,
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  typeBtnText: {
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: fontSize.sm,
  } as TextStyle,
  typeBtnTextActive: {
    color: colors.headerPrimary,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  } as ViewStyle,
  btnPrimary: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,
  btnPrimaryText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  btnSecondary: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,
  btnSecondaryText: {
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: fontSize.md,
  } as TextStyle,
  btnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
  } as ViewStyle,
  settingText: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
  } as TextStyle,
});
