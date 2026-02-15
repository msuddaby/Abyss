import { useEffect, useState } from 'react';
import { useAuthStore, api, getApiBase, PresenceStatus } from '@abyss/shared';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes in milliseconds

export function useIdleDetection() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const setPresenceStatus = useAuthStore((s) => s.setPresenceStatus);
  const [previousStatus, setPreviousStatus] = useState<number | null>(null);

  useEffect(() => {
    if (!user || !token) return;

    let idleTimer: ReturnType<typeof setTimeout>;

    const setPresence = async (status: number) => {
      try {
        await api.put(`${getApiBase()}/api/auth/presence`, {
          presenceStatus: status
        }, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        setPresenceStatus(status);
      } catch (error) {
        console.error('Failed to update presence status:', error);
      }
    };

    const resetTimer = () => {
      clearTimeout(idleTimer);

      // If was auto-idled, restore previous status
      if (previousStatus !== null && user.presenceStatus === PresenceStatus.Away) {
        setPresence(previousStatus);
        setPreviousStatus(null);
      }

      // Set new idle timer (10 minutes)
      idleTimer = setTimeout(() => {
        // Only auto-idle from Online status
        if (user.presenceStatus === PresenceStatus.Online) {
          setPreviousStatus(PresenceStatus.Online);
          setPresence(PresenceStatus.Away);
        }
      }, IDLE_TIMEOUT);
    };

    // Activity event listeners
    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'];
    events.forEach(event => window.addEventListener(event, resetTimer, { passive: true }));

    // Also listen for window focus
    window.addEventListener('focus', resetTimer);

    // Start initial timer
    resetTimer();

    return () => {
      clearTimeout(idleTimer);
      events.forEach(event => window.removeEventListener(event, resetTimer));
      window.removeEventListener('focus', resetTimer);
    };
  }, [user?.presenceStatus, previousStatus, user, token]);
}
