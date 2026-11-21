import { getApiBase, getStorage, api, useServerStore, useMessageStore, useArchiveStore } from '@abyss/shared';
import type { ArchiveItem, GalleryItem, Message } from '@abyss/shared';

/** A single thing the lightbox can show: an archive upload or a chat attachment. */
export type LightboxEntry =
  | { kind: 'archive'; item: ArchiveItem }
  | { kind: 'gallery'; item: GalleryItem };

export function mediaUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return `${getApiBase()}${path}`;
}

/** Archive videos are membership-checked; <video> can't send headers so pass the token. */
export function archiveVideoUrl(item: ArchiveItem): string {
  const token = getStorage().getItem('token');
  const sep = item.url.includes('?') ? '&' : '?';
  return `${getApiBase()}${item.url}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`;
}

export const isVideoType = (contentType: string) => contentType.startsWith('video/');

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

export function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Switch to the message's channel and load history around it (same flow as SearchPanel). */
export async function jumpToMessage(channelId: string, messageId: string) {
  const { channels, activeChannel, setActiveChannel } = useServerStore.getState();
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) return;
  useArchiveStore.getState().closeArchive();
  if (activeChannel?.id !== channel.id) setActiveChannel(channel);
  try {
    const res = await api.get<Message[]>(`/channels/${channel.id}/messages/around/${messageId}`);
    useMessageStore.setState({
      messages: res.data,
      currentChannelId: channel.id,
      hasMore: true,
      hasNewer: true,
      highlightedMessageId: messageId,
      loading: false,
    });
  } catch (e) {
    console.error('Failed to jump to message', e);
    useMessageStore.getState().fetchMessages(channel.id);
  }
}

export function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: unknown }; message?: string };
  if (typeof e?.response?.data === 'string' && e.response.data) return e.response.data;
  return e?.message || fallback;
}
