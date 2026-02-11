import type { MenuItem, ProviderContext } from '../types';

export function channelProvider(ctx: ProviderContext): MenuItem[] {
  const { entities, actions } = ctx;
  const { channel } = entities;
  if (!channel) return [];

  const items: MenuItem[] = [];

  if (actions.onChannelNotifSettings) {
    items.push({
      id: 'channel-notif',
      label: 'Notification Settings',
      group: 'channel',
      order: 0,
      action: actions.onChannelNotifSettings,
    });
  }

  if (actions.onEditChannel) {
    items.push({
      id: 'channel-edit',
      label: 'Edit Channel',
      group: 'channel',
      order: 1,
      action: actions.onEditChannel,
    });
  }

  if (actions.onChannelPermissions) {
    items.push({
      id: 'channel-permissions',
      label: 'Channel Permissions',
      group: 'channel',
      order: 2,
      action: actions.onChannelPermissions,
    });
  }

  if (actions.onDeleteChannel) {
    items.push({
      id: 'channel-delete',
      label: 'Delete Channel',
      group: 'channel',
      order: 3,
      danger: true,
      action: actions.onDeleteChannel,
    });
  }

  return items;
}
