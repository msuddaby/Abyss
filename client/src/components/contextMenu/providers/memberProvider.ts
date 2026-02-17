import { hasPermission, Permission, canActOn } from '@abyss/shared';
import { useRoleAssignStore } from '../../../stores/roleAssignStore';
import { useModerationStore } from '../../../stores/moderationStore';
import type { MenuItem, ProviderContext } from '../types';

export function memberProvider(ctx: ProviderContext): MenuItem[] {
  const { entities, currentUser, currentMember, activeServer } = ctx;
  const { member } = entities;
  if (!member || !currentMember || !activeServer) return [];
  if (member.userId === currentUser?.id) return [];
  if (!canActOn(currentMember, member)) return [];

  const items: MenuItem[] = [];

  if (hasPermission(currentMember, Permission.ManageRoles)) {
    items.push({
      id: 'member-manage-roles',
      label: 'Manage Roles',
      group: 'moderation',
      order: 0,
      action: () => useRoleAssignStore.getState().open(member),
    });
  }

  if (hasPermission(currentMember, Permission.KickMembers)) {
    items.push({
      id: 'member-kick',
      label: 'Kick',
      group: 'moderation',
      order: 1,
      danger: true,
      action: () => {
        useModerationStore.getState().open({
          type: 'kick',
          serverId: activeServer.id,
          userId: member.userId,
          displayName: member.user.displayName || member.user.username,
        });
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
      action: () => {
        useModerationStore.getState().open({
          type: 'ban',
          serverId: activeServer.id,
          userId: member.userId,
          displayName: member.user.displayName || member.user.username,
        });
      },
    });
  }

  return items;
}
