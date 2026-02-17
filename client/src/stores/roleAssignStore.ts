import { create } from 'zustand';
import type { ServerMember } from '@abyss/shared';

interface RoleAssignState {
  isOpen: boolean;
  target: ServerMember | null;
  selectedRoleIds: string[];
  open: (member: ServerMember) => void;
  close: () => void;
  setSelectedRoleIds: (ids: string[]) => void;
}

export const useRoleAssignStore = create<RoleAssignState>((set) => ({
  isOpen: false,
  target: null,
  selectedRoleIds: [],
  open: (member) =>
    set({
      isOpen: true,
      target: member,
      selectedRoleIds: member.roles.filter((r) => !r.isDefault).map((r) => r.id),
    }),
  close: () =>
    set({ isOpen: false, target: null, selectedRoleIds: [] }),
  setSelectedRoleIds: (ids) =>
    set({ selectedRoleIds: ids }),
}));
