import { useState, useEffect, useCallback } from 'react';
import { useVoiceStore } from '@abyss/shared/stores/voiceStore';
import { getLiveKitRoom } from '@abyss/shared';

interface SfuDebugInfo {
  roomName: string;
  connectionState: string;
  e2eeEnabled: boolean;
  localParticipant: string;
  remoteParticipants: { identity: string; name: string; audioPublished: boolean }[];
}

function getSfuDebugInfo(): SfuDebugInfo | null {
  const room = getLiveKitRoom();
  if (!room) return null;

  const remoteParticipants = Array.from(room.remoteParticipants.values()).map(p => ({
    identity: p.identity,
    name: p.name || p.identity,
    audioPublished: Array.from(p.trackPublications.values()).some(
      t => t.kind === 'audio' && t.isSubscribed,
    ),
  }));

  return {
    roomName: room.name || 'unknown',
    connectionState: room.state,
    e2eeEnabled: room.isE2EEEnabled,
    localParticipant: room.localParticipant?.identity || 'unknown',
    remoteParticipants,
  };
}

export function VoiceDebugPanel() {
  const [expanded, setExpanded] = useState(false);
  const [sfuInfo, setSfuInfo] = useState<SfuDebugInfo | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const currentChannelId = useVoiceStore(s => s.currentChannelId);
  const connectionMode = useVoiceStore(s => s.connectionMode);

  const refresh = useCallback(() => {
    setSfuInfo(getSfuDebugInfo());
    setLastUpdate(new Date());
  }, []);

  // Auto-refresh when expanded
  useEffect(() => {
    if (!expanded || !currentChannelId) return;
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [expanded, currentChannelId, refresh]);

  const handleCopyStats = () => {
    const output = {
      timestamp: new Date().toISOString(),
      mode: 'sfu',
      connectionMode,
      room: sfuInfo ? {
        name: sfuInfo.roomName,
        state: sfuInfo.connectionState,
        e2ee: sfuInfo.e2eeEnabled,
        localParticipant: sfuInfo.localParticipant,
      } : null,
      remoteParticipants: sfuInfo?.remoteParticipants ?? [],
    };
    navigator.clipboard.writeText(JSON.stringify(output, null, 2));
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  return (
    <div className="voice-debug-panel">
      <div className="voice-debug-header" onClick={() => setExpanded(!expanded)}>
        <div className="voice-debug-title">
          <span>Voice Debug (Beta)</span>
        </div>
        <div className={`voice-debug-toggle ${expanded ? 'expanded' : ''}`}>
          ▼
        </div>
      </div>

      {expanded && (
        <div className="voice-debug-content">
          {!currentChannelId ? (
            <div className="voice-debug-not-active">
              Not currently in a voice channel
            </div>
          ) : (
            <>
              <div className="voice-debug-actions">
                <button type="button" className="btn-small" onClick={refresh}>
                  Refresh
                </button>
                <button type="button" className="btn-small" onClick={handleCopyStats}>
                  {copyFeedback ? 'Copied!' : 'Copy Debug Info'}
                </button>
              </div>

              {/* Mode indicator */}
              <div className="voice-debug-metrics">
                <div className="voice-debug-metric">
                  <div className="voice-debug-metric-label">Mode</div>
                  <div className="voice-debug-metric-value">
                    {connectionMode === 'sfu' && 'SFU Relay'}
                    {connectionMode === 'connecting' && 'Connecting...'}
                    {connectionMode === 'disconnected' && 'Disconnected'}
                  </div>
                </div>
              </div>

              {/* SFU room stats */}
              {sfuInfo && (
                <>
                  <div className="voice-debug-metrics">
                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Room State</div>
                      <div className="voice-debug-metric-value">{sfuInfo.connectionState}</div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">E2EE</div>
                      <div className="voice-debug-metric-value">
                        {sfuInfo.e2eeEnabled ? 'Enabled' : 'Disabled'}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Room</div>
                      <div className="voice-debug-metric-value" style={{ fontSize: '0.85em' }}>
                        {sfuInfo.roomName}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Local Identity</div>
                      <div className="voice-debug-metric-value" style={{ fontSize: '0.85em' }}>
                        {sfuInfo.localParticipant}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Remote Participants</div>
                      <div className="voice-debug-metric-value">
                        {sfuInfo.remoteParticipants.length}
                      </div>
                    </div>
                  </div>

                  {sfuInfo.remoteParticipants.length > 0 && (
                    <div className="voice-debug-peer-list">
                      {sfuInfo.remoteParticipants.map((p) => (
                        <div key={p.identity} className="voice-debug-peer-card">
                          <div className="voice-debug-peer-header">
                            {p.name}
                          </div>
                          <div className="voice-debug-peer-metrics">
                            <div>
                              <div className="label">Identity</div>
                              <div style={{ fontSize: '0.85em' }}>{p.identity}</div>
                            </div>
                            <div>
                              <div className="label">Audio</div>
                              <div>{p.audioPublished ? 'Subscribed' : 'No audio'}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {lastUpdate && (
                <div className="voice-debug-timestamp">
                  Last updated: {lastUpdate.toLocaleTimeString()}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
