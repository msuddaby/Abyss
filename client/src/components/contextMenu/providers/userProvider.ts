import { useDmStore, useMessageStore, useServerStore } from '@abyss/shared';
import type { MenuItem, ProviderContext } from '../types';

export function userProvider(ctx: ProviderContext): MenuItem[] {
  const { entities, actions, currentUser } = ctx;
  const { user } = entities;
  if (!user) return [];

  const items: MenuItem[] = [];

  if (actions.onViewProfile) {
    items.push({
      id: 'user-profile',
      label: 'View Profile',
      group: 'user',
      order: 0,
      action: actions.onViewProfile,
    });
  }

  if (user.id !== currentUser?.id) {
    items.push({
      id: 'user-message',
      label: 'Message',
      group: 'user',
      order: 1,
      action: async () => {
        const { createOrGetDm, enterDmMode, setActiveDmChannel } = useDmStore.getState();
        const { leaveChannel, joinChannel, fetchMessages, currentChannelId } = useMessageStore.getState();
        if (currentChannelId) {
          await leaveChannel(currentChannelId).catch(console.error);
        }
        const dm = await createOrGetDm(user.id);
        enterDmMode();
        useServerStore.getState().clearActiveServer();
        setActiveDmChannel(dm);
        await joinChannel(dm.id).catch(console.error);
        fetchMessages(dm.id);
      },
    });
  }

  return items;
}
