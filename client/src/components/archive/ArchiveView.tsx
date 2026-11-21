import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useServerStore, useAuthStore, useArchiveStore, useToastStore, hasPermission, Permission, formatFileSize } from '@abyss/shared';
import type { ArchiveItem, ArchiveTypeFilter, GalleryItem } from '@abyss/shared';
import ConfirmModal from '../ConfirmModal';
import ArchiveLightbox from './ArchiveLightbox';
import { useArchiveWatch } from './useArchiveWatch';
import { mediaUrl, isVideoType, formatDuration, monthLabel, jumpToMessage, errorText } from './archiveUtils';
import type { LightboxEntry } from './archiveUtils';
import { ArchiveBoxIcon, PlayIcon, QueueAddIcon, UploadIcon, SearchIcon, PlusIcon, SpeakerIcon } from './ArchiveIcons';

const TYPE_OPTIONS: { value: ArchiveTypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Videos' },
  { value: 'image', label: 'Photos' },
];

function TypeFilter({ value, onChange }: { value: ArchiveTypeFilter; onChange: (v: ArchiveTypeFilter) => void }) {
  return (
    <div className="archive-segmented" role="group" aria-label="Type">
      {TYPE_OPTIONS.map((o) => (
        <button key={o.value} aria-pressed={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Calls onReach when the scroll container nears its bottom. */
function useNearBottom(onReach: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onReach);
  useEffect(() => { cb.current = onReach; });
  const onScroll = () => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 600) cb.current();
  };
  return { ref, onScroll };
}

export default function ArchiveView({ hamburger }: { hamburger: ReactNode }) {
  const server = useServerStore((s) => s.activeServer);
  const members = useServerStore((s) => s.members);
  const user = useAuthStore((s) => s.user);
  const tab = useArchiveStore((s) => s.tab);
  const setTab = useArchiveStore((s) => s.setTab);
  const items = useArchiveStore((s) => s.items);
  const gallery = useArchiveStore((s) => s.gallery);
  const filter = useArchiveStore((s) => s.filter);
  const albums = useArchiveStore((s) => s.albums);
  const uploads = useArchiveStore((s) => s.uploads);
  const stats = useArchiveStore((s) => s.stats);

  const [lightbox, setLightbox] = useState<{ entries: LightboxEntry[]; index: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentMember = members.find((m) => m.userId === user?.id);
  const canUpload = currentMember ? hasPermission(currentMember, Permission.UploadToArchive) : false;
  const canManage = currentMember ? hasPermission(currentMember, Permission.ManageArchive) : false;

  const serverId = server?.id;
  useEffect(() => {
    if (!serverId) return;
    useArchiveStore.getState().fetchAlbums(serverId).catch(console.error);
    useArchiveStore.getState().fetchStats(serverId).catch(console.error);
  }, [serverId]);

  if (!server) return null;

  const uploadFiles = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (list.length === 0) {
      useToastStore.getState().addToast('Only photos and videos can be added to the archive.', 'error');
      return;
    }
    if (tab !== 'uploads') setTab('uploads');
    useArchiveStore.getState().uploadFiles(server.id, list, filter.albumId);
  };

  const activeAlbum = albums.find((a) => a.id === filter.albumId);
  const subtitle = tab === 'uploads'
    ? (activeAlbum
      ? `${activeAlbum.itemCount} item${activeAlbum.itemCount === 1 ? '' : 's'} in ${activeAlbum.name}`
      : `${stats ? `${stats.total} item${stats.total === 1 ? '' : 's'} · ` : ''}${albums.length} album${albums.length === 1 ? '' : 's'}`)
    : 'Photos and videos posted in chat';

  return (
    <div
      className={`archive-view${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => { if (canUpload && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className="channel-header archive-header">
        {hamburger}
        <span className="archive-header-icon"><ArchiveBoxIcon size={22} /></span>
        <span className="channel-name">Archive</span>
        <span className="archive-header-sub">{subtitle}</span>
        <div className="archive-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'uploads'} className={tab === 'uploads' ? 'active' : ''} onClick={() => setTab('uploads')}>Uploads</button>
          <button role="tab" aria-selected={tab === 'gallery'} className={tab === 'gallery' ? 'active' : ''} onClick={() => setTab('gallery')}>Chat Gallery</button>
        </div>
        {canUpload && tab === 'uploads' && (
          <button className="archive-upload-btn" onClick={() => fileInputRef.current?.click()}>
            <UploadIcon /> <span>Upload</span>
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*"
          hidden
          onChange={(e) => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {uploads.length > 0 && (
        <div className="archive-upload-list">
          {uploads.map((u) => (
            <div key={u.id} className={`archive-upload-row${u.error ? ' failed' : ''}`}>
              <span className="archive-upload-name">{u.fileName}</span>
              {u.error ? (
                <>
                  <span className="archive-upload-error">{u.error}</span>
                  <button className="archive-link-btn" onClick={() => useArchiveStore.getState().dismissUpload(u.id)}>Dismiss</button>
                </>
              ) : (
                <div className="archive-progress" aria-label={`Uploading ${u.fileName}`}>
                  <div className={`archive-progress-bar${u.progress < 0 ? ' indeterminate' : ''}`} style={{ width: u.progress < 0 ? '30%' : `${u.progress}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'uploads' ? (
        <UploadsTab
          serverId={server.id}
          canUpload={canUpload}
          canManage={canManage}
          currentUserId={user?.id}
          onOpen={(list, index) => setLightbox({ entries: list.map((item) => ({ kind: 'archive', item })), index })}
          onUploadClick={() => fileInputRef.current?.click()}
        />
      ) : (
        <GalleryTab
          serverId={server.id}
          canUpload={canUpload}
          onOpen={(list, index) => setLightbox({ entries: list.map((item) => ({ kind: 'gallery', item })), index })}
        />
      )}

      {dragging && (
        <div className="archive-drop-overlay">
          <UploadIcon size={32} />
          <span>Drop to add to {activeAlbum ? activeAlbum.name : 'the archive'}</span>
        </div>
      )}

      {lightbox && (
        <ArchiveLightbox
          entries={lightbox.entries}
          index={lightbox.index}
          onIndexChange={(index) => setLightbox({ ...lightbox, index })}
          onClose={() => setLightbox(null)}
          canUpload={canUpload}
          canManage={canManage}
          currentUserId={user?.id}
          // Keep the lightbox in sync with live edits/deletes
          liveItems={tab === 'uploads' ? items : undefined}
          liveGallery={tab === 'gallery' ? gallery : undefined}
        />
      )}
    </div>
  );
}

// ───────────────────────── Uploads tab ─────────────────────────

function UploadsTab({ serverId, canUpload, canManage, currentUserId, onOpen, onUploadClick }: {
  serverId: string;
  canUpload: boolean;
  canManage: boolean;
  currentUserId?: string;
  onOpen: (list: ArchiveItem[], index: number) => void;
  onUploadClick: () => void;
}) {
  const items = useArchiveStore((s) => s.items);
  const albums = useArchiveStore((s) => s.albums);
  const filter = useArchiveStore((s) => s.filter);
  const loading = useArchiveStore((s) => s.itemsLoading);
  const cursor = useArchiveStore((s) => s.itemsCursor);
  const setFilter = useArchiveStore((s) => s.setFilter);
  const watch = useArchiveWatch();

  const [query, setQuery] = useState(filter.q);
  const [newAlbum, setNewAlbum] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDeleteAlbum, setConfirmDeleteAlbum] = useState(false);

  // Debounce search typing into the store filter
  useEffect(() => {
    const t = setTimeout(() => { if (query !== useArchiveStore.getState().filter.q) setFilter({ q: query }); }, 300);
    return () => clearTimeout(t);
  }, [query, setFilter]);

  useEffect(() => {
    useArchiveStore.getState().fetchItems(serverId).catch(console.error);
  }, [serverId, filter.albumId, filter.type, filter.q, filter.sort]);

  const { ref, onScroll } = useNearBottom(() => {
    if (!loading && cursor) useArchiveStore.getState().fetchItems(serverId, { append: true }).catch(console.error);
  });

  const activeAlbum = albums.find((a) => a.id === filter.albumId);
  const canEditAlbum = !!activeAlbum && (canManage || activeAlbum.createdById === currentUserId);
  const stats = useArchiveStore((s) => s.stats);

  const submitNewAlbum = async () => {
    const name = newAlbum?.trim();
    if (!name) { setNewAlbum(null); return; }
    try {
      const album = await useArchiveStore.getState().createAlbum(serverId, name);
      setNewAlbum(null);
      setFilter({ albumId: album.id });
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not create album'), 'error');
    }
  };

  const submitRename = async () => {
    const name = renaming?.trim();
    if (!activeAlbum || !name || name === activeAlbum.name) { setRenaming(null); return; }
    try {
      await useArchiveStore.getState().renameAlbum(serverId, activeAlbum.id, name);
      setRenaming(null);
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not rename album'), 'error');
    }
  };

  return (
    <div className="archive-body" ref={ref} onScroll={onScroll}>
      <div className="archive-toolbar">
        <label className="archive-search">
          <SearchIcon />
          <span className="sr-only">Search archive</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, descriptions, uploaders" />
        </label>
        <TypeFilter value={filter.type} onChange={(type) => setFilter({ type })} />
        <select className="archive-select" value={filter.sort} onChange={(e) => setFilter({ sort: e.target.value as 'newest' | 'oldest' })} aria-label="Sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      <section className="archive-albums" aria-label="Albums">
        <button className={`archive-album-card all${!filter.albumId ? ' active' : ''}`} onClick={() => setFilter({ albumId: null })}>
          <span className="archive-album-name">All items</span>
          {stats && <span className="archive-album-count">{stats.total} item{stats.total === 1 ? '' : 's'}</span>}
        </button>
        {albums.map((a) => (
          <button
            key={a.id}
            className={`archive-album-card${filter.albumId === a.id ? ' active' : ''}`}
            onClick={() => setFilter({ albumId: a.id })}
            style={a.coverUrl ? { backgroundImage: `url("${mediaUrl(a.coverUrl)}")` } : undefined}
          >
            <span className="archive-album-name">{a.name}</span>
            <span className="archive-album-count">{a.itemCount} item{a.itemCount === 1 ? '' : 's'}</span>
          </button>
        ))}
        {canUpload && (newAlbum === null ? (
          <button className="archive-album-card new" onClick={() => setNewAlbum('')}>
            <PlusIcon /> New album
          </button>
        ) : (
          <form className="archive-album-card new editing" onSubmit={(e) => { e.preventDefault(); submitNewAlbum(); }}>
            <input
              autoFocus
              maxLength={48}
              value={newAlbum}
              onChange={(e) => setNewAlbum(e.target.value)}
              onBlur={submitNewAlbum}
              onKeyDown={(e) => { if (e.key === 'Escape') setNewAlbum(null); }}
              placeholder="Album name"
              aria-label="New album name"
            />
          </form>
        ))}
      </section>

      {activeAlbum && canEditAlbum && (
        <div className="archive-album-bar">
          {renaming !== null ? (
            <form onSubmit={(e) => { e.preventDefault(); submitRename(); }}>
              <input
                autoFocus
                maxLength={48}
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={submitRename}
                onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }}
                aria-label="Album name"
              />
            </form>
          ) : (
            <strong>{activeAlbum.name}</strong>
          )}
          <button className="archive-link-btn" onClick={() => setRenaming(activeAlbum.name)}>Rename</button>
          <button className="archive-link-btn danger" onClick={() => setConfirmDeleteAlbum(true)}>Delete album</button>
        </div>
      )}

      {watch.voiceChannel && (watch.canStart || watch.canQueue) && (
        <div className="archive-voice-hint">
          <SpeakerIcon />
          {watch.partyHere
            ? <>A Watch Together party is running in {watch.voiceChannel.name}. Hover a video to add it to the queue.</>
            : <>You're in {watch.voiceChannel.name}. Hover a video to start a Watch Together party.</>}
        </div>
      )}

      {items.length === 0 && !loading ? (
        <div className="archive-empty">
          <ArchiveBoxIcon size={40} />
          <h3>{filter.q || filter.type !== 'all' ? 'Nothing matches' : activeAlbum ? 'This album is empty' : 'The archive is empty'}</h3>
          {canUpload && !filter.q && (
            <>
              <p>Upload photos and videos worth keeping. Drag files anywhere here, or</p>
              <button className="archive-upload-btn" onClick={onUploadClick}><UploadIcon /> Upload</button>
            </>
          )}
        </div>
      ) : (
        <div className="archive-masonry">
          {items.map((item, i) => {
            const video = isVideoType(item.contentType);
            const thumb = video ? item.posterPath : item.url;
            const ratio = item.width && item.height ? `${item.width} / ${item.height}` : video ? '16 / 9' : '1 / 1';
            return (
              <figure key={item.id} className="archive-tile" style={{ aspectRatio: ratio }}>
                <button className="archive-tile-open" onClick={() => onOpen(items, i)} aria-label={`Open ${item.title}`}>
                  {thumb ? <img src={mediaUrl(thumb)} alt="" loading="lazy" /> : <span className="archive-tile-placeholder"><PlayIcon size={28} /></span>}
                </button>
                {video && (
                  <>
                    <span className="archive-badge"><PlayIcon size={10} /> VIDEO</span>
                    {item.durationMs ? <span className="archive-duration">{formatDuration(item.durationMs)}</span> : null}
                  </>
                )}
                <figcaption className="archive-tile-overlay">
                  <div className="archive-tile-meta">
                    <span className="archive-tile-title">{item.title}</span>
                    <span className="archive-tile-sub">{item.uploader?.displayName ?? 'Unknown'} · {formatFileSize(item.size)}</span>
                  </div>
                  {video && (watch.canStart || watch.canQueue) && (
                    <div className="archive-tile-actions">
                      {watch.canStart && (
                        <button className="archive-primary-btn small" onClick={() => watch.start(item)}>Watch Together</button>
                      )}
                      {watch.canQueue && (
                        <button className="archive-icon-btn" onClick={() => watch.queue(item)} aria-label="Add to queue" title="Add to queue">
                          <QueueAddIcon />
                        </button>
                      )}
                    </div>
                  )}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {loading && <div className="archive-loading">Loading…</div>}

      {confirmDeleteAlbum && activeAlbum && (
        <ConfirmModal
          title="Delete album"
          message={`Delete "${activeAlbum.name}"? The ${activeAlbum.itemCount} item${activeAlbum.itemCount === 1 ? '' : 's'} in it stay in the archive.`}
          confirmLabel="Delete album"
          danger
          onConfirm={() => useArchiveStore.getState().deleteAlbum(serverId, activeAlbum.id)}
          onClose={() => setConfirmDeleteAlbum(false)}
        />
      )}
    </div>
  );
}

// ───────────────────────── Chat gallery tab ─────────────────────────

function GalleryTab({ serverId, canUpload, onOpen }: {
  serverId: string;
  canUpload: boolean;
  onOpen: (list: GalleryItem[], index: number) => void;
}) {
  const gallery = useArchiveStore((s) => s.gallery);
  const loading = useArchiveStore((s) => s.galleryLoading);
  const cursor = useArchiveStore((s) => s.galleryCursor);
  const gf = useArchiveStore((s) => s.galleryFilter);
  const setGalleryFilter = useArchiveStore((s) => s.setGalleryFilter);
  const channels = useServerStore((s) => s.channels);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const textChannels = channels.filter((c) => (c.type === 'Text' || c.type === 'XenForoMirror') && c.serverId === serverId);

  useEffect(() => {
    useArchiveStore.getState().fetchGallery(serverId).catch(console.error);
  }, [serverId, gf.channelId, gf.type]);

  const { ref, onScroll } = useNearBottom(() => {
    if (!loading && cursor) useArchiveStore.getState().fetchGallery(serverId, { append: true }).catch(console.error);
  });

  const groups = useMemo(() => {
    const out: { label: string; start: number; items: GalleryItem[] }[] = [];
    gallery.forEach((g, i) => {
      const label = monthLabel(g.createdAt);
      if (out.length === 0 || out[out.length - 1].label !== label) out.push({ label, start: i, items: [] });
      out[out.length - 1].items.push(g);
    });
    return out;
  }, [gallery]);

  const save = async (g: GalleryItem) => {
    try {
      await useArchiveStore.getState().saveFromAttachment(serverId, g.attachmentId);
      setSaved((s) => new Set(s).add(g.attachmentId));
      useToastStore.getState().addToast('Saved to Archive', 'success');
    } catch (err) {
      useToastStore.getState().addToast(errorText(err, 'Could not save to archive'), 'error');
    }
  };

  return (
    <div className="archive-body" ref={ref} onScroll={onScroll}>
      <div className="archive-toolbar">
        <div className="archive-chips" role="group" aria-label="Channel">
          <button aria-pressed={!gf.channelId} className={!gf.channelId ? 'active' : ''} onClick={() => setGalleryFilter({ channelId: null })}>All channels</button>
          {textChannels.map((c) => (
            <button key={c.id} aria-pressed={gf.channelId === c.id} className={gf.channelId === c.id ? 'active' : ''} onClick={() => setGalleryFilter({ channelId: c.id })}>
              # {c.name}
            </button>
          ))}
        </div>
        <TypeFilter value={gf.type} onChange={(type) => setGalleryFilter({ type })} />
      </div>

      {gallery.length === 0 && !loading ? (
        <div className="archive-empty">
          <ArchiveBoxIcon size={40} />
          <h3>No media yet</h3>
          <p>Photos and videos posted in this server's channels show up here.</p>
        </div>
      ) : groups.map((group) => (
        <section key={group.label} className="archive-gallery-group">
          <h2>{group.label}</h2>
          <div className="archive-gallery-grid">
            {group.items.map((g, j) => {
              const video = isVideoType(g.contentType);
              const thumb = video ? g.posterPath : g.filePath;
              return (
                <figure key={g.attachmentId} className="archive-gallery-tile">
                  <button className="archive-tile-open" onClick={() => onOpen(gallery, group.start + j)} aria-label={`Open ${g.fileName}`}>
                    {thumb ? <img src={mediaUrl(thumb)} alt="" loading="lazy" /> : <span className="archive-tile-placeholder"><PlayIcon size={24} /></span>}
                  </button>
                  {video && <span className="archive-duration"><PlayIcon size={9} /></span>}
                  <figcaption className="archive-tile-overlay compact">
                    <div className="archive-tile-meta">
                      <span className="archive-tile-title">{g.author.displayName}</span>
                      <span className="archive-tile-sub">#{g.channelName} · {new Date(g.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                    </div>
                    <div className="archive-tile-actions column">
                      {canUpload && (
                        <button className="archive-primary-btn small" disabled={saved.has(g.attachmentId)} onClick={() => save(g)}>
                          {saved.has(g.attachmentId) ? 'Saved' : 'Save to Archive'}
                        </button>
                      )}
                      <button className="archive-secondary-btn small" onClick={() => jumpToMessage(g.channelId, g.messageId)}>Jump to message</button>
                    </div>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ))}
      {loading && <div className="archive-loading">Loading…</div>}
    </div>
  );
}
