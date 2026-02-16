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
    if (presenceStatus === PresenceStatus.Away && !autoAwayRef.current) {
      // Server or idle timer set us to Away — adopt as auto-away so that
      // strong activity (mousemove, keydown, etc.) restores us to Online.
      autoAwayRef.current = true;
    } else if (autoAwayRef.current && presenceStatus !== PresenceStatus.Away) {
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

    // Reset the idle timer (any activity signal, including weak ones like scroll/focus).
    const resetIdleTimer = () => {
      if (!hasMainProcessIdle) {
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
        }
        idleTimerRef.current = setTimeout(() => {
          void markAwayIfEligible();
        }, IDLE_TIMEOUT_MS);
      }
    };

    // Strong activity: real user interaction — restores from auto-away AND resets timer.
    const handleStrongActivity = () => {
      void restoreIfAutoAway();
      resetIdleTimer();
    };

    // Weak activity: can fire without user interaction (programmatic scroll,
    // OS-level focus changes, new messages causing auto-scroll) — only resets
    // the idle timer, never restores from auto-away.
    const handleWeakActivity = () => {
      resetIdleTimer();
    };

    const strongEvents = ['mousemove', 'keydown', 'mousedown', 'touchstart'];
    const weakEvents = ['scroll'];
    strongEvents.forEach(event => window.addEventListener(event, handleStrongActivity, { passive: true }));
    weakEvents.forEach(event => window.addEventListener(event, handleWeakActivity, { passive: true }));
    window.addEventListener('focus', handleWeakActivity);

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
      strongEvents.forEach(event => window.removeEventListener(event, handleStrongActivity));
      weakEvents.forEach(event => window.removeEventListener(event, handleWeakActivity));
      window.removeEventListener('focus', handleWeakActivity);

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      unsubIdle?.();
      unsubReconnect();
    };
  }, [userId, token, setPresenceStatus]);
}
