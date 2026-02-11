import { useServerStore, hasPermission, Permission, canActOn } from '@abyss/shared';
import type { MenuItem, ProviderContext } from '../types';

export function memberProvider(ctx: ProviderContext): MenuItem[] {
  const { entities, actions, currentUser, currentMember, activeServer } = ctx;
  const { member } = entities;
  if (!member || !currentMember || !activeServer) return [];
  if (member.userId === currentUser?.id) return [];
  if (!canActOn(currentMember, member)) return [];

  const items: MenuItem[] = [];

  if (actions.onManageRoles && hasPermission(currentMember, Permission.ManageRoles)) {
    items.push({
      id: 'member-manage-roles',
      label: 'Manage Roles',
      group: 'moderation',
      order: 0,
      action: actions.onManageRoles,
    });
  }

  if (hasPermission(currentMember, Permission.KickMembers)) {
    items.push({
      id: 'member-kick',
      label: 'Kick',
      group: 'moderation',
      order: 1,
      danger: true,
      action: async () => {
        await useServerStore.getState().kickMember(activeServer.id, member.userId);
      },
    });
  }

  if (hasPermission(currentMember, Permission.BanMembers)) {
    items.push({
      id: 'member-ban',
      label: 'Ban',
      group: 'moderation',
      order: 2,
      danger: true,
      action: async () => {
        await useServerStore.getState().banMember(activeServer.id, member.userId);
      },
    });
  }

  return items;
}
