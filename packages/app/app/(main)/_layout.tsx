import { View, Pressable, StyleSheet, Animated, Keyboard, AppState, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Slot } from 'expo-router';
import {
  useSignalRListeners, useServerStore, useDmStore, useMessageStore,
  ensureConnected, getConnection, refreshSignalRState, rejoinActiveChannel,
  stopConnection,
} from '@abyss/shared';
import { useEffect, useRef, useState } from 'react';
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
import SearchPanel from '../../src/components/SearchPanel';
import PinnedMessagesModal from '../../src/components/PinnedMessagesModal';
import { useUiStore } from '../../src/stores/uiStore';
import { colors } from '../../src/theme/tokens';

export default function MainLayout() {
  useSignalRListeners();

  const leftDrawerOpen = useUiStore((s) => s.leftDrawerOpen);
  const rightDrawerOpen = useUiStore((s) => s.rightDrawerOpen);
  const closeLeftDrawer = useUiStore((s) => s.closeLeftDrawer);
  const closeRightDrawer = useUiStore((s) => s.closeRightDrawer);
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
      {activeModal === 'search' && <SearchPanel />}
      {activeModal === 'pins' && modalProps.channelId && (
        <PinnedMessagesModal channelId={modalProps.channelId} />
      )}
    </>
  );

  const leftWidth = 312;
  const rightWidth = 240;
  const leftTranslate = useRef(new Animated.Value(-leftWidth)).current;
  const rightTranslate = useRef(new Animated.Value(rightWidth)).current;
  const leftOverlayOpacity = useRef(new Animated.Value(0)).current;
  const rightOverlayOpacity = useRef(new Animated.Value(0)).current;
  const [renderLeft, setRenderLeft] = useState(leftDrawerOpen);
  const [renderRight, setRenderRight] = useState(rightDrawerOpen);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    if (!activeServer || isDmMode) closeRightDrawer();
  }, [activeServer, isDmMode, closeRightDrawer]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState) => {
      const prevState = appState.current;
      appState.current = nextState;

      if (nextState === 'active' && (prevState === 'background' || prevState === 'inactive')) {
        try {
          const conn = await ensureConnected();
          await rejoinActiveChannel(conn);
          refreshSignalRState(conn);

          const { isDmMode: dmMode, activeDmChannel } = useDmStore.getState();
          const { activeChannel } = useServerStore.getState();
          const channelId = dmMode ? activeDmChannel?.id : (activeChannel?.type === 'Text' ? activeChannel.id : null);
          if (channelId) {
            await useMessageStore.getState().fetchMessages(channelId);
          }
        } catch (err) {
          console.error('Failed to resume SignalR:', err);
        }
      }

      if (nextState === 'background' || nextState === 'inactive') {
        stopConnection().catch(() => {});
      }
    });

    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (leftDrawerOpen || rightDrawerOpen) {
      Keyboard.dismiss();
    }
  }, [leftDrawerOpen, rightDrawerOpen]);

  useEffect(() => {
    if (leftDrawerOpen) {
      setRenderLeft(true);
      Animated.parallel([
        Animated.timing(leftTranslate, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(leftOverlayOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    } else if (renderLeft) {
      Animated.parallel([
        Animated.timing(leftTranslate, { toValue: -leftWidth, duration: 200, useNativeDriver: true }),
        Animated.timing(leftOverlayOpacity, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRenderLeft(false);
      });
    }
  }, [leftDrawerOpen, renderLeft, leftTranslate, leftOverlayOpacity]);

  useEffect(() => {
    if (rightDrawerOpen) {
      setRenderRight(true);
      Animated.parallel([
        Animated.timing(rightTranslate, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(rightOverlayOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    } else if (renderRight) {
      Animated.parallel([
        Animated.timing(rightTranslate, { toValue: rightWidth, duration: 200, useNativeDriver: true }),
        Animated.timing(rightOverlayOpacity, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRenderRight(false);
      });
    }
  }, [rightDrawerOpen, renderRight, rightTranslate, rightOverlayOpacity]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.container}>
        <Slot />

        {renderLeft && (
          <>
            <Animated.View style={[styles.overlay, { opacity: leftOverlayOpacity }]} />
            <Pressable style={styles.overlayPressable} onPress={closeLeftDrawer} />
            <Animated.View style={[styles.leftDrawer, { transform: [{ translateX: leftTranslate }] }]}>
              <ServerSidebar />
              <ChannelSidebar />
            </Animated.View>
          </>
        )}

        {renderRight && (
          <>
            <Animated.View style={[styles.overlay, { opacity: rightOverlayOpacity }]} />
            <Pressable style={styles.overlayPressable} onPress={closeRightDrawer} />
            <Animated.View style={[styles.rightDrawer, { transform: [{ translateX: rightTranslate }] }]}>
              {activeServer && !isDmMode && <MemberList />}
            </Animated.View>
          </>
        )}
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
  container: {
    flex: 1,
  } as ViewStyle,
  overlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    zIndex: 1,
  } as ViewStyle,
  overlayPressable: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2,
  } as ViewStyle,
  leftDrawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    width: 312,
    backgroundColor: colors.bgSecondary,
    zIndex: 3,
  } as ViewStyle,
  rightDrawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 240,
    backgroundColor: colors.bgSecondary,
    zIndex: 3,
  } as ViewStyle,
});
