import { create } from 'zustand';
import type { Message } from '@abyss/shared';

interface ForumTopicState {
  startMessage: Message | null;
  modalRange: { startMessage: Message; endMessage: Message; channelId: string } | null;

  setStart: (message: Message) => void;
  clearStart: () => void;
  openModal: (startMessage: Message, endMessage: Message) => void;
  closeModal: () => void;
}

export const useForumTopicStore = create<ForumTopicState>((set) => ({
  startMessage: null,
  modalRange: null,

  setStart: (message) => set({ startMessage: message }),
  clearStart: () => set({ startMessage: null }),
  openModal: (startMessage, endMessage) =>
    set({ modalRange: { startMessage, endMessage, channelId: startMessage.channelId } }),
  closeModal: () => set({ modalRange: null, startMessage: null }),
}));
