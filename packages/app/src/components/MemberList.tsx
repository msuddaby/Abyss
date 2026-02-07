import { View, Text, SectionList, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { useServerStore, usePresenceStore } from '@abyss/shared';
import type { ServerMember } from '@abyss/shared';
import MemberItem from './MemberItem';
import { useUiStore } from '../stores/uiStore';
import { colors, spacing, fontSize } from '../theme/tokens';

export default function MemberList() {
  const members = useServerStore((s) => s.members);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const openModal = useUiStore((s) => s.openModal);

  if (members.length === 0) return null;

  const online = members.filter((m) => onlineUsers.has(m.userId));
  const offline = members.filter((m) => !onlineUsers.has(m.userId));

  const sections: { title: string; data: ServerMember[] }[] = [];
  if (online.length > 0) sections.push({ title: `Online — ${online.length}`, data: online });
  if (offline.length > 0) sections.push({ title: `Offline — ${offline.length}`, data: offline });

  return (
    <View style={styles.container}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.userId}
        renderItem={({ item }) => (
          <MemberItem
            member={item}
            isOnline={onlineUsers.has(item.userId)}
            onPress={() => openModal('userProfile', { userId: item.userId })}
          />
        )}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 240,
    backgroundColor: colors.bgSecondary,
  } as ViewStyle,
  sectionHeader: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  } as TextStyle,
});
