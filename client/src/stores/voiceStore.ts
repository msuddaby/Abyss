import { create } from 'zustand';

type VoiceMode = 'voice-activity' | 'push-to-talk';

interface VoiceState {
  currentChannelId: string | null;
  participants: Map<string, string>; // userId -> displayName
  isMuted: boolean;
  isDeafened: boolean;
  isScreenSharing: boolean;
  screenSharerUserId: string | null;
  screenSharerDisplayName: string | null;
  screenStreamVersion: number;
  speakingUsers: Set<string>;
  voiceMode: VoiceMode;
  pttKey: string;
  isPttActive: boolean;
  setCurrentChannel: (channelId: string | null) => void;
  setParticipants: (participants: Map<string, string>) => void;
  addParticipant: (userId: string, displayName: string) => void;
  removeParticipant: (userId: string) => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setScreenSharing: (sharing: boolean) => void;
  setScreenSharer: (userId: string | null, displayName: string | null) => void;
  bumpScreenStreamVersion: () => void;
  setVoiceMode: (mode: VoiceMode) => void;
  setPttKey: (key: string) => void;
  setPttActive: (active: boolean) => void;
  setSpeaking: (userId: string, speaking: boolean) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  currentChannelId: null,
  participants: new Map(),
  isMuted: false,
  isDeafened: false,
  isScreenSharing: false,
  screenSharerUserId: null,
  screenSharerDisplayName: null,
  screenStreamVersion: 0,
  speakingUsers: new Set<string>(),
  voiceMode: (localStorage.getItem('voiceMode') as VoiceMode) || 'voice-activity',
  pttKey: localStorage.getItem('pttKey') || '`',
  isPttActive: false,

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
      // If the removed user was the screen sharer, clear sharer
      const clearSharer = s.screenSharerUserId === userId
        ? { screenSharerUserId: null, screenSharerDisplayName: null, isScreenSharing: false }
        : {};
      return { participants: next, ...clearSharer };
    }),

  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  toggleDeafen: () => set((s) => ({ isDeafened: !s.isDeafened })),
  setScreenSharing: (sharing) => set({ isScreenSharing: sharing }),
  setScreenSharer: (userId, displayName) =>
    set({ screenSharerUserId: userId, screenSharerDisplayName: displayName }),
  bumpScreenStreamVersion: () =>
    set((s) => ({ screenStreamVersion: s.screenStreamVersion + 1 })),
  setVoiceMode: (mode) => {
    localStorage.setItem('voiceMode', mode);
    set({ voiceMode: mode, isPttActive: false });
  },
  setPttKey: (key) => {
    localStorage.setItem('pttKey', key);
    set({ pttKey: key });
  },
  setPttActive: (active) => set({ isPttActive: active }),
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
