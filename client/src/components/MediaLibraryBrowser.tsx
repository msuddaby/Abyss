import { useState, useEffect } from 'react';
import { useMediaProviderStore, useServerStore, useVoiceStore, useWatchPartyStore } from '@abyss/shared';
import type { MediaLibrary, MediaItem, MediaProviderConnection } from '@abyss/shared';

interface Props {
  onClose: () => void;
}

interface BreadcrumbEntry {
  label: string;
  itemId?: string; // undefined = library root
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Types that can be drilled into (have children) */
function isContainer(type: string): boolean {
  return type === 'show' || type === 'season' || type === 'artist' || type === 'album';
}

export default function MediaLibraryBrowser({ onClose }: Props) {
  const activeServer = useServerStore((s) => s.activeServer);
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const activeParty = useWatchPartyStore((s) => s.activeParty);
  const { connections, libraries, libraryItems, searchResults, isLoading,
    fetchConnections, fetchLibraries, fetchLibraryItems, fetchItemChildren, searchItems, clearLibrary } = useMediaProviderStore();

  const [selectedConnection, setSelectedConnection] = useState<MediaProviderConnection | null>(null);
  const [selectedLibrary, setSelectedLibrary] = useState<MediaLibrary | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Drill-down state: items currently displayed when inside a container
  const [drillItems, setDrillItems] = useState<MediaItem[] | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([]);

  useEffect(() => {
    if (activeServer) fetchConnections(activeServer.id);
    return () => clearLibrary();
  }, [activeServer]);

  useEffect(() => {
    if (connections.length > 0 && !selectedConnection) {
      setSelectedConnection(connections[0]);
    }
  }, [connections]);

  useEffect(() => {
    if (selectedConnection && activeServer) {
      fetchLibraries(activeServer.id, selectedConnection.id);
    }
  }, [selectedConnection]);

  useEffect(() => {
    if (selectedLibrary && selectedConnection && activeServer) {
      fetchLibraryItems(activeServer.id, selectedConnection.id, selectedLibrary.id);
      setDrillItems(null);
      setBreadcrumbs([]);
    }
  }, [selectedLibrary]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setDrillItems(null);
    setBreadcrumbs([]);
    if (searchTimeout) clearTimeout(searchTimeout);
    if (!query.trim()) return;
    if (!selectedConnection || !activeServer) return;
    const timeout = setTimeout(() => {
      searchItems(activeServer.id, selectedConnection.id, query, selectedLibrary?.id);
    }, 300);
    setSearchTimeout(timeout);
  };

  const handleDrillInto = async (item: MediaItem) => {
    if (!selectedConnection || !activeServer) return;
    const children = await fetchItemChildren(activeServer.id, selectedConnection.id, item.id);
    setDrillItems(children);
    setSearchQuery('');
    setBreadcrumbs((prev) => [...prev, { label: item.title, itemId: item.id }]);
  };

  const handleBreadcrumbClick = async (index: number) => {
    if (!selectedConnection || !activeServer) return;

    if (index < 0) {
      // Back to library root
      setDrillItems(null);
      setBreadcrumbs([]);
      if (selectedLibrary) {
        fetchLibraryItems(activeServer.id, selectedConnection.id, selectedLibrary.id);
      }
      return;
    }

    // Navigate to a specific breadcrumb level
    const target = breadcrumbs[index];
    const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(newBreadcrumbs);

    if (target.itemId) {
      const children = await fetchItemChildren(activeServer.id, selectedConnection.id, target.itemId);
      setDrillItems(children);
    }
  };

  const handlePlayNow = async (item: MediaItem) => {
    if (!selectedConnection || !currentChannelId || !activeServer) return;
    try {
      if (activeParty) {
        await useWatchPartyStore.getState().stopWatchParty(currentChannelId);
      }
      await useWatchPartyStore.getState().startWatchParty(currentChannelId, {
        mediaProviderConnectionId: selectedConnection.id,
        providerItemId: item.id,
        itemTitle: item.title,
        itemThumbnail: item.thumbnailUrl,
        itemDurationMs: item.durationMs,
      });
      onClose();
    } catch (e) {
      console.error('Failed to start watch party:', e);
    }
  };

  const handleAddToQueue = async (item: MediaItem) => {
    if (!currentChannelId || !activeParty) return;
    try {
      await useWatchPartyStore.getState().addToQueue(currentChannelId, {
        providerItemId: item.id,
        title: item.title,
        thumbnail: item.thumbnailUrl,
        durationMs: item.durationMs,
      });
    } catch (e) {
      console.error('Failed to add to queue:', e);
    }
  };

  const handleItemClick = (item: MediaItem) => {
    if (isContainer(item.type)) {
      handleDrillInto(item);
    }
  };

  const displayItems = searchQuery.trim() ? searchResults : (drillItems ?? libraryItems);

  if (connections.length === 0) {
    return (
      <div className="mlb-overlay" onClick={onClose}>
        <div className="mlb-container" onClick={(e) => e.stopPropagation()}>
          <div className="mlb-empty">
            <p>No media providers linked to this server.</p>
            <p>Link one in Server Settings &gt; Media.</p>
            <button className="mlb-close-btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mlb-overlay" onClick={onClose}>
      <div className="mlb-container" onClick={(e) => e.stopPropagation()}>
        <div className="mlb-header">
          <h3>Browse Library</h3>
          <button className="mlb-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="mlb-body">
          <div className="mlb-sidebar">
            {connections.length > 1 && (
              <div className="mlb-provider-select">
                {connections.map((c) => (
                  <button
                    key={c.id}
                    className={`mlb-provider-btn ${selectedConnection?.id === c.id ? 'active' : ''}`}
                    onClick={() => { setSelectedConnection(c); setSelectedLibrary(null); setDrillItems(null); setBreadcrumbs([]); }}
                  >
                    {c.displayName}
                  </button>
                ))}
              </div>
            )}
            <div className="mlb-library-list">
              {libraries.map((lib) => (
                <button
                  key={lib.id}
                  className={`mlb-library-btn ${selectedLibrary?.id === lib.id ? 'active' : ''}`}
                  onClick={() => setSelectedLibrary(lib)}
                >
                  {lib.name}
                  <span className="mlb-library-type">{lib.type}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mlb-content">
            <div className="mlb-search">
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                className="mlb-search-input"
              />
            </div>

            {breadcrumbs.length > 0 && !searchQuery.trim() && (
              <div className="mlb-breadcrumbs">
                <button className="mlb-breadcrumb" onClick={() => handleBreadcrumbClick(-1)}>
                  {selectedLibrary?.name ?? 'Library'}
                </button>
                {breadcrumbs.map((bc, i) => (
                  <span key={i} className="mlb-breadcrumb-sep">
                    <span className="mlb-breadcrumb-arrow">/</span>
                    {i < breadcrumbs.length - 1 ? (
                      <button className="mlb-breadcrumb" onClick={() => handleBreadcrumbClick(i)}>
                        {bc.label}
                      </button>
                    ) : (
                      <span className="mlb-breadcrumb-current">{bc.label}</span>
                    )}
                  </span>
                ))}
              </div>
            )}

            {isLoading ? (
              <div className="mlb-loading">Loading...</div>
            ) : displayItems.length === 0 ? (
              <div className="mlb-empty-results">
                {selectedLibrary ? 'No items found' : 'Select a library'}
              </div>
            ) : (
              <div className="mlb-grid">
                {displayItems.map((item) => {
                  const container = isContainer(item.type);
                  return (
                    <div
                      key={item.id}
                      className={`mlb-card${container ? ' mlb-card-container' : ''}`}
                      onClick={() => container ? handleItemClick(item) : undefined}
                      style={container ? { cursor: 'pointer' } : undefined}
                    >
                      <div className="mlb-card-thumb">
                        {item.thumbnailUrl ? (
                          <img src={item.thumbnailUrl} alt={item.title} loading="lazy" />
                        ) : (
                          <div className="mlb-card-placeholder">🎬</div>
                        )}
                        {container && (
                          <div className="mlb-card-browse-overlay">Browse</div>
                        )}
                      </div>
                      <div className="mlb-card-info">
                        <div className="mlb-card-title" title={item.title}>
                          {item.parentIndex != null && item.index != null
                            ? `S${item.parentIndex}E${item.index} - ${item.title}`
                            : item.index != null
                              ? `${item.type === 'season' ? 'Season' : ''} ${item.index}${item.title !== `Season ${item.index}` ? ` - ${item.title}` : ''}`
                              : item.title}
                        </div>
                        {item.year && <span className="mlb-card-year">{item.year}</span>}
                        {item.durationMs && (
                          <span className="mlb-card-duration">{formatDuration(item.durationMs)}</span>
                        )}
                        {item.parentTitle && (
                          <span className="mlb-card-parent">{item.parentTitle}</span>
                        )}
                      </div>
                      {!container && (
                        <div className="mlb-card-actions">
                          <button className="mlb-play-btn" onClick={(e) => { e.stopPropagation(); handlePlayNow(item); }}>
                            ▶ Play
                          </button>
                          {activeParty && (
                            <button className="mlb-queue-btn" onClick={(e) => { e.stopPropagation(); handleAddToQueue(item); }}>
                              + Queue
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
