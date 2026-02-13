import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput as RNTextInput,
  Pressable,
  ScrollView,
  Image,
  ActivityIndicator,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type ImageStyle,
} from 'react-native';
import {
  useWatchPartyStore,
  useMediaProviderStore,
  useServerStore,
  useVoiceStore,
  getConnection,
  getApiBase,
} from '@abyss/shared';
import type { WatchParty, MediaItem } from '@abyss/shared';
import { colors, spacing, borderRadius, fontSize } from '../theme/tokens';

/** Format milliseconds to MM:SS */
function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface WatchPartyHostControlsProps {
  channelId: string;
  isHost: boolean;
  activeParty: WatchParty;
}

type LibraryBrowseStep = 'closed' | 'connections' | 'libraries' | 'items' | 'search' | 'youtube';

export default function WatchPartyHostControls({
  channelId,
  isHost,
  activeParty,
}: WatchPartyHostControlsProps) {
  const connections = useMediaProviderStore((s) => s.connections);
  const libraries = useMediaProviderStore((s) => s.libraries);
  const libraryItems = useMediaProviderStore((s) => s.libraryItems);
  const searchResults = useMediaProviderStore((s) => s.searchResults);
  const isLoading = useMediaProviderStore((s) => s.isLoading);
  const activeServer = useServerStore((s) => s.activeServer);

  const [browseStep, setBrowseStep] = useState<LibraryBrowseStep>('closed');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeLoading, setYoutubeLoading] = useState(false);

  const serverId = activeServer?.id;

  // ---- Playback Controls ----

  const handlePlayPause = useCallback(() => {
    const conn = getConnection();
    conn?.invoke(
      'WatchPartyUpdatePlayback',
      channelId,
      activeParty.currentTimeMs,
      !activeParty.isPlaying,
    );
  }, [channelId, activeParty.currentTimeMs, activeParty.isPlaying]);

  const handleSeek = useCallback(
    (deltaMs: number) => {
      const newTime = Math.max(0, activeParty.currentTimeMs + deltaMs);
      const conn = getConnection();
      conn?.invoke('WatchPartyUpdatePlayback', channelId, newTime, activeParty.isPlaying);
    },
    [channelId, activeParty.currentTimeMs, activeParty.isPlaying],
  );

  const handleSkipNext = useCallback(() => {
    const conn = getConnection();
    conn?.invoke('WatchPartySkipToNext', channelId);
  }, [channelId]);

  const handleStop = useCallback(() => {
    useWatchPartyStore.getState().stopWatchParty(channelId);
  }, [channelId]);

  // ---- Queue Management ----

  const handleRemoveFromQueue = useCallback(
    (index: number) => {
      useWatchPartyStore.getState().removeFromQueue(channelId, index);
    },
    [channelId],
  );

  // ---- Library Browsing ----

  const openLibraryBrowser = useCallback(() => {
    if (!serverId) return;
    useMediaProviderStore.getState().fetchConnections(serverId);
    setBrowseStep('connections');
  }, [serverId]);

  const handleSelectConnection = useCallback(
    (connectionId: string) => {
      if (!serverId) return;
      setSelectedConnectionId(connectionId);
      useMediaProviderStore.getState().fetchLibraries(serverId, connectionId);
      setBrowseStep('libraries');
    },
    [serverId],
  );

  const handleSelectLibrary = useCallback(
    (libraryId: string) => {
      if (!serverId || !selectedConnectionId) return;
      setSelectedLibraryId(libraryId);
      useMediaProviderStore.getState().fetchLibraryItems(serverId, selectedConnectionId, libraryId);
      setBrowseStep('items');
    },
    [serverId, selectedConnectionId],
  );

  const handleSearch = useCallback(() => {
    if (!serverId || !selectedConnectionId || !searchQuery.trim()) return;
    useMediaProviderStore
      .getState()
      .searchItems(serverId, selectedConnectionId, searchQuery.trim(), selectedLibraryId ?? undefined);
  }, [serverId, selectedConnectionId, searchQuery, selectedLibraryId]);

  const handleResolveYouTube = useCallback(async () => {
    if (!serverId || !youtubeUrl.trim()) return;
    setYoutubeLoading(true);
    try {
      const result = await useMediaProviderStore.getState().resolveYouTubeUrl(serverId, youtubeUrl.trim());
      if (result) {
        await useWatchPartyStore.getState().startWatchParty(channelId, {
          mediaProviderConnectionId: result.connectionId,
          providerItemId: result.videoId,
          itemTitle: result.title,
          itemThumbnail: result.thumbnailUrl,
        });
        setYoutubeUrl('');
        setBrowseStep('closed');
      }
    } finally {
      setYoutubeLoading(false);
    }
  }, [serverId, youtubeUrl, channelId]);

  const handlePlayNow = useCallback(
    async (item: MediaItem) => {
      if (!selectedConnectionId) return;
      await useWatchPartyStore.getState().startWatchParty(channelId, {
        mediaProviderConnectionId: selectedConnectionId,
        providerItemId: item.id,
        itemTitle: item.title,
        itemThumbnail: item.thumbnailUrl,
        itemDurationMs: item.durationMs,
      });
      setBrowseStep('closed');
    },
    [channelId, selectedConnectionId],
  );

  const handleAddToQueue = useCallback(
    async (item: MediaItem) => {
      await useWatchPartyStore.getState().addToQueue(channelId, {
        providerItemId: item.id,
        title: item.title,
        thumbnail: item.thumbnailUrl,
        durationMs: item.durationMs,
      });
    },
    [channelId],
  );

  const closeBrowser = useCallback(() => {
    setBrowseStep('closed');
    setSelectedConnectionId(null);
    setSelectedLibraryId(null);
    setSearchQuery('');
    useMediaProviderStore.getState().clearLibrary();
  }, []);

  // ---- Render Helpers ----

  if (!isHost) return null;

  const renderBrowseBack = () => {
    let backStep: LibraryBrowseStep = 'closed';
    if (browseStep === 'libraries') backStep = 'connections';
    else if (browseStep === 'items' || browseStep === 'search') backStep = 'libraries';
    else if (browseStep === 'youtube') backStep = 'connections';

    return (
      <View style={styles.browseHeader}>
        <Pressable
          style={styles.backButton}
          onPress={() => {
            if (backStep === 'closed') {
              closeBrowser();
            } else {
              setBrowseStep(backStep);
            }
          }}
        >
          <Text style={styles.backButtonText}>Back</Text>
        </Pressable>
        <Text style={styles.browseTitle}>
          {browseStep === 'connections' && 'Select Provider'}
          {browseStep === 'libraries' && 'Select Library'}
          {browseStep === 'items' && 'Browse Items'}
          {browseStep === 'search' && 'Search Results'}
          {browseStep === 'youtube' && 'YouTube URL'}
        </Text>
      </View>
    );
  };

  const renderMediaItem = (item: MediaItem, index: number) => (
    <View key={`${item.id}-${index}`} style={styles.mediaItem}>
      {item.thumbnailUrl ? (
        <Image source={{ uri: item.thumbnailUrl }} style={styles.mediaThumb} resizeMode="cover" />
      ) : (
        <View style={styles.mediaThumbPlaceholder}>
          <Text style={styles.mediaThumbPlaceholderText}>?</Text>
        </View>
      )}
      <View style={styles.mediaItemInfo}>
        <Text style={styles.mediaItemTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {item.durationMs != null && item.durationMs > 0 && (
          <Text style={styles.mediaItemDuration}>{formatTime(item.durationMs)}</Text>
        )}
      </View>
      <View style={styles.mediaItemActions}>
        <Pressable
          style={({ pressed }) => [styles.smallActionBtn, styles.playNowBtn, pressed && styles.btnPressed]}
          onPress={() => handlePlayNow(item)}
        >
          <Text style={styles.smallActionBtnText}>Play</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.smallActionBtn, styles.queueBtn, pressed && styles.btnPressed]}
          onPress={() => handleAddToQueue(item)}
        >
          <Text style={styles.smallActionBtnText}>Queue</Text>
        </Pressable>
      </View>
    </View>
  );

  const renderLibraryBrowser = () => {
    if (browseStep === 'closed') return null;

    return (
      <View style={styles.browserContainer}>
        {renderBrowseBack()}

        {/* Connection Picker */}
        {browseStep === 'connections' && (
          <View style={styles.browseList}>
            {isLoading ? (
              <ActivityIndicator color={colors.brandColor} style={styles.loader} />
            ) : connections.length === 0 ? (
              <Text style={styles.emptyText}>No media providers linked</Text>
            ) : (
              <>
                {connections.map((c) => (
                  <Pressable
                    key={c.id}
                    style={({ pressed }) => [styles.browseRow, pressed && styles.browseRowPressed]}
                    onPress={() => handleSelectConnection(c.id)}
                  >
                    <Text style={styles.browseRowTitle}>{c.displayName}</Text>
                    <Text style={styles.browseRowSub}>{c.providerType}</Text>
                  </Pressable>
                ))}
                <Pressable
                  style={({ pressed }) => [styles.browseRow, pressed && styles.browseRowPressed]}
                  onPress={() => setBrowseStep('youtube')}
                >
                  <Text style={styles.browseRowTitle}>YouTube URL</Text>
                  <Text style={styles.browseRowSub}>Paste a video link</Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        {/* Library Picker */}
        {browseStep === 'libraries' && (
          <View style={styles.browseList}>
            {isLoading ? (
              <ActivityIndicator color={colors.brandColor} style={styles.loader} />
            ) : libraries.length === 0 ? (
              <Text style={styles.emptyText}>No libraries found</Text>
            ) : (
              <>
                {libraries.map((lib) => (
                  <Pressable
                    key={lib.id}
                    style={({ pressed }) => [styles.browseRow, pressed && styles.browseRowPressed]}
                    onPress={() => handleSelectLibrary(lib.id)}
                  >
                    <Text style={styles.browseRowTitle}>{lib.name}</Text>
                    <Text style={styles.browseRowSub}>
                      {lib.type} - {lib.itemCount} items
                    </Text>
                  </Pressable>
                ))}

                {/* Search toggle */}
                <Pressable
                  style={({ pressed }) => [styles.browseRow, pressed && styles.browseRowPressed]}
                  onPress={() => setBrowseStep('search')}
                >
                  <Text style={styles.browseRowTitle}>Search</Text>
                  <Text style={styles.browseRowSub}>Search across libraries</Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        {/* Item List */}
        {browseStep === 'items' && (
          <ScrollView style={styles.itemScrollView} nestedScrollEnabled showsVerticalScrollIndicator={false}>
            {isLoading ? (
              <ActivityIndicator color={colors.brandColor} style={styles.loader} />
            ) : libraryItems.length === 0 ? (
              <Text style={styles.emptyText}>No items found</Text>
            ) : (
              libraryItems.map((item, i) => renderMediaItem(item, i))
            )}
          </ScrollView>
        )}

        {/* Search */}
        {browseStep === 'search' && (
          <View>
            <View style={styles.searchRow}>
              <RNTextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search media..."
                placeholderTextColor={colors.textMuted}
                onSubmitEditing={handleSearch}
                returnKeyType="search"
              />
              <Pressable
                style={({ pressed }) => [styles.searchBtn, pressed && styles.btnPressed]}
                onPress={handleSearch}
              >
                {isLoading ? (
                  <ActivityIndicator color="#ffffff" size="small" />
                ) : (
                  <Text style={styles.searchBtnText}>Search</Text>
                )}
              </Pressable>
            </View>
            <ScrollView style={styles.itemScrollView} nestedScrollEnabled showsVerticalScrollIndicator={false}>
              {searchResults.length === 0 && !isLoading ? (
                <Text style={styles.emptyText}>No results</Text>
              ) : (
                searchResults.map((item, i) => renderMediaItem(item, i))
              )}
            </ScrollView>
          </View>
        )}

        {/* YouTube URL Input */}
        {browseStep === 'youtube' && (
          <View style={styles.youtubeSection}>
            <Text style={styles.fieldLabel}>YouTube Video URL</Text>
            <RNTextInput
              style={styles.searchInput}
              value={youtubeUrl}
              onChangeText={setYoutubeUrl}
              placeholder="https://youtube.com/watch?v=..."
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={handleResolveYouTube}
              returnKeyType="go"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              style={({ pressed }) => [
                styles.actionBtn,
                styles.primaryBtn,
                pressed && styles.btnPressed,
                youtubeLoading && styles.disabled,
              ]}
              onPress={handleResolveYouTube}
              disabled={youtubeLoading}
            >
              {youtubeLoading ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.actionBtnText}>Play YouTube Video</Text>
              )}
            </Pressable>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Section Header */}
      <Text style={styles.sectionLabel}>Host Controls</Text>

      {/* Playback Controls Row */}
      <View style={styles.controlsRow}>
        <Pressable
          style={({ pressed }) => [styles.controlBtn, pressed && styles.btnPressed]}
          onPress={() => handleSeek(-15000)}
        >
          <Text style={styles.controlBtnText}>-15s</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.controlBtn,
            styles.playPauseBtn,
            pressed && styles.btnPressed,
          ]}
          onPress={handlePlayPause}
        >
          <Text style={styles.controlBtnText}>{activeParty.isPlaying ? 'Pause' : 'Play'}</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.controlBtn, pressed && styles.btnPressed]}
          onPress={() => handleSeek(15000)}
        >
          <Text style={styles.controlBtnText}>+15s</Text>
        </Pressable>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionsRow}>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, styles.secondaryBtn, pressed && styles.btnPressed]}
          onPress={handleSkipNext}
        >
          <Text style={styles.actionBtnText}>Skip Next</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.actionBtn, styles.primaryBtn, pressed && styles.btnPressed]}
          onPress={browseStep === 'closed' ? openLibraryBrowser : closeBrowser}
        >
          <Text style={styles.actionBtnText}>
            {browseStep === 'closed' ? 'Media Library' : 'Close Browser'}
          </Text>
        </Pressable>
      </View>

      {/* Library Browser */}
      {renderLibraryBrowser()}

      {/* Queue Management */}
      {activeParty.queue.length > 0 && (
        <View style={styles.queueSection}>
          <Text style={styles.queueTitle}>Queue ({activeParty.queue.length})</Text>
          <ScrollView style={styles.queueList} nestedScrollEnabled showsVerticalScrollIndicator={false}>
            {activeParty.queue.map((item, index) => (
              <View key={`${item.providerItemId}-${index}`} style={styles.queueItem}>
                {item.thumbnail ? (
                  <Image source={{ uri: item.thumbnail }} style={styles.queueThumb} resizeMode="cover" />
                ) : (
                  <View style={styles.queueThumbPlaceholder}>
                    <Text style={styles.queueThumbText}>{index + 1}</Text>
                  </View>
                )}
                <View style={styles.queueItemInfo}>
                  <Text style={styles.queueItemTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.durationMs != null && item.durationMs > 0 && (
                    <Text style={styles.queueItemDuration}>{formatTime(item.durationMs)}</Text>
                  )}
                </View>
                <Pressable
                  style={({ pressed }) => [styles.removeBtn, pressed && styles.btnPressed]}
                  onPress={() => handleRemoveFromQueue(index)}
                >
                  <Text style={styles.removeBtnText}>X</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Stop Party */}
      <Pressable
        style={({ pressed }) => [styles.actionBtn, styles.dangerBtn, pressed && styles.dangerBtnPressed]}
        onPress={handleStop}
      >
        <Text style={styles.actionBtnText}>Stop Party</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.md,
    gap: spacing.sm,
  } as ViewStyle,

  sectionLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  } as TextStyle,

  // ---- Playback Controls ----
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  controlBtn: {
    backgroundColor: colors.channelTextArea,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 56,
  } as ViewStyle,
  playPauseBtn: {
    backgroundColor: colors.brandColor,
    minWidth: 80,
  } as ViewStyle,
  controlBtnText: {
    color: colors.headerPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,

  // ---- Action Buttons ----
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  actionBtn: {
    flex: 1,
    height: 40,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  } as ViewStyle,
  primaryBtn: {
    backgroundColor: colors.bgAccent,
  } as ViewStyle,
  secondaryBtn: {
    backgroundColor: colors.channelTextArea,
  } as ViewStyle,
  dangerBtn: {
    backgroundColor: colors.danger,
  } as ViewStyle,
  dangerBtnPressed: {
    backgroundColor: '#c03537',
  } as ViewStyle,
  actionBtnText: {
    color: '#ffffff',
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  btnPressed: {
    opacity: 0.8,
  } as ViewStyle,
  disabled: {
    opacity: 0.5,
  } as ViewStyle,

  // ---- Library Browser ----
  browserContainer: {
    backgroundColor: colors.bgTertiary,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    gap: spacing.sm,
  } as ViewStyle,
  browseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  } as ViewStyle,
  backButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.channelTextArea,
    borderRadius: borderRadius.sm,
  } as ViewStyle,
  backButtonText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  browseTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '700',
    flex: 1,
  } as TextStyle,
  browseList: {
    gap: spacing.xs,
  } as ViewStyle,
  browseRow: {
    backgroundColor: colors.bgSecondary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  browseRowPressed: {
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  browseRowTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  browseRowSub: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  } as TextStyle,

  // ---- Search ----
  searchRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  } as ViewStyle,
  searchInput: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    height: 38,
    borderWidth: 1,
    borderColor: 'transparent',
  } as TextStyle,
  searchBtn: {
    backgroundColor: colors.bgAccent,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
  } as ViewStyle,
  searchBtnText: {
    color: '#ffffff',
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,

  // ---- YouTube ----
  youtubeSection: {
    gap: spacing.sm,
  } as ViewStyle,
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,

  // ---- Media Items ----
  itemScrollView: {
    maxHeight: 240,
  } as ViewStyle,
  mediaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgPrimary,
  } as ViewStyle,
  mediaThumb: {
    width: 48,
    height: 36,
    borderRadius: borderRadius.sm,
  } as ImageStyle,
  mediaThumbPlaceholder: {
    width: 48,
    height: 36,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  mediaThumbPlaceholderText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  } as TextStyle,
  mediaItemInfo: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  mediaItemTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  } as TextStyle,
  mediaItemDuration: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
  mediaItemActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  } as ViewStyle,
  smallActionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  playNowBtn: {
    backgroundColor: colors.brandColor,
  } as ViewStyle,
  queueBtn: {
    backgroundColor: colors.channelTextArea,
  } as ViewStyle,
  smallActionBtnText: {
    color: '#ffffff',
    fontSize: fontSize.xs,
    fontWeight: '600',
  } as TextStyle,

  // ---- Loader & Empty ----
  loader: {
    paddingVertical: spacing.lg,
  } as ViewStyle,
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.lg,
    fontStyle: 'italic',
  } as TextStyle,

  // ---- Queue Management ----
  queueSection: {
    gap: spacing.xs,
  } as ViewStyle,
  queueTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  queueList: {
    maxHeight: 180,
  } as ViewStyle,
  queueItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
  } as ViewStyle,
  queueThumb: {
    width: 48,
    height: 36,
    borderRadius: borderRadius.sm,
  } as ImageStyle,
  queueThumbPlaceholder: {
    width: 48,
    height: 36,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  queueThumbText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '600',
  } as TextStyle,
  queueItemInfo: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  queueItemTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  } as TextStyle,
  queueItemDuration: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  } as TextStyle,
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  removeBtnText: {
    color: '#ffffff',
    fontSize: fontSize.xs,
    fontWeight: '700',
  } as TextStyle,
});
