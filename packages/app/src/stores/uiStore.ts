import { create } from 'zustand';
type ModalType = 'createServer' | 'joinServer' | 'createChannel' | 'invite'
  | 'userSettings' | 'serverSettings' | 'userProfile' | 'search' | 'pins' | null;

interface UiState {
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  openLeftDrawer: () => void;
  closeLeftDrawer: () => void;
  toggleLeftDrawer: () => void;
  openRightDrawer: () => void;
  closeRightDrawer: () => void;
  toggleRightDrawer: () => void;
  closeDrawers: () => void;
  activeModal: ModalType;
  modalProps: Record<string, any>;
  openModal: (modal: ModalType, props?: Record<string, any>) => void;
  closeModal: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  leftDrawerOpen: true,
  rightDrawerOpen: false,
  openLeftDrawer: () => set({ leftDrawerOpen: true, rightDrawerOpen: false }),
  closeLeftDrawer: () => set({ leftDrawerOpen: false }),
  toggleLeftDrawer: () => set((state) => ({ leftDrawerOpen: !state.leftDrawerOpen, rightDrawerOpen: false })),
  openRightDrawer: () => set({ rightDrawerOpen: true, leftDrawerOpen: false }),
  closeRightDrawer: () => set({ rightDrawerOpen: false }),
  toggleRightDrawer: () => set((state) => ({ rightDrawerOpen: !state.rightDrawerOpen, leftDrawerOpen: false })),
  closeDrawers: () => set({ leftDrawerOpen: false, rightDrawerOpen: false }),
  activeModal: null,
  modalProps: {},
  openModal: (modal, props = {}) => set({ activeModal: modal, modalProps: props }),
  closeModal: () => set({ activeModal: null, modalProps: {} }),
}));
