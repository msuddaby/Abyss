import ServerSidebar from '../components/ServerSidebar';
import ChannelSidebar from '../components/ChannelSidebar';
import MessageList from '../components/MessageList';
import MessageInput from '../components/MessageInput';

import VoiceChannelView from '../components/VoiceChannelView';
import TypingIndicator from '../components/TypingIndicator';
import MemberList from '../components/MemberList';
import SearchPanel from '../components/SearchPanel';
import PinnedMessagesModal from '../components/PinnedMessagesModal';
import UpdateBanner from '../components/UpdateBanner';
import VoiceChatOverlay from '../components/VoiceChatOverlay';
import MediaLibraryBrowser from '../components/MediaLibraryBrowser';
import ContextMenu from '../components/contextMenu/ContextMenu';
import WatchPartyPlayer from '../components/WatchPartyPlayer';
import { useServerStore, useSearchStore, useDmStore, useSignalRListeners, useSignalRStore, useAppConfigStore, useWatchPartyStore, useVoiceStore } from '@abyss/shared';
import { useEffect, useState } from 'react';
import { useMobileStore, isMobile } from '../stores/mobileStore';

export default function MainLayout() {
  const activeChannel = useServerStore((s) => s.activeChannel);
  const activeServer = useServerStore((s) => s.activeServer);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const activeDmChannel = useDmStore((s) => s.activeDmChannel);
  const searchIsOpen = useSearchStore((s) => s.isOpen);
  const openSearch = useSearchStore((s) => s.openSearch);
  const closeSearch = useSearchStore((s) => s.closeSearch);
  const signalRStatus = useSignalRStore((s) => s.status);
  const fetchConfig = useAppConfigStore((s) => s.fetchConfig);
  const activeParty = useWatchPartyStore((s) => s.activeParty);
  const isTunedIn = useWatchPartyStore((s) => s.isTunedIn);
  const isBrowsingLibrary = useWatchPartyStore((s) => s.isBrowsingLibrary);
  const setIsBrowsingLibrary = useWatchPartyStore((s) => s.setIsBrowsingLibrary);
  const voiceChannelId = useVoiceStore((s) => s.currentChannelId);
  const leftDrawerOpen = useMobileStore((s) => s.leftDrawerOpen);
  const rightDrawerOpen = useMobileStore((s) => s.rightDrawerOpen);
  const openLeftDrawer = useMobileStore((s) => s.openLeftDrawer);
  const openRightDrawer = useMobileStore((s) => s.openRightDrawer);
  const closeDrawers = useMobileStore((s) => s.closeDrawers);
  const [showPins, setShowPins] = useState(false);
  const [memberListVisible, setMemberListVisible] = useState(() => {
    const saved = localStorage.getItem('memberListVisible');
    return saved !== null ? saved === 'true' : true;
  });

  const toggleMemberList = () => {
    if (isMobile()) {
      openRightDrawer();
      return;
    }
    setMemberListVisible((prev) => {
      localStorage.setItem('memberListVisible', String(!prev));
      return !prev;
    });
  };

  useSignalRListeners();
  useEffect(() => {
    fetchConfig().catch(() => {});
  }, [fetchConfig]);

  useEffect(() => {
    requestAnimationFrame(() => {
      setShowPins(false);
    });
  }, [activeChannel?.id, activeDmChannel?.id, isDmMode]);

  const showSignalRBanner = signalRStatus !== 'connected';
  const signalRMessage = signalRStatus === 'connecting'
    ? 'Connecting to live updates...'
    : signalRStatus === 'reconnecting'
      ? 'Reconnecting to live updates...'
      : 'Live updates offline. Retrying...';

  const hamburgerButton = (
    <button className="mobile-hamburger" onClick={openLeftDrawer} aria-label="Open menu">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
      </svg>
    </button>
  );

  return (
    <div className="main-layout">
      <div className={`left-drawer${leftDrawerOpen ? ' open' : ''}`}>
        <ServerSidebar />
        <ChannelSidebar />
      </div>
      <div className="content-area">
        {showSignalRBanner && (
          <div className={`signalr-status-banner ${signalRStatus}`}>
            <span>{signalRMessage}</span>
          </div>
        )}
        {window.electron && <UpdateBanner />}
        {isDmMode && activeDmChannel ? (
          <>
            <div className="channel-header">
              {hamburgerButton}
              <span className="channel-dm-icon">@</span>
              <span className="channel-name">{activeDmChannel.otherUser.displayName}</span>
              <div className="channel-header-actions">
                <button
                  className={`pin-header-btn${showPins ? ' active' : ''}`}
                  onClick={() => setShowPins((s) => !s)}
                  title="Pinned messages"
                >
                  📌
                </button>
              </div>
            </div>
            <MessageList />
            <TypingIndicator />
            <MessageInput />
            {showPins && (
              <PinnedMessagesModal
                channelId={activeDmChannel.id}
                onClose={() => setShowPins(false)}
              />
            )}
          </>
        ) : activeChannel ? (
          activeChannel.type === 'Text' ? (
            <>
              <div className="channel-header">
                {hamburgerButton}
                <span className="channel-hash">#</span>
                <span className="channel-name">{activeChannel.name}</span>
                <div className="channel-header-actions">
                  <button
                    className={`search-header-btn${searchIsOpen ? ' active' : ''}`}
                    onClick={() => {
                      if (searchIsOpen) {
                        closeSearch();
                        if (isMobile()) closeDrawers();
                      } else {
                        openSearch();
                        if (isMobile()) openRightDrawer();
                      }
                    }}
                    title="Search messages"
                  >
                    🔍?
                  </button>
                  <button
                    className={`pin-header-btn${showPins ? ' active' : ''}`}
                    onClick={() => setShowPins((s) => !s)}
                    title="Pinned messages"
                  >
                    📌
                  </button>
                  <button
                    className={`member-list-toggle-btn${memberListVisible && !isMobile() ? ' active' : ''}`}
                    onClick={toggleMemberList}
                    title="Toggle member list"
                  >
                    👥
                  </button>
                </div>
              </div>
              <MessageList />
              <TypingIndicator />
              <MessageInput />
              {showPins && (
                <PinnedMessagesModal
                  channelId={activeChannel.id}
                  onClose={() => setShowPins(false)}
                />
              )}
            </>
          ) : (
            <div className="voice-channel-view">
              <div className="channel-header">
                {hamburgerButton}
                <span className="channel-voice-icon">🔊</span>
                <span className="channel-name">{activeChannel.name}</span>
                <div className="channel-header-actions">
                  <button
                    className={`member-list-toggle-btn${memberListVisible && !isMobile() ? ' active' : ''}`}
                    onClick={toggleMemberList}
                    title="Toggle member list"
                  >
                    👥
                  </button>
                </div>
              </div>
              <VoiceChannelView />
            </div>
          )
        ) : (
          <div className="no-channel">
            {hamburgerButton}
            <h2>Welcome to Abyss</h2>
            <p>Select a channel to start chatting</p>
          </div>
        )}
        {activeParty && voiceChannelId && isTunedIn && (
          <WatchPartyPlayer mini={activeChannel?.id !== voiceChannelId || activeChannel?.type !== 'Voice'} />
        )}
      </div>
      <div className={`right-drawer${rightDrawerOpen ? ' open' : ''}`}>
        {activeServer && !isDmMode && (searchIsOpen ? <SearchPanel /> : <MemberList />)}
      </div>
      {(leftDrawerOpen || rightDrawerOpen) && (
        <div className="mobile-drawer-overlay" onClick={() => { closeDrawers(); if (searchIsOpen) closeSearch(); }} />
      )}
      <VoiceChatOverlay />
      <ContextMenu />
      {isBrowsingLibrary && <MediaLibraryBrowser onClose={() => setIsBrowsingLibrary(false)} />}
    </div>
  );
}
