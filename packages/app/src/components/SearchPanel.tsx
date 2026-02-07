import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Image,
  Modal,
} from 'react-native';
import {
  useSearchStore,
  useServerStore,
  useMessageStore,
  api,
  getApiBase,
  formatTime,
  parseMentions,
} from '@abyss/shared';
import type { SearchResult, Message } from '@abyss/shared';
import { colors, spacing, fontSize } from '../theme/tokens';
import { useRouter } from 'expo-router';
import { useUiStore } from '../stores/uiStore';
import Avatar from './Avatar';

export default function SearchPanel() {
  const router = useRouter();
  const {
    query,
    setQuery,
    filters,
    setFilters,
    clearFilters,
    results,
    totalCount,
    loading,
    hasMore,
    search,
    loadMore,
    closeSearch,
  } = useSearchStore();
  const activeServer = useServerStore((s) => s.activeServer);
  const channels = useServerStore((s) => s.channels);
  const members = useServerStore((s) => s.members);
  const setActiveChannel = useServerStore((s) => s.setActiveChannel);
  const setHighlightedMessageId = useMessageStore((s) => s.setHighlightedMessageId);
  const closeDrawers = useUiStore((s) => s.closeDrawers);
  const closeModal = useUiStore((s) => s.closeModal);
  const [showFilters, setShowFilters] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const textChannels = channels.filter((c) => c.type === 'Text');

  const doSearch = useCallback(() => {
    if (activeServer) search(activeServer.id);
  }, [activeServer, search]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, filters, doSearch]);

  const handleLoadMore = () => {
    if (!activeServer || !hasMore || loading) return;
    loadMore(activeServer.id);
  };

  const jumpToMessage = async (result: SearchResult) => {
    if (!activeServer) return;
    const channel = textChannels.find((c) => c.name === result.channelName);
    if (!channel) return;

    // Close search modal
    closeSearch();
    closeModal();

    // Switch to the channel
    setActiveChannel(channel);
    closeDrawers();

    // Fetch messages around the target
    try {
      const res = await api.get(`/channels/${channel.id}/messages/around/${result.message.id}`);
      const messages: Message[] = res.data;
      useMessageStore.setState({
        messages,
        currentChannelId: channel.id,
        hasMore: true,
        loading: false,
      });
      // Set highlighted message ID to trigger scroll
      setHighlightedMessageId(result.message.id);
    } catch (e) {
      console.error('Failed to jump to message', e);
      // Fallback: just switch channel normally
      useMessageStore.getState().fetchMessages(channel.id);
    }
  };

  const highlightMatch = (text: string, q: string): string => {
    // For mobile, we'll just return the plain text and rely on visual highlighting in the UI
    return text;
  };

  const renderSearchResult = ({ item }: { item: SearchResult }) => {
    const avatarUri = item.message.author.avatarUrl
      ? `${getApiBase()}${item.message.author.avatarUrl}`
      : undefined;

    return (
      <Pressable
        style={({ pressed }) => [styles.resultCard, pressed && styles.resultCardPressed]}
        onPress={() => jumpToMessage(item)}
      >
        <Text style={styles.resultChannel}>#{item.channelName}</Text>
        <View style={styles.resultMeta}>
          <Avatar
            uri={avatarUri}
            name={item.message.author.displayName}
            size={24}
          />
          <Text style={styles.resultAuthor}>{item.message.author.displayName}</Text>
          <Text style={styles.resultTime}>{formatTime(item.message.createdAt)}</Text>
        </View>
        <Text style={styles.resultContent} numberOfLines={3}>
          {item.message.content}
        </Text>
        {item.message.attachments.length > 0 && (
          <Text style={styles.resultAttachmentBadge}>
            {item.message.attachments.length} attachment
            {item.message.attachments.length > 1 ? 's' : ''}
          </Text>
        )}
      </Pressable>
    );
  };

  const handleClose = () => {
    closeSearch();
    closeModal();
  };

  return (
    <Modal transparent={false} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Search</Text>
        <Pressable onPress={handleClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>✕</Text>
        </Pressable>
      </View>

      {/* Search Input */}
      <View style={styles.inputWrapper}>
        <TextInput
          style={styles.input}
          placeholder="Search messages..."
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoFocus
        />
      </View>

      {/* Filter Toggle */}
      <Pressable
        style={styles.filterToggle}
        onPress={() => setShowFilters(!showFilters)}
      >
        <Text style={styles.filterToggleText}>
          {showFilters ? 'Hide Filters' : 'Filters'}
        </Text>
        {Object.values(filters).some(Boolean) && <View style={styles.filterActiveDot} />}
      </Pressable>

      {/* Filters */}
      {showFilters && (
        <ScrollView style={styles.filters} contentContainerStyle={styles.filtersContent}>
          {/* Channel Filter */}
          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>Channel</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterChips}>
              <Pressable
                style={[styles.filterChip, !filters.channelId && styles.filterChipActive]}
                onPress={() => setFilters({ ...filters, channelId: undefined })}
              >
                <Text style={[styles.filterChipText, !filters.channelId && styles.filterChipTextActive]}>
                  All channels
                </Text>
              </Pressable>
              {textChannels.map((c) => (
                <Pressable
                  key={c.id}
                  style={[styles.filterChip, filters.channelId === c.id && styles.filterChipActive]}
                  onPress={() => setFilters({ ...filters, channelId: c.id })}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      filters.channelId === c.id && styles.filterChipTextActive,
                    ]}
                  >
                    #{c.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          {/* Author Filter */}
          <View style={styles.filterGroup}>
            <Text style={styles.filterLabel}>Author</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterChips}>
              <Pressable
                style={[styles.filterChip, !filters.authorId && styles.filterChipActive]}
                onPress={() => setFilters({ ...filters, authorId: undefined })}
              >
                <Text style={[styles.filterChipText, !filters.authorId && styles.filterChipTextActive]}>
                  Anyone
                </Text>
              </Pressable>
              {members.map((m) => (
                <Pressable
                  key={m.userId}
                  style={[styles.filterChip, filters.authorId === m.userId && styles.filterChipActive]}
                  onPress={() => setFilters({ ...filters, authorId: m.userId })}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      filters.authorId === m.userId && styles.filterChipTextActive,
                    ]}
                  >
                    {m.user.displayName}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          {/* Has Attachment */}
          <Pressable
            style={styles.filterCheckbox}
            onPress={() =>
              setFilters({ ...filters, hasAttachment: !filters.hasAttachment || undefined })
            }
          >
            <View style={[styles.checkbox, filters.hasAttachment && styles.checkboxChecked]}>
              {filters.hasAttachment && <Text style={styles.checkboxCheck}>✓</Text>}
            </View>
            <Text style={styles.filterCheckboxLabel}>Has attachment</Text>
          </Pressable>

          {/* Clear Filters */}
          {Object.values(filters).some(Boolean) && (
            <Pressable style={styles.clearFiltersButton} onPress={clearFilters}>
              <Text style={styles.clearFiltersText}>Clear filters</Text>
            </Pressable>
          )}
        </ScrollView>
      )}

      {/* Results Header */}
      {totalCount > 0 && (
        <View style={styles.resultsHeader}>
          <Text style={styles.resultsCount}>
            {totalCount} result{totalCount !== 1 ? 's' : ''}
          </Text>
        </View>
      )}

      {/* Results */}
      <FlatList
        data={results}
        renderItem={renderSearchResult}
        keyExtractor={(item) => item.message.id}
        contentContainerStyle={styles.resultsList}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          loading ? (
            <ActivityIndicator size="small" color={colors.brandColor} style={styles.loading} />
          ) : null
        }
        ListEmptyComponent={
          !loading && query.trim() ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No results found</Text>
            </View>
          ) : null
        }
      />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgModifierHover,
  },
  headerTitle: {
    fontSize: fontSize.xl,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  closeButton: {
    padding: spacing.sm,
  },
  closeButtonText: {
    fontSize: fontSize.xl,
    color: colors.textSecondary,
  },
  inputWrapper: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  input: {
    backgroundColor: colors.bgTertiary,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    color: colors.textPrimary,
  },
  filterToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  filterToggleText: {
    fontSize: fontSize.md,
    color: colors.brandColor,
    fontWeight: '500',
  },
  filterActiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.brandColor,
    marginLeft: spacing.sm,
  },
  filters: {
    maxHeight: 250,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgModifierHover,
  },
  filtersContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  filterGroup: {
    gap: spacing.sm,
  },
  filterLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '500',
    textTransform: 'uppercase',
  },
  filterChips: {
    flexDirection: 'row',
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 16,
    backgroundColor: colors.bgTertiary,
    marginRight: spacing.sm,
  },
  filterChipActive: {
    backgroundColor: colors.bgAccent,
  },
  filterChipText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  filterChipTextActive: {
    color: colors.textPrimary,
    fontWeight: '500',
  },
  filterCheckbox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.textSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.bgAccent,
    borderColor: colors.bgAccent,
  },
  checkboxCheck: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: 'bold',
  },
  filterCheckboxLabel: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
  },
  clearFiltersButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    backgroundColor: colors.bgTertiary,
    alignSelf: 'flex-start',
  },
  clearFiltersText: {
    fontSize: fontSize.sm,
    color: colors.danger,
    fontWeight: '500',
  },
  resultsHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgModifierHover,
  },
  resultsCount: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  resultsList: {
    padding: spacing.lg,
  },
  resultCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  resultCardPressed: {
    opacity: 0.7,
  },
  resultChannel: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  resultMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  resultAuthor: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '500',
    flex: 1,
  },
  resultTime: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },
  resultContent: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
    lineHeight: fontSize.md * 1.5,
  },
  resultAttachmentBadge: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
  loading: {
    marginVertical: spacing.lg,
  },
  emptyState: {
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: fontSize.md,
    color: colors.textMuted,
  },
});
