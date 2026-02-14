import { useEffect, useState, useRef, useCallback } from 'react';
import { useVoiceStore, useServerStore, useWatchPartyStore, useSoundboardStore, hasChannelPermission, Permission } from '@abyss/shared';
import { useWebRTC, attemptAudioUnlock, getConnectionStats, type ConnectionStats } from '../hooks/useWebRTC';
import SoundboardPanel from './SoundboardPanel';
import QualityPopover from './QualityPopover';
import { isMobile } from '../stores/mobileStore';

function matchesKeybind(e: KeyboardEvent, bind: string): boolean {
  const parts = bind.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  const mod = e.ctrlKey || e.metaKey;
  if (mods.has('mod') && !mod) return false;
  if (mods.has('shift') && !e.shiftKey) return false;
  if (mods.has('alt') && !e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function formatKeybind(bind: string): string {
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
  return bind
    .split('+')
    .map((p) => {
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join('+');
}

export default function VoiceControls() {
  const { currentChannelId, isScreenSharing, isCameraOn, voiceMode, isPttActive, pttKey, setVoiceMode, needsAudioUnlock } = useVoiceStore();
  const isCameraLoading = useVoiceStore((s) => s.isCameraLoading);
  const isScreenShareLoading = useVoiceStore((s) => s.isScreenShareLoading);
  const channels = useServerStore((s) => s.channels);
  const { leaveVoice, startScreenShare, stopScreenShare, startCamera, stopCamera } = useWebRTC();
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const connectionState = useVoiceStore((s) => s.connectionState);

  const isBrowsingLibrary = useWatchPartyStore((s) => s.isBrowsingLibrary);
  const setIsBrowsingLibrary = useWatchPartyStore((s) => s.setIsBrowsingLibrary);

  const [showSoundboard, setShowSoundboard] = useState(false);
  const soundboardClips = useSoundboardStore((s) => s.clips);

  const cameraBtnRef = useRef<HTMLButtonElement>(null);
  const screenBtnRef = useRef<HTMLButtonElement>(null);
  const [qualityPopover, setQualityPopover] = useState<{ type: 'camera' | 'screen'; rect: DOMRect } | null>(null);

  const openQualityPopover = useCallback((type: 'camera' | 'screen', btn: HTMLButtonElement | null) => {
    if (!btn) return;
    setQualityPopover({ type, rect: btn.getBoundingClientRect() });
  }, []);

  const channel = channels.find((c) => c.id === currentChannelId);
  const isPtt = voiceMode === 'push-to-talk';
  const canStream = channel ? hasChannelPermission(channel.permissions, Permission.Stream) : false;
  const canUseSoundboard = channel ? hasChannelPermission(channel.permissions, Permission.UseSoundboard) : false;

  // Connection quality stats — read cached stats from useWebRTC's collection interval
  const [stats, setStats] = useState<ConnectionStats>({ roundTripTime: null, packetLoss: null, jitter: null });
  useEffect(() => {
    if (!currentChannelId) {
      setStats({ roundTripTime: null, packetLoss: null, jitter: null });
      return;
    }
    // Read cached stats at half the collection rate to stay fresh without duplicating getStats() calls
    const id = setInterval(() => setStats(getConnectionStats()), 5000);
    // Read immediately on mount
    setStats(getConnectionStats());
    return () => clearInterval(id);
  }, [currentChannelId]);

  const qualityLevel = (() => {
    if (connectionState === 'reconnecting') return 'poor';
    if (stats.roundTripTime === null) return 'good'; // connected but no peers yet
    if (stats.roundTripTime < 100 && (stats.packetLoss ?? 0) < 2) return 'good';
    if (stats.roundTripTime < 250 && (stats.packetLoss ?? 0) < 5) return 'fair';
    return 'poor';
  })();

  const qualityTitle = connectionState === 'reconnecting'
    ? 'Reconnecting...'
    : stats.roundTripTime !== null
      ? `RTT: ${Math.round(stats.roundTripTime)}ms | Loss: ${(stats.packetLoss ?? 0).toFixed(1)}% | Jitter: ${Math.round(stats.jitter ?? 0)}ms`
      : 'Connected';

  // Customizable keyboard shortcuts
  const keybindToggleMute = useVoiceStore((s) => s.keybindToggleMute);
  const keybindToggleDeafen = useVoiceStore((s) => s.keybindToggleDeafen);
  const keybindDisconnect = useVoiceStore((s) => s.keybindDisconnect);

  useEffect(() => {
    if (!currentChannelId) return;

    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;

      if (matchesKeybind(e, keybindToggleMute)) {
        e.preventDefault();
        toggleMute();
      } else if (matchesKeybind(e, keybindToggleDeafen)) {
        e.preventDefault();
        toggleDeafen();
      } else if (matchesKeybind(e, keybindDisconnect)) {
        e.preventDefault();
        leaveVoice();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentChannelId, toggleMute, toggleDeafen, leaveVoice, keybindToggleMute, keybindToggleDeafen, keybindDisconnect]);

  useEffect(() => {
    if (!canStream && isScreenSharing) {
      stopScreenShare();
    }
    if (!canStream && isCameraOn) {
      stopCamera();
    }
  }, [canStream, isScreenSharing, isCameraOn, stopScreenShare, stopCamera]);

  if (!currentChannelId) return null;

  return (
    <div className="voice-controls-wrapper">
    <div className="voice-controls">
      <div className="voice-controls-header">
        <div className="voice-controls-info">
          <span className="voice-connected-label">
            <span className={`voice-quality-dot ${qualityLevel}`} title={qualityTitle} />
            Voice Connected
          </span>
          {channel && <span className="voice-channel-name">{channel.name}</span>}
          {isPtt && (
            <span className="vc-ptt-hint">
              {isPttActive ? '● Transmitting' : `Press ${pttKey.startsWith('Mouse') ? `Mouse ${pttKey.slice(5)}` : pttKey} to talk`}
            </span>
          )}
          {isScreenSharing && (
            <button className="vc-sharing-indicator" onClick={stopScreenShare} title="Click to stop sharing">
              Sharing Screen
            </button>
          )}
        </div>
        <button className="vc-disconnect-btn" onClick={leaveVoice} title={`Disconnect (${formatKeybind(keybindDisconnect)})`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
          </svg>
        </button>
      </div>
      {needsAudioUnlock && (
        <button
          className="vc-audio-unlock"
          onClick={() => attemptAudioUnlock()}
        >
          Click to enable audio playback
        </button>
      )}
      <div className="voice-controls-buttons">
        {!isMobile() && (
          <button
            className={`vc-btn ${isPtt ? 'vc-active' : ''}`}
            onClick={() => setVoiceMode(isPtt ? 'voice-activity' : 'push-to-talk')}
            title={isPtt ? 'Switch to Voice Activity' : 'Switch to Push to Talk'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            <span>{isPtt ? 'PTT' : 'VA'}</span>
          </button>
        )}
        {canStream && (
          <button
            ref={cameraBtnRef}
            className={`vc-btn ${isCameraOn ? 'vc-active' : ''}${isCameraLoading ? ' loading' : ''}`}
            onClick={isCameraOn ? stopCamera : startCamera}
            disabled={isCameraLoading}
            title={isCameraOn ? 'Stop Camera (right-click for quality)' : 'Start Camera'}
            onContextMenu={(e) => { if (isCameraOn) { e.preventDefault(); openQualityPopover('camera', cameraBtnRef.current); } }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
            {isCameraOn && <span className="vc-quality-chevron" />}
          </button>
        )}
        {canStream && (
          <button
            ref={screenBtnRef}
            className={`vc-btn ${isScreenSharing ? 'vc-sharing' : ''}${isScreenShareLoading ? ' loading' : ''}`}
            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
            disabled={isScreenShareLoading}
            title={isScreenSharing ? 'Stop Sharing (right-click for quality)' : 'Share Screen'}
            onContextMenu={(e) => { if (isScreenSharing) { e.preventDefault(); openQualityPopover('screen', screenBtnRef.current); } }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
            </svg>
            {isScreenSharing && <span className="vc-quality-chevron" />}
          </button>
        )}
        {canStream && (
          <button
            className={`vc-btn ${isBrowsingLibrary ? 'vc-active' : ''}`}
            onClick={() => setIsBrowsingLibrary(!isBrowsingLibrary)}
            title="Watch Party"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
            </svg>
          </button>
        )}
        {canUseSoundboard && soundboardClips.length > 0 && (
          <button
            className={`vc-btn ${showSoundboard ? 'vc-active' : ''}`}
            onClick={() => setShowSoundboard(!showSoundboard)}
            title="Soundboard"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
          </button>
        )}
      </div>
    </div>
    {showSoundboard && <SoundboardPanel />}
    {qualityPopover && (
      <QualityPopover
        type={qualityPopover.type}
        anchorRect={qualityPopover.rect}
        onClose={() => setQualityPopover(null)}
      />
    )}
    </div>
  );
}
