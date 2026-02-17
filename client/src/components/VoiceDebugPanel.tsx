import { useState, useEffect, useCallback } from 'react';
import { getDetailedConnectionStats } from '../hooks/useWebRTC';
import type { DetailedConnectionStats } from '../hooks/useWebRTC';
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
  const [detailedView, setDetailedView] = useState(false);
  const [stats, setStats] = useState<DetailedConnectionStats | null>(null);
  const [sfuInfo, setSfuInfo] = useState<SfuDebugInfo | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const currentChannelId = useVoiceStore(s => s.currentChannelId);
  const participants = useVoiceStore(s => s.participants);
  const connectionMode = useVoiceStore(s => s.connectionMode);
  const sfuFallbackReason = useVoiceStore(s => s.sfuFallbackReason);
  const p2pFailureCount = useVoiceStore(s => s.p2pFailureCount);

  const isSfu = connectionMode === 'sfu' || connectionMode === 'attempting-sfu';

  const refresh = useCallback(() => {
    if (isSfu) {
      setSfuInfo(getSfuDebugInfo());
    } else {
      setStats(getDetailedConnectionStats());
    }
    setLastUpdate(new Date());
  }, [isSfu]);

  // Auto-refresh when expanded
  useEffect(() => {
    if (!expanded || !currentChannelId) return;
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [expanded, currentChannelId, refresh]);

  const handleCopyStats = () => {
    let output: object;

    if (isSfu && sfuInfo) {
      output = {
        timestamp: new Date().toISOString(),
        mode: 'sfu',
        sfuFallbackReason,
        p2pFailureCount,
        room: {
          name: sfuInfo.roomName,
          state: sfuInfo.connectionState,
          e2ee: sfuInfo.e2eeEnabled,
          localParticipant: sfuInfo.localParticipant,
        },
        remoteParticipants: sfuInfo.remoteParticipants,
      };
    } else {
      output = {
        timestamp: new Date().toISOString(),
        mode: 'p2p',
        p2pFailureCount,
        summary: {
          activePeers: stats?.activePeerCount ?? 0,
          connectionType: stats?.connectionType ?? 'unknown',
          natType: stats?.natType ?? 'unknown',
          iceConnectionState: stats?.iceConnectionState ?? 'new',
          iceGatheringComplete: stats?.iceGatheringComplete ?? false,
          avgRoundTripTime: stats?.roundTripTime,
          avgPacketLoss: stats?.packetLoss,
          avgJitter: stats?.jitter,
        },
        localCandidates: stats?.localCandidates ?? {
          hostCount: 0, srflxCount: 0, relayCount: 0, protocol: 'unknown',
        },
        peers: stats?.perPeerStats.map(peer => ({
          userId: peer.userId,
          displayName: participants.get(peer.userId) ?? 'Unknown',
          iceState: peer.iceState,
          signalingState: peer.signalingState,
          connectionType: peer.connectionType,
          localCandidateType: peer.localCandidateType,
          remoteCandidateType: peer.remoteCandidateType,
          transportProtocol: peer.transportProtocol,
          consent: peer.consent,
          roundTripTime: peer.roundTripTime,
          packetLoss: peer.packetLoss,
          jitter: peer.jitter,
          bytesReceived: peer.bytesReceived,
          bytesSent: peer.bytesSent,
        })) ?? [],
      };
    }
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
                <button type="button" className="btn-small" onClick={refresh}>
                  Refresh
                </button>
                {!isSfu && (
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => setDetailedView(!detailedView)}
                  >
                    {detailedView ? 'Simple View' : 'Detailed View'}
                  </button>
                )}
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
                    {connectionMode === 'attempting-sfu' && 'Connecting to Relay...'}
                    {connectionMode === 'p2p' && 'Peer-to-Peer'}
                  </div>
                </div>

                {p2pFailureCount > 0 && (
                  <div className="voice-debug-metric">
                    <div className="voice-debug-metric-label">P2P Failures</div>
                    <div className="voice-debug-metric-value">{p2pFailureCount}</div>
                  </div>
                )}

                {sfuFallbackReason && (
                  <div className="voice-debug-metric" style={{ gridColumn: '1 / -1' }}>
                    <div className="voice-debug-metric-label">Fallback Reason</div>
                    <div className="voice-debug-metric-value" style={{ fontSize: '0.85em' }}>
                      {sfuFallbackReason}
                    </div>
                  </div>
                )}
              </div>

              {/* SFU-specific stats */}
              {isSfu && sfuInfo && (
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

              {/* P2P-specific stats */}
              {!isSfu && stats && (
                <>
                  <div className="voice-debug-metrics">
                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Connection Type</div>
                      <div className="voice-debug-metric-value">
                        {stats.connectionType === 'direct' && 'P2P Direct'}
                        {stats.connectionType === 'relay' && 'TURN Relay'}
                        {stats.connectionType === 'mixed' && 'Mixed'}
                        {stats.connectionType === 'unknown' && 'Unknown'}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">NAT Type</div>
                      <div className="voice-debug-metric-value">
                        {stats.natType === 'open' && 'Open Internet'}
                        {stats.natType === 'cone' && 'Cone NAT'}
                        {stats.natType === 'symmetric' && 'Symmetric NAT'}
                        {stats.natType === 'unknown' && 'Detecting...'}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">ICE Candidates</div>
                      <div className="voice-debug-metric-value" style={{ fontSize: '0.85em' }}>
                        Host: {stats.localCandidates.hostCount} |
                        STUN: {stats.localCandidates.srflxCount} |
                        TURN: {stats.localCandidates.relayCount}
                      </div>
                    </div>

                    <div className="voice-debug-metric">
                      <div className="voice-debug-metric-label">Protocol</div>
                      <div className="voice-debug-metric-value">
                        {stats.localCandidates.protocol.toUpperCase()}
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
                        {stats.iceGatheringComplete && ' (complete)'}
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
                              <div className="label">Local / Remote</div>
                              <div style={{ fontSize: '0.85em' }}>
                                {peer.localCandidateType || '?'} / {peer.remoteCandidateType || '?'}
                              </div>
                            </div>
                            <div>
                              <div className="label">Protocol</div>
                              <div>{peer.transportProtocol?.toUpperCase() || 'Unknown'}</div>
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
                              <div className="label">Consent</div>
                              <div>
                                {peer.consent === 'granted' && 'Active'}
                                {peer.consent === 'checking' && 'Checking'}
                                {peer.consent === 'unknown' && '?'}
                              </div>
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
