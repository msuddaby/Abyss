import type { MenuItem, ProviderContext } from '../types';

export function serverProvider(ctx: ProviderContext): MenuItem[] {
  const { entities, actions, currentUser } = ctx;
  const { server } = entities;
  if (!server) return [];

  const items: MenuItem[] = [];

  if (actions.onServerNotifSettings) {
    items.push({
      id: 'server-notif',
      label: 'Notification Settings',
      group: 'server',
      order: 0,
      action: actions.onServerNotifSettings,
    });
  }

  if (actions.onInvite) {
    items.push({
      id: 'server-invite',
      label: 'Invite People',
      group: 'server',
      order: 1,
      action: actions.onInvite,
    });
  }

  if (actions.onServerSettings) {
    items.push({
      id: 'server-settings',
      label: 'Server Settings',
      group: 'server',
      order: 2,
      action: actions.onServerSettings,
    });
  }

  if (actions.onLeaveServer && server.ownerId !== currentUser?.id) {
    items.push({
      id: 'server-leave',
      label: 'Leave Server',
      group: 'server',
      order: 3,
      danger: true,
      action: actions.onLeaveServer,
    });
  }

  return items;
}
