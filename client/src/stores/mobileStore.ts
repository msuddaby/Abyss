import { create } from 'zustand';

interface MobileState {
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  leftDrawerDragOffset: number;
  isLeftDrawerDragging: boolean;

  openLeftDrawer: () => void;
  closeLeftDrawer: () => void;
  openRightDrawer: () => void;
  closeRightDrawer: () => void;
  closeDrawers: () => void;
  setLeftDrawerDragOffset: (offset: number) => void;
  startLeftDrawerDrag: () => void;
  endLeftDrawerDrag: () => void;
  resetLeftDrawerDrag: () => void;
}

export const useMobileStore = create<MobileState>((set) => ({
  leftDrawerOpen: false,
  rightDrawerOpen: false,
  leftDrawerDragOffset: 0,
  isLeftDrawerDragging: false,

  openLeftDrawer: () => set({ leftDrawerOpen: true, rightDrawerOpen: false }),
  closeLeftDrawer: () => set({ leftDrawerOpen: false }),
  openRightDrawer: () => set({ rightDrawerOpen: true, leftDrawerOpen: false }),
  closeRightDrawer: () => set({ rightDrawerOpen: false }),
  closeDrawers: () => set({ leftDrawerOpen: false, rightDrawerOpen: false }),
  setLeftDrawerDragOffset: (offset) => set({ leftDrawerDragOffset: offset }),
  startLeftDrawerDrag: () => set({ isLeftDrawerDragging: true }),
  endLeftDrawerDrag: () => set({ isLeftDrawerDragging: false }),
  resetLeftDrawerDrag: () => set({ leftDrawerDragOffset: 0 }),
}));

export function isMobile() {
  return window.innerWidth <= 768;
}
