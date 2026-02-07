import { View, Pressable, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Slot } from 'expo-router';
import { useSignalRListeners, useServerStore, useDmStore } from '@abyss/shared';
import ServerSidebar from '../../src/components/ServerSidebar';
import ChannelSidebar from '../../src/components/ChannelSidebar';
import MemberList from '../../src/components/MemberList';
import CreateServerModal from '../../src/components/CreateServerModal';
import JoinServerModal from '../../src/components/JoinServerModal';
import CreateChannelModal from '../../src/components/CreateChannelModal';
import InviteModal from '../../src/components/InviteModal';
import UserSettingsModal from '../../src/components/UserSettingsModal';
import ServerSettingsModal from '../../src/components/ServerSettingsModal';
import UserProfileCard from '../../src/components/UserProfileCard';
import { useUiStore } from '../../src/stores/uiStore';
import { colors, spacing, fontSize } from '../../src/theme/tokens';

export default function MainLayout() {
  useSignalRListeners();

  const activePanel = useUiStore((s) => s.activePanel);
  const setPanel = useUiStore((s) => s.setPanel);
  const activeServer = useServerStore((s) => s.activeServer);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeModal = useUiStore((s) => s.activeModal);
  const modalProps = useUiStore((s) => s.modalProps);

  const modals = (
    <>
      {activeModal === 'createServer' && <CreateServerModal />}
      {activeModal === 'joinServer' && <JoinServerModal />}
      {activeModal === 'createChannel' && <CreateChannelModal />}
      {activeModal === 'invite' && <InviteModal />}
      {activeModal === 'userSettings' && <UserSettingsModal />}
      {activeModal === 'serverSettings' && <ServerSettingsModal />}
      {activeModal === 'userProfile' && <UserProfileCard userId={modalProps.userId} />}
    </>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.mobile}>
        {activePanel === 'servers' && (
          <View style={styles.mobileServerPanel}>
            <ServerSidebar />
            <ChannelSidebar />
          </View>
        )}
        {activePanel === 'channels' && (
          <View style={styles.mobileChannelPanel}>
            <ServerSidebar />
            <ChannelSidebar />
          </View>
        )}
        {activePanel === 'content' && <Slot />}
        {activePanel === 'members' && activeServer && !isDmMode && (
          <View style={styles.mobileMembersPanel}>
            <MemberList />
          </View>
        )}
        {activePanel === 'members' && (!activeServer || isDmMode) && <Slot />}

        {/* Bottom nav bar */}
        <View style={styles.bottomNav}>
          <Pressable style={styles.navItem} onPress={() => setPanel('channels')}>
            <Text style={[styles.navIcon, activePanel === 'channels' && styles.navIconActive]}>{'☰'}</Text>
            <Text style={[styles.navLabel, activePanel === 'channels' && styles.navLabelActive]}>Channels</Text>
          </Pressable>
          <Pressable style={styles.navItem} onPress={() => setPanel('content')}>
            <Text style={[styles.navIcon, activePanel === 'content' && styles.navIconActive]}>{'💬'}</Text>
            <Text style={[styles.navLabel, activePanel === 'content' && styles.navLabelActive]}>Chat</Text>
          </Pressable>
          <Pressable style={styles.navItem} onPress={() => setPanel('members')}>
            <Text style={[styles.navIcon, activePanel === 'members' && styles.navIconActive]}>{'👥'}</Text>
            <Text style={[styles.navLabel, activePanel === 'members' && styles.navLabelActive]}>Members</Text>
          </Pressable>
        </View>
      </View>
      {modals}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bgTertiary,
  } as ViewStyle,
  mobile: {
    flex: 1,
  } as ViewStyle,
  mobileServerPanel: {
    flex: 1,
    flexDirection: 'row',
  } as ViewStyle,
  mobileChannelPanel: {
    flex: 1,
    flexDirection: 'row',
  } as ViewStyle,
  mobileMembersPanel: {
    flex: 1,
    flexDirection: 'row',
  } as ViewStyle,
  bottomNav: {
    flexDirection: 'row',
    backgroundColor: colors.bgTertiary,
    borderTopWidth: 1,
    borderTopColor: colors.bgSecondary,
    paddingVertical: spacing.xs,
  } as ViewStyle,
  navItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.xs,
  } as ViewStyle,
  navIcon: {
    fontSize: 20,
    color: colors.textMuted,
    marginBottom: 2,
  } as TextStyle,
  navIconActive: {
    color: colors.headerPrimary,
  } as TextStyle,
  navLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  } as TextStyle,
  navLabelActive: {
    color: colors.headerPrimary,
  } as TextStyle,
});
