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
import { useServerStore, useSearchStore, useDmStore, useSignalRListeners, useSignalRStore, useAppConfigStore } from '@abyss/shared';
import { useEffect, useState } from 'react';

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
  const [showPins, setShowPins] = useState(false);

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

  return (
    <div className="main-layout">
      <ServerSidebar />
      <ChannelSidebar />
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
                <span className="channel-hash">#</span>
                <span className="channel-name">{activeChannel.name}</span>
                <div className="channel-header-actions">
                  <button
                    className={`search-header-btn${searchIsOpen ? ' active' : ''}`}
                    onClick={() => searchIsOpen ? closeSearch() : openSearch()}
                    title="Search messages"
                  >
                    🔍
                  </button>
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
                  channelId={activeChannel.id}
                  onClose={() => setShowPins(false)}
                />
              )}
            </>
          ) : (
            <div className="voice-channel-view">
              <div className="channel-header">
                <span className="channel-voice-icon">🔊</span>
                <span className="channel-name">{activeChannel.name}</span>
              </div>
              <VoiceChannelView />
            </div>
          )
        ) : (
          <div className="no-channel">
            <h2>Welcome to Abyss</h2>
            <p>Select a channel to start chatting</p>
          </div>
        )}
      </div>
      {activeServer && !isDmMode && (searchIsOpen ? <SearchPanel /> : <MemberList />)}
    </div>
  );
}
