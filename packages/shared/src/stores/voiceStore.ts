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
  speakingUsers: Set<string>;
  voiceMode: VoiceMode;
  pttKey: string;
  isPttActive: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
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
  setVoiceMode: (mode: VoiceMode) => void;
  setPttKey: (key: string) => void;
  setPttActive: (active: boolean) => void;
  setInputDeviceId: (deviceId: string) => void;
  setOutputDeviceId: (deviceId: string) => void;
  setNoiseSuppression: (enabled: boolean) => void;
  setEchoCancellation: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  setInputSensitivity: (value: number) => void;
  setLocalInputLevel: (value: number) => void;
  setNeedsAudioUnlock: (value: boolean) => void;
  speakerOn: boolean;
  toggleSpeaker: () => void;
  setSpeaking: (userId: string, speaking: boolean) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  currentChannelId: null,
  participants: new Map(),
  isMuted: (() => { try { return getStorage().getItem('isMuted') === 'true'; } catch { return false; } })(),
  isDeafened: (() => { try { return getStorage().getItem('isDeafened') === 'true'; } catch { return false; } })(),
  isScreenSharing: false,
  activeSharers: new Map(),
  watchingUserId: null,
  screenStreamVersion: 0,
  speakingUsers: new Set<string>(),
  voiceMode: (() => { try { return (getStorage().getItem('voiceMode') as VoiceMode) || 'voice-activity'; } catch { return 'voice-activity' as VoiceMode; } })(),
  pttKey: (() => { try { return getStorage().getItem('pttKey') || '`'; } catch { return '`'; } })(),
  speakerOn: (() => { try { const v = getStorage().getItem('speakerOn'); return v === null ? true : v === 'true'; } catch { return true; } })(),
  isPttActive: false,
  inputDeviceId: (() => { try { return getStorage().getItem('inputDeviceId') || 'default'; } catch { return 'default'; } })(),
  outputDeviceId: (() => { try { return getStorage().getItem('outputDeviceId') || 'default'; } catch { return 'default'; } })(),
  noiseSuppression: (() => { try { const v = getStorage().getItem('noiseSuppression'); return v === null ? true : v === 'true'; } catch { return true; } })(),
  echoCancellation: (() => { try { const v = getStorage().getItem('echoCancellation'); return v === null ? true : v === 'true'; } catch { return true; } })(),
  autoGainControl: (() => { try { const v = getStorage().getItem('autoGainControl'); return v === null ? true : v === 'true'; } catch { return true; } })(),
  inputSensitivity: (() => { try { const v = getStorage().getItem('inputSensitivity'); return v ? Number(v) : 0.78; } catch { return 0.78; } })(),
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
      let sharerUpdate: Partial<VoiceState> = {};
      if (s.activeSharers.has(userId)) {
        const nextSharers = new Map(s.activeSharers);
        nextSharers.delete(userId);
        sharerUpdate.activeSharers = nextSharers;
      }
      if (s.watchingUserId === userId) {
        sharerUpdate.watchingUserId = null;
      }
      return { participants: next, ...sharerUpdate };
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
  setVoiceMode: (mode) => {
    getStorage().setItem('voiceMode', mode);
    set({ voiceMode: mode, isPttActive: false });
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
  setNoiseSuppression: (enabled) => {
    getStorage().setItem('noiseSuppression', String(enabled));
    set({ noiseSuppression: enabled });
  },
  setEchoCancellation: (enabled) => {
    getStorage().setItem('echoCancellation', String(enabled));
    set({ echoCancellation: enabled });
  },
  setAutoGainControl: (enabled) => {
    getStorage().setItem('autoGainControl', String(enabled));
    set({ autoGainControl: enabled });
  },
  setInputSensitivity: (value) => {
    const next = Math.min(1, Math.max(0, value));
    getStorage().setItem('inputSensitivity', String(next));
    set({ inputSensitivity: next });
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
}));
