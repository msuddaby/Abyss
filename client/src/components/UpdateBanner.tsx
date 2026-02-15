import { useEffect, useState, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { onOtaStateChange, applyOtaUpdate, checkForOtaUpdate, type OtaUpdateState } from '../services/otaUpdater';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

interface UpdateState {
  status: UpdateStatus;
  version?: string;
  progress?: number;
  error?: string;
  manualDownloadUrl?: string;
}

// Capacitor OTA sub-component
function CapacitorUpdateBanner() {
  const [otaState, setOtaState] = useState<OtaUpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unsub = onOtaStateChange((state) => {
      setOtaState(state);
      setDismissed(false);
      if (state.status !== 'idle') setVisible(true);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (otaState.status === 'up-to-date') {
      const timer = setTimeout(() => setVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [otaState.status]);

  const handleApply = useCallback(() => {
    if (otaState.status === 'ready') {
      applyOtaUpdate(otaState.bundle, otaState.version);
    }
  }, [otaState]);

  const handleRetry = useCallback(() => {
    checkForOtaUpdate();
  }, []);

  if (!visible || dismissed || otaState.status === 'idle') return null;

  const canDismiss = otaState.status !== 'downloading';

  let statusClass: string;
  switch (otaState.status) {
    case 'checking': statusClass = 'checking'; break;
    case 'downloading': statusClass = 'downloading'; break;
    case 'ready': statusClass = 'downloaded'; break;
    case 'up-to-date': statusClass = 'not-available'; break;
    case 'error': statusClass = 'error'; break;
    default: statusClass = 'idle';
  }

  return (
    <div className={`update-banner ${statusClass}`}>
      <div className="update-banner-content">
        {otaState.status === 'checking' && (
          <>
            <span className="update-spinner" />
            <span>Checking for updates...</span>
          </>
        )}
        {otaState.status === 'downloading' && (
          <span>Downloading update v{otaState.version}...</span>
        )}
        {otaState.status === 'ready' && (
          <>
            <span>Update v{otaState.version} ready</span>
            <button className="update-action-btn" onClick={handleApply}>Apply</button>
          </>
        )}
        {otaState.status === 'up-to-date' && (
          <span>You're up to date</span>
        )}
        {otaState.status === 'error' && (
          <>
            <span>Update check failed</span>
            <button className="update-action-btn" onClick={handleRetry}>Retry</button>
          </>
        )}
        {canDismiss && (
          <button className="update-dismiss-btn" onClick={() => setDismissed(true)} title="Dismiss">&times;</button>
        )}
      </div>
    </div>
  );
}

// Electron update sub-component
function ElectronUpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!window.electron?.updates) return;

    const unsub = window.electron.updates.onUpdateStatusChanged((newState) => {
      console.log('[Update]', newState.status, newState.version ?? '', newState.progress != null ? `${newState.progress}%` : '');
      setState(newState);
      setDismissed(false);
      setVisible(true);
    });

    const unsubLog = window.electron.onUpdateLog?.((msg: string) => {
      console.log('[Update Log]', msg);
    });

    return () => {
      unsub();
      unsubLog?.();
    };
  }, []);

  useEffect(() => {
    if (state.status === 'not-available') {
      const timer = setTimeout(() => setVisible(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [state.status]);

  const handleDownload = useCallback(() => {
    window.electron?.updates.downloadUpdate();
  }, []);

  const handleRestart = useCallback(() => {
    window.electron?.updates.quitAndInstall();
  }, []);

  const handleRetry = useCallback(() => {
    window.electron?.updates.checkForUpdates();
  }, []);

  if (!visible || dismissed || state.status === 'idle') return null;

  const canDismiss = state.status !== 'downloading';

  return (
    <div className={`update-banner ${state.status}`}>
      <div className="update-banner-content">
        {state.status === 'checking' && (
          <>
            <span className="update-spinner" />
            <span>Checking for updates...</span>
          </>
        )}
        {state.status === 'available' && (
          <>
            <span>Update v{state.version} available</span>
            <button className="update-action-btn" onClick={handleDownload}>
              {state.manualDownloadUrl ? 'View Download' : 'Download'}
            </button>
          </>
        )}
        {state.status === 'downloading' && (
          <>
            <span>Downloading update... {state.progress ?? 0}%</span>
            <div className="update-progress-bar">
              <div className="update-progress-fill" style={{ width: `${state.progress ?? 0}%` }} />
            </div>
          </>
        )}
        {state.status === 'downloaded' && (
          <>
            <span>Update ready — restart to install</span>
            <button className="update-action-btn" onClick={handleRestart}>Restart</button>
          </>
        )}
        {state.status === 'error' && (
          <>
            <span>Update check failed</span>
            <button className="update-action-btn" onClick={handleRetry}>Retry</button>
          </>
        )}
        {state.status === 'not-available' && (
          <span>You're up to date</span>
        )}
        {canDismiss && (
          <button className="update-dismiss-btn" onClick={() => setDismissed(true)} title="Dismiss">&times;</button>
        )}
      </div>
    </div>
  );
}

export default function UpdateBanner() {
  if (Capacitor.isNativePlatform()) return <CapacitorUpdateBanner />;
  if (window.electron) return <ElectronUpdateBanner />;
  return null;
}
