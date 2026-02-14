import { useState, useEffect } from 'react';
import { getDetailedConnectionStats } from '../hooks/useWebRTC';
import type { DetailedConnectionStats } from '../hooks/useWebRTC';
import { useVoiceStore } from '@abyss/shared/stores/voiceStore';

export function VoiceDebugPanel() {
  const [expanded, setExpanded] = useState(false);
  const [detailedView, setDetailedView] = useState(false);
  const [stats, setStats] = useState<DetailedConnectionStats | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const currentChannelId = useVoiceStore(s => s.currentChannelId);
  const participants = useVoiceStore(s => s.participants);

  // Auto-refresh when expanded
  useEffect(() => {
    if (!expanded || !currentChannelId) return;

    const refresh = () => {
      const newStats = getDetailedConnectionStats();
      setStats(newStats);
      setLastUpdate(new Date());
    };

    refresh(); // Initial load
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [expanded, currentChannelId]);

  const handleCopyStats = () => {
    const output = {
      timestamp: new Date().toISOString(),
      summary: {
        activePeers: stats?.activePeerCount ?? 0,
        connectionType: stats?.connectionType ?? 'unknown',
        iceConnectionState: stats?.iceConnectionState ?? 'new',
        avgRoundTripTime: stats?.roundTripTime,
        avgPacketLoss: stats?.packetLoss,
        avgJitter: stats?.jitter,
      },
      peers: stats?.perPeerStats.map(peer => ({
        userId: peer.userId,
        displayName: participants.get(peer.userId) ?? 'Unknown',
        iceState: peer.iceState,
        signalingState: peer.signalingState,
        connectionType: peer.connectionType,
        roundTripTime: peer.roundTripTime,
        packetLoss: peer.packetLoss,
        jitter: peer.jitter,
        bytesReceived: peer.bytesReceived,
        bytesSent: peer.bytesSent,
      })) ?? [],
    };
    navigator.clipboard.writeText(JSON.stringify(output, null, 2));
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const getQualityClass = (rtt: number | null, packetLoss: number | null): string => {
    if (rtt === null && packetLoss === null) return '';
    if (rtt !== null && rtt > 250) return 'quality-error';
    if (packetLoss !== null && packetLoss > 3) return 'quality-error';
    if (rtt !== null && rtt > 100) return 'quality-warning';
    if (packetLoss !== null && packetLoss > 1) return 'quality-warning';
    return 'quality-good';
  };

  const formatMetric = (value: number | null, unit: string): string => {
    if (value === null) return 'N/A';
    return `${Math.round(value)}${unit}`;
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => {
                    const newStats = getDetailedConnectionStats();
                    setStats(newStats);
                    setLastUpdate(new Date());
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => setDetailedView(!detailedView)}
                >
                  {detailedView ? 'Simple View' : 'Detailed View'}
                </button>
                <button
                  type="button"
                  className="btn-small"
                  onClick={handleCopyStats}
                >
                  {copyFeedback ? 'Copied!' : 'Copy Debug Info'}
                </button>
              </div>

              {stats && (
                <>
                  <div className="voice-debug-metrics">
                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Connection Type</div>
                      <div className="voice-debug-metric-value">
                        {stats.connectionType === 'direct' && '🔗 P2P Direct'}
                        {stats.connectionType === 'relay' && '🔀 TURN Relay'}
                        {stats.connectionType === 'mixed' && '🔀 Mixed'}
                        {stats.connectionType === 'unknown' && '❓ Unknown'}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Ping / RTT</div>
                      <div className={`voice-debug-metric-value ${getQualityClass(stats.roundTripTime, null)}`}>
                        {formatMetric(stats.roundTripTime, 'ms')}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Packet Loss</div>
                      <div className={`voice-debug-metric-value ${getQualityClass(null, stats.packetLoss)}`}>
                        {formatMetric(stats.packetLoss, '%')}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Jitter</div>
                      <div className="voice-debug-metric-value">
                        {formatMetric(stats.jitter, 'ms')}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">ICE State</div>
                      <div className="voice-debug-metric-value">
                        {stats.iceConnectionState}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Active Peers</div>
                      <div className="voice-debug-metric-value">
                        {stats.activePeerCount}
                      </div>
                    </div>
                  </div>

                  {detailedView && stats.perPeerStats.length > 0 && (
                    <div className="voice-debug-peer-list">
                      {stats.perPeerStats.map((peer) => (
                        <div key={peer.userId} className="voice-debug-peer-card">
                          <div className="voice-debug-peer-header">
                            {participants.get(peer.userId) ?? peer.userId}
                          </div>
                          <div className="voice-debug-peer-metrics">
                            <div>
                              <div className="label">Connection</div>
                              <div>
                                {peer.connectionType === 'direct' && 'P2P Direct'}
                                {peer.connectionType === 'relay' && 'TURN Relay'}
                                {peer.connectionType === 'unknown' && 'Unknown'}
                              </div>
                            </div>
                            <div>
                              <div className="label">ICE State</div>
                              <div>{peer.iceState}</div>
                            </div>
                            <div>
                              <div className="label">Signaling</div>
                              <div>{peer.signalingState}</div>
                            </div>
                            <div>
                              <div className="label">RTT</div>
                              <div className={getQualityClass(peer.roundTripTime, null)}>
                                {formatMetric(peer.roundTripTime, 'ms')}
                              </div>
                            </div>
                            <div>
                              <div className="label">Packet Loss</div>
                              <div className={getQualityClass(null, peer.packetLoss)}>
                                {formatMetric(peer.packetLoss, '%')}
                              </div>
                            </div>
                            <div>
                              <div className="label">Jitter</div>
                              <div>{formatMetric(peer.jitter, 'ms')}</div>
                            </div>
                            <div>
                              <div className="label">Bytes Received</div>
                              <div>{formatBytes(peer.bytesReceived)}</div>
                            </div>
                            <div>
                              <div className="label">Bytes Sent</div>
                              <div>{formatBytes(peer.bytesSent)}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {lastUpdate && (
                    <div className="voice-debug-timestamp">
                      Last updated: {lastUpdate.toLocaleTimeString()}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
