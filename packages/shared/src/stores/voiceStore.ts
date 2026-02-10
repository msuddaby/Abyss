import { create } from 'zustand';
import { getStorage } from '../storage.js';

type VoiceMode = 'voice-activity' | 'push-to-talk';

interface VoiceState {
  currentChannelId: string | null;
  participants: Map<string, string>; // userId -> displayName
  isMuted: boolean;
  isDeafened: boolean;
  isScreenSharing: boolean;
  activeSharers: Map<string, string>; // userId -> displayName of all sharers in channel
  watchingUserId: string | null; // who we're currently watching
  screenStreamVersion: number;
  isCameraOn: boolean;
  activeCameras: Map<string, string>; // userId -> displayName of camera users
  cameraStreamVersion: number;
  focusedUserId: string | null;
  speakingUsers: Set<string>;
  voiceMode: VoiceMode;
  pttKey: string;
  isPttActive: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  inputSensitivity: number;
  localInputLevel: number;
  needsAudioUnlock: boolean;
  setCurrentChannel: (channelId: string | null) => void;
  setParticipants: (participants: Map<string, string>) => void;
  addParticipant: (userId: string, displayName: string) => void;
  removeParticipant: (userId: string) => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setMuteDeafen: (isMuted: boolean, isDeafened: boolean) => void;
  setScreenSharing: (sharing: boolean) => void;
  addActiveSharer: (userId: string, displayName: string) => void;
  removeActiveSharer: (userId: string) => void;
  setActiveSharers: (sharers: Map<string, string>) => void;
  setWatching: (userId: string | null) => void;
  bumpScreenStreamVersion: () => void;
  setCameraOn: (on: boolean) => void;
  addActiveCamera: (userId: string, displayName: string) => void;
  removeActiveCamera: (userId: string) => void;
  setActiveCameras: (cameras: Map<string, string>) => void;
  bumpCameraStreamVersion: () => void;
  setFocusedUserId: (userId: string | null) => void;
  setVoiceMode: (mode: VoiceMode) => void;
  setPttKey: (key: string) => void;
  setPttActive: (active: boolean) => void;
  setInputDeviceId: (deviceId: string) => void;
  setOutputDeviceId: (deviceId: string) => void;
  setCameraDeviceId: (deviceId: string) => void;
  setNoiseSuppression: (enabled: boolean) => void;
  setEchoCancellation: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  setInputSensitivity: (value: number) => void;
  setLocalInputLevel: (value: number) => void;
  setNeedsAudioUnlock: (value: boolean) => void;
  speakerOn: boolean;
  toggleSpeaker: () => void;
  setSpeaking: (userId: string, speaking: boolean) => void;
  isVoiceChatOpen: boolean;
  toggleVoiceChat: () => void;
  setVoiceChatOpen: (open: boolean) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  currentChannelId: null,
  participants: new Map(),
  isMuted: false,
  isDeafened: false,
  isScreenSharing: false,
  activeSharers: new Map(),
  watchingUserId: null,
  screenStreamVersion: 0,
  isCameraOn: false,
  activeCameras: new Map(),
  cameraStreamVersion: 0,
  focusedUserId: null,
  speakingUsers: new Set<string>(),
  voiceMode: 'voice-activity' as VoiceMode,
  pttKey: '`',
  speakerOn: true,
  isPttActive: false,
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  cameraDeviceId: 'default',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  inputSensitivity: 1,
  localInputLevel: 0,
  needsAudioUnlock: false,

  setCurrentChannel: (channelId) => set({ currentChannelId: channelId }),

  setParticipants: (participants) => set({ participants }),

  addParticipant: (userId, displayName) =>
    set((s) => {
      const next = new Map(s.participants);
      next.set(userId, displayName);
      return { participants: next };
    }),

  removeParticipant: (userId) =>
    set((s) => {
      const next = new Map(s.participants);
      next.delete(userId);
      let extra: Partial<VoiceState> = {};
      if (s.activeSharers.has(userId)) {
        const nextSharers = new Map(s.activeSharers);
        nextSharers.delete(userId);
        extra.activeSharers = nextSharers;
      }
      if (s.activeCameras.has(userId)) {
        const nextCameras = new Map(s.activeCameras);
        nextCameras.delete(userId);
        extra.activeCameras = nextCameras;
      }
      if (s.watchingUserId === userId) {
        extra.watchingUserId = null;
      }
      if (s.focusedUserId === userId) {
        extra.focusedUserId = null;
      }
      return { participants: next, ...extra };
    }),

  toggleMute: () => set((s) => {
    const next = !s.isMuted;
    getStorage().setItem('isMuted', String(next));
    return { isMuted: next };
  }),
  toggleDeafen: () => set((s) => {
    const next = !s.isDeafened;
    getStorage().setItem('isDeafened', String(next));
    return { isDeafened: next };
  }),
  setMuteDeafen: (isMuted, isDeafened) => {
    getStorage().setItem('isMuted', String(isMuted));
    getStorage().setItem('isDeafened', String(isDeafened));
    set({ isMuted, isDeafened });
  },
  setScreenSharing: (sharing) => set({ isScreenSharing: sharing }),

  addActiveSharer: (userId, displayName) =>
    set((s) => {
      const next = new Map(s.activeSharers);
      next.set(userId, displayName);
      return { activeSharers: next };
    }),

  removeActiveSharer: (userId) =>
    set((s) => {
      const next = new Map(s.activeSharers);
      next.delete(userId);
      const clearWatch = s.watchingUserId === userId ? { watchingUserId: null } : {};
      return { activeSharers: next, ...clearWatch };
    }),

  setActiveSharers: (sharers) => set({ activeSharers: sharers }),

  setWatching: (userId) => set({ watchingUserId: userId }),

  bumpScreenStreamVersion: () =>
    set((s) => ({ screenStreamVersion: s.screenStreamVersion + 1 })),

  setCameraOn: (on) => set({ isCameraOn: on }),

  addActiveCamera: (userId, displayName) =>
    set((s) => {
      const next = new Map(s.activeCameras);
      next.set(userId, displayName);
      return { activeCameras: next };
    }),

  removeActiveCamera: (userId) =>
    set((s) => {
      const next = new Map(s.activeCameras);
      next.delete(userId);
      const clearFocus = s.focusedUserId === userId ? { focusedUserId: null } : {};
      return { activeCameras: next, ...clearFocus };
    }),

  setActiveCameras: (cameras) => set({ activeCameras: cameras }),

  bumpCameraStreamVersion: () =>
    set((s) => ({ cameraStreamVersion: s.cameraStreamVersion + 1 })),

  setFocusedUserId: (userId) => set({ focusedUserId: userId }),

  setVoiceMode: (mode) => {
    getStorage().setItem('voiceMode', mode);
    set({ voiceMode: mode, isPttActive: false });
    // Sync to server (lazy import to avoid circular deps)
    import('./userPreferencesStore.js').then(m =>
      m.useUserPreferencesStore.getState().updatePreferences({
        inputMode: mode === 'push-to-talk' ? 1 : 0,
      })
    );
  },
  setPttKey: (key) => {
    getStorage().setItem('pttKey', key);
    set({ pttKey: key });
  },
  setPttActive: (active) => set({ isPttActive: active }),
  setInputDeviceId: (deviceId) => {
    getStorage().setItem('inputDeviceId', deviceId);
    set({ inputDeviceId: deviceId });
  },
  setOutputDeviceId: (deviceId) => {
    getStorage().setItem('outputDeviceId', deviceId);
    set({ outputDeviceId: deviceId });
  },
  setCameraDeviceId: (deviceId) => {
    getStorage().setItem('cameraDeviceId', deviceId);
    set({ cameraDeviceId: deviceId });
  },
  setNoiseSuppression: (enabled) => {
    getStorage().setItem('noiseSuppression', String(enabled));
    set({ noiseSuppression: enabled });
    import('./userPreferencesStore.js').then(m =>
      m.useUserPreferencesStore.getState().updatePreferences({ noiseSuppression: enabled })
    );
  },
  setEchoCancellation: (enabled) => {
    getStorage().setItem('echoCancellation', String(enabled));
    set({ echoCancellation: enabled });
    import('./userPreferencesStore.js').then(m =>
      m.useUserPreferencesStore.getState().updatePreferences({ echoCancellation: enabled })
    );
  },
  setAutoGainControl: (enabled) => {
    getStorage().setItem('autoGainControl', String(enabled));
    set({ autoGainControl: enabled });
    import('./userPreferencesStore.js').then(m =>
      m.useUserPreferencesStore.getState().updatePreferences({ autoGainControl: enabled })
    );
  },
  setInputSensitivity: (value) => {
    const next = Math.min(1, Math.max(0, value));
    getStorage().setItem('inputSensitivity', String(next));
    set({ inputSensitivity: next });
    import('./userPreferencesStore.js').then(m =>
      m.useUserPreferencesStore.getState().updatePreferences({ inputSensitivity: next })
    );
  },
  setLocalInputLevel: (value) => {
    const next = Math.min(1, Math.max(0, value));
    set({ localInputLevel: next });
  },
  setNeedsAudioUnlock: (value) => set({ needsAudioUnlock: value }),
  toggleSpeaker: () => set((s) => {
    const next = !s.speakerOn;
    getStorage().setItem('speakerOn', String(next));
    return { speakerOn: next };
  }),
  setSpeaking: (userId, speaking) =>
    set((s) => {
      const has = s.speakingUsers.has(userId);
      if (speaking === has) return s;
      const next = new Set(s.speakingUsers);
      if (speaking) next.add(userId);
      else next.delete(userId);
      return { speakingUsers: next };
    }),
  isVoiceChatOpen: false,
  toggleVoiceChat: () => set((s) => ({ isVoiceChatOpen: !s.isVoiceChatOpen })),
  setVoiceChatOpen: (open) => set({ isVoiceChatOpen: open }),
}));

/**
 * Hydrate voice store from persistent storage.
 * Must be called AFTER setStorage() so the adapter is available.
 */
export function hydrateVoiceStore() {
  const s = getStorage();
  const boolOr = (key: string, fallback: boolean) => {
    const v = s.getItem(key);
    return v === null ? fallback : v === 'true';
  };
  useVoiceStore.setState({
    isMuted: boolOr('isMuted', false),
    isDeafened: boolOr('isDeafened', false),
    voiceMode: (s.getItem('voiceMode') as VoiceMode) || 'voice-activity',
    pttKey: s.getItem('pttKey') || '`',
    speakerOn: boolOr('speakerOn', true),
    inputDeviceId: s.getItem('inputDeviceId') || 'default',
    outputDeviceId: s.getItem('outputDeviceId') || 'default',
    cameraDeviceId: s.getItem('cameraDeviceId') || 'default',
    noiseSuppression: boolOr('noiseSuppression', true),
    echoCancellation: boolOr('echoCancellation', true),
    autoGainControl: boolOr('autoGainControl', true),
    inputSensitivity: Number(s.getItem('inputSensitivity')) || 1,
  });
}
