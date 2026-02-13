import { create } from 'zustand';

interface MobileState {
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  openLeftDrawer: () => void;
  closeLeftDrawer: () => void;
  openRightDrawer: () => void;
  closeRightDrawer: () => void;
  closeDrawers: () => void;
}

export const useMobileStore = create<MobileState>((set) => ({
  leftDrawerOpen: false,
  rightDrawerOpen: false,
  openLeftDrawer: () => set({ leftDrawerOpen: true, rightDrawerOpen: false }),
  closeLeftDrawer: () => set({ leftDrawerOpen: false }),
  openRightDrawer: () => set({ rightDrawerOpen: true, leftDrawerOpen: false }),
  closeRightDrawer: () => set({ rightDrawerOpen: false }),
  closeDrawers: () => set({ leftDrawerOpen: false, rightDrawerOpen: false }),
}));

export function isMobile() {
  return window.innerWidth <= 768;
}
