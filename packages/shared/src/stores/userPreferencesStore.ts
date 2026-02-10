import { create } from 'zustand';
import api from '../services/api.js';
import { useVoiceStore } from './voiceStore.js';
import { getStorage } from '../storage.js';
import type { UserPreferences } from '../types/index.js';

interface UserPreferencesState {
  preferences: UserPreferences | null;
  fetchPreferences: () => Promise<void>;
  updatePreferences: (partial: Partial<UserPreferences>) => Promise<void>;
  applyToVoiceStore: (prefs: UserPreferences) => void;
}

export const useUserPreferencesStore = create<UserPreferencesState>((set, get) => ({
  preferences: null,

  fetchPreferences: async () => {
    try {
      const res = await api.get('/users/preferences');
      const prefs: UserPreferences = res.data;
      set({ preferences: prefs });
      get().applyToVoiceStore(prefs);
    } catch {
      // ignore — use localStorage defaults
    }
  },

  updatePreferences: async (partial: Partial<UserPreferences>) => {
    try {
      const res = await api.patch('/users/preferences', partial);
      const prefs: UserPreferences = res.data;
      set({ preferences: prefs });
    } catch {
      // ignore
    }
  },

  applyToVoiceStore: (prefs: UserPreferences) => {
    const s = getStorage();
    const voiceMode = prefs.inputMode === 1 ? 'push-to-talk' : 'voice-activity';
    // Write to storage so hydrateVoiceStore picks them up on future loads
    s.setItem('voiceMode', voiceMode);
    s.setItem('inputSensitivity', String(prefs.inputSensitivity));
    s.setItem('noiseSuppression', String(prefs.noiseSuppression));
    s.setItem('echoCancellation', String(prefs.echoCancellation));
    s.setItem('autoGainControl', String(prefs.autoGainControl));

    useVoiceStore.setState({
      voiceMode: voiceMode as 'voice-activity' | 'push-to-talk',
      inputSensitivity: prefs.inputSensitivity,
      noiseSuppression: prefs.noiseSuppression,
      echoCancellation: prefs.echoCancellation,
      autoGainControl: prefs.autoGainControl,
    });
  },
}));
