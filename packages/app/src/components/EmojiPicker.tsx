import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, Image, FlatList, ScrollView, Animated,
  StyleSheet, type ViewStyle, type TextStyle, type ImageStyle,
} from 'react-native';
import { getApiBase, getStorage, useServerStore } from '@abyss/shared';
import { ALL_NATIVE_EMOJIS, EMOJI_CATEGORIES, type NativeEmoji } from '../utils/emojiData';
import { colors, spacing, fontSize, borderRadius } from '../theme/tokens';

const RECENT_KEY = 'recentEmojis';
const MAX_RECENTS = 30;

export type EmojiSelection =
  | { type: 'native'; emoji: string; name: string }
  | { type: 'custom'; id: string; name: string; imageUrl: string };

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (emoji: EmojiSelection) => void;
  title?: string;
}

function readRecents(): string[] {
  try {
    const raw = getStorage().getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecents(values: string[]): void {
  try {
    getStorage().setItem(RECENT_KEY, JSON.stringify(values));
  } catch {
    // ignore storage failures
  }
}

function addRecent(value: string): string[] {
  const current = readRecents();
  const next = [value, ...current.filter((v) => v !== value)].slice(0, MAX_RECENTS);
  writeRecents(next);
  return next;
}

export default function EmojiPicker({ open, onClose, onSelect, title = 'Emoji' }: Props) {
  const emojis = useServerStore((s) => s.emojis);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'recent' | 'custom' | string>('recent');
  const [recentKeys, setRecentKeys] = useState<string[]>([]);
  const sheetY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveTab('recent');
    setRecentKeys(readRecents());
    sheetY.setValue(0);
  }, [open, sheetY]);

  useEffect(() => {
    if (!open) return;
    Animated.timing(sheetY, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [open, sheetY]);

  const customEmojis = useMemo(() => emojis.map((e) => ({
    id: e.id,
    name: e.name,
    imageUrl: e.imageUrl,
  })), [emojis]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;

    const native = ALL_NATIVE_EMOJIS.filter((e) =>
      e.keywords.some((k) => k.toLowerCase().includes(q))
    ).slice(0, 80);

    const custom = customEmojis
      .filter((e) => e.name.toLowerCase().includes(q))
      .slice(0, 40);

    return { native, custom };
  }, [query, customEmojis]);

  const recentItems = useMemo(() => {
    if (recentKeys.length === 0) return [] as EmojiSelection[];
    const mapCustom = new Map(customEmojis.map((e) => [e.id, e]));
    const out: EmojiSelection[] = [];

    for (const key of recentKeys) {
      if (key.startsWith('custom:')) {
        const id = key.slice(7);
        const ce = mapCustom.get(id);
        if (ce) out.push({ type: 'custom', id: ce.id, name: ce.name, imageUrl: ce.imageUrl });
      } else {
        const native = ALL_NATIVE_EMOJIS.find((e) => e.emoji === key);
        if (native) out.push({ type: 'native', emoji: native.emoji, name: native.name });
      }
    }

    return out;
  }, [recentKeys, customEmojis]);

  const handleSelect = useCallback((emoji: EmojiSelection) => {
    if (emoji.type === 'custom') {
      setRecentKeys(addRecent(`custom:${emoji.id}`));
    } else {
      setRecentKeys(addRecent(emoji.emoji));
    }
    onSelect(emoji);
    onClose();
  }, [onSelect, onClose]);

  const renderNativeEmoji = useCallback((item: NativeEmoji) => (
    <Pressable
      key={item.emoji}
      style={styles.emojiCell}
      onPress={() => handleSelect({ type: 'native', emoji: item.emoji, name: item.name })}
    >
      <Text style={styles.emojiText}>{item.emoji}</Text>
    </Pressable>
  ), [handleSelect]);

  const renderCustomEmoji = useCallback((item: { id: string; name: string; imageUrl: string }) => (
    <Pressable
      key={item.id}
      style={styles.emojiCell}
      onPress={() => handleSelect({ type: 'custom', id: item.id, name: item.name, imageUrl: item.imageUrl })}
    >
      <Image source={{ uri: `${getApiBase()}${item.imageUrl}` }} style={styles.customEmoji} />
    </Pressable>
  ), [handleSelect]);

  const renderEmojiGrid = (items: EmojiSelection[]) => (
    <View style={styles.gridWrapper}>
      <FlatList
        data={items}
        keyExtractor={(item) => (item.type === 'custom' ? `c:${item.id}` : `n:${item.emoji}`)}
        numColumns={8}
        contentContainerStyle={styles.gridListContent}
        renderItem={({ item }) => (
          item.type === 'custom'
            ? renderCustomEmoji(item)
            : renderNativeEmoji({
              emoji: item.emoji,
              name: item.name,
              keywords: [item.name],
              category: '',
            })
        )}
        columnWrapperStyle={styles.emojiRow}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );

  const activeCategory = EMOJI_CATEGORIES.find((c) => c.key === activeTab);

  const sheetTranslate = sheetY.interpolate({
    inputRange: [0, 1],
    outputRange: [420, 0],
  });

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <Animated.View style={[styles.sheet, { transform: [{ translateY: sheetTranslate }] }]}> 
          <View style={styles.sheetContent}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{title}</Text>
              <Pressable onPress={onClose} hitSlop={8}>
                <Text style={styles.closeBtn}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.searchRow}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search emojis"
                placeholderTextColor={colors.textMuted}
                style={styles.searchInput}
              />
            </View>

            <View style={styles.tabsContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs}>
                <Pressable
                  style={[styles.tab, activeTab === 'recent' && styles.tabActive]}
                  onPress={() => setActiveTab('recent')}
                >
                  <Text style={[styles.tabText, activeTab === 'recent' && styles.tabTextActive]}>🕘</Text>
                </Pressable>
                <Pressable
                  style={[styles.tab, activeTab === 'custom' && styles.tabActive]}
                  onPress={() => setActiveTab('custom')}
                >
                  <Text style={[styles.tabText, activeTab === 'custom' && styles.tabTextActive]}>✨</Text>
                </Pressable>
                {EMOJI_CATEGORIES.map((c) => (
                  <Pressable
                    key={c.key}
                    style={[styles.tab, activeTab === c.key && styles.tabActive]}
                    onPress={() => setActiveTab(c.key)}
                  >
                    <Text style={[styles.tabText, activeTab === c.key && styles.tabTextActive]}>
                      {c.icon}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            <View style={styles.gridContainer}>
            {searchResults ? (
              <View style={styles.gridWrapper}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {searchResults.custom.length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>Custom</Text>
                      <View style={styles.emojiRowWrap}>
                        {searchResults.custom.map((e) => renderCustomEmoji(e))}
                      </View>
                    </View>
                  )}
                  {searchResults.native.length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>Native</Text>
                      <View style={styles.emojiRowWrap}>
                        {searchResults.native.map((e) => renderNativeEmoji(e))}
                      </View>
                    </View>
                  )}
                  {searchResults.custom.length === 0 && searchResults.native.length === 0 && (
                    <View style={styles.empty}>
                      <Text style={styles.emptyText}>No matches</Text>
                    </View>
                  )}
                </ScrollView>
              </View>
            ) : activeTab === 'recent' ? (
              recentItems.length > 0
                ? renderEmojiGrid(recentItems)
                : (
                  <View style={styles.gridWrapper}>
                    <View style={styles.empty}>
                      <Text style={styles.emptyText}>No recent emojis yet</Text>
                    </View>
                  </View>
                )
            ) : activeTab === 'custom' ? (
              customEmojis.length > 0
                ? renderEmojiGrid(customEmojis.map((e) => ({
                  type: 'custom',
                  id: e.id,
                  name: e.name,
                  imageUrl: e.imageUrl,
                })))
                : (
                  <View style={styles.gridWrapper}>
                    <View style={styles.empty}>
                      <Text style={styles.emptyText}>No custom emojis</Text>
                    </View>
                  </View>
                )
            ) : (
              activeCategory
                ? renderEmojiGrid(activeCategory.emojis.map((e) => ({
                  type: 'native',
                  emoji: e.emoji,
                  name: e.name,
                })))
                : null
            )}
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  } as ViewStyle,
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  } as ViewStyle,
  sheet: {
    backgroundColor: colors.bgSecondary,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    paddingBottom: spacing.lg,
    height: '80%',
  } as ViewStyle,
  sheetContent: {
    flex: 1,
  } as ViewStyle,
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgTertiary,
    flexShrink: 0,
    flexGrow: 0,
  } as ViewStyle,
  sheetTitle: {
    color: colors.headerPrimary,
    fontSize: fontSize.md,
    fontWeight: '700',
  } as TextStyle,
  closeBtn: {
    color: colors.textMuted,
    fontSize: fontSize.lg,
  } as TextStyle,
  searchRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexShrink: 0,
    flexGrow: 0,
  } as ViewStyle,
  searchInput: {
    backgroundColor: colors.channelTextArea,
    color: colors.textPrimary,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
  } as TextStyle,
  tabsContainer: {
    flexShrink: 0,
    flexGrow: 0,
    maxHeight: 56,
  } as ViewStyle,
  tabs: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  } as ViewStyle,
  tab: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: spacing.sm,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  tabActive: {
    backgroundColor: colors.bgModifierActive,
  } as ViewStyle,
  tabText: {
    fontSize: 18,
    color: colors.textMuted,
  } as TextStyle,
  tabTextActive: {
    color: colors.textPrimary,
  } as TextStyle,
  gridContainer: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    overflow: 'hidden',
  } as ViewStyle,
  gridWrapper: {
    flex: 1,
  } as ViewStyle,
  gridListContent: {
    paddingBottom: spacing.lg,
  } as ViewStyle,
  emojiRow: {
    justifyContent: 'flex-start',
  } as ViewStyle,
  emojiRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  } as ViewStyle,
  emojiCell: {
    width: '12.5%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  } as ViewStyle,
  emojiText: {
    fontSize: 20,
  } as TextStyle,
  customEmoji: {
    width: 22,
    height: 22,
  } as ImageStyle,
  section: {
    marginBottom: spacing.md,
  } as ViewStyle,
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginBottom: spacing.xs,
  } as TextStyle,
  empty: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
  } as ViewStyle,
  emptyText: {
    color: colors.textMuted,
  } as TextStyle,
});
