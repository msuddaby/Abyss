import { useVoiceChatStore } from '@abyss/shared';
import type { MenuItem, ProviderContext } from '../types';

export function voiceProvider(ctx: ProviderContext): MenuItem[] {
  const { entities, currentUser, voiceChannelId, voiceParticipants } = ctx;
  const { user } = entities;
  if (!user || !voiceChannelId) return [];
  if (user.id === currentUser?.id) return [];
  if (!voiceParticipants.has(user.id)) return [];

  const items: MenuItem[] = [];

  items.push({
    id: 'voice-volume',
    label: 'User Volume',
    group: 'voice',
    order: 0,
    keepOpen: true,
    action: () => {},
    render: () => null, // Rendered specially by ContextMenu
  });

  const ttsUsers = useVoiceChatStore.getState().ttsUsers;
  const hasTts = ttsUsers.has(user.id);

  items.push({
    id: 'voice-tts',
    label: hasTts ? 'Stop Speaking Messages' : 'Speak Messages',
    group: 'voice',
    order: 1,
    action: () => useVoiceChatStore.getState().toggleTtsUser(user.id),
  });

  return items;
}
