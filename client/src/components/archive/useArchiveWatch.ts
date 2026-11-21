import { useCallback } from 'react';
import { useServerStore, useVoiceStore, useWatchPartyStore, useArchiveStore, useToastStore, hasChannelPermission, Permission } from '@abyss/shared';
import type { ArchiveItem } from '@abyss/shared';
import { errorText } from './archiveUtils';

/**
 * What the current user can do with an archive video in their voice channel.
 * Server enforces the same rules; this only decides which buttons to show.
 */
export function useArchiveWatch() {
  const voiceChannelId = useVoiceStore((s) => s.currentChannelId);
  const channels = useServerStore((s) => s.channels);
  const activeServerId = useServerStore((s) => s.activeServer?.id);
  const activeParty = useWatchPartyStore((s) => s.activeParty);

  // Only voice channels in this server count; a voice session elsewhere can't host an archive item.
  const voiceChannel = voiceChannelId ? channels.find((c) => c.id === voiceChannelId && c.serverId === activeServerId) : undefined;
  const partyHere = !!activeParty && activeParty.channelId === voiceChannel?.id;
  const canStart = !!voiceChannel && !partyHere && hasChannelPermission(voiceChannel.permissions, Permission.Stream);
  const canQueue = !!voiceChannel && partyHere && hasChannelPermission(voiceChannel.permissions, Permission.AddToWatchTogether);

  const start = useCallback(async (item: ArchiveItem) => {
    if (!voiceChannel) return;
    try {
      await useArchiveStore.getState().startWatchParty(voiceChannel.id, item);
      useToastStore.getState().addToast(`Watch Together started: ${item.title}`, 'success');
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not start Watch Together'), 'error');
    }
  }, [voiceChannel]);

  const queue = useCallback(async (item: ArchiveItem) => {
    if (!voiceChannel) return;
    try {
      await useArchiveStore.getState().queueItem(voiceChannel.id, item);
      useToastStore.getState().addToast(`Added to queue: ${item.title}`, 'success');
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not add to queue'), 'error');
    }
  }, [voiceChannel]);

  return { voiceChannel, partyHere, canStart, canQueue, start, queue };
}
