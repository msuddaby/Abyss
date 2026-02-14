import { useState } from 'react';
import { useWatchPartyStore } from '@abyss/shared';
import type { QueueItem } from '@abyss/shared';

interface Props {
  queue: QueueItem[];
  canControl: boolean;
  channelId: string;
  onClose: () => void;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function WatchPartyQueue({ queue, canControl, channelId, onClose }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleRemove = async (index: number) => {
    try {
      await useWatchPartyStore.getState().removeFromQueue(channelId, index);
    } catch (e) {
      console.error('Failed to remove from queue:', e);
    }
  };

  const handleDragStart = (index: number) => {
    if (!canControl) return;
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = async (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newOrder = queue.map((_, i) => i);
    const [removed] = newOrder.splice(dragIndex, 1);
    newOrder.splice(targetIndex, 0, removed);

    try {
      await useWatchPartyStore.getState().reorderQueue(channelId, newOrder);
    } catch (e) {
      console.error('Failed to reorder queue:', e);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="wpq-panel">
      <div className="wpq-header">
        <span>Queue ({queue.length})</span>
        <button className="wpq-close" onClick={onClose}>✕</button>
      </div>
      <div className="wpq-list">
        {queue.length === 0 ? (
          <div className="wpq-empty">Queue is empty</div>
        ) : (
          queue.map((item, i) => (
            <div
              key={`${item.providerItemId}-${i}`}
              className={`wpq-item ${dragOverIndex === i ? 'wpq-item-dragover' : ''}`}
              draggable={canControl}
              onDragStart={() => handleDragStart(i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={() => handleDrop(i)}
              onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
            >
              <div className="wpq-item-thumb">
                {item.thumbnail ? (
                  <img src={item.thumbnail} alt={item.title} />
                ) : (
                  <div className="wpq-item-placeholder">🎬</div>
                )}
              </div>
              <div className="wpq-item-info">
                <span className="wpq-item-title">{item.title}</span>
                {item.durationMs && (
                  <span className="wpq-item-duration">{formatDuration(item.durationMs)}</span>
                )}
              </div>
              {canControl && (
                <button className="wpq-item-remove" onClick={() => handleRemove(i)} title="Remove">
                  ✕
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
