import { create } from 'zustand';

interface ReactionDetailsState {
  // Ids rather than a message snapshot, so the modal can re-read the live message and
  // stay in sync as reactions are added/removed while it is open.
  target: { messageId: string; channelId: string; emoji: string | null } | null;

  open: (messageId: string, channelId: string, emoji?: string | null) => void;
  close: () => void;
}

export const useReactionDetailsStore = create<ReactionDetailsState>((set) => ({
  target: null,

  open: (messageId, channelId, emoji = null) =>
    set({ target: { messageId, channelId, emoji } }),
  close: () => set({ target: null }),
}));
