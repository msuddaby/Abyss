import { create } from 'zustand';
import type { ContextEntities, ContextActions } from '../components/contextMenu/types';

interface ContextMenuState {
  isOpen: boolean;
  position: { x: number; y: number };
  entities: ContextEntities;
  actions: ContextActions;
  open: (x: number, y: number, entities: ContextEntities, actions?: ContextActions) => void;
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  isOpen: false,
  position: { x: 0, y: 0 },
  entities: {},
  actions: {},
  open: (x, y, entities, actions = {}) =>
    set({ isOpen: true, position: { x, y }, entities, actions }),
  close: () =>
    set({ isOpen: false, entities: {}, actions: {} }),
}));
