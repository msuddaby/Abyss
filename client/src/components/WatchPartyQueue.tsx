import { useState } from 'react';
import { useWatchPartyStore } from '@abyss/shared';
import type { QueueItem } from '@abyss/shared';

interface Props {
  queue: QueueItem[];
  canControl: boolean;
  channelId: string;
  onClose: () => void;
  onAdd: () => void;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function WatchPartyQueue({ queue, canControl, channelId, onClose, onAdd }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleRemove = async (index: number) => {
    try {
      await useWatchPartyStore.getState().removeFromQueue(channelId, index);
    } catch (e) {
      console.error('Failed to remove from queue:', e);
    }
  };

  const handleClearAll = async () => {
    try {
      await useWatchPartyStore.getState().clearQueue(channelId);
    } catch (e) {
      console.error('Failed to clear queue:', e);
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
        <div className="wpq-header-actions">
          {canControl && queue.length > 0 && (
            <button className="wpq-clear-btn" onClick={handleClearAll} title="Clear queue">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </button>
          )}
          <button className="wpq-close" onClick={onClose}>&#10005;</button>
        </div>
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
              {canControl && (
                <div className="wpq-item-grip" title="Drag to reorder">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                  </svg>
                </div>
              )}
              <div className="wpq-item-thumb">
                {item.thumbnail ? (
                  <img src={item.thumbnail} alt={item.title} />
                ) : (
                  <div className="wpq-item-placeholder">&#127916;</div>
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
                  &#10005;
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="wpq-footer">
        <button className="wpq-add-btn" onClick={onAdd}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
          </svg>
          Add to Queue
        </button>
      </div>
    </div>
  );
}
