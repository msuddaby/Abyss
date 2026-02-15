import { useEffect, useRef } from 'react';
import { useAuthStore, api, getApiBase, PresenceStatus, onReconnected } from '@abyss/shared';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function useIdleDetection() {
  const userId = useAuthStore((s) => s.user?.id);
  const presenceStatus = useAuthStore((s) => s.user?.presenceStatus);
  const token = useAuthStore((s) => s.token);
  const setPresenceStatus = useAuthStore((s) => s.setPresenceStatus);
  const autoAwayRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (autoAwayRef.current && presenceStatus !== PresenceStatus.Away) {
      autoAwayRef.current = false;
    }
  }, [presenceStatus]);

  useEffect(() => {
    if (!userId || !token) {
      autoAwayRef.current = false;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      return;
    }

    let disposed = false;

    const updatePresence = async (status: number) => {
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (currentStatus === status) return;
      try {
        await api.put(`${getApiBase()}/api/auth/presence`, {
          presenceStatus: status
        }, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        if (!disposed) {
          setPresenceStatus(status);
        }
      } catch (error) {
        console.error('Failed to update presence status:', error);
      }
    };

    const markAwayIfEligible = async () => {
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (currentStatus !== PresenceStatus.Online) return;
      autoAwayRef.current = true;
      await updatePresence(PresenceStatus.Away);
    };

    const restoreIfAutoAway = async () => {
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (!autoAwayRef.current || currentStatus !== PresenceStatus.Away) return;
      autoAwayRef.current = false;
      await updatePresence(PresenceStatus.Online);
    };

    // Electron: idle detection runs in the main process (immune to renderer
    // throttling from macOS App Nap / screen lock). We just listen for its signal.
    const hasMainProcessIdle = typeof window.electron?.onSystemIdleChanged === 'function';

    let unsubIdle: (() => void) | null = null;
    if (hasMainProcessIdle) {
      unsubIdle = window.electron!.onSystemIdleChanged((isIdle) => {
        if (disposed) return;
        if (isIdle) {
          void markAwayIfEligible();
        } else {
          void restoreIfAutoAway();
        }
      });
    }

    // Web browser fallback: track activity events with a 10-minute timeout.
    // Also handles restoring from auto-away on activity in Electron.
    const handleActivity = () => {
      void restoreIfAutoAway();
      if (!hasMainProcessIdle) {
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
        }
        idleTimerRef.current = setTimeout(() => {
          void markAwayIfEligible();
        }, IDLE_TIMEOUT_MS);
      }
    };

    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'];
    events.forEach(event => window.addEventListener(event, handleActivity, { passive: true }));
    window.addEventListener('focus', handleActivity);

    // On SignalR reconnect (e.g. after waking from sleep), if the server
    // auto-set us to Away while we were disconnected, adopt that as auto-away
    // so the next activity event restores us to Online.
    const unsubReconnect = onReconnected(() => {
      if (disposed) return;
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (currentStatus === PresenceStatus.Away && !autoAwayRef.current) {
        autoAwayRef.current = true;
      }
    });

    // Start the web idle timer (no-op path for Electron since handleActivity
    // skips the timer when hasMainProcessIdle is true)
    if (!hasMainProcessIdle) {
      idleTimerRef.current = setTimeout(() => {
        void markAwayIfEligible();
      }, IDLE_TIMEOUT_MS);
    }

    return () => {
      disposed = true;
      events.forEach(event => window.removeEventListener(event, handleActivity));
      window.removeEventListener('focus', handleActivity);

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      unsubIdle?.();
      unsubReconnect();
    };
  }, [userId, token, setPresenceStatus]);
}
