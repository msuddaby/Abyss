import { create } from 'zustand';

interface ModerationAction {
  type: 'kick' | 'ban';
  serverId: string;
  userId: string;
  displayName: string;
}

interface ModerationState {
  pending: ModerationAction | null;
  open: (action: ModerationAction) => void;
  close: () => void;
}

export const useModerationStore = create<ModerationState>((set) => ({
  pending: null,
  open: (action) => set({ pending: action }),
  close: () => set({ pending: null }),
}));
