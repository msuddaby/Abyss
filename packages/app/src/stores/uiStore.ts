import { create } from 'zustand';

type Panel = 'servers' | 'channels' | 'content' | 'members';
type ModalType = 'createServer' | 'joinServer' | 'createChannel' | 'invite'
  | 'userSettings' | 'serverSettings' | 'userProfile' | null;

interface UiState {
  activePanel: Panel;
  setPanel: (panel: Panel) => void;
  activeModal: ModalType;
  modalProps: Record<string, any>;
  openModal: (modal: ModalType, props?: Record<string, any>) => void;
  closeModal: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  activePanel: 'channels',
  setPanel: (panel) => set({ activePanel: panel }),
  activeModal: null,
  modalProps: {},
  openModal: (modal, props = {}) => set({ activeModal: modal, modalProps: props }),
  closeModal: () => set({ activeModal: null, modalProps: {} }),
}));
