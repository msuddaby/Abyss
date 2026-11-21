import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useArchiveStore, useToastStore, formatFileSize } from '@abyss/shared';
import type { ArchiveItem, GalleryItem } from '@abyss/shared';
import ConfirmModal from '../ConfirmModal';
import { toMediaVolume } from '../../utils/audioUtils';
import { useArchiveWatch } from './useArchiveWatch';
import { mediaUrl, archiveVideoUrl, isVideoType, formatDuration, shortDate, jumpToMessage, errorText } from './archiveUtils';
import type { LightboxEntry } from './archiveUtils';
import { ChevronIcon, CloseIcon, PlayIcon, QueueAddIcon, SpeakerIcon } from './ArchiveIcons';

const entryId = (e: LightboxEntry) => (e.kind === 'archive' ? e.item.id : e.item.attachmentId);

// Element volume (0-1) last used in the lightbox player, remembered across items and sessions.
const LIGHTBOX_VOLUME_KEY = 'archive-lightbox-volume';
const LIGHTBOX_MUTED_KEY = 'archive-lightbox-muted';

function readSavedVolume(): { volume: number; muted: boolean } {
  try {
    const v = parseFloat(localStorage.getItem(LIGHTBOX_VOLUME_KEY) ?? '');
    return {
      // Default matches the app's scaled "100%" level instead of the far-too-loud element maximum
      volume: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : toMediaVolume(1),
      muted: localStorage.getItem(LIGHTBOX_MUTED_KEY) === '1',
    };
  } catch {
    return { volume: toMediaVolume(1), muted: false };
  }
}

/** Native <video controls> that restores and persists the user's volume. */
function LightboxVideo({ src, poster }: { src?: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const saved = readSavedVolume();
    video.volume = saved.volume;
    video.muted = saved.muted;
    const onVolume = () => {
      try {
        localStorage.setItem(LIGHTBOX_VOLUME_KEY, String(video.volume));
        localStorage.setItem(LIGHTBOX_MUTED_KEY, video.muted ? '1' : '0');
      } catch { /* storage unavailable: volume just won't persist */ }
    };
    video.addEventListener('volumechange', onVolume);
    return () => video.removeEventListener('volumechange', onVolume);
  }, [src]);

  return <video ref={ref} src={src} poster={poster} controls playsInline preload="metadata" />;
}

export default function ArchiveLightbox({
  entries, index, onIndexChange, onClose, canUpload, canManage, currentUserId, liveItems, liveGallery,
}: {
  entries: LightboxEntry[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  canUpload: boolean;
  canManage: boolean;
  currentUserId?: string;
  liveItems?: ArchiveItem[];
  liveGallery?: GalleryItem[];
}) {
  // Follow the live store lists so edits, deletes and newly loaded pages show up here.
  const list: LightboxEntry[] = useMemo(() => {
    if (entries[0]?.kind === 'archive' && liveItems) return liveItems.map((item) => ({ kind: 'archive' as const, item }));
    if (entries[0]?.kind === 'gallery' && liveGallery) return liveGallery.map((item) => ({ kind: 'gallery' as const, item }));
    return entries;
  }, [entries, liveItems, liveGallery]);

  const [currentId, setCurrentId] = useState(() => (entries[index] ? entryId(entries[index]) : ''));
  const pos = list.findIndex((e) => entryId(e) === currentId);
  const entry = pos >= 0 ? list[pos] : undefined;

  useEffect(() => {
    if (!entry) onClose();
  }, [entry, onClose]);

  const go = (delta: number) => {
    const next = pos + delta;
    if (next < 0 || next >= list.length) return;
    setCurrentId(entryId(list[next]));
    onIndexChange(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!entry) return null;

  const contentType = entry.item.contentType;
  const video = isVideoType(contentType);
  const src = entry.kind === 'archive'
    ? (video ? archiveVideoUrl(entry.item) : mediaUrl(entry.item.url))
    : mediaUrl(entry.item.filePath);
  const poster = mediaUrl(entry.item.posterPath ?? undefined);
  const title = entry.kind === 'archive' ? entry.item.title : entry.item.fileName;

  return createPortal(
    <div className="archive-lightbox" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="archive-lightbox-stage" onClick={(e) => e.stopPropagation()}>
        <div className="archive-lightbox-top">
          <button className="archive-round-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
          <span className="archive-lightbox-crumb">{pos + 1} of {list.length}</span>
        </div>
        <div className="archive-lightbox-media">
          <button className="archive-round-btn nav" onClick={() => go(-1)} disabled={pos <= 0} aria-label="Previous item"><ChevronIcon dir="left" /></button>
          <div className="archive-lightbox-frame">
            {video
              ? <LightboxVideo key={entryId(entry)} src={src} poster={poster} />
              : <img key={entryId(entry)} src={src} alt={title} />}
          </div>
          <button className="archive-round-btn nav" onClick={() => go(1)} disabled={pos >= list.length - 1} aria-label="Next item"><ChevronIcon dir="right" /></button>
        </div>
      </div>
      <aside className="archive-lightbox-panel" onClick={(e) => e.stopPropagation()}>
        {entry.kind === 'archive'
          ? <ArchiveDetails key={entry.item.id} item={entry.item} canManage={canManage} currentUserId={currentUserId} />
          : <GalleryDetails key={entry.item.attachmentId} item={entry.item} canUpload={canUpload} onJump={onClose} />}
      </aside>
    </div>,
    document.body,
  );
}

function ArchiveDetails({ item, canManage, currentUserId }: { item: ArchiveItem; canManage: boolean; currentUserId?: string }) {
  const albums = useArchiveStore((s) => s.albums);
  const watch = useArchiveWatch();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const video = isVideoType(item.contentType);
  const canEdit = canManage || item.uploaderId === currentUserId;
  const album = albums.find((a) => a.id === item.albumId);

  const save = async () => {
    try {
      await useArchiveStore.getState().updateItem(item.serverId, item.id, { title, description });
      setEditing(false);
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not save changes'), 'error');
    }
  };

  const move = async (albumId: string) => {
    try {
      await useArchiveStore.getState().updateItem(item.serverId, item.id, { albumId: albumId || null });
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not move item'), 'error');
    }
  };

  const details: [string, string][] = [
    ['Uploaded by', item.uploader?.displayName ?? 'Unknown'],
    ['Added', shortDate(item.createdAt)],
  ];
  if (video && item.durationMs) details.push(['Length', formatDuration(item.durationMs)]);
  details.push(['File', [item.contentType.split('/')[1]?.toUpperCase(), item.width && item.height ? `${item.width}×${item.height}` : null, formatFileSize(item.size)].filter(Boolean).join(' · ')]);

  return (
    <>
      {editing ? (
        <form className="archive-edit-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
          <label>Description<textarea value={description} maxLength={1000} rows={4} onChange={(e) => setDescription(e.target.value)} /></label>
          <div className="archive-edit-actions">
            <button type="button" className="archive-secondary-btn" onClick={() => { setEditing(false); setTitle(item.title); setDescription(item.description ?? ''); }}>Cancel</button>
            <button type="submit" className="archive-primary-btn" disabled={!title.trim()}>Save</button>
          </div>
        </form>
      ) : (
        <div>
          <h2 className="archive-lightbox-title">{item.title}</h2>
          {item.description && <p className="archive-lightbox-desc">{item.description}</p>}
        </div>
      )}

      <dl className="archive-details">
        {details.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
        <div>
          <dt>Album</dt>
          <dd>
            {canEdit ? (
              <select className="archive-select" value={item.albumId ?? ''} onChange={(e) => move(e.target.value)} aria-label="Album">
                <option value="">No album</option>
                {albums.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            ) : (album?.name ?? 'None')}
          </dd>
        </div>
      </dl>

      {video && watch.voiceChannel && (watch.canStart || watch.canQueue) && (
        <div className="archive-watch-card">
          <div className="archive-watch-where"><SpeakerIcon /> In {watch.voiceChannel.name}</div>
          {watch.canStart && (
            <button className="archive-primary-btn large" onClick={() => watch.start(item)}><PlayIcon size={14} /> Start Watch Together</button>
          )}
          {watch.canQueue && (
            <button className="archive-secondary-btn large" onClick={() => watch.queue(item)}><QueueAddIcon /> Add to queue</button>
          )}
          <span className="archive-watch-note">
            {watch.canStart ? 'No party running. Starting one makes you the host.' : 'A party is running; this plays after the current queue.'}
          </span>
        </div>
      )}

      <div className="archive-lightbox-footer">
        {canEdit && !editing && <button className="archive-secondary-btn" onClick={() => setEditing(true)}>Edit details</button>}
        <a className="archive-secondary-btn" href={video ? archiveVideoUrl(item) : mediaUrl(item.url)} download={item.fileName}>Download</a>
        {canEdit && <button className="archive-secondary-btn danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete from archive"
          message={`Delete "${item.title}"? This can't be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => useArchiveStore.getState().deleteItem(item.serverId, item.id)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

function GalleryDetails({ item, canUpload, onJump }: { item: GalleryItem; canUpload: boolean; onJump: () => void }) {
  const albums = useArchiveStore((s) => s.albums);
  const [albumId, setAlbumId] = useState('');
  const [saved, setSaved] = useState(false);
  const serverId = useArchiveStore((s) => s.openServerId);

  const save = async () => {
    if (!serverId) return;
    try {
      await useArchiveStore.getState().saveFromAttachment(serverId, item.attachmentId, albumId || null);
      setSaved(true);
      useToastStore.getState().addToast('Saved to Archive', 'success');
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not save to archive'), 'error');
    }
  };

  return (
    <>
      <div>
        <h2 className="archive-lightbox-title">{item.fileName}</h2>
        <p className="archive-lightbox-desc">Posted by {item.author.displayName} in #{item.channelName}</p>
      </div>
      <dl className="archive-details">
        <div><dt>Posted</dt><dd>{shortDate(item.createdAt)}</dd></div>
        <div><dt>File</dt><dd>{[item.width && item.height ? `${item.width}×${item.height}` : null, formatFileSize(item.size)].filter(Boolean).join(' · ')}</dd></div>
      </dl>
      {canUpload && (
        <div className="archive-watch-card">
          <label className="archive-save-label">
            Save into
            <select className="archive-select" value={albumId} onChange={(e) => setAlbumId(e.target.value)}>
              <option value="">No album</option>
              {albums.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <button className="archive-primary-btn large" disabled={saved} onClick={save}>{saved ? 'Saved to Archive' : 'Save to Archive'}</button>
          <span className="archive-watch-note">Saving keeps a copy even if the message is deleted.</span>
        </div>
      )}
      <div className="archive-lightbox-footer">
        <button className="archive-secondary-btn" onClick={() => { onJump(); jumpToMessage(item.channelId, item.messageId); }}>Jump to message</button>
        <a className="archive-secondary-btn" href={mediaUrl(item.filePath)} download={item.fileName}>Download</a>
      </div>
    </>
  );
}
