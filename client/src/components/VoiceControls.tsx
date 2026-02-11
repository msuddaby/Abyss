import { useEffect, useState } from 'react';
import { useVoiceStore, useServerStore, hasChannelPermission, Permission } from '@abyss/shared';
import { useWebRTC, attemptAudioUnlock, getConnectionStats, type ConnectionStats } from '../hooks/useWebRTC';

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
  const isMac = navigator.platform.toUpperCase().includes('MAC');
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

  const channel = channels.find((c) => c.id === currentChannelId);
  const isPtt = voiceMode === 'push-to-talk';
  const canStream = channel ? hasChannelPermission(channel.permissions, Permission.Stream) : false;

  // Connection quality stats
  const [stats, setStats] = useState<ConnectionStats>({ roundTripTime: null, packetLoss: null, jitter: null });
  useEffect(() => {
    if (!currentChannelId) return;
    const id = setInterval(() => setStats(getConnectionStats()), 3000);
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
    <div className="voice-controls">
      <div className="voice-controls-info">
        <span className="voice-connected-label">
          <span className={`voice-quality-dot ${qualityLevel}`} title={qualityTitle} />
          Voice Connected
        </span>
        {channel && <span className="voice-channel-name">🔊 {channel.name}</span>}
      </div>
      <div className="voice-controls-buttons">
        {needsAudioUnlock && (
          <button
            className="voice-ctrl-btn audio-unlock"
            onClick={() => attemptAudioUnlock()}
            title="Enable audio playback"
          >
            Enable Audio
          </button>
        )}
        <button
          className={`voice-ctrl-btn voice-mode-toggle`}
          onClick={() => setVoiceMode(isPtt ? 'voice-activity' : 'push-to-talk')}
          title={isPtt ? 'Switch to Voice Activity' : 'Switch to Push to Talk'}
        >
          {isPtt ? 'PTT' : 'VA'}
        </button>
        {isPtt && (
          <span className="ptt-hint">
            {isPttActive ? '🎤' : `[${pttKey.startsWith('Mouse') ? `M${pttKey.slice(5)}` : pttKey}]`}
          </span>
        )}
        {canStream && (
          <button
            className={`voice-ctrl-btn ${isCameraOn ? 'active' : ''}${isCameraLoading ? ' loading' : ''}`}
            onClick={isCameraOn ? stopCamera : startCamera}
            disabled={isCameraLoading}
            title={isCameraOn ? 'Stop Camera' : 'Start Camera'}
          >
            {isCameraLoading ? '⏳' : '📷'}
          </button>
        )}
        {canStream && (
          <button
            className={`voice-ctrl-btn ${isScreenSharing ? 'active' : ''}${isScreenShareLoading ? ' loading' : ''}`}
            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
            disabled={isScreenShareLoading}
            title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          >
            {isScreenShareLoading ? '⏳' : '🖥️'}
          </button>
        )}
        <button className="voice-ctrl-btn disconnect" onClick={leaveVoice} title={`Disconnect (${formatKeybind(keybindDisconnect)})`}>
          📞
        </button>
      </div>
    </div>
  );
}
