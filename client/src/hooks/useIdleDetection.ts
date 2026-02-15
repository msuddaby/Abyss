import { useEffect, useRef } from 'react';
import { useAuthStore, api, getApiBase, PresenceStatus } from '@abyss/shared';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_POLL_INTERVAL_MS = 30 * 1000;

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
    const hasSystemIdleDetector = typeof window.electron?.getSystemIdleTime === 'function';

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

    const resetWebIdleTimer = () => {
      if (hasSystemIdleDetector) return;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = setTimeout(() => {
        void markAwayIfEligible();
      }, IDLE_TIMEOUT_MS);
    };

    const handleActivity = () => {
      void restoreIfAutoAway();
      resetWebIdleTimer();
    };

    // Activity event listeners
    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'];
    events.forEach(event => window.addEventListener(event, handleActivity, { passive: true }));

    window.addEventListener('focus', handleActivity);

    resetWebIdleTimer();

    let idlePollInterval: ReturnType<typeof setInterval> | null = null;
    if (hasSystemIdleDetector) {
      const pollSystemIdle = async () => {
        try {
          const idleSeconds = await window.electron!.getSystemIdleTime();
          if (disposed) return;
          const idleMs = idleSeconds * 1000;
          if (idleMs >= IDLE_TIMEOUT_MS) {
            await markAwayIfEligible();
          } else {
            await restoreIfAutoAway();
          }
        } catch (error) {
          console.error('Failed to poll system idle time:', error);
        }
      };

      void pollSystemIdle();
      idlePollInterval = setInterval(() => {
        void pollSystemIdle();
      }, IDLE_POLL_INTERVAL_MS);
    }

    // Listen for screen lock/unlock events from the main process.
    // The setInterval polling above gets throttled by macOS when the screen
    // is locked, so this ensures away status is set immediately.
    let unsubScreenLock: (() => void) | null = null;
    if (typeof window.electron?.onScreenLockChanged === 'function') {
      unsubScreenLock = window.electron.onScreenLockChanged((locked) => {
        if (disposed) return;
        if (locked) {
          void markAwayIfEligible();
        } else {
          void restoreIfAutoAway();
        }
      });
    }

    return () => {
      disposed = true;
      events.forEach(event => window.removeEventListener(event, handleActivity));
      window.removeEventListener('focus', handleActivity);

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (idlePollInterval) {
        clearInterval(idlePollInterval);
      }
      unsubScreenLock?.();
    };
  }, [userId, token, setPresenceStatus]);
}
