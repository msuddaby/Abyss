import { useEffect, useState } from 'react';
import { api, useArchiveStore, useWatchPartyStore, useToastStore } from '@abyss/shared';
import type { ArchiveItem } from '@abyss/shared';
import { mediaUrl, formatDuration, errorText } from './archiveUtils';
import { PlayIcon } from './ArchiveIcons';

/** Archive tab inside the watch-party media browser: pick an archived video to play or queue. */
export default function ArchivePicker({ serverId, channelId, onClose }: { serverId: string; channelId: string | null; onClose: () => void }) {
  const activeParty = useWatchPartyStore((s) => s.activeParty);
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params: Record<string, string | number> = { type: 'video', limit: 100 };
        if (query.trim()) params.q = query.trim();
        const res = await api.get<{ items: ArchiveItem[] }>(`/servers/${serverId}/archive/items`, { params });
        if (!cancelled) setItems(res.data.items);
      } catch (e) {
        console.error('Failed to load archive videos', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [serverId, query]);

  const play = async (item: ArchiveItem) => {
    if (!channelId) return;
    try {
      if (activeParty) await useWatchPartyStore.getState().stopWatchParty(channelId);
      await useArchiveStore.getState().startWatchParty(channelId, item);
      onClose();
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not start Watch Together'), 'error');
    }
  };

  const queue = async (item: ArchiveItem) => {
    if (!channelId) return;
    try {
      await useArchiveStore.getState().queueItem(channelId, item);
      useToastStore.getState().addToast(`Added to queue: ${item.title}`, 'success');
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not add to queue'), 'error');
    }
  };

  return (
    <div className="mlb-yt-section archive-picker">
      <div className="mlb-yt-input-row">
        <input
          type="text"
          className="mlb-yt-input"
          placeholder="Search archived videos..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!loading && items.length === 0 && (
        <div className="archive-picker-empty">
          {query ? 'No archived videos match.' : 'No videos in the archive yet. Upload some from the Archive in the channel sidebar.'}
        </div>
      )}
      <div className="archive-picker-grid">
        {items.map((item) => (
          <div key={item.id} className="archive-picker-card">
            <div className="archive-picker-thumb">
              {item.posterPath ? <img src={mediaUrl(item.posterPath)} alt="" loading="lazy" /> : <PlayIcon size={24} />}
              {item.durationMs ? <span className="archive-duration">{formatDuration(item.durationMs)}</span> : null}
            </div>
            <div className="archive-picker-title" title={item.title}>{item.title}</div>
            <div className="mlb-yt-preview-actions">
              <button className="mlb-play-btn" onClick={() => play(item)}>▶ Play Now</button>
              {activeParty && <button className="mlb-queue-btn" onClick={() => queue(item)}>+ Queue</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
